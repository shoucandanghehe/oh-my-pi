import type {
	Component,
	HistoryBatch,
	TextSelectionRange,
	VirtualViewportFrame,
	VirtualViewportProvider,
	VirtualViewportRequest,
} from "@oh-my-pi/pi-tui";
import { Container, componentContains, extractComponentTextSelection, normalizeTextSelection } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { isToolActivityComponent } from "./tool-activity";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
}

/** Presentation declaration captured permanently when a block is added. */
export type TranscriptBlockMode = "mutable" | "appendOnly";

/** Immutable width-independent identity for one stable semantic row. */
export interface TranscriptStableRow {
	readonly key: string;
}

/**
 * Explicit semantic-row contract for a block whose stable head may enter native
 * history before finalization. Every later array must extend the prior keys
 * exactly; each row renderer is deterministic for its width.
 * A publication that breaks these invariants (e.g. a mid-stream theme change
 * re-coloring already-emitted bytes) freezes further stable-row emission for
 * that block instead of failing the render — see {@link TranscriptContainer}.
 */
export interface AppendOnlyTranscriptBlock {
	readonly transcriptBlockMode: "appendOnly";
	getTranscriptStableRows(): readonly TranscriptStableRow[];
	/**
	 * Render the first `count` semantic rows at the requested current width.
	 * Counts are monotonic identities, not physical row counts; this output must
	 * prefix the block's full render at the same width.
	 */
	renderTranscriptStableRows(count: number, width: number): readonly string[];
	/**
	 * Discard every published stable row so the block re-renders its head from
	 * scratch. Called only alongside a destructive display reset (e.g. a
	 * thinking-visibility toggle) that clears the native scrollback those rows
	 * occupied — the sole context in which the append-only "published bytes never
	 * change" contract may be retracted. Optional: blocks whose stable-row
	 * presentation never changes may omit it.
	 */
	resetTranscriptStableRows?(): void;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	/** Render the row that must remain represented under emergency viewport pressure. */
	renderTranscriptBlockEmergencyRow?(width: number): string | undefined;
	/** Whether finalized rows may retire into immutable terminal history. */
	isTranscriptBlockAppendOnly?(): boolean;
	getTranscriptBlockVersion?(): number;
}

interface ExpandableBlock {
	setExpanded(expanded: boolean): void;
}

function setBlockExpanded(component: Component, expanded: boolean): void {
	const candidate = component as Component & Partial<ExpandableBlock>;
	candidate.setExpanded?.(expanded);
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport until pressure.
 * - `committed`: logically retired; replay never rewinds this state.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
	mode: TranscriptBlockMode;
	stableRows: readonly TranscriptStableRow[];
	renderedStableByWidth: Map<number, readonly string[]>;
	emitted: number;
	/**
	 * Set when a published stable row drifted (retraction, byte change within a
	 * width epoch, or no longer a render prefix). Rows already in native
	 * scrollback cannot be retracted, so the entry keeps its last good stable
	 * state for emitted-row slicing but never emits another mid-stream row.
	 */
	stableFrozen: boolean;
}

type RetirementPolicy = "pressure" | "flush";
type Offered =
	| { batch: HistoryBatch; kind: "append"; entry: number; emittedEnd: number }
	| { batch: HistoryBatch; kind: "commit"; end: number }
	| { batch: HistoryBatch; kind: "replay" };

interface VirtualBlockExtent {
	component: Component;
	contribution: readonly string[] | undefined;
	rawRef: readonly string[] | undefined;
	estimatedBodyRows: number;
	measuredWidth: number;
	measuredGeneration: number;
	measuredVersion: number | undefined;
	startRow: number;
	rowCount: number;
	sep: number;
}

interface VirtualWarmMeasurement {
	entry: VirtualBlockExtent;
	raw: readonly string[];
	contribution: readonly string[];
	version: number | undefined;
}

interface VirtualWarmup {
	token: number;
	width: number;
	generation: number;
	expanded: boolean;
	entries: VirtualBlockExtent[];
	promise: Promise<void>;
}

const MAX_LIVE_BLOCKS = 256;
/** Grace before a pressure-blocked frontier is reported; a streaming block may legitimately hold it briefly. */
const PINNED_FRONTIER_WARN_MS = 30_000;
const EMPTY_ROWS: readonly string[] = [];
const EMPTY_STABLE_ROWS: readonly TranscriptStableRow[] = [];
const VIRTUAL_OVERSCAN_BLOCKS = 8;
const VIRTUAL_WARMUP_CHUNK_ENTRIES = 32;
const VIRTUAL_WARMUP_CHUNK_MS = 4;

function isBlockFinalized(component: Component): boolean {
	return (component as Component & FinalizableBlock).isTranscriptBlockFinalized?.() ?? true;
}

function isBlockExplicitlyFinalized(component: Component): boolean {
	return (component as Component & FinalizableBlock).isTranscriptBlockFinalized?.() === true;
}

function canRetire(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return isBlockFinalized(component) && (block.isTranscriptBlockAppendOnly?.() ?? true);
}

function blockMode(component: Component): TranscriptBlockMode {
	return (component as Component & Partial<AppendOnlyTranscriptBlock>).transcriptBlockMode === "appendOnly"
		? "appendOnly"
		: "mutable";
}

function getBlockVersion(component: Component): number | undefined {
	return (component as Component & FinalizableBlock).getTranscriptBlockVersion?.();
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Whether `prefix` matches `rows` byte-for-byte from the top. */
export function isRowPrefix(prefix: readonly string[], rows: readonly string[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index] !== rows[index]) return false;
	}
	return true;
}

function isStablePrefix(prefix: readonly TranscriptStableRow[], rows: readonly TranscriptStableRow[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index]!.key !== rows[index]!.key) return false;
	}
	return true;
}

/** Strip leading/trailing all-blank rows; the viewport allocator measures blocks by this trimmed height. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container implements VirtualViewportProvider {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: Offered | undefined;
	#replayPending = false;
	#replayRequested = false;
	#toolActivityVisible = true;
	#expanded = false;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };
	// Start rows from the last full render(), keyed by child component (transcript deep-links).
	#childStartRows = new Map<Component, number>();
	// Watchdog for the wedge where an unfinalized frontier block pins pressure
	// retirement: everything behind it stays live and degrades to one-line
	// allocations. Logs once per pinned episode after a grace period.
	#pinnedFrontier: { index: number; since: number; logged: boolean } | undefined;
	#virtualEntries: VirtualBlockExtent[] = [];
	#measuredVirtualEntries = new Set<VirtualBlockExtent>();
	#visibleVirtualEntries = new Set<VirtualBlockExtent>();
	#virtualTotalRows = 0;
	#virtualStructureDirty = true;
	#virtualWidth = -1;
	#virtualGeneration = -1;
	#virtualEstimateSeeded = false;
	#virtualEstimatedBodyRows = 1;
	#virtualWarmupToken = 0;
	#virtualWarmup: VirtualWarmup | undefined;
	#virtualExact = false;
	#generation = 0;

	override addChild(component: Component): void {
		// New transcript blocks arrive on the frame hot path. Extend the warmed
		// ledger in place; removals and pre-warm batches still take full reconcile.
		const canExtendVirtualLedger =
			!this.#virtualStructureDirty && this.#virtualEntries.length === this.children.length;
		if (this.#virtualWarmup || this.#virtualExact) this.#cancelVirtualWarmup();
		super.addChild(component);
		this.#applyPresentationState(component);
		this.#entries.push({
			component,
			state: "active",
			mode: blockMode(component),
			stableRows: EMPTY_STABLE_ROWS,
			renderedStableByWidth: new Map(),
			emitted: 0,
			stableFrozen: false,
		});
		if (!canExtendVirtualLedger) {
			this.#virtualStructureDirty = true;
			return;
		}
		const estimatedBodyRows = this.#virtualEstimatedBodyRows;
		const sep = this.#virtualTotalRows > 0 ? 1 : 0;
		const rowCount = sep + estimatedBodyRows;
		this.#virtualEntries.push({
			component,
			rawRef: undefined,
			contribution: undefined,
			estimatedBodyRows,
			measuredWidth: -1,
			measuredGeneration: -1,
			measuredVersion: undefined,
			startRow: this.#virtualTotalRows,
			rowCount,
			sep,
		});
		this.#virtualTotalRows += rowCount;
	}

	override removeChild(component: Component): void {
		if (this.children.indexOf(component) < 0 || !this.canRemoveBlock(component)) return;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
		this.#childStartRows.delete(component);
		this.#virtualStructureDirty = true;
		this.#cancelVirtualWarmup();
	}

	override clear(): void {
		this.#cancelVirtualWarmup();
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#childStartRows.clear();
		this.#pinnedFrontier = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#virtualEntries = [];
		this.#measuredVirtualEntries = new Set<VirtualBlockExtent>();
		this.#visibleVirtualEntries = new Set<VirtualBlockExtent>();
		this.#virtualTotalRows = 0;
		this.#virtualStructureDirty = true;
		this.#virtualEstimateSeeded = false;
		this.#virtualEstimatedBodyRows = 1;
		this.#virtualExact = false;
		this.#generation++;
	}

	/**
	 * Reconcile child identities and estimated row offsets without rendering.
	 * Incremental transcript builders call this at yield boundaries so later
	 * appends extend an already-warmed ledger in constant time.
	 */
	prepareVirtualStructure(): void {
		this.#syncVirtualStructure();
	}

	/**
	 * Measure every transcript block in bounded event-loop chunks. The live
	 * scrollbar keeps its current estimate until the complete exact ledger can
	 * replace it atomically.
	 */
	warmVirtualViewport(width: number): Promise<void> {
		width = Math.max(1, Math.trunc(width));
		this.#syncVirtualEntries(width);
		if (this.#virtualExact) return Promise.resolve();
		const current = this.#virtualWarmup;
		if (
			current &&
			current.width === width &&
			current.generation === this.#generation &&
			current.expanded === this.#expanded &&
			current.entries === this.#virtualEntries
		) {
			return current.promise;
		}

		const token = ++this.#virtualWarmupToken;
		const { promise, resolve } = Promise.withResolvers<void>();
		const warmup: VirtualWarmup = {
			token,
			width,
			generation: this.#generation,
			expanded: this.#expanded,
			entries: this.#virtualEntries,
			promise,
		};
		this.#virtualWarmup = warmup;
		setImmediate(() => {
			void this.#runVirtualWarmup(warmup)
				.catch(error => {
					logger.debug("Transcript virtual-height warmup stopped", { error: String(error) });
				})
				.finally(() => {
					if (this.#virtualWarmup === warmup) this.#virtualWarmup = undefined;
					resolve();
				});
		});
		return promise;
	}

	/**
	 * Move an already-built transcript into this empty container without
	 * rebuilding child lifecycle or virtual-layout state.
	 */
	adoptContentsFrom(source: TranscriptContainer): void {
		if (source === this) return;
		if (this.children.length > 0) {
			throw new Error("TranscriptContainer.adoptContentsFrom requires an empty destination");
		}
		const children = source.children;
		const entries = source.#entries;
		const frontier = source.#frontier;
		const nextBatchId = source.#nextBatchId;
		const offered = source.#offered;
		const toolActivityVisible = source.#toolActivityVisible;
		const expanded = source.#expanded;
		const lastFrame = source.#lastFrame;
		const virtualEntries = source.#virtualEntries;
		const measuredVirtualEntries = source.#measuredVirtualEntries;
		const visibleVirtualEntries = source.#visibleVirtualEntries;
		const virtualTotalRows = source.#virtualTotalRows;
		const virtualStructureDirty = source.#virtualStructureDirty;
		const virtualWidth = source.#virtualWidth;
		const virtualGeneration = source.#virtualGeneration;
		const virtualEstimateSeeded = source.#virtualEstimateSeeded;
		const virtualEstimatedBodyRows = source.#virtualEstimatedBodyRows;
		const virtualExact = source.#virtualExact;
		const generation = source.#generation;

		source.clear();
		super.clear();
		this.children = children;
		this.#entries = entries;
		this.#frontier = frontier;
		this.#nextBatchId = nextBatchId;
		this.#offered = offered;
		this.#toolActivityVisible = toolActivityVisible;
		this.#expanded = expanded;
		this.#lastFrame = lastFrame;
		this.#virtualEntries = virtualEntries;
		this.#measuredVirtualEntries = measuredVirtualEntries;
		this.#visibleVirtualEntries = visibleVirtualEntries;
		this.#virtualTotalRows = virtualTotalRows;
		this.#virtualStructureDirty = virtualStructureDirty;
		this.#virtualWidth = virtualWidth;
		this.#virtualGeneration = virtualGeneration;
		this.#virtualEstimateSeeded = virtualEstimateSeeded;
		this.#virtualEstimatedBodyRows = virtualEstimatedBodyRows;
		this.#virtualExact = virtualExact;
		this.#generation = generation;
	}

	override invalidate(): void {
		this.#cancelVirtualWarmup();
		this.#generation++;
		super.invalidate();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cancelVirtualWarmup();
		for (const entry of this.#visibleVirtualEntries) this.#applyPresentationState(entry.component);
		for (const entry of this.#measuredVirtualEntries) {
			if (entry.contribution !== undefined) entry.estimatedBodyRows = entry.contribution.length;
			entry.contribution = undefined;
			entry.rawRef = undefined;
		}
		this.#measuredVirtualEntries.clear();
		this.#virtualEstimateSeeded = false;
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	/**
	 * Forget the append-only emission ledger — emitted counts, published stable
	 * rows, per-width render cache, and freeze state — for every block, and ask
	 * each append-only block to drop its own published rows. The next replay then
	 * re-renders each block from its current {@link Component.render}, applying a
	 * changed presentation (e.g. a thinking-visibility toggle) to rows that were
	 * already emitted as stable heads while streaming (#10177).
	 *
	 * Callers MUST pair this with a scrollback-clearing {@link resetDisplay}: the
	 * emitted rows it forgets still sit in native history until that clear
	 * rewrites them, so unpaired use would duplicate them on the next retirement.
	 */
	resetStableEmission(): void {
		this.#syncEntries();
		if (this.#offered?.kind === "append") this.#offered = undefined;
		for (const entry of this.#entries) {
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth = new Map();
			entry.stableFrozen = false;
			if (entry.mode === "appendOnly") {
				(entry.component as Component & AppendOnlyTranscriptBlock).resetTranscriptStableRows?.();
			}
		}
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0) return false;
		if (this.#offered?.kind === "commit" && index < this.#offered.end) return false;
		if (this.#offered?.kind === "append" && index === this.#offered.entry) return false;
		return true;
	}

	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Permanently captured presentation mode per block (diagnostics and tests). */
	blockModes(): readonly TranscriptBlockMode[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.mode);
	}

	/** Emitted stable semantic-row counts in transcript order. */
	emittedStableRows(): readonly number[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.emitted);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Prepares one atomic replay of the committed ledger and an emitted active-head prefix. */
	beginReplay(): void {
		this.#syncEntries();
		if (this.#offered !== undefined) {
			this.#replayRequested = true;
			return;
		}
		this.#startReplay();
	}
	/**
	 * Drop a not-yet-offered replay so a shutdown flush emits only un-retired
	 * rows. The terminal already holds the committed ledger; re-streaming it at
	 * quit is pure write volume. An already offered replay batch stays valid.
	 */
	cancelReplay(): void {
		this.#replayPending = false;
		this.#replayRequested = false;
	}

	/** Total rows the live, un-emitted tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const { entry, index } of this.#liveEntries()) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			const block = rendered.slice(this.#projectedEmitted(entry, index, width));
			if (block.length > 0) total += block.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Render the live tail, constrained to the supplied transcript height. */
	renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) return EMPTY_ROWS;

		const shown: Array<{ entry: TranscriptEntry; index: number }> = [];
		const blocks: (readonly string[])[] = [];
		let total = 0;
		for (const candidate of live) {
			this.#setAllocation(candidate.entry.component, Number.MAX_SAFE_INTEGER, frame);
			const rendered = this.#renderEntry(candidate.entry, width);
			const block = rendered.slice(this.#projectedEmitted(candidate.entry, candidate.index, width));
			if (block.length === 0) continue;
			total += block.length + (shown.length > 0 ? 1 : 0);
			shown.push(candidate);
			blocks.push(block);
		}
		if (shown.length === 0) return EMPTY_ROWS;
		if (shown.length > capacity) return this.#renderEmergency(shown, width, capacity, frame);
		if (total <= capacity) {
			const output: string[] = [];
			for (const rendered of blocks) {
				if (output.length > 0) output.push("");
				output.push(...rendered);
			}
			return output;
		}

		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const allocation: number[] = new Array(shown.length).fill(1);
		let surplus = capacity - shown.length;
		// Surplus rows favor ordinary transcript blocks over dynamic tool-activity
		// cards (newest-first within each class), so a growing tool card collapses to
		// its compact form instead of clipping already-visible assistant text (#9718).
		const order: number[] = [];
		for (let index = shown.length - 1; index >= 0; index--) {
			if (!isToolActivityComponent(shown[index]!.entry.component)) order.push(index);
		}
		for (let index = shown.length - 1; index >= 0; index--) {
			if (isToolActivityComponent(shown[index]!.entry.component)) order.push(index);
		}
		for (const index of order) {
			if (surplus <= 0) break;
			const extra = Math.min(Math.max(0, blocks[index]!.length - 1), surplus);
			allocation[index] += extra;
			surplus -= extra;
		}
		const output: string[] = [];
		for (let index = 0; index < shown.length; index++) {
			const candidate = shown[index]!;
			const allocated = allocation[index]!;
			this.#setAllocation(candidate.entry.component, allocated, frame);
			const rendered = this.#renderEntry(candidate.entry, width).slice(
				this.#projectedEmitted(candidate.entry, candidate.index, width),
			);
			if (rendered.length <= allocated) output.push(...rendered);
			else output.push(...rendered.slice(rendered.length - allocated));
		}
		return output.length > capacity ? output.slice(output.length - capacity) : output;
	}

	/** Offers stable-head emission or the shortest finalized prefix needed under pressure. */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Returns only a prepared complete replay, never a normal retirement offer. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) {
			return this.#offered.kind === "replay" ? this.#offered.batch : undefined;
		}
		if (!this.#replayPending) return undefined;
		const rows = this.#renderReplay(width);
		this.#replayPending = false;
		if (rows.length === 0) return undefined;
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "replay" };
		this.#offered = { batch, kind: "replay" };
		return batch;
	}

	/** Offers the complete currently eligible prefix for graceful shutdown. */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		return this.#peekBatch(width, 0, "flush");
	}

	/** Recompose the unacknowledged batch so a discarded TUI frame can be rendered again. */
	rerenderOfferedBatch(width: number): HistoryBatch | undefined {
		const offered = this.#offered;
		if (offered === undefined) return undefined;
		let rows: readonly string[];
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined) return undefined;
			const before = this.#renderStablePrefix(entry, entry.emitted, width);
			const after = this.#renderStablePrefix(entry, offered.emittedEnd, width);
			rows = after.slice(before.length);
		} else if (offered.kind === "commit") {
			rows = this.#renderRange(this.#frontier, offered.end, width, true);
		} else {
			rows = this.#renderReplay(width);
		}
		offered.batch = { id: offered.batch.id, rows, kind: offered.batch.kind };
		return offered.batch;
	}

	#peekBatch(width: number, capacity: number, policy: RetirementPolicy): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		const replay = this.peekReplayBatch(width);
		if (replay !== undefined) return replay;

		this.#completeFullyEmittedHeads(width);
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const rendered: (readonly string[])[] = new Array(live.length);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			const candidate = live[index]!;
			this.#setAllocation(candidate.entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const renderedEntry = this.#renderEntry(candidate.entry, width);
			const rows = renderedEntry.slice(
				this.#renderStablePrefix(candidate.entry, candidate.entry.emitted, width).length,
			);
			rendered[index] = rows;
			heights[index] = rows.length;
			if (rows.length > 0) total += rows.length + (visible++ > 0 ? 1 : 0);
		}
		const overflowing = total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing) {
			this.#pinnedFrontier = undefined;
			return undefined;
		}

		const head = this.#entries[this.#frontier];
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted < head.stableRows.length
		) {
			const emittedEnd = head.emitted + 1;
			const before = this.#renderStablePrefix(head, head.emitted, width);
			const after = this.#renderStablePrefix(head, emittedEnd, width);
			if (!isRowPrefix(before, after) || after.length === before.length) {
				this.#freezeStableRows(head, EMPTY_ROWS, "semantic row render added no suffix");
				return undefined;
			}
			const batch: HistoryBatch = {
				id: this.#nextBatchId++,
				rows: after.slice(before.length),
				kind: "append",
			};
			this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
			this.#pinnedFrontier = undefined;
			return batch;
		}

		let end = this.#frontier;
		let freed = 0;
		let index = 0;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			if (
				policy === "pressure" &&
				total - freed <= room &&
				this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS
			)
				break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.#frontier) {
			if (policy === "pressure") this.#notePinnedFrontier();
			return undefined;
		}
		this.#pinnedFrontier = undefined;
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows: this.#renderRange(this.#frontier, end, width, true),
			kind: "append",
		};
		this.#offered = { batch, end, kind: "commit" };
		return batch;
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined || offered.entry !== this.#frontier || offered.emittedEnd !== entry.emitted + 1)
				return;
			entry.emitted = offered.emittedEnd;
		} else if (offered.kind === "commit") {
			for (let index = this.#frontier; index < offered.end; index++) {
				this.#entries[index]!.state = "committed";
				this.#entries[index]!.emitted = 0;
			}
			this.#frontier = offered.end;
		}
		this.#offered = undefined;
		if (this.#replayRequested) this.#startReplay();
	}

	/**
	 * Render only the trailing `maxRows` semantic rows, walking blocks bottom-up.
	 * Used by the transient resize-buffer repaint, which needs one viewport of
	 * tail rows per resize event — never the full committed ledger.
	 */
	renderTail(width: number, maxRows: number): readonly string[] {
		this.#syncEntries();
		const cap = Math.max(0, Math.trunc(maxRows));
		if (cap === 0) return EMPTY_ROWS;
		const rows: string[] = [];
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.unshift("");
			rows.unshift(...block);
			if (rows.length >= cap) break;
		}
		return rows.length > cap ? rows.slice(rows.length - cap) : rows;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#syncEntries();
		this.#childStartRows.clear();
		this.#syncVirtualEntries(width);
		const rows: string[] = [];
		for (let index = 0; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			const component = entry.component;
			this.#applyPresentationState(component);
			this.#setAllocation(component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const raw = component.render(width);
			const block = this.#renderEntry(entry, width, raw);
			this.#recordVirtualMeasurement(index, width, raw, block);
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			this.#childStartRows.set(entry.component, rows.length);
			rows.push(...block);
		}
		this.#rebuildVirtualRows(0);
		return rows;
	}

	/** Rendered row where a child's block begins in the full or virtual transcript. */
	getChildStartRow(child: Component, width?: number): number | undefined {
		if (width !== undefined) {
			this.#syncVirtualEntries(Math.max(1, width));
			const index = this.children.indexOf(child);
			const entry = index >= 0 ? this.#virtualEntries[index] : undefined;
			if (entry) return entry.startRow + entry.sep;
		}
		return this.#childStartRows.get(child);
	}

	#renderEntry(entry: TranscriptEntry, width: number, raw?: readonly string[]): readonly string[] {
		const rendered = trimBlankEdges(raw ?? entry.component.render(width));
		if (entry.mode === "mutable" || entry.stableFrozen) return rendered;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		const stable = appendOnly.getTranscriptStableRows();
		if (!isStablePrefix(entry.stableRows, stable)) {
			return this.#freezeStableRows(entry, rendered, "publication retracted the published prefix");
		}
		if (entry.emitted > stable.length) {
			return this.#freezeStableRows(entry, rendered, "publication retracted emitted history");
		}
		const published =
			stable.length > entry.stableRows.length
				? [...entry.stableRows, ...stable.slice(entry.stableRows.length)]
				: entry.stableRows;
		const stableRendered = appendOnly.renderTranscriptStableRows(published.length, width);
		if (!isRowPrefix(stableRendered, rendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows no longer render as a prefix of the block");
		}
		const priorRender = entry.renderedStableByWidth.get(width);
		if (priorRender && !isRowPrefix(priorRender, stableRendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows changed within a width epoch");
		}
		entry.stableRows = published;
		entry.renderedStableByWidth.set(width, stableRendered.slice());
		return rendered;
	}

	/**
	 * Demote a drifting append-only publication: rows already written to native
	 * scrollback cannot be retracted, so keep the last good stable state for
	 * emitted-row slicing and stop mid-stream emission for this block. The block
	 * still renders and retires whole on finalization; worst case is the old
	 * finalize-time behavior plus a possible stale-byte seam in scrollback.
	 */
	#freezeStableRows(entry: TranscriptEntry, rendered: readonly string[], reason: string): readonly string[] {
		entry.stableFrozen = true;
		logger.warn("Append-only transcript block frozen", { reason, emitted: entry.emitted });
		return rendered;
	}

	#renderStablePrefix(entry: TranscriptEntry, count: number, width: number): readonly string[] {
		if (count === 0) return EMPTY_ROWS;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		return appendOnly.renderTranscriptStableRows(Math.min(count, entry.stableRows.length), width);
	}
	/**
	 * Record that pressure retirement is blocked behind a not-yet-settled
	 * frontier block, and log its identity once the episode outlives the grace
	 * period. A block that never finalizes (a dropped terminal event) pins the
	 * whole live region here with no visible symptom other than degraded
	 * one-line layout, so the log line is the only forensic trail.
	 */
	#notePinnedFrontier(): void {
		const entry = this.#entries[this.#frontier];
		if (entry === undefined) return;
		const now = Date.now();
		if (this.#pinnedFrontier?.index !== this.#frontier) {
			this.#pinnedFrontier = { index: this.#frontier, since: now, logged: false };
			return;
		}
		if (this.#pinnedFrontier.logged || now - this.#pinnedFrontier.since < PINNED_FRONTIER_WARN_MS) return;
		this.#pinnedFrontier.logged = true;
		logger.warn("Transcript retirement pinned by unfinalized frontier block", {
			component: entry.component.constructor.name,
			state: entry.state,
			mode: entry.mode,
			liveBlocks: this.#liveCount(),
		});
	}

	#renderRange(start: number, end: number, width: number, trailingBlank: boolean): readonly string[] {
		const rows: string[] = [];
		for (let index = start; index < end; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			// Only the range head is sliced by its emitted stable prefix; every other
			// entry renders whole, so the append-only verification pass (a second
			// full render of the block's stable prefix) is skipped for them. This
			// keeps a complete-ledger replay at one render per block.
			const rendered =
				index === start ? this.#renderEntry(entry, width) : trimBlankEdges(entry.component.render(width));
			const emittedRows = index === start ? this.#renderStablePrefix(entry, entry.emitted, width).length : 0;
			const block = rendered.slice(emittedRows);
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		if (trailingBlank && rows.length > 0) rows.push("");
		return rows;
	}

	#renderReplay(width: number): readonly string[] {
		const rows = Array.from(this.#renderRange(0, this.#frontier, width, true));
		const head = this.#entries[this.#frontier];
		if (head?.mode === "appendOnly" && head.emitted > 0) {
			this.#setAllocation(head.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			this.#renderEntry(head, width);
			rows.push(...this.#renderStablePrefix(head, head.emitted, width));
		}
		return rows;
	}

	#completeFullyEmittedHeads(width: number): void {
		while (this.#frontier < this.#entries.length) {
			const entry = this.#entries[this.#frontier]!;
			if (entry.mode !== "appendOnly" || entry.state !== "settled") return;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			if (entry.emitted !== entry.stableRows.length) return;
			if (this.#renderStablePrefix(entry, entry.emitted, width).length !== rendered.length) return;
			entry.state = "committed";
			entry.emitted = 0;
			this.#frontier++;
		}
	}

	#startReplay(): void {
		const head = this.#entries[this.#frontier];
		this.#replayPending = this.#frontier > 0 || (head?.mode === "appendOnly" && head.emitted > 0);
		this.#replayRequested = false;
	}
	override renderTargeted(width: number, targets: readonly Component[]): readonly string[] {
		width = Math.max(1, width);
		this.#syncVirtualEntries(width);
		if (
			targets.length === 0 ||
			targets.includes(this) ||
			this.#virtualEntries.some(entry => entry.contribution === undefined)
		) {
			return this.render(width);
		}
		let changedFrom = this.#virtualEntries.length;
		const measured = new Set<Component>();
		for (const target of targets) {
			const owner = this.children.find(child => componentContains(child, target));
			if (!owner || measured.has(owner)) continue;
			measured.add(owner);
			const index = this.children.indexOf(owner);
			if (index < 0) return this.render(width);
			if (this.#measureVirtualEntry(index, width)) changedFrom = Math.min(changedFrom, index);
		}
		if (measured.size === 0) return this.render(width);
		if (changedFrom < this.#virtualEntries.length) this.#rebuildVirtualRows(changedFrom);
		return this.#renderVirtualRows(0, this.#virtualTotalRows);
	}

	override hasVirtualViewport(): boolean {
		return true;
	}

	override getEstimatedVirtualRows(width: number): number {
		this.#syncVirtualEntries(Math.max(1, width));
		return this.#virtualTotalRows;
	}

	override renderVirtualViewport(width: number, request: VirtualViewportRequest): VirtualViewportFrame {
		return this.#renderVirtualViewport(width, request);
	}

	override renderVirtualViewportTargeted(
		width: number,
		request: VirtualViewportRequest,
		targets: readonly Component[],
	): VirtualViewportFrame {
		const targeted = new Set<number>();
		for (const target of targets) {
			if (target === this) return this.#renderVirtualViewport(width, request);
			const ownerIndex = this.children.findIndex(child => componentContains(child, target));
			if (ownerIndex < 0) return this.#renderVirtualViewport(width, request);
			targeted.add(ownerIndex);
		}
		return this.#renderVirtualViewport(width, request, targeted);
	}

	override renderViewportTail(width: number, maxRows: number): readonly string[] {
		return this.#renderVirtualViewport(width, {
			rows: Math.max(0, Math.trunc(maxRows)),
			offset: 0,
			followBottom: true,
		}).lines;
	}

	/** Direct transcript blocks intersecting an inclusive estimated virtual row range. */
	getVirtualBlocksInRowRange(width: number, startRow: number, endRow: number): readonly Component[] {
		this.#syncVirtualEntries(Math.max(1, width));
		const start = Math.max(0, Math.trunc(startRow));
		const end = Math.max(start, Math.trunc(endRow));
		const blocks: Component[] = [];
		let index = this.#findVirtualEntry(start);
		while (index >= 0 && index < this.#virtualEntries.length) {
			const entry = this.#virtualEntries[index]!;
			if (entry.startRow > end) break;
			const contentStart = entry.startRow + entry.sep;
			const contentEnd = entry.startRow + entry.rowCount - 1;
			if (entry.rowCount > entry.sep && contentStart <= end && contentEnd >= start) blocks.push(entry.component);
			index++;
		}
		return blocks;
	}

	override getVirtualTextSelectionInset(width: number, row: number): number {
		return this.#getVirtualTextSelectionInset(width, row, false);
	}

	override getVirtualTextSelectionRightInset(width: number, row: number): number {
		return this.#getVirtualTextSelectionInset(width, row, true);
	}

	override getVirtualTextSelection(width: number, selection: TextSelectionRange): string | undefined {
		this.#syncVirtualEntries(Math.max(1, width));
		const normalized = normalizeTextSelection(selection);
		if (normalized.start.row < 0 || normalized.end.row >= this.#virtualTotalRows) return undefined;
		let text = "";
		let selected = false;
		const append = (part: string): void => {
			if (selected) text += "\n";
			text += part;
			selected = true;
		};
		let index = this.#findVirtualEntry(normalized.start.row);
		while (index >= 0 && index < this.#virtualEntries.length) {
			const entry = this.#virtualEntries[index]!;
			if (entry.startRow > normalized.end.row) break;
			const entryEnd = entry.startRow + entry.rowCount - 1;
			const contentStart = entry.startRow + entry.sep;
			if (entry.sep > 0 && normalized.start.row <= entry.startRow && normalized.end.row >= entry.startRow) {
				append("");
			}
			const overlapStart = Math.max(normalized.start.row, contentStart);
			const overlapEnd = Math.min(normalized.end.row, entryEnd);
			if (overlapStart <= overlapEnd) {
				const raw = entry.rawRef;
				if (!raw) return undefined;
				let leadingBlankRows = 0;
				while (leadingBlankRows < raw.length && isPlainBlank(raw[leadingBlankRows]!)) leadingBlankRows++;
				const part = extractComponentTextSelection(entry.component, raw, {
					start: {
						row: leadingBlankRows + overlapStart - contentStart,
						col: overlapStart === normalized.start.row ? normalized.start.col : 0,
					},
					end: {
						row: leadingBlankRows + overlapEnd - contentStart,
						col: overlapEnd === normalized.end.row ? normalized.end.col : Number.MAX_SAFE_INTEGER,
					},
				});
				if (part === undefined) return undefined;
				append(part);
			}
			index++;
		}
		return selected ? text : undefined;
	}

	#getVirtualTextSelectionInset(width: number, row: number, right: boolean): number {
		this.#syncVirtualEntries(Math.max(1, width));
		const targetRow = Math.trunc(row);
		if (targetRow < 0 || targetRow >= this.#virtualTotalRows) return 0;
		const entry = this.#virtualEntries[this.#findVirtualEntry(targetRow)];
		if (!entry?.rawRef) return 0;
		const contentStart = entry.startRow + entry.sep;
		if (targetRow < contentStart) return 0;
		let leadingBlankRows = 0;
		while (leadingBlankRows < entry.rawRef.length && isPlainBlank(entry.rawRef[leadingBlankRows]!)) {
			leadingBlankRows++;
		}
		const componentRow = leadingBlankRows + targetRow - contentStart;
		return right
			? (entry.component.getTextSelectionRightInset?.(componentRow) ?? 0)
			: (entry.component.getTextSelectionInset?.(componentRow) ?? 0);
	}
	#renderVirtualViewport(
		width: number,
		request: VirtualViewportRequest,
		targeted?: ReadonlySet<number>,
	): VirtualViewportFrame {
		width = Math.max(1, width);
		const rows = Math.max(0, Math.trunc(request.rows));
		this.#syncVirtualEntries(width);
		if (!request.followBottom && this.#virtualWarmup) this.#cancelVirtualWarmup();

		let totalRows = this.#virtualTotalRows;
		let offset = request.followBottom
			? Math.max(0, totalRows - rows)
			: Math.max(0, Math.min(Math.trunc(request.offset), Math.max(0, totalRows - rows)));
		const anchorIndex = request.followBottom ? -1 : this.#findVirtualEntry(offset);
		const anchorIntraRow =
			anchorIndex < 0 ? 0 : Math.max(0, offset - (this.#virtualEntries[anchorIndex]?.startRow ?? 0));
		const measured = new Set<number>();

		if (targeted) {
			let changedFrom = this.#virtualEntries.length;
			for (const index of targeted) {
				measured.add(index);
				if (this.#measureVirtualEntry(index, width, true)) changedFrom = Math.min(changedFrom, index);
			}
			if (changedFrom < this.#virtualEntries.length) {
				this.#rebuildVirtualRows(changedFrom);
				totalRows = this.#virtualTotalRows;
				if (request.followBottom) {
					offset = Math.max(0, totalRows - rows);
				} else if (anchorIndex >= 0) {
					const anchor = this.#virtualEntries[anchorIndex];
					const anchored = anchor
						? anchor.startRow + Math.min(anchorIntraRow, Math.max(0, anchor.rowCount - 1))
						: offset;
					offset = Math.max(0, Math.min(anchored, Math.max(0, totalRows - rows)));
				}
			}
		}

		if (rows === 0 || totalRows === 0) {
			this.#visibleVirtualEntries.clear();
			if (request.followBottom) void this.warmVirtualViewport(width);
			return { lines: EMPTY_ROWS, estimatedTotalRows: totalRows, offset: 0 };
		}

		while (totalRows > 0) {
			const firstVisible = this.#findVirtualEntry(offset);
			const lastVisible = this.#findVirtualEntry(Math.min(totalRows - 1, offset + rows - 1));
			if (firstVisible < 0 || lastVisible < 0) break;
			const first = Math.max(0, firstVisible - VIRTUAL_OVERSCAN_BLOCKS);
			const last = Math.min(this.#virtualEntries.length - 1, lastVisible + VIRTUAL_OVERSCAN_BLOCKS);
			let changedFrom = this.#virtualEntries.length;
			for (let index = first; index <= last; index++) {
				if (measured.has(index)) continue;
				measured.add(index);
				if (targeted && !targeted.has(index) && this.#virtualEntries[index]?.contribution !== undefined) continue;
				if (this.#measureVirtualEntry(index, width)) changedFrom = Math.min(changedFrom, index);
			}
			if (!this.#virtualEstimateSeeded && this.#calibrateVirtualEstimates(measured)) changedFrom = 0;
			if (changedFrom === this.#virtualEntries.length) break;
			this.#rebuildVirtualRows(changedFrom);
			totalRows = this.#virtualTotalRows;
			if (request.followBottom) {
				offset = Math.max(0, totalRows - rows);
			} else if (anchorIndex >= 0) {
				const anchor = this.#virtualEntries[anchorIndex];
				const anchored = anchor
					? anchor.startRow + Math.min(anchorIntraRow, Math.max(0, anchor.rowCount - 1))
					: offset;
				offset = Math.max(0, Math.min(anchored, Math.max(0, totalRows - rows)));
			}
		}

		const lines = this.#renderVirtualRows(offset, rows);
		this.#visibleVirtualEntries.clear();
		const finalFirst = this.#findVirtualEntry(offset);
		const finalLast = this.#findVirtualEntry(Math.min(this.#virtualTotalRows - 1, offset + rows - 1));
		for (let index = finalFirst; index >= 0 && index <= finalLast; index++) {
			const entry = this.#virtualEntries[index];
			if (entry) this.#visibleVirtualEntries.add(entry);
		}
		const frame = {
			lines,
			estimatedTotalRows: this.#virtualTotalRows,
			offset,
		};
		if (request.followBottom) void this.warmVirtualViewport(width);
		return frame;
	}

	#cancelVirtualWarmup(): void {
		this.#virtualWarmupToken++;
		this.#virtualWarmup = undefined;
		this.#virtualExact = false;
	}

	#virtualWarmupIsCurrent(warmup: VirtualWarmup): boolean {
		return (
			this.#virtualWarmupToken === warmup.token &&
			this.#virtualEntries === warmup.entries &&
			this.#generation === warmup.generation &&
			this.#expanded === warmup.expanded &&
			this.#virtualWidth === warmup.width
		);
	}

	async #runVirtualWarmup(warmup: VirtualWarmup): Promise<void> {
		const measurements = new Array<VirtualWarmMeasurement | undefined>(warmup.entries.length);
		let index = 0;
		while (index < warmup.entries.length) {
			if (!this.#virtualWarmupIsCurrent(warmup)) return;
			const chunkStartedAt = performance.now();
			let chunkEntries = 0;
			while (
				index < warmup.entries.length &&
				chunkEntries < VIRTUAL_WARMUP_CHUNK_ENTRIES &&
				performance.now() - chunkStartedAt < VIRTUAL_WARMUP_CHUNK_MS
			) {
				const entry = warmup.entries[index]!;
				this.#applyPresentationState(entry.component);
				const currentVersion = getBlockVersion(entry.component);
				let raw = entry.rawRef;
				let contribution = entry.contribution;
				if (
					raw === undefined ||
					contribution === undefined ||
					entry.measuredWidth !== warmup.width ||
					entry.measuredGeneration !== warmup.generation ||
					entry.measuredVersion !== currentVersion ||
					!isBlockFinalized(entry.component)
				) {
					this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
					raw = entry.component.render(warmup.width);
					contribution = trimBlankEdges(raw);
				}
				measurements[index] = {
					entry,
					raw,
					contribution,
					version: getBlockVersion(entry.component),
				};
				index++;
				chunkEntries++;
			}
			if (index < warmup.entries.length) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setImmediate(resolve);
				await promise;
			}
		}
		if (!this.#virtualWarmupIsCurrent(warmup)) return;

		let bodyRows = 0;
		let visibleEntries = 0;
		for (let measurementIndex = 0; measurementIndex < measurements.length; measurementIndex++) {
			const measurement = measurements[measurementIndex];
			if (
				!measurement ||
				warmup.entries[measurementIndex] !== measurement.entry ||
				!isBlockFinalized(measurement.entry.component) ||
				getBlockVersion(measurement.entry.component) !== measurement.version
			) {
				return;
			}
			bodyRows += measurement.contribution.length;
			if (measurement.contribution.length > 0) visibleEntries++;
		}

		const exactEntries = new Set<VirtualBlockExtent>();
		for (const measurement of measurements) {
			if (!measurement) return;
			const entry = measurement.entry;
			entry.rawRef = measurement.raw;
			entry.contribution = measurement.contribution;
			entry.estimatedBodyRows = measurement.contribution.length;
			entry.measuredWidth = warmup.width;
			entry.measuredGeneration = warmup.generation;
			entry.measuredVersion = measurement.version;
			exactEntries.add(entry);
		}
		this.#measuredVirtualEntries = exactEntries;
		this.#virtualEstimatedBodyRows = visibleEntries > 0 ? Math.max(1, Math.round(bodyRows / visibleEntries)) : 1;
		this.#virtualEstimateSeeded = true;
		this.#rebuildVirtualRows(0);
		this.#virtualExact = true;
	}

	#syncVirtualEntries(width: number): void {
		const structureChanged = this.#syncVirtualStructure();
		const widthChanged = this.#virtualWidth !== width;
		if (widthChanged && (this.#virtualWarmup || this.#virtualExact)) this.#cancelVirtualWarmup();
		const epochChanged = widthChanged || this.#virtualGeneration !== this.#generation;
		let measurementsCleared = false;
		if (epochChanged) {
			measurementsCleared = this.#measuredVirtualEntries.size > 0;
			for (const entry of this.#measuredVirtualEntries) {
				if (entry.contribution !== undefined) entry.estimatedBodyRows = entry.contribution.length;
				entry.contribution = undefined;
				entry.rawRef = undefined;
			}
			this.#measuredVirtualEntries.clear();
			this.#virtualWidth = width;
			this.#virtualGeneration = this.#generation;
			if (widthChanged) this.#virtualEstimateSeeded = false;
		}
		if (
			measurementsCleared ||
			(!structureChanged && this.#virtualEntries.length === 0 && this.#virtualTotalRows !== 0)
		) {
			this.#rebuildVirtualRows(0);
		}
	}

	#syncVirtualStructure(): boolean {
		const children = this.children;
		const entries = this.#virtualEntries;
		const structureChanged = this.#virtualStructureDirty || entries.length !== children.length;
		if (!structureChanged) return false;
		if (this.#virtualWarmup || this.#virtualExact) this.#cancelVirtualWarmup();

		const previous = new Map(entries.map(entry => [entry.component, entry]));
		const next = children.map(component => {
			const retained = previous.get(component);
			if (retained) return retained;
			return {
				component,
				rawRef: undefined,
				contribution: undefined,
				estimatedBodyRows: this.#virtualEstimatedBodyRows,
				measuredWidth: -1,
				measuredGeneration: -1,
				measuredVersion: undefined,
				startRow: 0,
				rowCount: 0,
				sep: 0,
			};
		});
		this.#virtualEntries = next;
		this.#virtualStructureDirty = false;
		if (this.#measuredVirtualEntries.size > 0) {
			const retained = new Set(next);
			for (const entry of this.#measuredVirtualEntries) {
				if (!retained.has(entry)) this.#measuredVirtualEntries.delete(entry);
			}
		}
		this.#rebuildVirtualRows(0);
		return true;
	}

	#measureVirtualEntry(index: number, width: number, force = false): boolean {
		const entry = this.#virtualEntries[index];
		if (!entry) return false;
		this.#applyPresentationState(entry.component);
		const currentVersion = getBlockVersion(entry.component);
		if (
			!force &&
			entry.contribution !== undefined &&
			entry.rawRef !== undefined &&
			entry.measuredWidth === width &&
			entry.measuredGeneration === this.#generation &&
			entry.measuredVersion === currentVersion &&
			(isBlockExplicitlyFinalized(entry.component) || (this.#virtualExact && isBlockFinalized(entry.component)))
		) {
			return false;
		}
		const previousRows = entry.contribution?.length ?? entry.estimatedBodyRows;
		this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
		const raw = entry.component.render(width);
		const contribution = trimBlankEdges(raw);
		this.#recordVirtualMeasurement(index, width, raw, contribution);
		return contribution.length !== previousRows;
	}

	#recordVirtualMeasurement(
		index: number,
		width: number,
		raw: readonly string[],
		contribution: readonly string[],
	): void {
		const entry = this.#virtualEntries[index];
		if (!entry) return;
		entry.rawRef = raw;
		entry.contribution = contribution;
		entry.estimatedBodyRows = contribution.length;
		entry.measuredWidth = width;
		entry.measuredGeneration = this.#generation;
		entry.measuredVersion = getBlockVersion(entry.component);
		this.#measuredVirtualEntries.add(entry);
	}

	#calibrateVirtualEstimates(measured: ReadonlySet<number>): boolean {
		const samples: number[] = [];
		for (const index of measured) {
			const rows = this.#virtualEntries[index]?.contribution?.length;
			if (rows !== undefined && rows > 0) samples.push(rows);
		}
		this.#virtualEstimateSeeded = true;
		if (samples.length === 0) return false;
		const total = samples.reduce((sum, rows) => sum + rows, 0);
		const estimate = Math.max(1, Math.round(total / samples.length));
		this.#virtualEstimatedBodyRows = estimate;
		let changed = false;
		for (const entry of this.#virtualEntries) {
			if (entry.contribution !== undefined || entry.estimatedBodyRows === estimate) continue;
			entry.estimatedBodyRows = estimate;
			changed = true;
		}
		return changed;
	}

	#rebuildVirtualRows(startIndex: number): void {
		const entries = this.#virtualEntries;
		const start = Math.max(0, Math.min(Math.trunc(startIndex), entries.length));
		let row = start === 0 ? 0 : (entries[start - 1]?.startRow ?? 0) + (entries[start - 1]?.rowCount ?? 0);
		let hasVisible = row > 0;
		for (let index = start; index < entries.length; index++) {
			const entry = entries[index]!;
			const bodyRows = entry.contribution?.length ?? entry.estimatedBodyRows;
			entry.startRow = row;
			entry.sep = bodyRows > 0 && hasVisible ? 1 : 0;
			entry.rowCount = entry.sep + bodyRows;
			row += entry.rowCount;
			if (bodyRows > 0) hasVisible = true;
		}
		this.#virtualTotalRows = row;
	}

	#findVirtualEntry(row: number): number {
		let low = 0;
		let high = this.#virtualEntries.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			const entry = this.#virtualEntries[middle]!;
			if (entry.startRow + entry.rowCount <= row) low = middle + 1;
			else high = middle;
		}
		return low < this.#virtualEntries.length ? low : -1;
	}

	#renderVirtualRows(offset: number, rows: number): readonly string[] {
		const end = Math.min(this.#virtualTotalRows, offset + rows);
		const lines: string[] = [];
		let index = this.#findVirtualEntry(offset);
		while (index >= 0 && index < this.#virtualEntries.length && lines.length < rows) {
			const entry = this.#virtualEntries[index]!;
			if (entry.startRow >= end) break;
			const from = Math.max(offset, entry.startRow);
			const to = Math.min(end, entry.startRow + entry.rowCount);
			for (let row = from; row < to; row++) {
				const local = row - entry.startRow;
				lines.push(local < entry.sep ? "" : (entry.contribution?.[local - entry.sep] ?? ""));
			}
			index++;
		}
		return lines;
	}

	#renderEmergency(
		shown: readonly { entry: TranscriptEntry; index: number }[],
		width: number,
		rows: number,
		frame: AnimationFrame,
	): readonly string[] {
		let visibleRows = rows;
		let visible: { entry: TranscriptEntry; index: number }[] = [];
		let emergencyCandidate: { entry: TranscriptEntry; index: number } | undefined;
		let emergencyRow: string | undefined;
		let hiddenActive = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			visible = visibleRows > 0 ? shown.slice(-visibleRows) : [];
			emergencyCandidate = undefined;
			emergencyRow = undefined;
			const visibleStart = shown.length - visibleRows;
			for (let index = visibleStart - 1; index >= 0; index--) {
				const candidate = shown[index]!;
				const block = candidate.entry.component as Component & FinalizableBlock;
				const row =
					candidate.entry.state === "settled" ? block.renderTranscriptBlockEmergencyRow?.(width) : undefined;
				if (row === undefined) continue;
				emergencyCandidate = candidate;
				emergencyRow = row;
				visible = [candidate, ...visible.slice(1)];
				break;
			}

			let activeTotal = 0;
			for (const candidate of shown) {
				if (candidate.entry.state === "active") activeTotal++;
			}
			hiddenActive = activeTotal;
			for (const candidate of visible) {
				if (candidate.entry.state === "active") hiddenActive--;
			}
			// The summary row itself represents the newest active block when no
			// active row fits beside it; report only the additional backlog.
			if (hiddenActive === activeTotal && hiddenActive > 0) hiddenActive--;
			if (attempt === 0 && hiddenActive > 0) {
				visibleRows = Math.max(0, rows - 1);
				continue;
			}
			break;
		}

		const output = hiddenActive > 0 ? [`${hiddenActive} more transcript blocks active`] : [];
		for (const candidate of visible) {
			if (candidate === emergencyCandidate) {
				output.push(emergencyRow ?? "");
				continue;
			}
			this.#applyPresentationState(candidate.entry.component);
			this.#setAllocation(candidate.entry.component, 1, frame);
			const rendered = this.#renderEntry(candidate.entry, width).slice(
				this.#projectedEmitted(candidate.entry, candidate.index, width),
			);
			output.push(rendered[0] ?? "");
		}
		return output.slice(0, rows);
	}

	#projectedEmitted(entry: TranscriptEntry, index: number, width: number): number {
		const offered = this.#offered;
		const count = offered?.kind === "append" && offered.entry === index ? offered.emittedEnd : entry.emitted;
		return this.#renderStablePrefix(entry, count, width).length;
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	#applyPresentationState(component: Component): void {
		setBlockExpanded(component, this.#expanded);
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
	}

	#settleFinalized(): void {
		for (const entry of this.#entries) {
			if (entry.state === "active" && canRetire(entry.component)) entry.state = "settled";
		}
	}

	#liveEntries(): Array<{ entry: TranscriptEntry; index: number }> {
		const start = this.#offered?.kind === "commit" ? this.#offered.end : this.#frontier;
		const live: Array<{ entry: TranscriptEntry; index: number }> = [];
		for (let index = start; index < this.#entries.length; index++) live.push({ entry: this.#entries[index]!, index });
		return live;
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(
			component =>
				existing.get(component) ?? {
					component,
					state: "active",
					mode: blockMode(component),
					stableRows: EMPTY_STABLE_ROWS,
					renderedStableByWidth: new Map(),
					emitted: 0,
					stableFrozen: false,
				},
		);
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one conservative mutable semantic transcript block. */
export class TranscriptBlock extends Container {}
