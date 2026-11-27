/** A painted transcript row as clipboard/search text; offsets are UTF-16, columns are terminal cells. */
import { holdsImage } from "../driver/images/anchor";
import { KITTY_PLACEHOLDER } from "../driver/images/kitty";
import { sgrParams, SgrState, stripEscapes, tokens } from "../text/ansi";
import { pieces, type TextRow, visibleWidth } from "../text/width";
import type { Block, Cell } from "./paint";

interface TranscriptCell {
	readonly start: number;
	readonly end: number;
	readonly col: number;
	readonly width: number;
}

export interface TranscriptLine {
	readonly text: string;
	readonly cells: readonly TranscriptCell[];
}

/** Graphics contain no selectable text. OSC 66, unlike other graphics, carries visible glyphs. */
export function isTranscriptImage(row: string): boolean {
	return row.includes(KITTY_PLACEHOLDER) || (holdsImage(row) && !row.includes("\x1b]66;"));
}

/** Visible text only: most search indexing and multi-line copies never need a cell map. */
export function plainTranscriptText(row: string): string {
	if (isTranscriptImage(row)) return "";
	return row.includes("\x1b]66;") ? transcriptLine(row).text : stripEscapes(row);
}

/** Payload of an OSC 66 group; the whole group has one declared cell span. */
function sizedPayload(span: string): string {
	return span.slice(span.indexOf(";", 5) + 1, span.endsWith("\x07") ? -1 : -2);
}

export function transcriptLine(row: string): TranscriptLine {
	let text = "";
	let col = 0;
	const cells: TranscriptCell[] = [];
	const append = (run: string): void => {
		// Segment the visible text, not the SGR runs: a style boundary can even fall inside a grapheme.
		for (const piece of pieces(run)) {
			const start = text.length;
			text += piece.text;
			cells.push({ start, end: text.length, col, width: piece.width });
			col += piece.width;
		}
	};
	if (isTranscriptImage(row)) return { text, cells };
	if (!row.includes("\x1b]66;")) append(stripEscapes(row));
	else {
		let run = "";
		for (const token of tokens(row)) {
			if (!token.escape) run += token.text;
			else if (token.text.startsWith("\x1b]66;")) {
				append(run);
				run = "";
				const start = text.length;
				text += sizedPayload(token.text);
				const width = visibleWidth(token.text);
				cells.push({ start, end: text.length, col, width });
				col += width;
			}
		}
		append(run);
	}
	return { text, cells };
}

/** Select logical text, not paint padding. Only an unannotated row selected to its end loses trailing blanks. */
export function selectedText(raw: string, fact: TextRow | undefined, start = 0, end = Infinity): string {
	if (!fact && start === 0 && end === Infinity) return plainTranscriptText(raw).trimEnd();
	const { text, cells } = transcriptLine(raw);
	const from = Math.max(start, fact?.start ?? 0);
	const to = Math.min(end, fact?.end ?? Infinity);
	if (from >= to) return "";
	const left = cells.find(cell => cell.col + cell.width > from)?.start ?? text.length;
	const right = cells.findLast(cell => cell.col < to)?.end ?? 0;
	const selected = text.slice(left, right);
	return !fact && right === text.length ? selected.trimEnd() : selected;
}

/** Move a caret through a rewrap of the same logical block, preserving its side of an empty soft break. */
export function reflowCell(before: Block, after: Block, point: Cell, end: boolean): Cell | undefined {
	if (point.row < 0) return point; // Block separator.
	const layout = (block: Block) => {
		let text = "";
		const starts = block.rows.map((raw, i) => {
			const fact = block.textRows?.[i];
			if (i > 0) text += fact?.join ?? "\n";
			const start = text.length;
			text += selectedText(raw, fact);
			return start;
		});
		return { starts, text };
	};
	const old = layout(before);
	const next = layout(after);
	if (!next.text.startsWith(old.text) || !after.rows.length || old.starts[point.row] === undefined) return;
	const offset =
		old.starts[point.row]! + selectedText(before.rows[point.row]!, before.textRows?.[point.row], 0, point.col).length;
	let row = next.starts.findLastIndex(
		(start, i) => start < offset || (start === offset && (!end || after.textRows?.[i]?.join !== "")),
	);
	row = Math.max(0, row);
	const fact = after.textRows?.[row];
	const { cells } = transcriptLine(after.rows[row]!);
	const first = cells.find(cell => cell.col + cell.width > (fact?.start ?? 0))?.start ?? 0;
	const at = first + offset - next.starts[row]!;
	const last = cells.at(-1);
	const col = cells.find(cell => cell.end > at)?.col ?? (last ? last.col + last.width : 0);
	return { row, col: Math.min(col, fact?.end ?? Infinity) };
}

/** Style every grapheme intersecting [start,end), retaining the original control sequences and SGR state. */
export function styleTranscriptCells(row: string, start: number, end: number, style: (text: string) => string): string {
	if (end <= start) return row;
	const { cells } = transcriptLine(row);
	const left = cells.find(cell => cell.col + cell.width > start);
	const right = cells.findLast(cell => cell.col < end);
	if (!left || !right || left.start >= right.end) return row;
	const sgr = new SgrState();
	let out = "";
	let offset = 0;
	for (const token of tokens(row)) {
		const sized = token.escape && token.text.startsWith("\x1b]66;");
		if (token.escape && !sized) {
			out += token.text;
			const params = sgrParams(token.text);
			if (params !== undefined) sgr.apply(params);
			continue;
		}
		const length = sized ? sizedPayload(token.text).length : token.text.length;
		const from = Math.max(0, left.start - offset);
		const to = Math.min(length, right.end - offset);
		offset += length;
		if (from >= to) out += token.text;
		else if (sized) out += style(token.text) + sgr.open();
		else out += token.text.slice(0, from) + style(token.text.slice(from, to)) + sgr.open() + token.text.slice(to);
	}
	return out;
}
