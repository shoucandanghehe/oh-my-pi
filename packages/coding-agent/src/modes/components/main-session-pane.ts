import {
	appendBrailleScrollbar,
	type BrailleScrollbarMetrics,
	type Component,
	type ComponentViewportTailProvider,
	componentContains,
	extractComponentTextSelection,
	extractRenderedTextSelection,
	layoutBrailleScrollbar,
	type MouseRoutable,
	matchesKey,
	normalizeTextSelection,
	renderTargeted,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TargetedRender,
	type TextSelectionRange,
	type ViewportHeightAware,
	type ViewportTailProvider,
} from "@oh-my-pi/pi-tui";

export interface MainSessionPaneOptions {
	scrollRoot: Component;
	stickyRoot: Component;
	requestRender: () => void;
	requestComponentRender?: (component: Component) => void;
}

/**
 * Fixed-height main-session surface for app-viewport workspaces. Transcript and
 * transient HUD rows scroll together while status/editor chrome stays pinned.
 */
export class MainSessionPane
	implements Component, MouseRoutable, TargetedRender, ViewportHeightAware, ComponentViewportTailProvider
{
	readonly componentViewportTail = true;
	readonly #scrollRoot: Component;
	readonly #stickyRoot: Component;
	readonly #requestRender: () => void;
	readonly #requestComponentRender: ((component: Component) => void) | undefined;
	#height = 1;
	#offset = 0;
	#maxOffset = 0;
	#followBottom = true;
	#width = 1;
	#scrollbarHeight = 0;
	#scrollbarMetrics: BrailleScrollbarMetrics | null = null;
	#scrollbarDrag: { grabOffsetRows: number } | undefined;
	#cachedScrollLines: readonly string[] = [];
	#cachedVisibleScrollLines: readonly string[] = [];
	#selectionScrollLines: readonly string[] = [];
	#selectionStickyLines: readonly string[] = [];
	#selectionViewportHeight = 0;
	#renderWidth = 0;
	#tailFrameActive = false;
	#tailHasOverflow = false;

	constructor(options: MainSessionPaneOptions) {
		this.#scrollRoot = options.scrollRoot;
		this.#stickyRoot = options.stickyRoot;
		this.#requestRender = options.requestRender;
		this.#requestComponentRender = options.requestComponentRender;
	}

	setViewportHeight(height: number): void {
		this.#height = Math.max(1, Math.trunc(height));
	}
	containsComponent(component: Component): boolean {
		return componentContains(this.#stickyRoot, component) || componentContains(this.#scrollRoot, component);
	}

	#materializeGeometry(): void {
		if (!this.#tailFrameActive) return;
		const width = Math.max(1, this.#renderWidth);
		const sticky = this.#stickyRoot.render(width);
		const scroll = this.#scrollRoot.render(Math.max(1, width - 1));
		this.#renderFrame(width, scroll, sticky);
	}

	getTextSelection(selection: TextSelectionRange): string | undefined {
		this.#materializeGeometry();
		const normalized = normalizeTextSelection(selection);
		const intersectsScrollViewport = normalized.start.row < this.#selectionViewportHeight && normalized.end.row >= 0;
		if (
			this.#tailFrameActive &&
			intersectsScrollViewport &&
			normalized.start.row >= 0 &&
			normalized.end.row < this.#cachedVisibleScrollLines.length
		) {
			return extractRenderedTextSelection(this.#cachedVisibleScrollLines, normalized);
		}
		const startContentRow = normalized.start.row + this.#offset;
		const endContentRow = normalized.end.row + this.#offset;
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
		this.#materializeGeometry();
		const localRow = Math.trunc(row);
		const visibleScrollRows = Math.min(
			this.#selectionViewportHeight,
			Math.max(0, this.#selectionScrollLines.length - this.#offset),
		);
		if (localRow >= 0 && localRow < visibleScrollRows) {
			if (this.#tailFrameActive) {
				const plain = Bun.stripANSI(this.#cachedVisibleScrollLines[localRow] ?? "");
				return plain.length - plain.trimStart().length;
			}
			return this.#scrollRoot.getTextSelectionInset?.(localRow + this.#offset) ?? 0;
		}
		const stickyStart = this.#selectionViewportHeight;
		if (localRow >= stickyStart && localRow < stickyStart + this.#selectionStickyLines.length) {
			return this.#stickyRoot.getTextSelectionInset?.(localRow - stickyStart) ?? 0;
		}
		return 0;
	}

	getTextSelectionRightInset(row: number): number {
		this.#materializeGeometry();
		const localRow = Math.trunc(row);
		if (localRow >= 0 && localRow < this.#selectionViewportHeight) {
			if (this.#tailFrameActive) {
				const plain = Bun.stripANSI(this.#cachedVisibleScrollLines[localRow] ?? "");
				return 1 + plain.length - plain.trimEnd().length;
			}
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
		this.#materializeGeometry();
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
			this.#materializeGeometry();
			this.#offset = 0;
			this.#followBottom = false;
			this.#requestViewportRender();
		} else if (matchesKey(data, "alt+end")) {
			this.#offset = this.#maxOffset;
			this.#followBottom = true;
			this.#requestViewportRender();
		}
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		return this.#handleMouse(event, line, col);
	}

	render(width: number): readonly string[] {
		const sticky = this.#stickyRoot.render(width);
		const scroll = this.#scrollRoot.render(Math.max(1, width - 1));
		return this.#renderFrame(width, scroll, sticky);
	}

	renderTargeted(width: number, targets: readonly Component[]): readonly string[] {
		if (this.#followBottom) return this.renderViewportTailTargeted(width, this.#height, targets);
		return this.#renderTargetedFull(width, targets);
	}

	#renderTargetedFull(width: number, targets: readonly Component[]): readonly string[] {
		const scrollTargets: Component[] = [];
		const stickyTargets: Component[] = [];
		for (const target of targets) {
			if (componentContains(this.#stickyRoot, target)) {
				stickyTargets.push(target);
			} else if (componentContains(this.#scrollRoot, target)) {
				scrollTargets.push(target);
			} else {
				return this.render(width);
			}
		}
		const sticky =
			stickyTargets.length > 0 ? renderTargeted(this.#stickyRoot, width, stickyTargets) : this.#selectionStickyLines;
		const scroll =
			scrollTargets.length > 0
				? renderTargeted(this.#scrollRoot, Math.max(1, width - 1), scrollTargets)
				: this.#cachedScrollLines;
		return this.#renderFrame(width, scroll, sticky);
	}

	#renderFrame(width: number, scroll: readonly string[], sticky: readonly string[]): readonly string[] {
		this.#tailFrameActive = false;
		this.#cachedScrollLines = scroll;
		this.#selectionStickyLines = sticky;
		this.#renderWidth = width;
		if (sticky.length >= this.#height) {
			this.#selectionScrollLines = [];
			this.#selectionViewportHeight = 0;
			return sticky.slice(-this.#height);
		}
		const viewportHeight = this.#height - sticky.length;
		this.#maxOffset = Math.max(0, scroll.length - viewportHeight);
		this.#offset = this.#followBottom ? this.#maxOffset : Math.max(0, Math.min(this.#offset, this.#maxOffset));
		this.#followBottom = this.#offset >= this.#maxOffset;
		const visible = scroll.slice(this.#offset, this.#offset + viewportHeight);
		this.#cachedVisibleScrollLines = visible;
		this.#selectionScrollLines = scroll;
		this.#selectionViewportHeight = viewportHeight;
		return [...this.#renderScrollWindow(visible, width, viewportHeight, scroll.length, this.#offset), ...sticky];
	}

	renderViewportTail(width: number, maxRows: number): readonly string[] {
		const requested = Math.max(0, Math.min(this.#height, Math.trunc(maxRows)));
		if (requested === 0) return [];
		// Follow-bottom frames need no authoritative history geometry: render only
		// the visible tail from the first paint onward. History navigation flips
		// #followBottom off and materializes the full transcript on demand.
		if (!this.#followBottom) return this.render(width).slice(-requested);
		const sticky = this.#stickyRoot.render(width);
		const viewportHeight = Math.max(0, this.#height - Math.min(sticky.length, this.#height));
		const scroll = this.#renderScrollTail(width, viewportHeight);
		return this.#renderTailFrame(width, scroll, sticky, requested);
	}

	renderViewportTailTargeted(width: number, maxRows: number, targets: readonly Component[]): readonly string[] {
		const requested = Math.max(0, Math.min(this.#height, Math.trunc(maxRows)));
		if (requested === 0) return [];
		if (!this.#followBottom) return this.#renderTargetedFull(width, targets).slice(-requested);
		const scrollTargets: Component[] = [];
		const stickyTargets: Component[] = [];
		for (const target of targets) {
			if (target === this) return this.renderViewportTail(width, requested);
			if (componentContains(this.#stickyRoot, target)) {
				stickyTargets.push(target);
			} else if (componentContains(this.#scrollRoot, target)) {
				scrollTargets.push(target);
			} else {
				return this.renderViewportTail(width, requested);
			}
		}
		const sticky =
			stickyTargets.length > 0
				? renderTargeted(this.#stickyRoot, width, stickyTargets)
				: this.#tailFrameActive
					? this.#selectionStickyLines
					: this.#stickyRoot.render(width);
		const viewportHeight = Math.max(0, this.#height - Math.min(sticky.length, this.#height));
		const scroll =
			scrollTargets.length > 0 || !this.#tailFrameActive || this.#cachedVisibleScrollLines.length !== viewportHeight
				? this.#renderScrollTail(width, viewportHeight)
				: this.#cachedVisibleScrollLines;
		return this.#renderTailFrame(width, scroll, sticky, requested);
	}

	#renderScrollTail(width: number, viewportHeight: number): readonly string[] {
		if (viewportHeight <= 0) {
			this.#tailHasOverflow = false;
			return [];
		}
		const scrollWidth = Math.max(1, width - 1);
		const provider = this.#scrollRoot as Component & Partial<ViewportTailProvider>;
		const requested = viewportHeight + 1;
		const scroll = provider.renderViewportTail
			? provider.renderViewportTail(scrollWidth, requested)
			: this.#scrollRoot.render(scrollWidth).slice(-requested);
		this.#tailHasOverflow = scroll.length > viewportHeight;
		return this.#tailHasOverflow ? scroll.slice(-viewportHeight) : scroll;
	}

	#renderTailFrame(
		width: number,
		scroll: readonly string[],
		sticky: readonly string[],
		requested: number,
	): readonly string[] {
		this.#tailFrameActive = true;
		this.#cachedVisibleScrollLines = scroll;
		this.#selectionStickyLines = sticky;
		this.#renderWidth = width;
		if (sticky.length >= this.#height) {
			this.#selectionViewportHeight = 0;
			return sticky.slice(-this.#height).slice(-requested);
		}
		const viewportHeight = this.#height - sticky.length;
		// Exact wrapped history geometry is intentionally deferred. One extra tail
		// row is enough to retain an overflow affordance; history interaction then
		// materializes the authoritative total and offset.
		const totalRows = this.#tailHasOverflow ? viewportHeight + 1 : scroll.length;
		const offset = this.#tailHasOverflow ? 1 : 0;
		this.#maxOffset = offset;
		this.#offset = offset;
		this.#selectionViewportHeight = viewportHeight;
		const rendered = this.#renderScrollWindow(scroll, width, viewportHeight, totalRows, offset);
		return [...rendered, ...sticky].slice(-requested);
	}

	invalidate(): void {
		this.#tailFrameActive = false;
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
			this.#materializeGeometry();
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
		if (this.#tailFrameActive && this.#tailHasOverflow && col === this.#width - 1) {
			this.#materializeGeometry();
		}
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
		const ratio = metrics.maxOffset <= 0 ? 1 : nextOffset / metrics.maxOffset;
		this.#offset = Math.max(0, Math.min(nextOffset, metrics.maxOffset));
		this.#followBottom = ratio >= 1;
		this.#requestViewportRender();
	}

	#scroll(delta: number): void {
		if (delta < 0) this.#materializeGeometry();
		this.#offset = Math.max(0, Math.min(this.#maxOffset, this.#offset + delta));
		this.#followBottom = this.#offset >= this.#maxOffset;
		this.#requestViewportRender();
	}

	#requestViewportRender(): void {
		if (this.#requestComponentRender) this.#requestComponentRender(this.#stickyRoot);
		else this.#requestRender();
	}
}
