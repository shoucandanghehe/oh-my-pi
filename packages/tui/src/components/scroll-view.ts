import { matchesKey } from "../keys";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
import { TERMINAL } from "../terminal-capabilities";
import type { Component } from "../tui";
import {
	Ellipsis,
	replaceTabs,
	sliceByColumn,
	TERMINAL_STATE_TERMINATOR,
	truncateToWidth,
	visibleWidth,
} from "../utils";

const DEFAULT_TRACK = "│";
const DEFAULT_THUMB = "█";

const BRAILLE_SCROLLBAR_DOTS = [0x09, 0x12, 0x24, 0xc0] as const;
export const BRAILLE_SCROLLBAR_BLANK = " ";

export interface BrailleScrollbarMetrics {
	maxOffset: number;
	thumbTopRow: number;
	thumbRows: number;
	travelRows: number;
}

export interface BrailleScrollbarLayout {
	glyphs: readonly string[];
	metrics: BrailleScrollbarMetrics | null;
}

/** Proportional four-subcell scrollbar used by the app viewport and workspace panes. */
export function layoutBrailleScrollbar(
	viewportRows: number,
	totalRows: number,
	scrollOffset: number,
): BrailleScrollbarLayout {
	const height = Math.max(0, Math.trunc(viewportRows));
	const total = Math.max(0, Math.trunc(totalRows));
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const glyphs: string[] = new Array(height).fill(BRAILLE_SCROLLBAR_BLANK);
	if (height === 0 || total <= height) return { glyphs, metrics: null };
	const slotsPerRow = BRAILLE_SCROLLBAR_DOTS.length;
	const totalSlots = height * slotsPerRow;
	const proportionalThumbSlots = Math.floor((totalSlots * height) / total);
	const minThumbSlots = Math.min(slotsPerRow, totalSlots);
	const thumbSlots = Math.max(minThumbSlots, Math.min(proportionalThumbSlots, totalSlots));
	const travelSlots = totalSlots - thumbSlots;
	const maxOffset = total - height;
	const boundedOffset = Math.max(0, Math.min(Math.trunc(scrollOffset), maxOffset));
	const thumbStart = maxOffset === 0 ? 0 : Math.round((boundedOffset / maxOffset) * travelSlots);
	const thumbEnd = thumbStart + thumbSlots;
	const thumbTopRow = Math.floor(thumbStart / slotsPerRow);
	const thumbEndRow = Math.max(thumbTopRow + 1, Math.ceil(thumbEnd / slotsPerRow));
	const thumbRows = Math.max(1, Math.min(height, thumbEndRow - thumbTopRow));
	for (let row = 0; row < height; row++) {
		let mask = 0;
		const rowStart = row * slotsPerRow;
		for (let slot = 0; slot < slotsPerRow; slot++) {
			const absoluteSlot = rowStart + slot;
			if (absoluteSlot >= thumbStart && absoluteSlot < thumbEnd) mask |= BRAILLE_SCROLLBAR_DOTS[slot] ?? 0;
		}
		if (mask !== 0) glyphs[row] = `\x1b[2m${String.fromCodePoint(0x2800 | mask)}\x1b[0m`;
	}
	return {
		glyphs,
		metrics: {
			maxOffset,
			thumbTopRow: Math.max(0, Math.min(thumbTopRow, height - 1)),
			thumbRows,
			travelRows: Math.max(0, height - thumbRows),
		},
	};
}

/** Reserve the rightmost column and overlay the non-blank Braille thumb cells. */
export function appendBrailleScrollbar(lines: readonly string[], glyphs: readonly string[], width: number): string[] {
	const fitted = [...lines];
	if (!glyphs.some(glyph => glyph !== BRAILLE_SCROLLBAR_BLANK)) return fitted;
	const contentWidth = Math.max(0, Math.trunc(width) - 1);
	for (let row = 0; row < fitted.length; row++) {
		const line = fitted[row] ?? "";
		if (TERMINAL.isImageLine(line)) continue;
		const content = sliceByColumn(line, 0, contentWidth, true);
		const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		const glyph = glyphs[row] ?? BRAILLE_SCROLLBAR_BLANK;
		fitted[row] = `${content}${pad}${TERMINAL_STATE_TERMINATOR}${glyph}`;
	}
	return fitted;
}

type ScrollbarMode = "auto" | "always" | "never";
type ScrollbarStyle = "solid" | "braille";

export interface ScrollViewTheme {
	track?: (text: string) => string;
	thumb?: (text: string) => string;
}

export interface ScrollViewOptions {
	height: number;
	/** Defaults to "auto". "auto" reserves a scrollbar column only when content overflows. */
	scrollbar?: ScrollbarMode | boolean;
	/** Defaults to the conventional solid track/thumb. */
	scrollbarStyle?: ScrollbarStyle;
	/** Logical row count for pre-windowed line slices. Defaults to lines.length. */
	totalRows?: number;
	theme?: ScrollViewTheme;
	trackChar?: string;
	thumbChar?: string;
	/**
	 * Indicator appended when a row overflows `contentWidth`. Defaults to
	 * {@link Ellipsis.Unicode}. Pass {@link Ellipsis.Omit} when callers wrap
	 * lines to width themselves and only trailing padding can overflow (e.g.
	 * the plan-review overlay), so no stray `…` lands on every padded row.
	 */
	ellipsis?: Ellipsis;
	/**
	 * Rows moved per keystroke when {@link ScrollView.handleScrollKey} sees a
	 * Shift+Arrow (the "scroll faster" affordance). Defaults to 5.
	 */
	fastScrollLines?: number;
}

function normalizeScrollbarMode(scrollbar: ScrollViewOptions["scrollbar"]): ScrollbarMode {
	if (scrollbar === true) return "auto";
	if (scrollbar === false) return "never";
	return scrollbar ?? "auto";
}

function firstCellGlyph(value: string, fallback: string): string {
	const glyph = Array.from(value)[0] ?? fallback;
	return visibleWidth(glyph) === 1 ? glyph : fallback;
}

/**
 * Fixed-height viewport over pre-rendered lines, with optional right-edge scrollbar.
 *
 * ScrollView owns only the row offset. Callers remain responsible for producing
 * already-wrapped logical lines appropriate for the current render width.
 */
export class ScrollView implements Component, MouseRoutable {
	#lines: string[];
	#height: number;
	#scrollOffset = 0;
	#totalRows: number | undefined;
	#scrollbar: ScrollbarMode;
	#scrollbarStyle: ScrollbarStyle;
	#theme: Required<ScrollViewTheme>;
	#trackChar: string;
	#thumbChar: string;
	#ellipsis: Ellipsis;
	#fastScrollLines: number;
	#width = 0;
	#brailleMetrics: BrailleScrollbarMetrics | null = null;
	#brailleDrag: { grabOffsetRows: number } | undefined;

	constructor(lines: readonly string[], options: ScrollViewOptions) {
		this.#lines = [...lines];
		this.#height = Number.isFinite(options.height) ? Math.max(0, Math.trunc(options.height)) : 0;
		this.#totalRows = options.totalRows === undefined ? undefined : Math.max(0, Math.trunc(options.totalRows));
		this.#scrollbar = normalizeScrollbarMode(options.scrollbar);
		this.#scrollbarStyle = options.scrollbarStyle ?? "solid";
		this.#theme = {
			track: options.theme?.track ?? (text => text),
			thumb: options.theme?.thumb ?? (text => text),
		};
		this.#trackChar = firstCellGlyph(options.trackChar ?? DEFAULT_TRACK, DEFAULT_TRACK);
		this.#thumbChar = firstCellGlyph(options.thumbChar ?? DEFAULT_THUMB, DEFAULT_THUMB);
		this.#ellipsis = options.ellipsis ?? Ellipsis.Unicode;
		this.#fastScrollLines = Math.max(1, Math.trunc(options.fastScrollLines ?? 5));
		this.#clampScrollOffset();
	}
	/** Return viewport, content, and scroll position state for debug inspection. */
	debugState(): Record<string, unknown> {
		const rowCount = this.#totalRows ?? this.#lines.length;
		return {
			scrollOffset: this.#scrollOffset,
			maxScrollOffset: this.getMaxScrollOffset(),
			height: this.#height,
			rowCount,
			bufferedLineCount: this.#lines.length,
			scrollbar: this.#scrollbar,
		};
	}

	setLines(lines: readonly string[]): void {
		this.#lines = [...lines];
		this.#clampScrollOffset();
	}

	setTotalRows(totalRows: number | undefined): void {
		this.#totalRows = totalRows === undefined ? undefined : Math.max(0, Math.trunc(totalRows));
		this.#clampScrollOffset();
	}

	setHeight(height: number): void {
		this.#height = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
		this.#clampScrollOffset();
	}

	setScrollbar(scrollbar: ScrollViewOptions["scrollbar"]): void {
		this.#scrollbar = normalizeScrollbarMode(scrollbar);
	}

	getScrollOffset(): number {
		return this.#scrollOffset;
	}

	getMaxScrollOffset(): number {
		const rowCount = this.#totalRows ?? this.#lines.length;
		return Math.max(0, rowCount - this.#height);
	}

	setScrollOffset(offset: number): void {
		this.#scrollOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
		this.#clampScrollOffset();
	}

	scroll(delta: number): void {
		this.setScrollOffset(this.#scrollOffset + (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	page(delta: number): void {
		const step = Math.max(1, this.#height - 1);
		this.scroll(step * (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	scrollToTop(): void {
		this.#scrollOffset = 0;
	}

	scrollToBottom(): void {
		this.#scrollOffset = this.getMaxScrollOffset();
	}

	/**
	 * Apply a standard navigation key to the viewport. Shift+Arrow scrolls by
	 * {@link ScrollViewOptions.fastScrollLines} (the "scroll faster" affordance);
	 * plain Arrow by one line; PageUp/PageDown by a page; Home/End to the ends.
	 * Returns true when the key was consumed, so callers can fall through to
	 * their own (e.g. vim-style) bindings. Generic on purpose: every ScrollView
	 * consumer gets the same scroll keys, including Shift-to-go-faster.
	 */
	handleScrollKey(data: string): boolean {
		if (matchesKey(data, "shift+up")) {
			this.scroll(-this.#fastScrollLines);
			return true;
		}
		if (matchesKey(data, "shift+down")) {
			this.scroll(this.#fastScrollLines);
			return true;
		}
		if (matchesKey(data, "up")) {
			this.scroll(-1);
			return true;
		}
		if (matchesKey(data, "down")) {
			this.scroll(1);
			return true;
		}
		if (matchesKey(data, "pageUp")) {
			this.page(-1);
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.page(1);
			return true;
		}
		if (matchesKey(data, "home")) {
			this.scrollToTop();
			return true;
		}
		if (matchesKey(data, "end")) {
			this.scrollToBottom();
			return true;
		}
		return false;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		if (event.wheel !== null) {
			this.#brailleDrag = undefined;
			this.scroll(event.wheel * 3);
			return true;
		}
		if (this.#scrollbarStyle !== "braille") return false;
		if (event.release) {
			const handled = this.#brailleDrag !== undefined;
			this.#brailleDrag = undefined;
			return handled;
		}
		if (this.#brailleDrag) {
			if (event.motion) this.#dragBrailleScrollbar(line);
			return true;
		}
		if (!event.leftClick) return false;
		const metrics = this.#brailleMetrics;
		if (!metrics || metrics.maxOffset <= 0 || col !== this.#width - 1) return false;
		if (line < 0 || line >= this.#height) return false;
		const inThumb = line >= metrics.thumbTopRow && line < metrics.thumbTopRow + metrics.thumbRows;
		const fallbackOffset = Math.max(0, (metrics.thumbRows - 1) / 2);
		const grabOffsetRows = inThumb ? line - metrics.thumbTopRow : fallbackOffset;
		this.#brailleDrag = {
			grabOffsetRows: Math.max(0, Math.min(grabOffsetRows, Math.max(0, metrics.thumbRows - 1))),
		};
		this.#dragBrailleScrollbar(line);
		return true;
	}

	invalidate(): void {
		// No cached layout to invalidate.
	}

	render(width: number): readonly string[] {
		this.#clampScrollOffset();
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		this.#width = safeWidth;
		if (this.#height === 0) return [];
		const showScrollbar = safeWidth > 0 && this.#shouldRenderScrollbar();
		const contentWidth = Math.max(0, safeWidth - (showScrollbar ? 1 : 0));
		const braille = showScrollbar && this.#scrollbarStyle === "braille";
		const thumb = showScrollbar && !braille ? this.#thumbRange() : undefined;
		const lines: string[] = [];
		for (let row = 0; row < this.#height; row++) {
			const sourceIndex = this.#totalRows === undefined ? this.#scrollOffset + row : row;
			const source = this.#lines[sourceIndex] ?? "";
			const truncated = truncateToWidth(replaceTabs(source), contentWidth, this.#ellipsis);
			if (!showScrollbar || braille) {
				lines.push(truncated);
				continue;
			}
			const content = `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
			const barGlyph = thumb && row >= thumb.start && row < thumb.end ? this.#thumbChar : this.#trackChar;
			const styledBar =
				thumb && row >= thumb.start && row < thumb.end ? this.#theme.thumb(barGlyph) : this.#theme.track(barGlyph);
			lines.push(`${content}${styledBar}`);
		}
		if (!braille) {
			this.#brailleMetrics = null;
			return lines;
		}
		const scrollbar = layoutBrailleScrollbar(this.#height, this.#totalRows ?? this.#lines.length, this.#scrollOffset);
		this.#brailleMetrics = scrollbar.metrics;
		return appendBrailleScrollbar(lines, scrollbar.glyphs, safeWidth);
	}

	#dragBrailleScrollbar(line: number): void {
		const metrics = this.#brailleMetrics;
		const drag = this.#brailleDrag;
		if (!metrics || !drag || metrics.maxOffset <= 0) return;
		const boundedRow = Math.max(0, Math.min(line, this.#height - 1));
		const thumbTop = Math.max(0, Math.min(boundedRow - drag.grabOffsetRows, metrics.travelRows));
		const nextOffset = metrics.travelRows <= 0 ? 0 : Math.round((thumbTop / metrics.travelRows) * metrics.maxOffset);
		this.#scrollOffset = Math.max(0, Math.min(nextOffset, metrics.maxOffset));
	}

	#clampScrollOffset(): void {
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, this.getMaxScrollOffset()));
	}

	#shouldRenderScrollbar(): boolean {
		if (this.#height <= 0) return false;
		if (this.#scrollbar === "never") return false;
		if (this.#scrollbar === "always") return true;
		return (this.#totalRows ?? this.#lines.length) > this.#height;
	}

	#thumbRange(): { start: number; end: number } {
		if (this.#height <= 0) return { start: 0, end: 0 };
		const rowCount = this.#totalRows ?? this.#lines.length;
		if (rowCount <= this.#height) return { start: 0, end: this.#height };
		const thumbSize = Math.max(1, Math.min(Math.floor((this.#height * this.#height) / rowCount), this.#height));
		const travel = this.#height - thumbSize;
		const maxOffset = this.getMaxScrollOffset();
		const start = maxOffset === 0 ? 0 : Math.round((this.#scrollOffset / maxOffset) * travel);
		return { start, end: start + thumbSize };
	}
}
