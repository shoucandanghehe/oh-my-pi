import {
	type AppViewportHoverProvider,
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
	type VirtualViewportFrame,
	type VirtualViewportProvider,
} from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

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
	implements
		Component,
		MouseRoutable,
		TargetedRender,
		ViewportHeightAware,
		ComponentViewportTailProvider,
		AppViewportHoverProvider
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
	#selectionStickyStart = 0;
	#renderWidth = 0;
	#tailFrameActive = false;
	#tailHasOverflow = false;
	#virtualFrameActive = false;
	#textSelectionActive = false;
	#returnToBottomVisible = false;
	#returnToBottomRow = -1;
	#returnToBottomCol = -1;
	#returnToBottomHovered = false;

	constructor(options: MainSessionPaneOptions) {
		this.#scrollRoot = options.scrollRoot;
		this.#stickyRoot = options.stickyRoot;
		this.#requestRender = options.requestRender;
		this.#requestComponentRender = options.requestComponentRender;
	}

	setViewportHeight(height: number): void {
		this.#height = Math.max(1, Math.trunc(height));
	}

	setTextSelectionActive(active: boolean): void {
		if (this.#textSelectionActive === active) return;
		this.#textSelectionActive = active;
		if (active) this.#followBottom = false;
	}

	wantsAppViewportHover(): boolean {
		return this.#returnToBottomVisible;
	}

	clearAppViewportHover(): void {
		if (!this.#returnToBottomHovered) return;
		this.#returnToBottomHovered = false;
		this.#requestViewportRender();
	}
	containsComponent(component: Component): boolean {
		return componentContains(this.#stickyRoot, component) || componentContains(this.#scrollRoot, component);
	}

	#materializeGeometry(): void {
		if (!this.#tailFrameActive || this.#virtualFrameActive) return;
		const width = Math.max(1, this.#renderWidth);
		const sticky = this.#stickyRoot.render(width);
		const scroll = this.#scrollRoot.render(Math.max(1, width - 1));
		this.#renderFrame(width, scroll, sticky);
	}

	#materializeInputGeometry(): void {
		if (this.#virtualScrollProvider()) return;
		this.#materializeGeometry();
	}

	getTextSelection(selection: TextSelectionRange): string | undefined {
		this.#materializeGeometry();
		const normalized = normalizeTextSelection(selection);
		const intersectsScrollViewport = normalized.start.row < this.#selectionViewportHeight && normalized.end.row >= 0;
		if (
			this.#virtualFrameActive &&
			intersectsScrollViewport &&
			normalized.start.row >= 0 &&
			normalized.end.row < this.#selectionViewportHeight
		) {
			return this.#virtualScrollProvider()?.getVirtualTextSelection?.(Math.max(1, this.#renderWidth - 1), {
				start: { row: normalized.start.row + this.#offset, col: normalized.start.col },
				end: { row: normalized.end.row + this.#offset, col: normalized.end.col },
			});
		}
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
		const stickyStart = this.#selectionStickyStart;
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
		const visibleScrollRows = this.#virtualFrameActive
			? this.#selectionViewportHeight
			: Math.min(this.#selectionViewportHeight, Math.max(0, this.#selectionScrollLines.length - this.#offset));
		if (localRow >= 0 && localRow < visibleScrollRows) {
			if (this.#virtualFrameActive) {
				return (
					this.#virtualScrollProvider()?.getVirtualTextSelectionInset?.(
						Math.max(1, this.#renderWidth - 1),
						localRow + this.#offset,
					) ?? 0
				);
			}
			if (this.#tailFrameActive) {
				const plain = Bun.stripANSI(this.#cachedVisibleScrollLines[localRow] ?? "");
				return plain.length - plain.trimStart().length;
			}
			return this.#scrollRoot.getTextSelectionInset?.(localRow + this.#offset) ?? 0;
		}
		const stickyStart = this.#selectionStickyStart;
		if (localRow >= stickyStart && localRow < stickyStart + this.#selectionStickyLines.length) {
			return this.#stickyRoot.getTextSelectionInset?.(localRow - stickyStart) ?? 0;
		}
		return 0;
	}

	getTextSelectionRightInset(row: number): number {
		this.#materializeGeometry();
		const localRow = Math.trunc(row);
		if (localRow >= 0 && localRow < this.#selectionViewportHeight) {
			if (this.#virtualFrameActive) {
				return (
					this.#virtualScrollProvider()?.getVirtualTextSelectionRightInset?.(
						Math.max(1, this.#renderWidth - 1),
						localRow + this.#offset,
					) ?? 0
				);
			}
			if (this.#tailFrameActive) {
				const plain = Bun.stripANSI(this.#cachedVisibleScrollLines[localRow] ?? "");
				return 1 + plain.length - plain.trimEnd().length;
			}
			const contentRow = localRow + this.#offset;
			return 1 + (this.#scrollRoot.getTextSelectionRightInset?.(contentRow) ?? 0);
		}
		const stickyStart = this.#selectionStickyStart;
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
			if (!this.#virtualFrameActive) this.#materializeInputGeometry();
			this.#offset = 0;
			this.#followBottom = false;
			this.#virtualFrameActive = false;
			this.#requestViewportRender();
		} else if (matchesKey(data, "alt+end")) {
			this.#jumpToBottom();
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
		if (this.#virtualScrollProvider() || this.#followBottom) {
			return this.renderViewportTailTargeted(width, this.#height, targets);
		}
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
		this.#virtualFrameActive = false;
		this.#cachedScrollLines = scroll;
		this.#selectionStickyLines = sticky;
		this.#renderWidth = width;
		if (sticky.length >= this.#height) {
			this.#selectionScrollLines = [];
			this.#selectionViewportHeight = 0;
			this.#selectionStickyStart = 0;
			this.#clearReturnToBottomControl();
			return sticky.slice(-this.#height);
		}
		const viewportHeight = this.#scrollViewportHeight(sticky.length);
		this.#maxOffset = Math.max(0, scroll.length - viewportHeight);
		this.#offset = this.#followBottom ? this.#maxOffset : Math.max(0, Math.min(this.#offset, this.#maxOffset));
		this.#followBottom = !this.#textSelectionActive && this.#offset >= this.#maxOffset;
		const visible = scroll.slice(this.#offset, this.#offset + viewportHeight);
		this.#cachedVisibleScrollLines = visible;
		this.#selectionScrollLines = scroll;
		this.#selectionViewportHeight = viewportHeight;
		this.#selectionStickyStart = viewportHeight;
		const rendered = [...this.#renderScrollWindow(visible, width, viewportHeight, scroll.length, this.#offset)];
		const renderedSticky = this.#renderStickyWithReturnControl(width, viewportHeight, sticky);
		return [...rendered, ...renderedSticky];
	}

	renderViewportTail(width: number, maxRows: number): readonly string[] {
		const requested = Math.max(0, Math.min(this.#height, Math.trunc(maxRows)));
		if (requested === 0) return [];
		const sticky = this.#stickyRoot.render(width);
		const viewportHeight = this.#scrollViewportHeight(sticky.length);
		const virtualFrame = this.#renderVirtualScroll(width, viewportHeight);
		if (virtualFrame) {
			this.#tailHasOverflow = virtualFrame.estimatedTotalRows > viewportHeight;
			return this.#renderTailFrame(width, virtualFrame.lines, sticky, requested, virtualFrame);
		}
		if (!this.#followBottom) return this.render(width).slice(-requested);
		const scroll = this.#renderScrollTail(width, viewportHeight);
		return this.#renderTailFrame(width, scroll, sticky, requested);
	}

	renderViewportTailTargeted(width: number, maxRows: number, targets: readonly Component[]): readonly string[] {
		const requested = Math.max(0, Math.min(this.#height, Math.trunc(maxRows)));
		if (requested === 0) return [];
		const virtualProvider = this.#virtualScrollProvider();
		if (!this.#followBottom && !virtualProvider) return this.#renderTargetedFull(width, targets).slice(-requested);
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
		const viewportHeight = this.#scrollViewportHeight(sticky.length);
		const shouldRenderScroll =
			scrollTargets.length > 0 ||
			!this.#virtualFrameActive ||
			this.#renderWidth !== width ||
			this.#cachedVisibleScrollLines.length !== viewportHeight;
		const virtualFrame = virtualProvider
			? shouldRenderScroll
				? scrollTargets.length > 0 && virtualProvider.renderVirtualViewportTargeted
					? virtualProvider.renderVirtualViewportTargeted(
							Math.max(1, width - 1),
							{
								rows: viewportHeight,
								offset: this.#offset,
								followBottom: this.#followBottom,
							},
							scrollTargets,
						)
					: virtualProvider.renderVirtualViewport(Math.max(1, width - 1), {
							rows: viewportHeight,
							offset: this.#offset,
							followBottom: this.#followBottom,
						})
				: {
						lines: this.#cachedVisibleScrollLines,
						estimatedTotalRows: this.#maxOffset + viewportHeight,
						offset: this.#offset,
					}
			: undefined;
		if (virtualFrame) {
			this.#tailHasOverflow = virtualFrame.estimatedTotalRows > viewportHeight;
			return this.#renderTailFrame(width, virtualFrame.lines, sticky, requested, virtualFrame);
		}
		const scroll =
			scrollTargets.length > 0 || !this.#tailFrameActive || this.#cachedVisibleScrollLines.length !== viewportHeight
				? this.#renderScrollTail(width, viewportHeight)
				: this.#cachedVisibleScrollLines;
		return this.#renderTailFrame(width, scroll, sticky, requested);
	}

	#virtualScrollProvider(): VirtualViewportProvider | undefined {
		const candidate = this.#scrollRoot as Component & Partial<VirtualViewportProvider>;
		return typeof candidate.hasVirtualViewport === "function" &&
			candidate.hasVirtualViewport() &&
			typeof candidate.getEstimatedVirtualRows === "function" &&
			typeof candidate.renderVirtualViewport === "function"
			? (candidate as VirtualViewportProvider)
			: undefined;
	}

	#renderVirtualScroll(width: number, viewportHeight: number): VirtualViewportFrame | undefined {
		return this.#virtualScrollProvider()?.renderVirtualViewport(Math.max(1, width - 1), {
			rows: viewportHeight,
			offset: this.#offset,
			followBottom: this.#followBottom,
		});
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
		virtualFrame?: VirtualViewportFrame,
	): readonly string[] {
		this.#tailFrameActive = true;
		this.#virtualFrameActive = virtualFrame !== undefined;
		this.#cachedVisibleScrollLines = scroll;
		this.#selectionStickyLines = sticky;
		this.#renderWidth = width;
		if (sticky.length >= this.#height) {
			this.#selectionViewportHeight = 0;
			this.#selectionStickyStart = 0;
			this.#clearReturnToBottomControl();
			return sticky.slice(-this.#height).slice(-requested);
		}
		const viewportHeight = this.#scrollViewportHeight(sticky.length);
		const totalRows =
			virtualFrame?.estimatedTotalRows ?? (this.#tailHasOverflow ? viewportHeight + 1 : scroll.length);
		const offset = virtualFrame?.offset ?? (this.#tailHasOverflow ? 1 : 0);
		this.#maxOffset = Math.max(0, totalRows - viewportHeight);
		this.#offset = Math.max(0, Math.min(offset, this.#maxOffset));
		this.#selectionViewportHeight = viewportHeight;
		this.#selectionStickyStart = viewportHeight;
		const rendered = [...this.#renderScrollWindow(scroll, width, viewportHeight, totalRows, this.#offset)];
		const renderedSticky = this.#renderStickyWithReturnControl(width, viewportHeight, sticky);
		return [...rendered, ...renderedSticky].slice(-requested);
	}
	#scrollViewportHeight(stickyRows: number): number {
		return Math.max(0, this.#height - Math.min(stickyRows, this.#height));
	}

	#renderStickyWithReturnControl(width: number, viewportHeight: number, sticky: readonly string[]): string[] {
		const renderedSticky = [...sticky];
		if (renderedSticky.length === 0 || Bun.stripANSI(renderedSticky[0] ?? "").trim().length > 0) {
			this.#clearReturnToBottomControl();
			return renderedSticky;
		}
		renderedSticky[0] = this.#renderReturnToBottomControl(width, viewportHeight);
		return renderedSticky;
	}

	#renderReturnToBottomControl(width: number, row: number): string {
		this.#returnToBottomRow = row;
		this.#returnToBottomCol = Math.max(0, Math.trunc(width) - 1);
		this.#returnToBottomVisible = !this.#followBottom && this.#offset < this.#maxOffset;
		if (!this.#returnToBottomVisible) {
			this.#returnToBottomHovered = false;
			return "";
		}
		const glyph = theme?.fg(this.#returnToBottomHovered ? "text" : "muted", "▽") ?? "▽";
		return `${" ".repeat(this.#returnToBottomCol)}${glyph}`;
	}

	#clearReturnToBottomControl(): void {
		this.#returnToBottomVisible = false;
		this.#returnToBottomHovered = false;
		this.#returnToBottomRow = -1;
		this.#returnToBottomCol = -1;
	}

	#returnToBottomContains(row: number, col: number): boolean {
		return (
			this.#returnToBottomVisible &&
			row === this.#returnToBottomRow &&
			col >= Math.max(0, this.#returnToBottomCol - 2) &&
			col <= this.#returnToBottomCol
		);
	}

	#jumpToBottom(): void {
		this.#offset = this.#maxOffset;
		this.#followBottom = true;
		this.#returnToBottomHovered = false;
		this.#virtualFrameActive = false;
		this.#requestViewportRender();
	}

	invalidate(): void {
		this.#tailFrameActive = false;
		this.#virtualFrameActive = false;
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
			if (!this.#virtualFrameActive) this.#materializeInputGeometry();
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
		if (event.motion) {
			const hovered = this.#returnToBottomContains(row, col);
			if (hovered !== this.#returnToBottomHovered) {
				this.#returnToBottomHovered = hovered;
				this.#requestViewportRender();
				return true;
			}
			if (hovered) return true;
		}
		if (!event.leftClick) return false;
		if (this.#returnToBottomContains(row, col)) {
			this.#jumpToBottom();
			return true;
		}
		if (!this.#virtualFrameActive && this.#tailFrameActive && this.#tailHasOverflow && col === this.#width - 1) {
			this.#materializeInputGeometry();
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
		this.#virtualFrameActive = false;
		this.#requestViewportRender();
	}

	#scroll(delta: number): void {
		if (delta < 0 && this.#followBottom && this.#virtualFrameActive) {
			const provider = this.#virtualScrollProvider();
			if (provider) {
				this.#maxOffset = Math.max(
					0,
					provider.getEstimatedVirtualRows(Math.max(1, this.#renderWidth - 1)) - this.#selectionViewportHeight,
				);
				this.#offset = this.#maxOffset;
			}
		} else if (delta < 0 && !this.#virtualFrameActive) {
			this.#materializeInputGeometry();
		}
		this.#offset = Math.max(0, Math.min(this.#maxOffset, this.#offset + delta));
		this.#followBottom = this.#offset >= this.#maxOffset;
		this.#virtualFrameActive = false;
		this.#requestViewportRender();
	}

	#requestViewportRender(): void {
		if (this.#requestComponentRender) this.#requestComponentRender(this.#stickyRoot);
		else this.#requestRender();
	}
}
