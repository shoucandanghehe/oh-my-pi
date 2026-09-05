import {
	appendBrailleScrollbar,
	type BrailleScrollbarMetrics,
	type Component,
	extractComponentTextSelection,
	layoutBrailleScrollbar,
	type MouseRoutable,
	matchesKey,
	normalizeTextSelection,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TextSelectionRange,
	type ViewportHeightAware,
	type ViewportTailProvider,
} from "@oh-my-pi/pi-tui";

export interface MainSessionPaneOptions {
	scrollRoot: Component;
	stickyRoot: Component;
	requestRender: () => void;
}

/**
 * Fixed-height main-session surface for app-viewport workspaces. Transcript and
 * transient HUD rows scroll together while status/editor chrome stays pinned.
 */
export class MainSessionPane implements Component, MouseRoutable, ViewportHeightAware, ViewportTailProvider {
	readonly #scrollRoot: Component;
	readonly #stickyRoot: Component;
	readonly #requestRender: () => void;
	#lastScrollRows = 0;
	#height = 1;
	#offset = 0;
	#maxOffset = 0;
	#followBottom = true;
	#width = 1;
	#scrollbarHeight = 0;
	#scrollbarMetrics: BrailleScrollbarMetrics | null = null;
	#scrollbarDrag: { grabOffsetRows: number } | undefined;
	#selectionScrollLines: readonly string[] = [];
	#selectionStickyLines: readonly string[] = [];
	#selectionViewportHeight = 0;

	constructor(options: MainSessionPaneOptions) {
		this.#scrollRoot = options.scrollRoot;
		this.#stickyRoot = options.stickyRoot;
		this.#requestRender = options.requestRender;
	}

	setViewportHeight(height: number): void {
		this.#height = Math.max(1, Math.trunc(height));
	}

	getTextSelection(selection: TextSelectionRange): string | undefined {
		const normalized = normalizeTextSelection(selection);
		const startContentRow = normalized.start.row + this.#offset;
		const endContentRow = normalized.end.row + this.#offset;
		const intersectsScrollViewport = normalized.start.row < this.#selectionViewportHeight && normalized.end.row >= 0;
		if (intersectsScrollViewport && startContentRow >= 0 && endContentRow < this.#selectionScrollLines.length) {
			return extractComponentTextSelection(this.#scrollRoot, this.#selectionScrollLines, {
				start: {
					row: startContentRow,
					col: normalized.start.col,
				},
				end: {
					row: endContentRow,
					col: normalized.end.col,
				},
			});
		}
		const stickyStart = this.#selectionViewportHeight;
		if (normalized.start.row >= stickyStart && normalized.end.row < stickyStart + this.#selectionStickyLines.length) {
			return extractComponentTextSelection(this.#stickyRoot, this.#selectionStickyLines, {
				start: {
					row: normalized.start.row - stickyStart,
					col: normalized.start.col,
				},
				end: {
					row: normalized.end.row - stickyStart,
					col: normalized.end.col,
				},
			});
		}
		return undefined;
	}

	getTextSelectionInset(row: number): number {
		const localRow = Math.trunc(row);
		const visibleScrollRows = Math.min(
			this.#selectionViewportHeight,
			Math.max(0, this.#selectionScrollLines.length - this.#offset),
		);
		if (localRow >= 0 && localRow < visibleScrollRows) {
			return this.#scrollRoot.getTextSelectionInset?.(localRow + this.#offset) ?? 0;
		}
		const stickyStart = this.#selectionViewportHeight;
		if (localRow >= stickyStart && localRow < stickyStart + this.#selectionStickyLines.length) {
			return this.#stickyRoot.getTextSelectionInset?.(localRow - stickyStart) ?? 0;
		}
		return 0;
	}

	getTextSelectionRightInset(row: number): number {
		const localRow = Math.trunc(row);
		if (localRow >= 0 && localRow < this.#selectionViewportHeight) {
			const contentRow = localRow + this.#offset;
			return 1 + (this.#scrollRoot.getTextSelectionRightInset?.(contentRow) ?? 0);
		}
		const stickyStart = this.#selectionViewportHeight;
		if (localRow >= stickyStart && localRow < stickyStart + this.#selectionStickyLines.length) {
			return this.#stickyRoot.getTextSelectionRightInset?.(localRow - stickyStart) ?? 0;
		}
		return 0;
	}

	getTextSelectionScrollOffset(row: number): number | undefined {
		const localRow = Math.trunc(row);
		return localRow >= 0 && localRow < this.#selectionViewportHeight ? this.#offset : undefined;
	}

	handleInput(data: string): void {
		if (routeSgrMouseInput(data, event => this.#handleMouse(event, event.row, event.col))) {
			return;
		}
		const page = Math.max(1, this.#height - 2);
		if (matchesKey(data, "pageUp") || matchesKey(data, "alt+pageUp")) {
			this.#scroll(-page);
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "alt+pageDown")) {
			this.#scroll(page);
		} else if (matchesKey(data, "alt+home")) {
			this.#offset = 0;
			this.#followBottom = false;
			this.#requestRender();
		} else if (matchesKey(data, "alt+end")) {
			this.#offset = this.#maxOffset;
			this.#followBottom = true;
			this.#requestRender();
		}
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		return this.#handleMouse(event, line, col);
	}

	render(width: number): readonly string[] {
		const sticky = this.#stickyRoot.render(width);
		this.#selectionStickyLines = sticky;
		if (sticky.length >= this.#height) {
			this.#selectionScrollLines = [];
			this.#selectionViewportHeight = 0;
			return sticky.slice(-this.#height);
		}
		const viewportHeight = this.#height - sticky.length;
		const scroll = this.#scrollRoot.render(Math.max(1, width - 1));
		this.#lastScrollRows = scroll.length;
		this.#maxOffset = Math.max(0, scroll.length - viewportHeight);
		this.#offset = this.#followBottom ? this.#maxOffset : Math.max(0, Math.min(this.#offset, this.#maxOffset));
		const visible = scroll.slice(this.#offset, this.#offset + viewportHeight);
		this.#selectionScrollLines = scroll;
		this.#selectionViewportHeight = viewportHeight;
		return [...this.#renderScrollWindow(visible, width, viewportHeight, scroll.length, this.#offset), ...sticky];
	}

	renderViewportTail(width: number, maxRows: number): readonly string[] {
		const requested = Math.max(0, Math.min(this.#height, Math.trunc(maxRows)));
		if (requested === 0) return [];
		if (!this.#followBottom) return this.render(width).slice(-requested);
		const sticky = this.#stickyRoot.render(width);
		if (sticky.length >= this.#height) return sticky.slice(-this.#height).slice(-requested);
		const viewportHeight = this.#height - sticky.length;
		const scrollWidth = Math.max(1, width - 1);
		const provider = this.#scrollRoot as Component & Partial<ViewportTailProvider>;
		const scroll = provider.renderViewportTail
			? provider.renderViewportTail(scrollWidth, viewportHeight)
			: this.#scrollRoot.render(scrollWidth).slice(-viewportHeight);
		const visible = scroll.length > viewportHeight ? scroll.slice(-viewportHeight) : scroll;
		const totalRows = Math.max(this.#lastScrollRows, visible.length);
		const offset = Math.max(0, totalRows - viewportHeight);
		const rendered = this.#renderScrollWindow(visible, width, viewportHeight, totalRows, offset);
		return [...rendered, ...sticky].slice(-requested);
	}

	invalidate(): void {
		this.#scrollRoot.invalidate?.();
		this.#stickyRoot.invalidate?.();
	}

	dispose(): void {
		this.#scrollRoot.dispose?.();
		this.#stickyRoot.dispose?.();
	}

	#renderScrollWindow(
		lines: readonly string[],
		width: number,
		height: number,
		totalRows: number,
		offset: number,
	): readonly string[] {
		const windowLines = Array.from({ length: height }, (_value, row) => lines[row] ?? "");
		const scrollbar = layoutBrailleScrollbar(height, totalRows, offset);
		this.#width = Math.max(0, Math.trunc(width));
		this.#scrollbarHeight = height;
		this.#scrollbarMetrics = scrollbar.metrics;
		return appendBrailleScrollbar(windowLines, scrollbar.glyphs, width);
	}

	#handleMouse(event: SgrMouseEvent, row: number, col: number): boolean {
		if (event.wheel !== null) {
			this.#scrollbarDrag = undefined;
			this.#scroll(event.wheel * 3);
			return true;
		}
		if (event.release) {
			const handled = this.#scrollbarDrag !== undefined;
			this.#scrollbarDrag = undefined;
			return handled;
		}
		if (this.#scrollbarDrag) {
			if (event.motion) this.#dragScrollbar(row);
			return true;
		}
		if (!event.leftClick) return false;
		const metrics = this.#scrollbarMetrics;
		if (!metrics || metrics.maxOffset <= 0 || col !== this.#width - 1) return false;
		if (row < 0 || row >= this.#scrollbarHeight) return false;
		const inThumb = row >= metrics.thumbTopRow && row < metrics.thumbTopRow + metrics.thumbRows;
		const fallbackOffset = Math.max(0, (metrics.thumbRows - 1) / 2);
		const grabOffsetRows = inThumb ? row - metrics.thumbTopRow : fallbackOffset;
		this.#scrollbarDrag = {
			grabOffsetRows: Math.max(0, Math.min(grabOffsetRows, Math.max(0, metrics.thumbRows - 1))),
		};
		this.#dragScrollbar(row);
		return true;
	}

	#dragScrollbar(row: number): void {
		const metrics = this.#scrollbarMetrics;
		const drag = this.#scrollbarDrag;
		if (!metrics || !drag || metrics.maxOffset <= 0) return;
		const boundedRow = Math.max(0, Math.min(row, this.#scrollbarHeight - 1));
		const thumbTop = Math.max(0, Math.min(boundedRow - drag.grabOffsetRows, metrics.travelRows));
		const nextOffset = metrics.travelRows <= 0 ? 0 : Math.round((thumbTop / metrics.travelRows) * metrics.maxOffset);
		this.#offset = Math.max(0, Math.min(nextOffset, metrics.maxOffset));
		this.#followBottom = this.#offset >= metrics.maxOffset;
		this.#requestRender();
	}

	#scroll(delta: number): void {
		this.#offset = Math.max(0, Math.min(this.#maxOffset, this.#offset + delta));
		this.#followBottom = this.#offset >= this.#maxOffset;
		this.#requestRender();
	}
}
