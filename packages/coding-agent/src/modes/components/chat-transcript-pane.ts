import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	type EditorTopBorder,
	extractComponentTextSelection,
	type Focusable,
	type MouseRoutable,
	matchesKey,
	normalizeTextSelection,
	routeSgrMouseInput,
	ScrollView,
	type SgrMouseEvent,
	type TextSelectionRange,
	type ViewportHeightAware,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { KeyId } from "../../config/keybindings";
import type { SessionMessageEntry } from "../../session/session-entries";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { ChatTranscriptBuilder, type ChatTranscriptBuilderDeps } from "./chat-transcript-builder";
import { CustomEditor } from "./custom-editor";

export type ChatTranscriptPaneEditorOptions =
	| {
			label: string;
			placeholder: string;
			readOnly?: false;
			onSubmit: (text: string) => boolean;
	  }
	| {
			label: string;
			placeholder: string;
			readOnly: true;
			onSubmit?: never;
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
	onEditorChange?: (text: string) => void;
	onClose: () => void;
}

function sanitizeNotice(text: string, maxWidth: number): string {
	const singleLine = replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\/[^\s'")\]]+/g, path => shortenPath(path));
	return truncateToWidth(singleLine, Math.max(10, maxWidth));
}

/** Shared transcript, scrolling, selection, editor, and pane chrome. */
export class ChatTranscriptPane implements Component, Focusable, MouseRoutable, ViewportHeightAware {
	readonly #builder: ChatTranscriptBuilder;
	readonly #scrollView = new ScrollView([], { height: 10, scrollbar: "auto", scrollbarStyle: "braille" });
	readonly #editor: CustomEditor | undefined;

	#followBottom = true;
	#focused = false;
	#notice: string | undefined;
	#viewportHeight: number | undefined;
	#scrollViewStartLine = 0;
	#selectionContentLines: readonly string[] = [];
	#selectionViewportHeight = 0;
	#initialEntryId: string | undefined;

	constructor(private readonly options: ChatTranscriptPaneOptions) {
		this.#builder = new ChatTranscriptBuilder(options.builder);
		this.#initialEntryId = options.initialEntryId;
		if (options.editor) {
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
			if (!editor.disableSubmit) editor.onSubmit = text => this.#submit(text);
			this.#editor = editor;
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

	getEditorText(): string {
		return this.#editor?.getText() ?? "";
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

	getTextSelection(selection: TextSelectionRange): string | undefined {
		const normalized = normalizeTextSelection(selection);
		const contentStart = this.#scrollViewStartLine;
		const viewportEnd = contentStart + this.#selectionViewportHeight;
		if (normalized.start.row >= viewportEnd || normalized.end.row < contentStart) return undefined;
		const scrollOffset = this.#scrollView.getScrollOffset();
		const startRow = scrollOffset + normalized.start.row - contentStart;
		const endRow = scrollOffset + normalized.end.row - contentStart;
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
		if (contentRow < 0 || contentRow >= this.#selectionContentLines.length) return 0;
		return this.#builder.container.getTextSelectionInset?.(contentRow) ?? 0;
	}

	getTextSelectionRightInset(row: number): number {
		const localRow = Math.trunc(row);
		const contentStart = this.#scrollViewStartLine;
		if (localRow < contentStart || localRow >= contentStart + this.#selectionViewportHeight) return 0;
		if (this.#builder.isEmpty) return 1;
		const contentRow = this.#scrollView.getScrollOffset() + localRow - contentStart;
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
		if (matchesKey(data, "escape")) {
			if (!editorEmpty) {
				this.#editor?.setText("");
				this.options.builder.requestRender();
				return;
			}
			this.options.onClose();
			return;
		}
		for (const key of this.options.expandKeys) {
			if (matchesKey(data, key)) {
				const startRow = this.#scrollView.getScrollOffset();
				this.#builder.toggleExpanded(
					startRow,
					startRow + Math.max(1, this.#selectionViewportHeight) - 1,
					this.#followBottom,
				);
				this.options.builder.requestRender();
				return;
			}
		}
		if (editorEmpty && this.#handleScroll(data)) return;
		if (this.#editor && this.options.editor?.readOnly !== true) {
			this.#editor.handleInput(data);
			this.options.onEditorChange?.(this.#editor.getText());
			this.options.builder.requestRender();
		}
	}

	render(width: number): readonly string[] {
		const termHeight = this.#viewportHeight ?? (process.stdout.rows || 40);
		const contentWidth = Math.max(1, width - 1);
		const notice = this.#notice ?? this.options.getNotice?.();
		const noticeLine = notice ? ` ${theme.fg("error", sanitizeNotice(notice, Math.max(10, width - 2)))}` : undefined;
		const editorLines = this.#editor ? this.#editor.render(width) : [];
		const chrome = editorLines.length + (noticeLine ? 1 : 0);
		const viewportHeight = Math.max(this.#viewportHeight === undefined ? 3 : 0, termHeight - chrome);
		const contentLines = this.#builder.isEmpty
			? [
					` ${theme.fg(
						"dim",
						sanitizeNotice(
							this.options.getPlaceholder(Math.max(10, contentWidth - 1)),
							Math.max(10, contentWidth - 1),
						),
					)}`,
				]
			: this.#builder.container.render(contentWidth);
		this.#scrollView.setLines(contentLines);
		this.#selectionContentLines = contentLines;
		this.#selectionViewportHeight = viewportHeight;
		this.#scrollView.setHeight(viewportHeight);
		if (this.#initialEntryId) {
			const targetRow = this.#builder.rowForEntry(this.#initialEntryId);
			if (targetRow !== undefined) {
				this.#followBottom = false;
				this.#scrollView.setScrollOffset(Math.max(0, targetRow - 1));
				this.#initialEntryId = undefined;
			}
		} else if (this.#followBottom) {
			this.#scrollView.scrollToBottom();
		}

		this.#scrollViewStartLine = 0;
		const lines = [...this.#scrollView.render(width)];
		if (noticeLine) lines.push(noticeLine);
		lines.push(...editorLines);
		return this.#viewportHeight === undefined ? lines : lines.slice(0, termHeight);
	}

	dispose(): void {
		this.#builder.dispose();
	}

	#submit(text: string): void {
		if (this.options.editor?.readOnly === true) return;
		const trimmed = text.trim();
		if (!trimmed) {
			this.#editor?.setText("");
			return;
		}
		if (!this.options.editor?.onSubmit(trimmed)) return;
		this.#editor?.setText("");
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
