import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type AppViewportHoverProvider,
	type AutocompleteProvider,
	type Component,
	componentContains,
	type EditorTopBorder,
	extractComponentTextSelection,
	type Focusable,
	type MouseRoutable,
	matchesKey,
	normalizeTextSelection,
	renderTargeted,
	routeSgrMouseInput,
	ScrollView,
	type SgrMouseEvent,
	type TargetedRender,
	type TextSelectionRange,
	type ViewportHeightAware,
	type VirtualViewportFrame,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { KeyId } from "../../config/keybindings";
import type { SessionMessageEntry } from "../../session/session-entries";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import { compactImageMarkers } from "../composer-attachments";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { ChatTranscriptBuilder, type ChatTranscriptBuilderDeps } from "./chat-transcript-builder";
import { CustomEditor } from "./custom-editor";

export type ChatTranscriptPaneEditorOptions =
	| {
			label: string;
			placeholder: string;
			readOnly?: false;
			onSubmit: (text: string, images?: ImageContent[], key?: string) => boolean;
			images?: boolean;
			autocompleteProvider?: AutocompleteProvider;
	  }
	| {
			label: string;
			placeholder: string;
			readOnly: true;
			onSubmit?: never;
			autocompleteProvider?: undefined;
	  };

export interface ChatTranscriptPaneOptions {
	builder: ChatTranscriptBuilderDeps;
	initialEntryId?: string;
	editor?: ChatTranscriptPaneEditorOptions;
	expandKeys: readonly KeyId[];
	getHeaderLines?: () => readonly string[];
	getFooterLines?: () => readonly string[];
	getHint?: (hasEditor: boolean) => string;
	renderWorkspaceHeader?: (width: number, focused: boolean) => string;
	getEditorTopBorder?: (availableWidth: number) => EditorTopBorder | undefined;
	getPlaceholder: (maxWidth: number) => string;
	getNotice?: () => string | undefined;
	onInput?: (data: string, editorEmpty: boolean) => boolean;
	onEditorChange?: (text: string, images: ImageContent[], imageLinks: (string | undefined)[], key?: string) => void;
	onClose: () => void;
}

function sanitizeNotice(text: string, maxWidth: number): string {
	const singleLine = replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\/[^\s'")\]]+/g, path => shortenPath(path));
	return truncateToWidth(singleLine, Math.max(10, maxWidth));
}

/** Shared transcript, scrolling, selection, editor, and pane chrome. */
export class ChatTranscriptPane
	implements Component, Focusable, MouseRoutable, TargetedRender, ViewportHeightAware, AppViewportHoverProvider
{
	readonly #builder: ChatTranscriptBuilder;
	readonly #scrollView = new ScrollView([], { height: 10, scrollbar: "auto", scrollbarStyle: "braille" });
	#editor: CustomEditor | undefined;
	readonly #editors = new Map<string | undefined, CustomEditor>();

	#followBottom = true;
	#focused = false;
	#notice: string | undefined;
	#viewportHeight: number | undefined;
	#scrollViewStartLine = 0;
	#selectionContentLines: readonly string[] = [];
	#selectionViewportHeight = 0;
	#initialEntryId: string | undefined;
	#cachedContentLines: readonly string[] = [];
	#cachedEditorLines: readonly string[] = [];
	#cachedNoticeLine: string | undefined;
	#renderWidth = 0;
	#renderHeight = 0;
	#hasFullFrame = false;
	#virtualContent = false;
	#estimatedTotalRows = 0;
	#returnToBottomVisible = false;
	#returnToBottomRow = -1;
	#returnToBottomCol = -1;
	#returnToBottomHovered = false;

	constructor(private readonly options: ChatTranscriptPaneOptions) {
		this.#builder = new ChatTranscriptBuilder(options.builder);
		this.#initialEntryId = options.initialEntryId;
		this.#editor = this.#createEditor();
	}

	#createEditor(key?: string): CustomEditor | undefined {
		const options = this.options;
		if (!options.editor) return undefined;
		const editor = new CustomEditor(getEditorTheme());
		const label = ` ${replaceTabs(options.editor.label)} `;
		editor.borderColor = text => theme.fg(editor.focused ? "accent" : "muted", text);
		editor.setTopBorderProvider(
			options.getEditorTopBorder ??
				(() => ({
					content: theme.fg("accent", label),
					width: visibleWidth(label),
				})),
		);
		editor.setPlaceholder(options.editor.placeholder);
		editor.setMaxHeight(4);
		editor.onExit = options.onClose;
		editor.disableSubmit = options.editor.readOnly === true;
		if (options.editor.autocompleteProvider) editor.setAutocompleteProvider(options.editor.autocompleteProvider);
		editor.onAutocompleteUpdate = () => options.builder.requestRender();
		editor.acceptsImagePaste = options.editor.readOnly !== true && options.editor.images === true;
		editor.onChange = () => {
			options.onEditorChange?.(editor.getExpandedText(), editor.pendingImages, editor.pendingImageLinks, key);
			options.builder.requestRender();
		};
		if (!editor.disableSubmit) editor.onSubmit = text => this.#submit(editor, text, key);
		this.#editors.set(key, editor);
		return editor;
	}
	getPasteTarget(): CustomEditor | undefined {
		return this.options.editor?.readOnly ? undefined : this.#editor;
	}

	/** Each thread keeps its own editor while clipboard reads are in flight. */
	selectEditor(
		key: string | undefined,
		text: string,
		images?: readonly ImageContent[],
		links?: readonly (string | undefined)[],
	): void {
		if (this.#editor) this.#editor.focused = false;
		let editor = this.#editors.get(key);
		if (!editor) {
			editor = this.#createEditor(key);
			if (editor) {
				const onChange = editor.onChange;
				editor.onChange = undefined;
				editor.setDraft(text, images);
				editor.pendingImageLinks = links ? [...links] : editor.pendingImageLinks;
				editor.imageLinks = editor.pendingImageLinks;
				editor.onChange = onChange;
			}
		}
		this.#editor = editor;
		this.focused = this.#focused;
	}

	retainEditors(keys: readonly string[]): void {
		for (const [key, editor] of this.#editors) {
			if (key === undefined || keys.includes(key)) continue;
			editor.onChange = undefined;
			editor.onSubmit = undefined;
			this.#editors.delete(key);
		}
	}

	get isEmpty(): boolean {
		return this.#builder.isEmpty;
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(focused: boolean) {
		this.#focused = focused;
		if (this.#editor) {
			this.#editor.focused = focused && this.options.editor?.readOnly !== true;
			this.#editor.setPlaceholder(focused ? undefined : this.options.editor?.placeholder);
		}
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#editor?.setUseTerminalCursor(useTerminalCursor);
	}

	renderWorkspaceHeader(width: number, focused: boolean): string {
		return this.options.renderWorkspaceHeader?.(width, focused) ?? "";
	}

	setViewportHeight(height: number): void {
		this.#viewportHeight = Math.max(1, Math.trunc(height));
	}

	setTextSelectionActive(active: boolean): void {
		this.#followBottom = !active && this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	wantsAppViewportHover(): boolean {
		return this.#returnToBottomVisible;
	}

	clearAppViewportHover(): void {
		if (!this.#returnToBottomHovered) return;
		this.#returnToBottomHovered = false;
		this.options.builder.requestRender();
	}

	containsComponent(component: Component): boolean {
		return (
			(this.#editor !== undefined && componentContains(this.#editor, component)) ||
			componentContains(this.#builder.container, component)
		);
	}

	getEditorText(): string {
		return this.#editor?.getExpandedText() ?? "";
	}

	setEditorText(text: string): void {
		this.#editor?.setText(text);
	}

	getScrollOffset(): number {
		return this.#scrollView.getScrollOffset();
	}

	setScrollOffset(offset: number | "bottom"): void {
		if (offset === "bottom") {
			this.#scrollView.scrollToBottom();
			this.#followBottom = true;
			return;
		}
		this.#scrollView.setScrollOffset(offset);
		this.#syncFollow();
	}

	setNotice(notice: string | undefined): void {
		this.#notice = notice;
		this.options.builder.requestRender();
	}

	rebuild(messages: readonly AgentMessage[]): void {
		this.#builder.rebuild(messages);
		this.options.builder.requestRender();
	}

	append(messages: readonly AgentMessage[]): void {
		this.#builder.append(messages);
		this.options.builder.requestRender();
	}

	rebuildEntries(entries: readonly SessionMessageEntry[]): void {
		this.#builder.rebuildEntries(entries);
		this.options.builder.requestRender();
	}

	appendEntries(entries: readonly SessionMessageEntry[]): void {
		this.#builder.appendEntries(entries);
		this.options.builder.requestRender();
	}

	updateStreamingAssistant(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
		const component = this.#builder.updateStreamingAssistant(message);
		if (!component) return false;
		this.options.builder.ui.requestComponentRender(component);
		return true;
	}

	finalizeStreamingAssistant(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
		const component = this.#builder.finalizeStreamingAssistant(message);
		if (!component) return false;
		this.options.builder.ui.requestComponentRender(component);
		return true;
	}

	getTextSelection(selection: TextSelectionRange): string | undefined {
		const normalized = normalizeTextSelection(selection);
		const contentStart = this.#scrollViewStartLine;
		const viewportEnd = contentStart + this.#selectionViewportHeight;
		if (normalized.start.row >= viewportEnd || normalized.end.row < contentStart) return undefined;
		const visibleStart = normalized.start.row - contentStart;
		const visibleEnd = normalized.end.row - contentStart;
		if (this.#virtualContent) {
			if (visibleEnd >= this.#selectionContentLines.length) {
				this.#builder.container.renderVirtualViewport(Math.max(1, this.#renderWidth - 1), {
					rows: visibleEnd + 1,
					offset: this.#scrollView.getScrollOffset(),
					followBottom: false,
				});
			}
			const scrollOffset = this.#scrollView.getScrollOffset();
			return this.#builder.container.getVirtualTextSelection(Math.max(1, this.#renderWidth - 1), {
				start: { row: scrollOffset + visibleStart, col: normalized.start.col },
				end: { row: scrollOffset + visibleEnd, col: normalized.end.col },
			});
		}
		const scrollOffset = this.#scrollView.getScrollOffset();
		const startRow = scrollOffset + visibleStart;
		const endRow = scrollOffset + visibleEnd;
		if (startRow < 0 || endRow >= this.#selectionContentLines.length) return undefined;
		return extractComponentTextSelection(this.#builder.container, this.#selectionContentLines, {
			start: { row: startRow, col: normalized.start.col },
			end: { row: endRow, col: normalized.end.col },
		});
	}

	getTextSelectionInset(row: number): number {
		const localRow = Math.trunc(row);
		const contentStart = this.#scrollViewStartLine;
		if (localRow < contentStart || localRow >= contentStart + this.#selectionViewportHeight) return 1;
		if (this.#builder.isEmpty) return 1;
		const contentRow = this.#scrollView.getScrollOffset() + localRow - contentStart;
		if (this.#virtualContent) {
			return this.#builder.container.getVirtualTextSelectionInset(Math.max(1, this.#renderWidth - 1), contentRow);
		}
		if (contentRow < 0 || contentRow >= this.#selectionContentLines.length) return 0;
		return this.#builder.container.getTextSelectionInset?.(contentRow) ?? 0;
	}

	getTextSelectionRightInset(row: number): number {
		const localRow = Math.trunc(row);
		const contentStart = this.#scrollViewStartLine;
		if (localRow < contentStart || localRow >= contentStart + this.#selectionViewportHeight) return 0;
		if (this.#builder.isEmpty) return 1;
		const contentRow = this.#scrollView.getScrollOffset() + localRow - contentStart;
		if (this.#virtualContent) {
			return this.#builder.container.getVirtualTextSelectionRightInset(
				Math.max(1, this.#renderWidth - 1),
				contentRow,
			);
		}
		if (contentRow < 0 || contentRow >= this.#selectionContentLines.length) return 1;
		return 1 + (this.#builder.container.getTextSelectionRightInset?.(contentRow) ?? 0);
	}

	getTextSelectionScrollOffset(row: number): number | undefined {
		const localRow = Math.trunc(row);
		const contentStart = this.#scrollViewStartLine;
		return localRow >= contentStart && localRow < contentStart + this.#selectionViewportHeight
			? this.#scrollView.getScrollOffset()
			: undefined;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		if (event.motion) {
			const hovered = this.#returnToBottomContains(line, col);
			if (hovered !== this.#returnToBottomHovered) {
				this.#returnToBottomHovered = hovered;
				this.options.builder.requestRender();
				return true;
			}
			if (hovered) return true;
		}
		if (event.leftClick && this.#returnToBottomContains(line, col)) {
			this.#jumpToBottom();
			return true;
		}
		const handled = this.#scrollView.routeMouse(event, line - this.#scrollViewStartLine, col);
		if (!handled) return false;
		this.#syncFollow();
		this.options.builder.requestRender();
		return true;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.routeMouse(event, event.row, event.col));
			return;
		}
		const editorEmpty = !this.#editor || this.#editor.getText().trim() === "";
		if (this.options.onInput?.(data, editorEmpty)) return;
		if (matchesKey(data, "escape") && this.#editor?.hasAutocomplete()) {
			this.#editor.handleInput(data);
			this.options.builder.requestRender();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (!editorEmpty) {
				this.#editor?.clearDraft();
				this.options.builder.requestRender();
				return;
			}
			this.options.onClose();
			return;
		}
		for (const key of this.options.expandKeys) {
			if (matchesKey(data, key)) {
				const startRow = this.#scrollView.getScrollOffset();
				const endRow = startRow + Math.max(1, this.#selectionViewportHeight) - 1;
				const visibleBlocks = this.#builder.container.getVirtualBlocksInRowRange(
					Math.max(1, this.#renderWidth - 1),
					startRow,
					endRow,
				);
				this.#builder.toggleExpanded(visibleBlocks, this.#followBottom);
				this.options.builder.requestRender();
				return;
			}
		}
		if (editorEmpty && this.#handleScroll(data)) return;
		if (this.#editor && this.options.editor?.readOnly !== true) {
			this.#editor.handleInput(data);
			// Editor.onChange also covers asynchronous clipboard completion.
			this.options.builder.requestRender();
		}
	}

	render(width: number): readonly string[] {
		const contentWidth = Math.max(1, width - 1);
		const notice = this.#notice ?? this.options.getNotice?.();
		const noticeLine = notice ? ` ${theme.fg("error", sanitizeNotice(notice, Math.max(10, width - 2)))}` : undefined;
		const editorLines = this.#editor ? this.#editor.render(width) : [];
		const viewportHeight = this.#contentViewportHeight(editorLines, noticeLine);
		let scrollOffset = this.#scrollView.getScrollOffset();
		if (this.#initialEntryId) {
			const targetRow = this.#builder.rowForEntry(this.#initialEntryId, contentWidth);
			if (targetRow !== undefined) {
				this.#followBottom = false;
				scrollOffset = Math.max(0, targetRow - 1);
				this.#initialEntryId = undefined;
			}
		}
		const virtualFrame = this.#builder.isEmpty
			? undefined
			: this.#builder.container.renderVirtualViewport(contentWidth, {
					rows: viewportHeight,
					offset: scrollOffset,
					followBottom: this.#followBottom,
				});
		const contentLines = virtualFrame?.lines ?? [
			` ${theme.fg(
				"dim",
				sanitizeNotice(this.options.getPlaceholder(Math.max(10, contentWidth - 1)), Math.max(10, contentWidth - 1)),
			)}`,
		];
		return this.#renderFrame(width, contentLines, editorLines, noticeLine, virtualFrame);
	}

	renderTargeted(width: number, targets: readonly Component[]): readonly string[] {
		const termHeight = this.#viewportHeight ?? (process.stdout.rows || 40);
		if (
			!this.#hasFullFrame ||
			width !== this.#renderWidth ||
			termHeight !== this.#renderHeight ||
			targets.length === 0
		) {
			return this.render(width);
		}
		const contentTargets: Component[] = [];
		const editorTargets: Component[] = [];
		for (const target of targets) {
			if (this.#editor !== undefined && componentContains(this.#editor, target)) {
				editorTargets.push(target);
			} else if (componentContains(this.#builder.container, target)) {
				contentTargets.push(target);
			} else {
				return this.render(width);
			}
		}
		const contentWidth = Math.max(1, width - 1);
		const editorLines =
			editorTargets.length > 0 && this.#editor
				? renderTargeted(this.#editor, width, editorTargets)
				: this.#cachedEditorLines;
		const viewportHeight = this.#contentViewportHeight(editorLines, this.#cachedNoticeLine);
		let virtualFrame: VirtualViewportFrame | undefined;
		if (!this.#builder.isEmpty) {
			if (contentTargets.length > 0) {
				virtualFrame = this.#builder.container.renderVirtualViewportTargeted(
					contentWidth,
					{
						rows: viewportHeight,
						offset: this.#scrollView.getScrollOffset(),
						followBottom: this.#followBottom,
					},
					contentTargets,
				);
			} else if (this.#virtualContent && viewportHeight === this.#selectionViewportHeight) {
				virtualFrame = {
					lines: this.#cachedContentLines,
					estimatedTotalRows: this.#estimatedTotalRows,
					offset: this.#scrollView.getScrollOffset(),
				};
			} else {
				virtualFrame = this.#builder.container.renderVirtualViewport(contentWidth, {
					rows: viewportHeight,
					offset: this.#scrollView.getScrollOffset(),
					followBottom: this.#followBottom,
				});
			}
		}
		const contentLines = virtualFrame?.lines ?? this.#cachedContentLines;
		return this.#renderFrame(width, contentLines, editorLines, this.#cachedNoticeLine, virtualFrame);
	}

	#contentViewportHeight(editorLines: readonly string[], noticeLine: string | undefined): number {
		const termHeight = this.#viewportHeight ?? (process.stdout.rows || 40);
		const returnControlRows = this.#editor ? 1 : 0;
		const chrome = returnControlRows + editorLines.length + (noticeLine ? 1 : 0);
		return Math.max(this.#viewportHeight === undefined ? 3 : 0, termHeight - chrome);
	}

	#renderFrame(
		width: number,
		contentLines: readonly string[],
		editorLines: readonly string[],
		noticeLine: string | undefined,
		virtualFrame: VirtualViewportFrame | undefined,
	): readonly string[] {
		const termHeight = this.#viewportHeight ?? (process.stdout.rows || 40);
		const viewportHeight = this.#contentViewportHeight(editorLines, noticeLine);
		this.#cachedContentLines = contentLines;
		this.#cachedEditorLines = editorLines;
		this.#cachedNoticeLine = noticeLine;
		this.#renderWidth = width;
		this.#renderHeight = termHeight;
		this.#hasFullFrame = true;
		this.#virtualContent = virtualFrame !== undefined;
		this.#estimatedTotalRows = virtualFrame?.estimatedTotalRows ?? contentLines.length;
		this.#selectionContentLines = contentLines;
		this.#selectionViewportHeight = viewportHeight;
		this.#scrollView.setHeight(viewportHeight);
		this.#scrollView.setTotalRows(virtualFrame?.estimatedTotalRows);
		this.#scrollView.setLines(contentLines);
		if (virtualFrame) this.#scrollView.setScrollOffset(virtualFrame.offset);
		else if (this.#followBottom) this.#scrollView.scrollToBottom();

		this.#scrollViewStartLine = 0;
		const lines = [...this.#scrollView.render(width)];
		if (this.#editor) lines.push(this.#renderReturnToBottomControl(width, lines.length));
		else this.#clearReturnToBottomControl();
		if (noticeLine) lines.push(noticeLine);
		lines.push(...editorLines);
		return this.#viewportHeight === undefined ? lines : lines.slice(0, termHeight);
	}

	#renderReturnToBottomControl(width: number, row: number): string {
		this.#returnToBottomRow = row;
		this.#returnToBottomCol = Math.max(0, Math.trunc(width) - 1);
		this.#returnToBottomVisible =
			!this.#followBottom && this.#scrollView.getScrollOffset() < this.#scrollView.getMaxScrollOffset();
		if (!this.#returnToBottomVisible) {
			this.#returnToBottomHovered = false;
			return "";
		}
		const glyph = theme.fg(this.#returnToBottomHovered ? "text" : "muted", "▽");
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
		this.#scrollView.scrollToBottom();
		this.#followBottom = true;
		this.#returnToBottomHovered = false;
		this.options.builder.requestRender();
	}
	invalidate(): void {
		this.#hasFullFrame = false;
		this.#builder.container.invalidate();
		this.#editor?.invalidate?.();
		this.#scrollView.invalidate?.();
	}

	dispose(): void {
		for (const editor of this.#editors.values()) {
			editor.onSubmit = undefined;
		}
		this.#builder.dispose();
	}

	#submit(editor: CustomEditor, text: string, key?: string): void {
		if (this.options.editor?.readOnly === true) return;
		const compacted = compactImageMarkers(text.trim(), editor.pendingImages.length);
		const trimmed = compacted?.text ?? text.trim();
		const images = compacted ? compacted.keep.map(index => editor.pendingImages[index]!) : [...editor.pendingImages];
		if (!trimmed && images.length === 0) return;
		if (!this.options.editor?.onSubmit(trimmed, images.length ? images : undefined, key)) {
			editor.setDraft(trimmed, images);
			return;
		}
		editor.clearDraft();
		this.#notice = undefined;
		this.options.builder.requestRender();
	}

	#handleScroll(data: string): boolean {
		if (this.#scrollView.handleScrollKey(data)) {
			this.#syncFollow();
			this.options.builder.requestRender();
			return true;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
		} else if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
		} else if (data === "g") {
			this.#scrollView.scrollToTop();
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
		} else {
			return false;
		}
		this.#syncFollow();
		this.options.builder.requestRender();
		return true;
	}

	#syncFollow(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}
}
