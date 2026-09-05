import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import {
	TranscriptContainer,
	type TranscriptStableRow,
} from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { highlightCode, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Container } from "@oh-my-pi/pi-tui";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;
	allocations: number[] = [];

	constructor(rows: string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(rows: string[]): void {
		this.#rows = rows;
		this.#finalized = true;
	}

	update(rows: string[]): void {
		this.#rows = rows;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.allocations.push(rows);
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

/** A live block the container recognizes as dynamic tool-activity. */
class ToolBlock extends Block {
	setToolActivityVisible(): void {}
}

function literalStableRow(row: string): TranscriptStableRow {
	return { key: row };
}

class AppendBlock extends Block {
	readonly transcriptBlockMode = "appendOnly" as const;
	#stable: readonly TranscriptStableRow[];
	#stableRender: readonly string[];

	constructor(rows: string[], stable: readonly string[], finalized = false) {
		super(rows, finalized);
		this.#stable = stable.map(literalStableRow);
		this.#stableRender = stable;
	}

	publish(rows: readonly string[]): void {
		this.#stable = rows.map(literalStableRow);
		this.#stableRender = rows;
	}

	publishStable(rows: readonly TranscriptStableRow[], rendered: readonly string[]): void {
		this.#stable = rows;
		this.#stableRender = rendered;
	}

	/** Change the block's full render without finalizing (e.g. hiding thinking). */
	revise(rows: string[]): void {
		this.finalize(rows);
	}

	resetTranscriptStableRows(): void {
		this.#stable = [];
		this.#stableRender = [];
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#stable;
	}

	renderTranscriptStableRows(count: number, _width: number): readonly string[] {
		return this.#stableRender.slice(0, count);
	}
}

class ReflowingAppendBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	#finalized = false;
	readonly #stable: TranscriptStableRow = { key: "abcdefgh" };

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return [this.#stable];
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (count <= 0) return [];
		const rows: string[] = [];
		for (let offset = 0; offset < 8; offset += width) rows.push("abcdefgh".slice(offset, offset + width));
		return rows;
	}

	render(width: number): readonly string[] {
		return [...this.renderTranscriptStableRows(1, width), this.#finalized ? "final" : "partial"];
	}
}
const finalAnswer: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "Reasoning first" },
		{ type: "text", text: "## Implemented" },
	],
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.6-sol",
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 1,
};

class ReplacementBlock extends Block {
	isTranscriptBlockAppendOnly(): boolean {
		return false;
	}
}

class CountingFinalizedBlock implements Component {
	renderCount = 0;
	measureCount = 0;

	constructor(readonly rows: readonly string[]) {}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}
	measureRows(): number {
		this.measureCount++;
		return this.rows.length;
	}

	render(): readonly string[] {
		this.renderCount++;
		return this.rows;
	}
}

class HighlightedFinalizedBlock implements Component {
	coloredMeasureCount = 0;
	measureCount = 0;
	readonly #code: string;

	constructor(index: number) {
		this.#code = Array.from(
			{ length: 40 },
			(_value, line) => `def unique_${index}_${line}(value: int) -> int: return value * ${index + line}`,
		).join("\n");
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	measureRows(width: number): number {
		this.measureCount++;
		const highlighted = highlightCode(`${this.#code}\n# width ${width}`, "python");
		if (highlighted.some(line => line.includes("\x1b["))) this.coloredMeasureCount++;
		return highlighted.length;
	}

	render(width: number): readonly string[] {
		return highlightCode(`${this.#code}\n# width ${width}`, "python");
	}
}
const frame = { tick: 0, now: 0 };

describe("TranscriptContainer", () => {
	it("captures mutable by default and append-only declarations permanently", () => {
		const transcript = new TranscriptContainer();
		const mutable = new Block(["mutable"], false) as Block & {
			transcriptBlockMode?: "appendOnly";
			getTranscriptStableRows?: () => readonly TranscriptStableRow[];
		};
		transcript.addChild(mutable);
		mutable.transcriptBlockMode = "appendOnly";
		mutable.getTranscriptStableRows = () => [literalStableRow("mutable")];
		transcript.addChild(new AppendBlock(["stable", "partial"], ["stable"]));

		expect(transcript.blockModes()).toEqual(["mutable", "appendOnly"]);
	});

	it("freezes a retracting publication and keeps rendering the block", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		// Retraction cannot be honored (rows may already sit in scrollback):
		// the block demotes to finalize-time retirement but never fails a render.
		block.publish(["changed"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);
		expect(transcript.blockModes()).toEqual(["appendOnly"]);
	});

	it("freezes drifted stable bytes, keeps the emitted slice, and retires the remainder once", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		expect(emitted.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);

		// Published bytes drift (e.g. a mid-stream theme change): the emitted
		// slice stays retired, the live tail keeps rendering, and no further
		// mid-stream row is offered.
		block.publishStable([literalStableRow("one"), literalStableRow("two")], ["one", "changed physical row"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["two"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		// Finalization retires exactly the un-emitted suffix.
		block.finalize(["one", "two"]);
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["two", ""]);
	});

	it("emits only the stable current head under row pressure", () => {
		const transcript = new TranscriptContainer();
		const head = new Block(["mutable head"], false);
		const later = new AppendBlock(["later stable", "later partial"], ["later stable"]);
		transcript.addChild(head);
		transcript.addChild(later);

		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();

		head.finalize(["mutable head"]);
		const retired = transcript.peekFinalizedBatch(80, 1);
		expect(retired?.rows).toEqual(["mutable head", ""]);
		transcript.acknowledgeFinalizedBatch(retired!.id);

		const emitted = transcript.peekFinalizedBatch(80, 1);
		expect(emitted?.rows).toEqual(["later stable"]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["later partial"]);
	});

	it("retires only the un-emitted final suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two", "partial"], ["one", "two"]);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 2)!;
		expect(first.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		const second = transcript.peekFinalizedBatch(80, 1)!;
		expect(second.rows).toEqual(["two"]);
		transcript.acknowledgeFinalizedBatch(second.id);

		block.finalize(["one", "two", "final"]);
		const suffix = transcript.peekFinalizedBatch(80, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("advances a fully emitted finalized head without a physical write", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["complete"], ["complete"]);
		transcript.addChild(block);
		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(emitted.id);

		block.finalize(["complete"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["committed"]);
	});

	it("replays and retires semantic stable rows after they reflow at a new width", () => {
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);

		const emitted = transcript.peekFinalizedBatch(4, 2)!;
		expect(emitted.rows).toEqual(["abcd", "efgh"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);
		expect(transcript.renderViewport(8, 1, frame)).toEqual(["partial"]);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(8)!;
		expect(replay.rows).toEqual(["abcdefgh"]);
		transcript.acknowledgeFinalizedBatch(replay.id);

		block.finalize();
		const suffix = transcript.peekFinalizedBatch(8, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("drops emitted stable rows on reset so a replay honors a hidden presentation (#10177)", () => {
		const transcript = new TranscriptContainer();
		// A thinking block whose reasoning prefix streams into scrollback ahead of
		// its answer while the whole block is still the live frontier head.
		const block = new AppendBlock(["reasoning one", "reasoning two", "answer"], ["reasoning one", "reasoning two"]);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 1)!;
		expect(first.rows).toEqual(["reasoning one"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		const second = transcript.peekFinalizedBatch(80, 1)!;
		expect(second.rows).toEqual(["reasoning two"]);
		transcript.acknowledgeFinalizedBatch(second.id);
		expect(transcript.emittedStableRows()).toEqual([2]);

		// Ctrl+T hides thinking: the block now renders only its answer and drops
		// its published reasoning snapshots. resetStableEmission forgets the
		// emitted prefix so the paired destructive replay does not resurrect the
		// captured reasoning that visibly streamed into scrollback.
		block.revise(["answer"]);
		transcript.resetStableEmission();
		expect(transcript.emittedStableRows()).toEqual([0]);

		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
		expect(transcript.renderViewport(80, 5, frame)).toEqual(["answer"]);
	});

	beforeAll(async () => {
		await initTheme(false);
	});

	it("keeps settled blocks live while the viewport has room", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["streaming"], false));

		// Both fit: nothing retires, the settled block still renders live.
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["settled", "", "streaming"]);
	});

	it("keeps finalized replacement blocks mutable under retirement pressure", () => {
		const transcript = new TranscriptContainer();
		const replacement = new ReplacementBlock(["initial"], true);
		transcript.addChild(replacement);

		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["active"]);

		replacement.finalize(["replaced"]);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["replaced"]);
	});

	it("retires the settled prefix only under capacity pressure, in order", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first final"], true);
		const second = new Block(["second live", "row", "row"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		// 5 rows fit everything (1 + separator + 3).
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		// 3 rows force the settled prefix out.
		expect(transcript.peekFinalizedBatch(80, 3)?.rows).toEqual(["first final", ""]);
	});

	it("never retires a finalized successor past an active predecessor", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["active live"], false);
		const settled = new Block(["settled final"], true);
		transcript.addChild(active);
		transcript.addChild(settled);

		// Pressure exists but the prefix starts with an active block: no batch,
		// and both blocks still render (clipped by the viewport).
		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active live", "", "settled final"]);

		active.finalize(["active final"]);
		// Capacity 1 fits the remaining settled block, so only the first retires.
		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["active final", ""]);
	});

	it("reoffers an unacknowledged batch and retires it exactly once", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final one"], true));
		transcript.addChild(new Block(["final two"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		const second = transcript.peekFinalizedBatch(80, 50);

		expect(second).toEqual(first);
		if (first === undefined) throw new Error("expected a batch under zero capacity");
		transcript.acknowledgeFinalizedBatch(first.id);
		// Committed blocks leave the live tail and never render again.
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
	});

	it("excludes an offered batch from the live viewport in the same frame", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old settled"], true));
		transcript.addChild(new Block(["fresh live"], false));

		const batch = transcript.peekFinalizedBatch(80, 1);
		expect(batch?.rows).toEqual(["old settled", ""]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["fresh live"]);
	});

	it("assigns one row per live block until pressure requires aggregation", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"], false));
		transcript.addChild(new Block(["second"], false));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["first", "second"]);
		expect(transcript.canAdmit(2)).toBe(false);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["1 more transcript blocks active"]);
	});
	it("does not report settled resume backlog as active", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled one"], true));
		transcript.addChild(new Block(["settled two"], true));
		transcript.addChild(new Block(["current tool"], false));

		// The welcome header can consume the first history offer, leaving the
		// settled transcript prefix live for one frame while it drains next.
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["current tool"]);
	});
	it("excludes empty blocks so pressure never emits blank rows (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		// Text blocks interleaved with empty (hidden tool-activity) blocks that
		// render nothing but stay live until retired.
		for (let i = 0; i < 6; i++) {
			transcript.addChild(new Block([`t${i}a`, `t${i}b`, `t${i}c`], true));
			for (let j = 0; j < 8; j++) transcript.addChild(new Block([], true));
		}
		// Emergency path: more non-empty blocks than rows. Every row carries real
		// text — no block's tail is dropped as blank padding.
		const out = transcript.renderViewport(80, 12, frame);
		expect(out).toHaveLength(12);
		expect(out.every(row => /\S/.test(row))).toBe(true);
	});

	it("empty blocks do not reserve capacity from real text under pressure (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["A1", "A2", "A3", "A4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["B1", "B2", "B3", "B4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["C1", "C2", "C3", "C4"], true));
		// Capacity 10 fits all real content once the two empty blocks stop
		// stealing a base row each; the older block keeps its tail rows.
		const out = transcript.renderViewport(80, 10, frame);
		expect(out).toEqual(["A3", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4"]);
	});

	it("keeps a completed assistant answer visible behind an active prefix", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stale active"], false));
		transcript.addChild(new AssistantMessageComponent(finalAnswer));
		transcript.addChild(new Block(["continued turn"], false));
		transcript.addChild(new Block(["task running"], false));

		expect(transcript.peekFinalizedBatch(80, 3)).toBeUndefined();
		const rows = transcript.renderViewport(80, 3, frame);
		expect(rows[0]).toBe("2 more transcript blocks active");
		expect(Bun.stripANSI(rows[1] ?? "").trim()).toBe("Implemented");
		expect(rows[2]).toBe("task running");
	});

	it("gives surplus rows to assistant text before a growing tool card (issue 9718)", () => {
		const transcript = new TranscriptContainer();
		const assistant = new Block(["A1", "A2", "A3", "A4"], false);
		const tool = new ToolBlock(["T1", "T2", "T3", "T4"], false);
		transcript.addChild(assistant);
		transcript.addChild(tool);
		// Capacity 5 cannot fit both blocks in full. Surplus (3 rows) goes to the
		// assistant block first; the tool card collapses to its one-row minimum
		// instead of clipping already-visible assistant text.
		const out = transcript.renderViewport(80, 5, frame);
		expect(out).toEqual(["A1", "A2", "A3", "A4", "T4"]);
		expect(assistant.allocations.at(-1)).toBe(4);
		expect(tool.allocations.at(-1)).toBe(1);
	});

	it("permits removing settled blocks until they are offered or committed", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled snapshot"], true);
		const live = new Block(["live", "live", "live"], false);
		transcript.addChild(settled);
		transcript.addChild(live);

		// Settled but still in the mutable viewport: removable without a trace,
		// so a follow-up displaceable snapshot can retract it.
		expect(transcript.canRemoveBlock(settled)).toBe(true);

		// Offered to the terminal: mid-write, no longer removable.
		const batch = transcript.peekFinalizedBatch(80, 2);
		expect(batch?.rows).toEqual(["settled snapshot", ""]);
		expect(transcript.canRemoveBlock(settled)).toBe(false);

		// Committed: immutable history; removal must be refused outright.
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.canRemoveBlock(settled)).toBe(false);
		transcript.removeChild(settled);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
	});

	it("replays committed history without rewinding lifecycle state", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.blockStates()).toEqual(["committed"]);

		transcript.beginReplay();
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		const replay = transcript.peekFinalizedBatch(80, 10);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
	});

	it("flushes a finalized prefix without viewport pressure", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["fits"], true));

		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["fits", ""]);
	});

	it("keeps the live viewport while an independent replay is offered", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["active"], false));

		transcript.beginReplay();
		expect(transcript.peekFinalizedBatch(80, 10)?.rows).toEqual(["committed", ""]);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active"]);
	});
	it("renders exactly the trailing semantic rows without walking the full ledger", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a1", "a2"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new AppendBlock(["b1", "b2"], ["b1"], true));
		transcript.addChild(new Block(["c1"], false));

		const full = transcript.render(80);
		for (const cap of [1, 3, 4, full.length, full.length + 5]) {
			expect(transcript.renderTail(80, cap)).toEqual(full.slice(-Math.min(cap, full.length)));
		}
		expect(transcript.renderTail(80, 0)).toEqual([]);
	});

	it("cancels a pending replay so shutdown flush emits only un-retired rows", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["tail"], true));

		transcript.beginReplay();
		transcript.cancelReplay();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["tail", ""]);
	});
});

describe("TranscriptContainer virtual viewport", () => {
	it("renders only the visible tail and overscan from estimated history", () => {
		const blocks = Array.from(
			{ length: 10_000 },
			(_value, index) => new CountingFinalizedBlock([`history-${index}`]),
		);
		const transcript = new TranscriptContainer();
		for (const block of blocks) transcript.addChild(block);

		const rendered = transcript.renderVirtualViewport(80, {
			rows: 40,
			offset: 0,
			followBottom: true,
		});

		expect(rendered.lines).toHaveLength(40);
		expect(blocks.reduce((total, block) => total + block.renderCount, 0)).toBeLessThan(40);
	});

	it("keeps the first scrollbar jump stable after calibrating uniform unseen history", () => {
		const blocks = Array.from(
			{ length: 10_000 },
			(_value, index) =>
				new CountingFinalizedBlock(Array.from({ length: 8 }, (_rowValue, row) => `history-${index}-${row}`)),
		);
		const transcript = new TranscriptContainer();
		for (const block of blocks) transcript.addChild(block);
		transcript.prepareVirtualStructure();

		const tail = transcript.renderVirtualViewport(80, {
			rows: 40,
			offset: 0,
			followBottom: true,
		});
		const requestedOffset = Math.floor((tail.estimatedTotalRows - 40) / 2);
		const middle = transcript.renderVirtualViewport(80, {
			rows: 40,
			offset: requestedOffset,
			followBottom: false,
		});
		const requestedProgress = requestedOffset / (tail.estimatedTotalRows - 40);
		const renderedProgress = middle.offset / (middle.estimatedTotalRows - 40);

		expect(tail.estimatedTotalRows).toBe(89_999);
		expect(Math.abs(renderedProgress - requestedProgress)).toBeLessThan(0.001);
		expect(blocks.reduce((total, block) => total + block.renderCount, 0)).toBeLessThan(80);
	});

	it("publishes an exact stable scrollbar range before heterogeneous history is visited", () => {
		const blocks = Array.from(
			{ length: 100 },
			(_value, index) =>
				new CountingFinalizedBlock(
					Array.from({ length: index < 90 ? 8 : 1 }, (_rowValue, row) => `history-${index}-${row}`),
				),
		);
		const transcript = new TranscriptContainer();
		for (const block of blocks) transcript.addChild(block);
		transcript.prepareVirtualStructure();

		const tail = transcript.renderVirtualViewport(80, {
			rows: 10,
			offset: 0,
			followBottom: true,
		});
		const requestedOffset = Math.floor((tail.estimatedTotalRows - 10) / 2);
		const middle = transcript.renderVirtualViewport(80, {
			rows: 10,
			offset: requestedOffset,
			followBottom: false,
		});

		expect(tail.estimatedTotalRows).toBe(829);
		expect(middle.estimatedTotalRows).toBe(tail.estimatedTotalRows);
		expect(middle.offset).toBe(requestedOffset);
		expect(blocks.reduce((total, block) => total + block.measureCount, 0)).toBe(100);
		expect(blocks.reduce((total, block) => total + block.renderCount, 0)).toBeLessThan(40);
	});

	it("keeps background work viewport-bound while following a large transcript tail", async () => {
		const blocks = Array.from(
			{ length: 2_000 },
			(_value, index) =>
				new CountingFinalizedBlock(
					Array.from({ length: (index % 9) + 1 }, (_rowValue, row) => `history-${index}-${row}`),
				),
		);
		const transcript = new TranscriptContainer();
		for (const block of blocks) transcript.addChild(block);

		transcript.renderVirtualViewport(80, { rows: 40, offset: 0, followBottom: true });
		const rendersAfterFrame = blocks.reduce((total, block) => total + block.renderCount, 0);
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;

		expect(blocks.reduce((total, block) => total + block.renderCount, 0)).toBe(rendersAfterFrame);
	});

	it("adopts a prepared large transcript without a cold first-frame rebuild", () => {
		const blocks = Array.from(
			{ length: 100_000 },
			(_value, index) => new CountingFinalizedBlock([`history-${index}`]),
		);
		const staged = new TranscriptContainer();
		for (const block of blocks) staged.addChild(block);
		staged.prepareVirtualStructure();
		const transcript = new TranscriptContainer();
		transcript.adoptContentsFrom(staged);

		const startedAt = performance.now();
		const rendered = transcript.renderVirtualViewport(80, {
			rows: 40,
			offset: 0,
			followBottom: true,
		});
		const frameCost = performance.now() - startedAt;

		expect(staged.children).toHaveLength(0);
		expect(rendered.lines.at(-1)).toBe("history-99999");
		expect(blocks.reduce((total, block) => total + block.renderCount, 0)).toBeLessThan(40);
		expect(frameCost).toBeLessThan(10);
	});

	it("does not add a phantom separator after measuring empty history", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new CountingFinalizedBlock([]));
		transcript.renderVirtualViewport(40, { rows: 5, offset: 0, followBottom: true });

		transcript.addChild(new CountingFinalizedBlock(["first", "second"]));
		const rendered = transcript.renderVirtualViewport(40, {
			rows: 5,
			offset: 0,
			followBottom: true,
		});

		expect(rendered.lines).toEqual(["first", "second"]);
		expect(rendered.estimatedTotalRows).toBe(2);
	});

	it("keeps repeated tail appends within the app-viewport frame budget on large histories", () => {
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 100_000; index++) {
			transcript.addChild(new CountingFinalizedBlock([`history-${index}`]));
		}
		transcript.renderVirtualViewport(80, { rows: 40, offset: 0, followBottom: true });

		const startedAt = performance.now();
		for (let index = 0; index < 25; index++) {
			transcript.addChild(new CountingFinalizedBlock([`live-${index}`]));
			transcript.renderVirtualViewport(80, { rows: 40, offset: 0, followBottom: true });
		}

		expect(performance.now() - startedAt).toBeLessThan(100);
	});

	it("keeps direct and nested targeted animations within the frame budget on large histories", () => {
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 100_000; index++) {
			transcript.addChild(new CountingFinalizedBlock([`history-${index}`]));
		}
		const owner = new Container();
		const active = new Block(["waiting"], false);
		owner.addChild(active);
		transcript.addChild(owner);
		transcript.renderVirtualViewport(80, { rows: 40, offset: 0, followBottom: true });
		expect(transcript.containsComponent(owner)).toBe(true);
		expect(transcript.containsComponent(active)).toBe(true);

		const targets = [owner, active];
		const startedAt = performance.now();
		for (let frame = 0; frame < 100; frame++) {
			transcript.renderVirtualViewportTargeted(80, { rows: 40, offset: 0, followBottom: true }, targets);
		}

		expect(performance.now() - startedAt).toBeLessThan(10);
	});

	it("keeps syntax-highlighted history reflow within the interactive resize budget", async () => {
		await initTheme(false);
		const blocks = Array.from({ length: 100 }, (_value, index) => new HighlightedFinalizedBlock(index));
		const transcript = new TranscriptContainer();
		for (const block of blocks) transcript.addChild(block);
		const initial = transcript.renderVirtualViewport(160, { rows: 40, offset: 0, followBottom: true });
		for (const block of blocks) {
			block.measureCount = 0;
			block.coloredMeasureCount = 0;
		}

		const startedAt = performance.now();
		const resized = transcript.renderVirtualViewport(140, { rows: 40, offset: 0, followBottom: true });
		const resizeCost = performance.now() - startedAt;

		expect(resized.estimatedTotalRows).toBe(initial.estimatedTotalRows);
		expect(blocks.reduce((total, block) => total + block.measureCount, 0)).toBe(100);
		expect(blocks.reduce((total, block) => total + block.coloredMeasureCount, 0)).toBe(0);
		expect(resizeCost).toBeLessThan(50);
	});

	it("remeasures an offscreen targeted stream before the user scrolls back toward it", () => {
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 100; index++) {
			transcript.addChild(new CountingFinalizedBlock([`history-${index}`]));
		}
		const stream = new Block(["stream-0"], false);
		transcript.addChild(stream);
		transcript.renderVirtualViewport(80, { rows: 10, offset: 0, followBottom: true });
		const scrolledUp = transcript.renderVirtualViewport(80, {
			rows: 10,
			offset: 0,
			followBottom: false,
		});

		stream.update(Array.from({ length: 100 }, (_value, index) => `stream-${index}`));
		const updated = transcript.renderVirtualViewportTargeted(
			80,
			{ rows: 10, offset: scrolledUp.offset, followBottom: false },
			[stream],
		);

		expect(updated.offset).toBe(scrolledUp.offset);
		expect(updated.estimatedTotalRows).toBe(scrolledUp.estimatedTotalRows + 99);
	});
});
