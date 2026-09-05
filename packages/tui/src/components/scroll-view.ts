import { matchesKey } from "../keys";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
import { TERMINAL } from "../terminal-capabilities";
import type { Component } from "../tui";
import {
	Ellipsis,
	getWidthConfigEpoch,
	padding,
	replaceTabs,
	sliceByColumn,
	TERMINAL_STATE_TERMINATOR,
	truncateToWidth,
	visibleWidth,
} from "../utils";
import {
	clampScrollOffset,
	maxScrollOffset,
	scrollbarThumbRange,
	scrollOffsetForRow,
	type ViewportAlignment,
	viewportOverflows,
	viewportRange,
} from "./scroll-viewport";

const DEFAULT_TRACK = "│";
const DEFAULT_THUMB = "█";
const EMPTY_LINES: readonly string[] = [];

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
		const pad = padding(Math.max(0, contentWidth - visibleWidth(content)));
		const glyph = glyphs[row] ?? BRAILLE_SCROLLBAR_BLANK;
		fitted[row] = `${content}${pad}${TERMINAL_STATE_TERMINATOR}${glyph}`;
	}
	return fitted;
}

type ScrollbarMode = "auto" | "always" | "never";
export type ScrollAnchor = "start" | "end";
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
	/** Logical row count for pre-windowed line slices. Defaults to the rendered content row count. */
	totalRows?: number;
	theme?: ScrollViewTheme;
	trackChar?: string;
	thumbChar?: string;
	/**
	 * Indicator appended when a row overflows `contentWidth`. Defaults to
	 * {@link Ellipsis.Unicode}. Pass {@link Ellipsis.Omit} when callers wrap
	 * lines to width themselves and only trailing padding can overflow.
	 */
	ellipsis?: Ellipsis;
	/** Rows moved by Shift+Arrow in {@link ScrollView.handleScrollKey}. Defaults to 5. */
	fastScrollLines?: number;
	/** Follow newly appended rows while the viewport was already at its tail. */
	followTail?: boolean;
	/** Preserve either the leading row or the distance from the tail across content/height changes. */
	anchor?: ScrollAnchor;
}

/** A selected logical range revealed once or whenever its geometry changes. */
export interface ScrollRangeAnchor {
	id: string;
	start: number;
	end: number;
	margin?: number;
	alignment?: ViewportAlignment;
	mode?: "selection" | "once";
	/** Prefer the leading edge when the selected range fills more than the viewport. */
	oversized?: "nearest" | "start";
}

interface RangeSnapshot {
	anchor: Required<ScrollRangeAnchor>;
	width: number;
	height: number;
	totalRows: number;
}

interface RenderCache {
	width: number;
	widthEpoch: number;
	height: number;
	scrollOffset: number;
	rowCount: number;
	showScrollbar: boolean;
	scrollbarStyle: ScrollbarStyle;
	trackSample: string;
	thumbSample: string;
	sourceLines: readonly string[];
	sourceSnapshot: readonly string[] | undefined;
	result: readonly string[];
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

function normalizedRows(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function isComponent(content: readonly string[] | Component): content is Component {
	return !Array.isArray(content);
}

/**
 * Fixed-height viewport over supplied rows or a lazily rendered child.
 *
 * Without `totalRows`, content is a complete row buffer and ScrollView slices
 * it at its own offset. With `totalRows`, content is an already-windowed slice:
 * the offset remains logical (for thumb and hit mapping), while local row zero
 * is rendered from content row zero.
 */
export class ScrollView implements Component, MouseRoutable {
	#lines: readonly string[];
	#child: Component | undefined;
	#measuredRows: number;
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
	#followTail: boolean;
	#anchor: ScrollAnchor;
	#activeRow: number | undefined;
	#activeAlignment: ViewportAlignment = "nearest";
	#rangeSnapshot: RangeSnapshot | undefined;
	#cache: RenderCache | undefined;
	#disposed = false;
	#width = 0;
	#brailleMetrics: BrailleScrollbarMetrics | null = null;
	#brailleDrag: { grabOffsetRows: number } | undefined;

	constructor(content: readonly string[] | Component, options: ScrollViewOptions) {
		this.#child = isComponent(content) ? content : undefined;
		this.#lines = isComponent(content) ? [] : content.slice();
		this.#measuredRows = this.#lines.length;
		this.#height = normalizedRows(options.height);
		this.#totalRows = options.totalRows === undefined ? undefined : normalizedRows(options.totalRows);
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
		this.#followTail = options.followTail ?? false;
		this.#anchor = options.anchor ?? "start";
		if (this.#followTail || this.#anchor === "end") this.#scrollOffset = this.getMaxScrollOffset();
	}

	/** Child exposed for debug-tree traversal when the viewport wraps a component. */
	get debugChildren(): readonly Component[] {
		return !this.#disposed && this.#child ? [this.#child] : [];
	}

	/** Return viewport, content, and scroll position state for debug inspection. */
	debugState(): Record<string, unknown> {
		return {
			scrollOffset: this.#scrollOffset,
			maxScrollOffset: this.getMaxScrollOffset(),
			height: this.#height,
			rowCount: this.#rowCount(),
			bufferedLineCount: this.#child ? this.#measuredRows : this.#lines.length,
			scrollbar: this.#scrollbar,
			followTail: this.#followTail,
			anchor: this.#anchor,
			activeRow: this.#activeRow,
			disposed: this.#disposed,
		};
	}

	setLines(lines: readonly string[]): void {
		if (this.#disposed) return;
		const oldTotal = this.#rowCount();
		const oldHeight = this.#height;
		this.#child = undefined;
		this.#lines = lines.slice();
		this.#measuredRows = this.#lines.length;
		this.#reconcileBounds(oldTotal, oldHeight);
		this.#cache = undefined;
	}

	/** Replace the supplied rows with a lazily rendered child component. */
	setChild(child: Component): void {
		if (this.#disposed) {
			child.dispose?.();
			return;
		}
		if (this.#child === child) return;
		this.#child = child;
		this.#lines = [];
		this.#cache = undefined;
	}

	setTotalRows(totalRows: number | undefined): void {
		const normalized = totalRows === undefined ? undefined : normalizedRows(totalRows);
		if (this.#totalRows === normalized) return;
		const oldTotal = this.#rowCount();
		const oldHeight = this.#height;
		this.#totalRows = normalized;
		this.#reconcileBounds(oldTotal, oldHeight);
		this.#cache = undefined;
	}

	setHeight(height: number): void {
		const normalized = normalizedRows(height);
		if (this.#height === normalized) return;
		const oldTotal = this.#rowCount();
		const oldHeight = this.#height;
		this.#height = normalized;
		this.#brailleMetrics = null;
		this.#brailleDrag = undefined;
		this.#reconcileBounds(oldTotal, oldHeight);
		this.#cache = undefined;
	}

	setScrollbar(scrollbar: ScrollViewOptions["scrollbar"]): void {
		const normalized = normalizeScrollbarMode(scrollbar);
		if (this.#scrollbar === normalized) return;
		this.#scrollbar = normalized;
		this.#brailleMetrics = null;
		this.#brailleDrag = undefined;
		this.#cache = undefined;
	}

	setFollowTail(followTail: boolean): void {
		this.#followTail = followTail;
	}

	setAnchor(anchor: ScrollAnchor): void {
		this.#anchor = anchor;
	}

	getScrollOffset(): number {
		return this.#scrollOffset;
	}

	getMaxScrollOffset(): number {
		return maxScrollOffset(this.#rowCount(), this.#height);
	}

	/** Current half-open logical row range. */
	getVisibleRange(): { start: number; end: number } {
		return viewportRange(this.#rowCount(), this.#height, this.#scrollOffset);
	}

	/** Map a local viewport row to its logical content row. */
	logicalRowAt(localRow: number): number | undefined {
		if (!Number.isFinite(localRow)) return undefined;
		const local = Math.trunc(localRow);
		const range = this.getVisibleRange();
		const logical = range.start + local;
		return local >= 0 && logical < range.end ? logical : undefined;
	}

	/** Map a visible logical content row to its local viewport row. */
	localRowFor(logicalRow: number): number | undefined {
		if (!Number.isFinite(logicalRow)) return undefined;
		const logical = Math.trunc(logicalRow);
		const range = this.getVisibleRange();
		return logical >= range.start && logical < range.end ? logical - range.start : undefined;
	}

	setScrollOffset(offset: number): void {
		const next = clampScrollOffset(offset, this.#rowCount(), this.#height);
		if (this.#scrollOffset === next) return;
		this.#scrollOffset = next;
		this.#cache = undefined;
	}

	/** Keep a logical row visible now and through subsequent resize/content changes. */
	setActiveRow(row: number | undefined, alignment: ViewportAlignment = "nearest"): void {
		this.#activeRow = row === undefined ? undefined : normalizedRows(row);
		this.#activeAlignment = alignment;
		if (this.#activeRow !== undefined) {
			this.setScrollOffset(
				scrollOffsetForRow(
					this.#scrollOffset,
					this.#activeRow,
					this.#rowCount(),
					this.#height,
					this.#activeAlignment,
				),
			);
		}
	}

	/** Whether a keyed range has already been revealed successfully. */
	hasRevealedRange(id: string): boolean {
		return this.#rangeSnapshot?.anchor.id === id;
	}

	/**
	 * Reveal a changed selection without snapping manual scrolling back on
	 * unchanged renders. Passing undefined forgets the previous range.
	 */
	revealRange(anchor: ScrollRangeAnchor | undefined, width: number): boolean {
		if (!anchor) {
			this.#rangeSnapshot = undefined;
			return false;
		}
		if (
			this.#disposed ||
			!Number.isFinite(anchor.start) ||
			!Number.isFinite(anchor.end) ||
			anchor.start < 0 ||
			anchor.end <= anchor.start
		) {
			return false;
		}
		const mode = anchor.mode ?? "selection";
		const alignment = anchor.alignment ?? "nearest";
		const margin = normalizedRows(anchor.margin ?? 1);
		const oversized = anchor.oversized ?? "nearest";
		const totalRows = this.#rowCount();
		const previous = this.#rangeSnapshot;
		if (
			previous?.anchor.id === anchor.id &&
			previous.anchor.mode === mode &&
			previous.anchor.alignment === alignment &&
			previous.anchor.margin === margin &&
			previous.anchor.oversized === oversized &&
			(mode === "once" ||
				(previous.anchor.start === anchor.start &&
					previous.anchor.end === anchor.end &&
					previous.width === width &&
					previous.height === this.#height &&
					previous.totalRows === totalRows))
		)
			return false;

		const top = Math.max(0, Math.trunc(anchor.start) - margin);
		const bottom = Math.min(totalRows, Math.trunc(anchor.end) + margin);
		const visible = this.getVisibleRange();
		if (alignment === "start") this.setActiveRow(top, "start");
		else if (alignment === "end") this.setActiveRow(Math.max(top, bottom - 1), "end");
		else if (alignment === "center") this.setActiveRow(Math.floor((anchor.start + anchor.end - 1) / 2), "center");
		else if (top < visible.start || (oversized === "start" && bottom - top >= this.#height))
			this.setActiveRow(top, "start");
		else if (bottom > visible.end) this.setActiveRow(Math.max(top, bottom - 1), "end");
		this.setActiveRow(undefined);
		this.#rangeSnapshot = {
			anchor: { ...anchor, mode, alignment, margin, oversized },
			width,
			height: this.#height,
			totalRows,
		};
		return true;
	}

	scroll(delta: number): void {
		this.setScrollOffset(this.#scrollOffset + (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	page(delta: number): void {
		const step = Math.max(1, this.#height - 1);
		this.scroll(step * (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	scrollToTop(): void {
		this.setScrollOffset(0);
	}

	scrollToBottom(): void {
		this.setScrollOffset(this.getMaxScrollOffset());
	}

	/** Apply Arrow, Shift+Arrow, Page, Home, and End navigation keys. */
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
		if (this.#disposed || this.#height === 0) return false;
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
		if (this.#disposed) return;
		this.#cache = undefined;
		this.#child?.invalidate?.();
	}

	/** Permanently release a wrapped child's timers, subscriptions, and other resources. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#cache = undefined;
		this.#brailleMetrics = null;
		this.#brailleDrag = undefined;
		this.#lines = EMPTY_LINES;
		this.#measuredRows = 0;
		const child = this.#child;
		this.#child = undefined;
		child?.dispose?.();
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return EMPTY_LINES;
		const safeWidth = normalizedRows(width);
		this.#width = safeWidth;
		if (this.#height === 0) {
			this.#brailleMetrics = null;
			this.#brailleDrag = undefined;
			return EMPTY_LINES;
		}

		let sourceLines: readonly string[];
		let showScrollbar: boolean;
		if (this.#child) {
			const knownRows = this.#totalRows;
			if (knownRows !== undefined || this.#scrollbar !== "auto") {
				showScrollbar = this.#shouldRenderScrollbar(knownRows ?? this.#measuredRows, safeWidth);
				sourceLines = this.#child.render(Math.max(0, safeWidth - (showScrollbar ? 1 : 0)));
			} else {
				sourceLines = this.#child.render(safeWidth);
				showScrollbar = this.#shouldRenderScrollbar(sourceLines.length, safeWidth);
				if (showScrollbar) sourceLines = this.#child.render(Math.max(0, safeWidth - 1));
			}
			this.#updateMeasuredRows(sourceLines.length);
			showScrollbar = this.#shouldRenderScrollbar(this.#rowCount(), safeWidth);
		} else {
			sourceLines = this.#lines;
			showScrollbar = this.#shouldRenderScrollbar(this.#rowCount(), safeWidth);
		}

		this.#scrollOffset = clampScrollOffset(this.#scrollOffset, this.#rowCount(), this.#height);
		const rowCount = this.#rowCount();
		const contentWidth = Math.max(0, safeWidth - (showScrollbar ? 1 : 0));
		const braille = showScrollbar && this.#scrollbarStyle === "braille";
		const thumb = showScrollbar && !braille ? scrollbarThumbRange(this.#height, rowCount, this.#scrollOffset) : undefined;
		const trackSample = this.#theme.track(this.#trackChar);
		const thumbSample = this.#theme.thumb(this.#thumbChar);
		const widthEpoch = getWidthConfigEpoch();
		const cached = this.#cache;
		if (
			cached !== undefined &&
			cached.width === safeWidth &&
			cached.widthEpoch === widthEpoch &&
			cached.height === this.#height &&
			cached.scrollOffset === this.#scrollOffset &&
			cached.rowCount === rowCount &&
			cached.showScrollbar === showScrollbar &&
			cached.scrollbarStyle === this.#scrollbarStyle &&
			cached.trackSample === trackSample &&
			cached.thumbSample === thumbSample &&
			(this.#child
				? cached.sourceSnapshot !== undefined &&
					cached.sourceSnapshot.length === sourceLines.length &&
					sourceLines.every((line, index) => cached.sourceSnapshot?.[index] === line)
				: cached.sourceLines === sourceLines)
		) {
			return cached.result;
		}

		const lines: string[] = [];
		for (let row = 0; row < this.#height; row++) {
			const sourceIndex = this.#totalRows === undefined ? this.#scrollOffset + row : row;
			const source = sourceLines[sourceIndex] ?? "";
			const truncated = truncateToWidth(replaceTabs(source), contentWidth, this.#ellipsis);
			if (!showScrollbar || braille) {
				lines.push(truncated);
				continue;
			}
			const content = `${truncated}${padding(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
			lines.push(`${content}${thumb && row >= thumb.start && row < thumb.end ? thumbSample : trackSample}`);
		}

		let result: readonly string[] = lines;
		if (braille) {
			const scrollbar = layoutBrailleScrollbar(this.#height, rowCount, this.#scrollOffset);
			this.#brailleMetrics = scrollbar.metrics;
			result = appendBrailleScrollbar(lines, scrollbar.glyphs, safeWidth);
		} else {
			this.#brailleMetrics = null;
		}
		if (!this.#brailleMetrics) this.#brailleDrag = undefined;

		this.#cache = {
			width: safeWidth,
			widthEpoch: getWidthConfigEpoch(),
			height: this.#height,
			scrollOffset: this.#scrollOffset,
			rowCount,
			showScrollbar,
			scrollbarStyle: this.#scrollbarStyle,
			trackSample,
			thumbSample,
			sourceLines,
			sourceSnapshot: this.#child ? sourceLines.slice() : undefined,
			result,
		};
		return result;
	}

	#dragBrailleScrollbar(line: number): void {
		const metrics = this.#brailleMetrics;
		const drag = this.#brailleDrag;
		if (!metrics || !drag || metrics.maxOffset <= 0) return;
		const boundedRow = Math.max(0, Math.min(line, this.#height - 1));
		const thumbTop = Math.max(0, Math.min(boundedRow - drag.grabOffsetRows, metrics.travelRows));
		const nextOffset = metrics.travelRows <= 0 ? 0 : Math.round((thumbTop / metrics.travelRows) * metrics.maxOffset);
		this.setScrollOffset(nextOffset);
	}

	#rowCount(): number {
		return this.#totalRows ?? this.#measuredRows;
	}

	#updateMeasuredRows(measuredRows: number): void {
		const normalized = normalizedRows(measuredRows);
		if (this.#measuredRows === normalized) return;
		const oldTotal = this.#rowCount();
		const oldHeight = this.#height;
		this.#measuredRows = normalized;
		this.#reconcileBounds(oldTotal, oldHeight);
		this.#cache = undefined;
	}

	#reconcileBounds(oldTotal: number, oldHeight: number): void {
		const newTotal = this.#rowCount();
		if (this.#activeRow !== undefined) {
			this.#scrollOffset = scrollOffsetForRow(
				this.#scrollOffset,
				this.#activeRow,
				newTotal,
				this.#height,
				this.#activeAlignment,
			);
			return;
		}

		const wasAtTail = this.#scrollOffset >= maxScrollOffset(oldTotal, oldHeight);
		if (this.#anchor === "end") {
			const trailingRows = Math.max(0, oldTotal - (this.#scrollOffset + oldHeight));
			this.#scrollOffset = clampScrollOffset(newTotal - this.#height - trailingRows, newTotal, this.#height);
		} else if (this.#followTail && wasAtTail) {
			this.#scrollOffset = maxScrollOffset(newTotal, this.#height);
		} else {
			this.#scrollOffset = clampScrollOffset(this.#scrollOffset, newTotal, this.#height);
		}
	}

	#shouldRenderScrollbar(rowCount: number, width: number): boolean {
		if (this.#height <= 0 || width <= 0 || this.#scrollbar === "never") return false;
		if (this.#scrollbar === "always") return true;
		return viewportOverflows(rowCount, this.#height);
	}
}
