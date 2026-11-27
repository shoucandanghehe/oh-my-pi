/**
 * Rewind's terminal look (the `omp.rewind.bar` row): the transcript
 * selectors' screen (`./transcript-view`) headed `↶ Rewind · pick the point
 * to continue from`, the outlined turn boxed in the accent, then the counter
 * and key hints (after the filter field while filtering).
 *
 * A turn with sibling branches splits the rest of the branch into columns,
 * one per branch (the current path first) under a `⑂ n/m · label` head; the
 * column ←/→ moved into has the accent head.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { pickerState, sheetHit } from "@oh-my-pi/pi-tui/term/painters/picker";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { TranscriptRows } from "@oh-my-pi/pi-tui/term/transcript-rows";
import { sliceCells, truncate } from "@oh-my-pi/pi-tui/text/width";
import { expandKeyLabel, keyLabel } from "../../keys/hints";
import { bindingGlyph, selectNavGlyphs, termOf } from "../panels/common";
import { caretField } from "./common";
import { type LaneViewport, type LaneItem, laneRows, transcriptScreen, wheelTranscriptView } from "./transcript-view";

/** The blocks of a turn are built only when its rows are requested. */
export type RewindLookTurn = LaneItem & { readonly id: string };

/** One branch of a fork, drawn as a column. */
export type RewindLookColumn = {
	/** What the head names the branch by (`current` for the current path). */
	readonly label: string;
	/** The column ←/→ moved into. */
	readonly active: boolean;
	readonly turns: readonly RewindLookTurn[];
};

/** The look's term facts. */
export type RewindLookTerm = {
	/** Turns drawn across the whole width. */
	readonly turns: readonly RewindLookTurn[];
	/** Branches diverging after `turns`, side by side; none when the outlined turn has no siblings. */
	readonly columns: readonly RewindLookColumn[];
	/** Shown instead of the turns (a filter matching nothing). */
	readonly empty?: string;
	readonly counter: { readonly t: string; readonly s: string };
	readonly filter?: { readonly text: string; readonly cursor: number };
	/** What ←/→ move between: user turns, or a fork's branches. */
	readonly sideLabel: string;
	/** Older turns are not drawn yet (`a` draws them). */
	readonly truncated: boolean;
	/** Screen rows when the layer allots no height. */
	readonly rows?: number;
	readonly selection: string;
	readonly expanded: boolean;
	setPaintContext(cx: PaintContext): void;
};

/** Cells between branch columns. */
const COLUMN_GAP = 2;
/** Narrowest branch column. */
const MIN_COLUMN = 24;

/** Off-screen turns count as one row until their first paint at this width. */
function virtualLane(
	cx: PaintContext,
	turns: readonly RewindLookTurn[],
	width: number,
	measured: Map<string, number>,
): LaneViewport {
	const active = turns.findIndex(turn => turn.outlined);
	const index = new TranscriptRows(
		turns.map(turn => {
			const height = measured.get(turn.id);
			return turn.outlined ? (height ?? 1) + 2 : height;
		}),
		1,
	);
	return {
		get length() {
			return index.end;
		},
		get outline(): LaneViewport["outline"] {
			return active < 0 ? undefined : [index.start(active), index.start(active + 1)];
		},
		slice(start, end) {
			const first = index.find(start);
			if (first >= turns.length) return [];
			const skip = start - index.start(first);
			const rows: string[] = [];
			for (let i = first; i < turns.length && rows.length < end - start; i++) {
				const turn = turns[i]!;
				const painted = laneRows(cx, [turn], width, "accent").rows;
				index.set(i, painted.length);
				measured.set(turn.id, painted.length - (turn.outlined ? 2 : 0));
				const from = i === first ? skip : 0;
				rows.push(...painted.slice(from, from + end - start - rows.length));
			}
			return rows;
		},
	};
}

/** Only the branch columns intersecting the horizontal window draw their rows. */
function forkRows(
	cx: PaintContext,
	columns: readonly RewindLookColumn[],
	width: number,
	measured: Map<string, number>,
): LaneViewport {
	const theme = cx.theme;
	const count = columns.length;
	const column = Math.max(MIN_COLUMN, Math.floor((width - COLUMN_GAP) / 2));
	const gap = " ".repeat(COLUMN_GAP);
	const activeIndex = columns.findIndex(branch => branch.active);
	const stride = column + COLUMN_GAP;
	const total = count * stride - COLUMN_GAP;
	const offset = Math.max(0, Math.min(activeIndex * stride - Math.floor((width - column) / 2), total - width));
	const first = Math.floor(offset / stride);
	const last = Math.ceil((offset + width) / stride);
	const join = (cells: readonly string[]): string =>
		sliceCells(cells.map(cell => truncate(cell, column, "", true)).join(gap), offset - first * stride, width).text;
	const heads = columns
		.slice(first, last)
		.map(
			(branch, index) =>
				` ${theme.style(branch.active ? "accent" : "dim", `${theme.symbols.icon("branch")} ${first + index + 1}/${count}${theme.symbols.symbol("sep.dot")}${branch.label}`)}`,
		);
	const lanes = columns.map(branch => virtualLane(cx, branch.turns, column, measured));
	const shown = lanes.slice(first, last);
	const header = [join(heads), ""];
	return {
		get length() {
			return header.length + Math.max(...lanes.map(lane => lane.length));
		},
		get outline(): LaneViewport["outline"] {
			const active = lanes[activeIndex]?.outline;
			return active && [active[0] + header.length, active[1] + header.length];
		},
		slice(start, end) {
			const rows = header.slice(start, end);
			const from = Math.max(0, start - header.length);
			const to = end - header.length;
			if (to <= from) return rows;
			const windows = shown.map(lane => lane.slice(from, to));
			const size = Math.min(to - from, Math.max(this.length - header.length - from, 0));
			for (let row = 0; row < size; row++) rows.push(join(windows.map(window => window[row] ?? "")));
			return rows;
		},
	};
}

function paintRewind(node: UiNode, cx: PaintContext): Block {
	const term = termOf<RewindLookTerm>(node);
	const theme = cx.theme;
	const width = cx.width;
	if (!term.turns || !term.columns || !term.counter || !term.sideLabel || !term.setPaintContext || width < 8)
		return { rows: [] };
	term.setPaintContext(cx);
	const counter = theme.style(term.counter.s, term.counter.t);
	const steps = `${selectNavGlyphs(theme)} step  ${keyLabel(theme, "left")}/${keyLabel(theme, "right")} ${term.sideLabel}`;
	const rewind = `${keyLabel(theme, "enter")} rewind`;
	const cancel = bindingGlyph("tui.select.cancel", "escape", theme);
	const earlier = term.truncated ? `  ${keyLabel(theme, "a")} earlier turns` : "";
	const hints = term.filter
		? `${steps}  ${rewind}  ${cancel} show all`
		: `${steps}  ${keyLabel(theme, "f")} filter  ${rewind}${earlier}  ${expandKeyLabel(theme)} expand  ${cancel} cancel`;
	const status = `${counter}  ${theme.style("dim", hints)}`;
	const footer = term.filter
		? `${caretField(theme, ` ${theme.style("accent", "filter:")} `, term.filter.text, term.filter.cursor, width)}  ${status}`
		: ` ${status}`;

	let body: LaneViewport | { rows: string[] };
	if (term.empty !== undefined) body = { rows: [theme.style("muted", `  ${term.empty}`)] };
	else {
		const state = pickerState(node, "rewind.measurements", () => ({
			width,
			expanded: term.expanded,
			full: new Map<string, number>(),
			column: new Map<string, number>(),
		})).peek();
		if (state.width !== width || state.expanded !== term.expanded) {
			state.width = width;
			state.expanded = term.expanded;
			state.full.clear();
			state.column.clear();
		}
		const lane = virtualLane(cx, term.turns, width - 1, state.full);
		body = lane;
		if (term.columns.length > 0) {
			const fork = forkRows(cx, term.columns, width - 1, state.column);
			body = {
				get length() {
					return lane.length + fork.length;
				},
				get outline(): LaneViewport["outline"] {
					const outline = fork.outline;
					return outline && [lane.length + outline[0], lane.length + outline[1]];
				},
				slice(start, end) {
					const prefix = lane.slice(start, end);
					return end <= lane.length
						? prefix
						: [...prefix, ...fork.slice(Math.max(0, start - lane.length), end - lane.length)];
				},
			};
		}
	}
	const head = ` ${theme.symbols.icon("rewind")} ${theme.style("strong", "Rewind")}${theme.symbols.symbol("sep.dot")}${theme.style("dim", "pick the point to continue from")}`;
	const screen = transcriptScreen(node, cx, { head, body, footer, rows: term.rows, selection: term.selection });
	return { ...screen, hits: [sheetHit(node, width, screen.rows.length)] };
}

defineRolePainter("row", "omp.rewind.bar", paintRewind);
defineRoleWidget("row", "omp.rewind.bar", {
	mouse(node, mouse) {
		if (mouse.action !== "press" || (mouse.button !== "wheel-up" && mouse.button !== "wheel-down")) return false;
		wheelTranscriptView(node, mouse.button === "wheel-up" ? -1 : 1);
		return true;
	},
});
