/** Row positions for the fullscreen transcript; separators belong to the block below. */
import type { UiNode } from "../node";
import { type Accessor, untrack } from "../reactive";
import { type Block, EMPTY_BLOCK } from "./paint";
import { TranscriptRows } from "./transcript-rows";

export interface TranscriptEntry {
	readonly node: UiNode;
	readonly top: number;
	readonly lead: number;
	readonly index: number;
	readonly size: number;
}

interface IndexedBlock {
	readonly node: UiNode;
	lead: number;
	body?: number;
	entry?: TranscriptEntry;
}

const REFINE_BLOCKS = 32;
const REFINE_MS = 4;

export class TranscriptDocument {
	readonly #blocks: IndexedBlock[] = [];
	readonly #byNode = new Map<UiNode, number>();
	readonly #heights: TranscriptRows;
	#nodes: readonly UiNode[] | undefined;
	#painted: ReadonlyMap<number, Block> | undefined;
	#pending = 0;
	#next = -1;
	#sampled = false;

	constructor(
		readonly main: Accessor<readonly UiNode[]>,
		readonly block: (node: UiNode) => Block,
		readonly separator: (above: UiNode, below: UiNode) => number,
		estimate = 2,
		readonly paintVisible = block,
	) {
		this.#heights = new TranscriptRows([], estimate);
	}

	get rows(): number {
		return this.#heights.end;
	}

	get estimate(): number {
		return this.#heights.estimate;
	}

	get pending(): boolean {
		return this.#pending > 0;
	}

	/** The common prefix stays indexed; appending and replacing a tail only change its leaves. */
	sync(): void {
		const nodes = this.main();
		if (nodes === this.#nodes) return;
		this.#nodes = nodes;
		this.#painted = undefined;
		let start = 0;
		while (start < nodes.length && this.#blocks[start]?.node === nodes[start]) start++;
		for (let i = start; i < this.#blocks.length; i++) {
			const block = this.#blocks[i]!;
			this.#byNode.delete(block.node);
			if (block.body === undefined) this.#pending--;
		}
		this.#blocks.length = start;
		this.#heights.truncate(start);
		for (let i = start; i < nodes.length; i++) {
			const node = nodes[i]!;
			this.#blocks.push({ node, lead: i > 0 ? 1 : 0 });
			this.#byNode.set(node, i);
			this.#heights.push();
		}
		this.#pending += nodes.length - start;
		this.#next = nodes.length > start ? nodes.length - 1 : Math.min(this.#next, start - 1);
	}

	indexOf(node: UiNode): number {
		return this.#byNode.get(node) ?? -1;
	}

	indexAt(row: number): number {
		return this.#heights.find(row);
	}

	start(index: number): number {
		return this.#heights.start(index);
	}

	size(index: number): number {
		return this.#heights.weight(index);
	}

	#entry(index: number): TranscriptEntry | undefined {
		const block = this.#blocks[index];
		if (!block) return undefined;
		const size = this.size(index);
		if (size === 0) return undefined;
		const top = this.start(index);
		const { node, lead, entry } = block;
		if (entry?.top === top && entry.size === size && entry.lead === lead) return entry;
		return (block.entry = { node, top, lead, index, size });
	}

	entry(node: UiNode): TranscriptEntry | undefined {
		return this.#entry(this.indexOf(node));
	}

	at(row: number): TranscriptEntry | undefined {
		return this.#entry(this.indexAt(row));
	}

	lines(node: UiNode): readonly string[] {
		const paint = this.#painted?.has(this.indexOf(node)) ? this.paintVisible : this.block;
		return paint(node).rows;
	}

	painted(blocks: ReadonlyMap<number, Block>): void {
		this.#painted = blocks;
	}

	line(row: number): string {
		const entry = this.at(row);
		return entry ? (this.lines(entry.node)[row - entry.top - entry.lead] ?? "") : "";
	}

	#setExtent(index: number): void {
		const block = this.#blocks[index]!;
		const above = this.#blocks[this.indexAt(this.start(index) - 1)]?.node;
		const lead = above && block.body !== 0 ? Math.max(0, this.separator(above, block.node)) : 0;
		block.lead = lead;
		if (block.body !== undefined) this.#heights.set(index, block.body + lead);
	}

	/** Resolve a short scroll through real adjacent extents before choosing its anchor. */
	offset(entry: TranscriptEntry, row: number, delta: number): number {
		let target = entry.top + row + delta;
		const step = Math.sign(delta);
		// Sparse or empty stretches can take more blocks than there are rows on screen.
		for (let i = entry.index + step, n = 0; step && i >= 0 && i < this.#blocks.length && n < 128; i += step, n++) {
			if (step < 0 ? target >= this.start(i + 1) : target < this.start(i)) break;
			if (this.#blocks[i]!.body !== undefined) continue;
			this.measure(i);
			target = this.start(entry.index) + row + delta;
		}
		return target;
	}

	/** Reweight one block; if it becomes empty/nonempty, reconnect its next separator too. */
	measure(index: number, visible = false): Block {
		const item = this.#blocks[index];
		if (!item) return EMPTY_BLOCK;
		const block = (visible ? this.paintVisible : this.block)(item.node);
		const hadRows = item.body !== 0;
		if (item.body === undefined) this.#pending--;
		item.body = block.rows.length;
		this.#setExtent(index);
		const hasRows = item.body > 0;
		if (hadRows !== hasRows) {
			const next = this.indexAt(this.start(index + 1));
			if (next < this.#blocks.length) this.#setExtent(next);
		}
		return block;
	}

	seed(sum: number, count: number): void {
		if (this.#sampled || !count) return;
		this.#heights.estimate = Math.max(1, Math.round(sum / count));
		this.#sampled = true;
	}

	/** Distant blocks do not subscribe the frame to their text, clock or image resources. */
	refine(): void {
		if (!this.pending) return;
		const deadline = performance.now() + REFINE_MS;
		untrack(() => {
			for (let n = 0; this.#next >= 0 && n < REFINE_BLOCKS && this.pending; n++) {
				const index = this.#next--;
				if (this.#blocks[index]!.body === undefined) this.measure(index);
				if (performance.now() >= deadline) break;
			}
		});
	}
}
