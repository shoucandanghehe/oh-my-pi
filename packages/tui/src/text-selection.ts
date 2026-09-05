import type { Component } from "./tui";
import { CURSOR_MARKER, visibleWidth, wrapTextWithAnsi } from "./utils";

export interface TextSelectionPoint {
	row: number;
	col: number;
}

/** Inclusive physical-row/cell range relative to a component's latest render. */
export interface TextSelectionRange {
	start: TextSelectionPoint;
	end: TextSelectionPoint;
}

/** Maps one rendered row back into an unwrapped, plain-text logical line. */
export interface RenderedTextSelectionRow {
	logicalLine: number;
	source: string;
	sourceStart: number;
	sourceEnd: number;
	contentStartCol: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function stripRenderedControlSequences(text: string): string {
	return Bun.stripANSI(text.replaceAll(CURSOR_MARKER, ""));
}

export function normalizeTextSelection(selection: TextSelectionRange): TextSelectionRange {
	const { start, end } = selection;
	if (start.row < end.row || (start.row === end.row && start.col <= end.col)) return selection;
	return { start: end, end: start };
}

function sourceOffsetAtCell(text: string, cell: number, afterCell: boolean): number {
	if (cell < 0) return 0;
	let col = 0;
	for (const segment of graphemeSegmenter.segment(text)) {
		const width = Math.max(0, Bun.stringWidth(segment.segment));
		const nextCol = col + width;
		if (cell < nextCol || (width === 0 && cell === col)) {
			return afterCell ? segment.index + segment.segment.length : segment.index;
		}
		col = nextCol;
	}
	return text.length;
}

function fallbackRows(renderedLines: readonly string[], contentStartCol: number): RenderedTextSelectionRow[] {
	return renderedLines.map((line, logicalLine) => {
		const source = stripRenderedControlSequences(line);
		return {
			logicalLine,
			source,
			sourceStart: 0,
			sourceEnd: source.length,
			contentStartCol,
		};
	});
}

/**
 * Align wrapped physical rows with the logical text that produced them. Gaps
 * between adjacent segments retain word-wrap whitespace discarded on screen.
 */
export function mapLogicalTextSelectionRows(
	logicalLines: readonly string[],
	width: number,
	contentStartCol: number,
	renderedLines: readonly string[],
	logicalLineOffset = 0,
): RenderedTextSelectionRow[] {
	const rows: RenderedTextSelectionRow[] = [];
	for (let logicalLine = 0; logicalLine < logicalLines.length; logicalLine++) {
		const styledSource = logicalLines[logicalLine] ?? "";
		const source = stripRenderedControlSequences(styledSource);
		const wrapped = wrapTextWithAnsi(styledSource, Math.max(1, width));
		let sourceOffset = 0;
		for (const rendered of wrapped) {
			const plain = stripRenderedControlSequences(rendered);
			const match = plain === "" ? sourceOffset : source.indexOf(plain, sourceOffset);
			if (match < 0) return fallbackRows(renderedLines, contentStartCol);
			rows.push({
				logicalLine: logicalLineOffset + logicalLine,
				source,
				sourceStart: match,
				sourceEnd: match + plain.length,
				contentStartCol,
			});
			sourceOffset = match + plain.length;
		}
	}
	if (rows.length !== renderedLines.length) return fallbackRows(renderedLines, contentStartCol);
	for (let row = 0; row < rows.length; row++) {
		const mapped = rows[row]!;
		const rendered = stripRenderedControlSequences(renderedLines[row] ?? "");
		if (mapped.source.slice(mapped.sourceStart, mapped.sourceEnd) !== rendered) {
			return fallbackRows(renderedLines, contentStartCol);
		}
	}
	return rows;
}

/** Extract selected visible text while restoring soft-wrap gaps and hard newlines. */
export function extractMappedTextSelection(
	rows: readonly RenderedTextSelectionRow[],
	selection: TextSelectionRange,
): string | undefined {
	const normalized = normalizeTextSelection(selection);
	if (normalized.start.row < 0 || normalized.end.row >= rows.length) return undefined;
	let text = "";
	let previous: RenderedTextSelectionRow | undefined;
	for (let rowIndex = normalized.start.row; rowIndex <= normalized.end.row; rowIndex++) {
		const row = rows[rowIndex];
		if (!row) return undefined;
		if (previous) {
			text +=
				previous.logicalLine === row.logicalLine ? row.source.slice(previous.sourceEnd, row.sourceStart) : "\n";
		}
		const renderedSource = row.source.slice(row.sourceStart, row.sourceEnd);
		const startCell = rowIndex === normalized.start.row ? normalized.start.col - row.contentStartCol : 0;
		const endCell =
			rowIndex === normalized.end.row
				? normalized.end.col - row.contentStartCol
				: Math.max(0, visibleWidth(renderedSource) - 1);
		const startOffset = sourceOffsetAtCell(renderedSource, startCell, false);
		const endOffset = sourceOffsetAtCell(renderedSource, endCell, true);
		text += renderedSource.slice(startOffset, Math.max(startOffset, endOffset));
		previous = row;
	}
	return text;
}

/** Fallback for components that expose only their rendered physical rows. */
export function extractRenderedTextSelection(
	lines: readonly string[],
	selection: TextSelectionRange,
): string | undefined {
	const rows = lines.map((line, logicalLine) => {
		const source = stripRenderedControlSequences(line).replace(/[ \t]+$/u, "");
		return {
			logicalLine,
			source,
			sourceStart: 0,
			sourceEnd: source.length,
			contentStartCol: 0,
		};
	});
	return extractMappedTextSelection(rows, selection);
}

/** Prefer a component's logical-text mapping, falling back to its rendered rows. */
export function extractComponentTextSelection(
	component: Component,
	lines: readonly string[],
	selection: TextSelectionRange,
): string | undefined {
	const logicalText = component.getTextSelection?.(selection);
	return logicalText === undefined ? extractRenderedTextSelection(lines, selection) : logicalText;
}
