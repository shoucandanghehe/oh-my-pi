import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import {
	type AppViewportHoverProvider,
	CombinedAutocompleteProvider,
	type Component,
	componentContains,
	type Focusable,
	type MouseRoutable,
	matchesKey,
	padding,
	renderTargeted,
	type SgrMouseEvent,
	type SlashCommand,
	sliceWithWidth,
	type TargetedRender,
	type TextSelectionRange,
	type TUI,
	type ViewportHeightAware,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { KeyId } from "../../config/keybindings";
import type { BtwThreadPhase } from "../../session/btw-manager";
import type { BtwThreadModelRef } from "../../session/btw-thread";
import type { EphemeralConversationStatus, EphemeralConversationTurn } from "../../session/ephemeral-conversation";
import { sanitizeAssistantForReparentedHistory } from "../../session/messages";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { renderWorkspacePaneHeader } from "../shared";
import { theme } from "../theme/theme";
import { ChatTranscriptPane } from "./chat-transcript-pane";
import type { CustomEditor } from "./custom-editor";
import type { StatusLineComponent } from "./status-line";

export interface BtwThreadView {
	readonly key: string;
	readonly title: string;
	readonly phase: BtwThreadPhase;
	readonly model: BtwThreadModelRef;
	readonly error: string | undefined;
	readonly draft: string;
	readonly draftImages?: readonly ImageContent[];
	readonly draftImageLinks?: readonly (string | undefined)[];
	readonly turns: readonly EphemeralConversationTurn[];
	readonly getTool?: (name: string) => AgentTool | undefined;
	readonly status?: EphemeralConversationStatus;
	readonly unread: number;
	readonly request:
		| {
				readonly input: string;
				readonly images?: readonly ImageContent[];
				readonly messages: readonly AgentMessage[];
				readonly streamMessage: AssistantMessage | undefined;
				readonly timestamp: number;
		  }
		| undefined;
}

export interface BtwConversationPaneOptions {
	ui: TUI;
	cwd: string;
	expandKeys: readonly KeyId[];
	hideThinkingBlock: () => boolean;
	proseOnlyThinking: () => boolean;
	requestRender: () => void;
	statusLine: Pick<StatusLineComponent, "getTopBorder" | "setRuntimeStatus" | "dispose">;
	onSubmit: (input: string, images?: ImageContent[], key?: string) => boolean;
	onNewThread: () => boolean;
	canCopy: (key: string) => boolean;
	onCopy: (key: string) => Promise<boolean>;
	onClose: () => void;
	onDraftChange: (key: string, text: string, images?: ImageContent[], imageLinks?: (string | undefined)[]) => void;
	onPersistDraft: (key: string) => void;
	onSelectThread: (key: string) => boolean;
	onMarkRead: (key: string) => void;
	onCloseThread: (key: string) => boolean;
	onPromoteThread: (key: string) => Promise<boolean>;
	/** A submit was consumed because the selected thread is still streaming. */
	onRejectedSubmit?: () => void;
}

const RAIL_MAX_WIDTH = 30;
const RAIL_MIN_WIDTH = 14;
const RAIL_TARGET_WIDTH = 24;
const RAIL_HANDLE_HOVER_ROW_RADIUS = 2;
const RAIL_HANDLE_HOVER_WIDTH = 3;
const RAIL_PEEK_EXIT_SLOP = 3;
const RAIL_PEEK_LEAVE_GRACE_MS = 150;
const RAIL_TOGGLE_ANIMATION_FRAME_MS = 20;
const RAIL_TOGGLE_ANIMATION_FRAMES = 6;

const BTW_SLASH_COMMANDS: SlashCommand[] = [
	{
		name: "new",
		description: "Start a new durable BTW thread, optionally with its first question",
		argumentHint: "[question]",
		allowArgs: true,
	},
	{
		name: "help",
		description: "List available BTW actions",
		allowArgs: false,
	},
	{
		name: "handoff",
		description: "Send this thread's conversation to Main as context",
		argumentHint: "[instruction]",
		allowArgs: true,
	},
	{
		name: "promote",
		description: "Branch this thread's turns into a new session",
		allowArgs: false,
	},
	{
		name: "delete",
		description: "Delete the selected durable BTW thread",
		allowArgs: false,
	},
];

/** Durable BTW transcript with a collapsible, hover-previewable thread rail. */
export class BtwConversationPane
	implements Component, Focusable, MouseRoutable, TargetedRender, ViewportHeightAware, AppViewportHoverProvider
{
	readonly #pane: ChatTranscriptPane;
	readonly #options: BtwConversationPaneOptions;
	readonly #scrollOffsets = new Map<string, number>();
	#threads: readonly BtwThreadView[] = [];
	#selectedKey: string | undefined;
	#previewKey: string | undefined;
	#displayedKey: string | undefined;
	#renderedTurns: readonly EphemeralConversationTurn[] | undefined;
	#renderedTurnsLength = 0;
	#renderedRequestInput: string | undefined;
	#renderedRequestTimestamp: number | undefined;
	#renderedRequestMessages: readonly AgentMessage[] | undefined;
	#renderedRequestMessagesLength = 0;
	#renderedStreamMessage: AssistantMessage | undefined;
	#railOffset = 0;
	#railCollapsed = true;
	#railPeek = false;
	#hoverClearTimer: NodeJS.Timeout | undefined;
	#newThreadHovered = false;
	#railAnimation: { fromWidth: number; targetWidth: number; frame: number; kind: "toggle" | "peek" } | undefined;
	#railAnimationTimer: NodeJS.Timeout | undefined;
	#width = 80;
	#height = 20;
	#abandoned = false;

	constructor(options: BtwConversationPaneOptions) {
		this.#options = options;
		this.#pane = new ChatTranscriptPane({
			builder: {
				ui: options.ui,
				cwd: options.cwd,
				getTool: name => this.#displayed()?.getTool?.(name),
				hideThinkingBlock: options.hideThinkingBlock,
				proseOnlyThinking: options.proseOnlyThinking,
				requestRender: options.requestRender,
			},
			editor: {
				label: "Ask BTW",
				placeholder: "Continue the side conversation…",
				images: true,
				onSubmit: (input, images, key) => options.onSubmit(input, images, key),
				autocompleteProvider: new CombinedAutocompleteProvider(BTW_SLASH_COMMANDS, options.cwd),
			},
			expandKeys: options.expandKeys,
			getEditorTopBorder: availableWidth => options.statusLine.getTopBorder(availableWidth),
			getPlaceholder: () =>
				"No threads yet — type a question to start a durable BTW thread, or use /btw <question> from Main.",
			getNotice: () => this.#selected()?.error,
			onEditorChange: (text, images, imageLinks, key) => {
				if (key && !this.#abandoned) this.#options.onDraftChange(key, text, images, imageLinks);
			},
			onInput: (data, editorEmpty) => this.#handleInput(data, editorEmpty),
			onClose: options.onClose,
		});
	}

	get focused(): boolean {
		return this.#pane.focused;
	}

	set focused(focused: boolean) {
		this.#pane.focused = focused;
		if (!focused) this.#clearAppViewportHoverNow();
	}

	wantsAppViewportHover(): boolean {
		return this.#threads.length > 0 || this.#pane.wantsAppViewportHover();
	}

	clearAppViewportHover(): void {
		this.#pane.clearAppViewportHover();
		if ((!this.#previewKey && !this.#railPeek && !this.#newThreadHovered) || this.#hoverClearTimer) return;
		this.#hoverClearTimer = setTimeout(() => this.#clearAppViewportHoverNow(), RAIL_PEEK_LEAVE_GRACE_MS);
		this.#hoverClearTimer.unref();
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#pane.setUseTerminalCursor(useTerminalCursor);
	}

	setViewportHeight(height: number): void {
		this.#height = Math.max(1, Math.trunc(height));
		this.#pane.setViewportHeight(this.#height);
	}

	setTextSelectionActive(active: boolean): void {
		this.#pane.setTextSelectionActive(active);
	}

	update(threads: readonly BtwThreadView[], selectedKey: string | undefined): void {
		const previousSelected = this.#selectedKey;
		this.#threads = threads;
		const selected = threads.find(thread => thread.key === selectedKey) ?? threads.at(-1);
		this.#selectedKey = selected?.key;
		if (!threads.some(thread => thread.key === this.#previewKey)) this.#previewKey = undefined;
		if (threads.length === 0) {
			this.#railPeek = false;
			this.#stopRailAnimation();
		}
		if (previousSelected !== this.#selectedKey) {
			if (previousSelected) this.#options.onPersistDraft(previousSelected);
			this.#pane.selectEditor(
				selected?.key,
				selected?.draft ?? "",
				selected?.draftImages,
				selected?.draftImageLinks,
			);
		}
		this.#pane.retainEditors(threads.map(thread => thread.key));
		this.#showDisplayedThread();
		if (selected) this.#options.onMarkRead(selected.key);
		this.#ensureRailTargetVisible();
		this.#options.requestRender();
	}

	renderWorkspaceHeader(width: number, focused: boolean): string {
		const selected = this.#displayed();
		const count = this.#threads.length;
		if (!selected) return renderWorkspacePaneHeader("BTW", width, focused, theme.fg("muted", " · no threads"));
		const mode = this.#previewKey ? "preview" : focused ? "focused" : "ready";
		const status = selected.phase === "running" ? "streaming" : selected.error ? "error" : mode;
		const details = ` · ${count} ${count === 1 ? "thread" : "threads"} · ${selected.title} · ${status}`;
		const suffix = theme.fg(status === "error" ? "error" : "muted", details);
		return renderWorkspacePaneHeader("BTW", width, focused, suffix);
	}

	getTextSelection(selection: TextSelectionRange): string | undefined {
		const railWidth = this.#railWidth(this.#width);
		const animationKind = this.#railAnimation?.kind;
		const peekOverlay = this.#railPeek || animationKind === "peek";
		const overlayEnd =
			animationKind === "toggle" ? railWidth : peekOverlay && railWidth > 0 ? railWidth + 1 : undefined;
		if (overlayEnd !== undefined) {
			if (selection.start.col <= overlayEnd || selection.end.col <= overlayEnd) return undefined;
			return this.#pane.getTextSelection({
				start: { row: selection.start.row, col: selection.start.col - 1 },
				end: { row: selection.end.row, col: selection.end.col - 1 },
			});
		}
		const offset = railWidth + 1;
		if (selection.start.col < offset || selection.end.col < offset) return undefined;
		return this.#pane.getTextSelection({
			start: { row: selection.start.row, col: selection.start.col - offset },
			end: { row: selection.end.row, col: selection.end.col - offset },
		});
	}

	getTextSelectionInset(row: number): number {
		const railWidth = this.#railWidth(this.#width);
		const paneInset = this.#pane.getTextSelectionInset(row);
		const animationKind = this.#railAnimation?.kind;
		if (animationKind === "toggle") return Math.max(railWidth + 1, paneInset + 1);
		if ((this.#railPeek || animationKind === "peek") && railWidth > 0) {
			return Math.max(railWidth + 2, paneInset + 1);
		}
		return railWidth + 1 + paneInset;
	}

	getTextSelectionRightInset(row: number): number {
		return this.#pane.getTextSelectionRightInset(row);
	}

	getTextSelectionScrollOffset(row: number): number | undefined {
		return this.#pane.getTextSelectionScrollOffset(row);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		if (this.#hoverClearTimer) {
			clearTimeout(this.#hoverClearTimer);
			this.#hoverClearTimer = undefined;
		}
		const railWidth = this.#railWidth(this.#width);
		const handleDistance = Math.abs(line - this.#railHandleRow());
		const onHandleClickRow = handleDistance <= 1;
		const onHandleHover = handleDistance <= RAIL_HANDLE_HOVER_ROW_RADIUS && col >= 0 && col < RAIL_HANDLE_HOVER_WIDTH;
		const animation = this.#railAnimation;
		const motionOverRail =
			animation?.kind === "peek"
				? railWidth > 0 && col <= railWidth
				: animation?.kind === "toggle"
					? col < railWidth
					: this.#railCollapsed
						? this.#railPeek && col <= railWidth
						: col < railWidth;
		if (event.motion && !motionOverRail && this.#newThreadHovered) {
			this.#newThreadHovered = false;
			this.#options.requestRender();
		}
		if (animation?.kind === "peek") {
			if (event.motion && onHandleHover && !this.#railPeek) this.#showRailPeek();
			if (event.motion && onHandleHover && railWidth === 0) return true;
			if (col === 0 && onHandleClickRow && event.leftClick) {
				this.#toggleRail();
				return true;
			}
			if (railWidth > 0) {
				if (col <= railWidth) return this.#routeRailMouse(event, line);
				if (col === railWidth + 1) return true;
				if (event.motion && col <= railWidth + 1 + RAIL_PEEK_EXIT_SLOP) return true;
				if (event.motion) this.#hideRailPeek();
			}
			return this.#pane.routeMouse(event, line, col - 1);
		}
		if (animation?.kind === "toggle") {
			if (onHandleClickRow && col === railWidth) {
				if (event.leftClick) this.#toggleRail();
				return true;
			}
			if (col < railWidth) return this.#routeRailMouse(event, line);
			if (col === railWidth) return true;
			return this.#pane.routeMouse(event, line, col - 1);
		}
		if (this.#railCollapsed) {
			if (event.motion && onHandleHover && !this.#railPeek) this.#showRailPeek();
			if (col === 0) {
				if (onHandleClickRow && event.leftClick) this.#toggleRail();
				return true;
			}
			if (this.#railPeek) {
				if (col <= railWidth) return this.#routeRailMouse(event, line);
				if (col === railWidth + 1) return true;
				if (event.motion && col <= railWidth + 1 + RAIL_PEEK_EXIT_SLOP) return true;
				if (event.motion) this.#hideRailPeek();
			}
			return this.#pane.routeMouse(event, line, col - 1);
		}
		if (onHandleClickRow && col === railWidth) {
			if (event.motion) this.clearAppViewportHover();
			if (event.leftClick) this.#toggleRail();
			return true;
		}
		if (col < railWidth) return this.#routeRailMouse(event, line);
		if (col === railWidth) return true;
		if (event.motion) this.clearAppViewportHover();
		return this.#pane.routeMouse(event, line, col - railWidth - 1);
	}

	handleInput(data: string): void {
		this.#pane.handleInput(data);
	}

	getPasteTarget(): CustomEditor | undefined {
		return this.#pane.getPasteTarget();
	}

	containsComponent(component: Component): boolean {
		return componentContains(this.#pane, component);
	}

	render(width: number): readonly string[] {
		return this.#renderFrame(width);
	}

	renderTargeted(width: number, targets: readonly Component[]): readonly string[] {
		if (targets.length === 0 || targets.some(target => !componentContains(this.#pane, target))) {
			return this.render(width);
		}
		return this.#renderFrame(width, targets);
	}

	#renderFrame(width: number, targets?: readonly Component[]): readonly string[] {
		this.#width = Math.max(1, width);
		const railWidth = this.#railWidth(this.#width);
		const animationKind = this.#railAnimation?.kind;
		const toggleAnimating = animationKind === "toggle";
		const peekOverlay = this.#railPeek || animationKind === "peek";
		const railOverlay = toggleAnimating || peekOverlay;
		const transcriptWidth = Math.max(1, this.#width - (this.#railCollapsed || railOverlay ? 1 : railWidth + 1));
		const transcript = targets
			? renderTargeted(this.#pane, transcriptWidth, targets)
			: this.#pane.render(transcriptWidth);
		const rail = railWidth > 0 ? this.#renderRail(railWidth, Math.max(this.#height, transcript.length)) : [];
		const rows = Math.max(this.#height, rail.length, transcript.length);
		const lines: string[] = [];
		for (let row = 0; row < rows; row++) {
			const railLine = rail[row] ?? " ".repeat(railWidth);
			const transcriptLine = transcript[row] ?? "";
			const handleRow = row === this.#railHandleRow();
			if (toggleAnimating) {
				const handle = handleRow ? theme.fg("accent", this.#railCollapsed ? "▶" : "◀") : theme.fg("dim", "│");
				const tailStart = railWidth;
				const tailWidth = Math.max(0, transcriptWidth - tailStart);
				lines.push(`${railLine}${handle}${this.#sliceTranscriptTail(transcriptLine, tailStart, tailWidth)}`);
			} else if (peekOverlay && railWidth > 0) {
				const handle = handleRow ? theme.fg("accent", "▶") : theme.fg("dim", "│");
				const divider = theme.fg("dim", "│");
				const tailStart = railWidth + 1;
				const tailWidth = Math.max(0, transcriptWidth - tailStart);
				lines.push(
					`${handle}${railLine}${divider}${this.#sliceTranscriptTail(transcriptLine, tailStart, tailWidth)}`,
				);
			} else {
				const divider = handleRow ? theme.fg("accent", this.#railCollapsed ? "▶" : "◀") : theme.fg("dim", "│");
				lines.push(`${railLine}${divider}${transcriptLine}`);
			}
		}
		return this.#height > 0 ? lines.slice(0, this.#height) : lines;
	}

	invalidate(): void {
		this.#pane.invalidate();
	}

	abandon(): void {
		this.#abandoned = true;
	}

	dispose(): void {
		if (this.#hoverClearTimer) {
			clearTimeout(this.#hoverClearTimer);
			this.#hoverClearTimer = undefined;
		}
		this.#stopRailAnimation();
		if (!this.#abandoned && this.#selectedKey) {
			this.#persistCurrentDraft();
		}
		this.#pane.dispose();
		this.#options.statusLine.dispose();
	}

	#handleInput(data: string, editorEmpty: boolean): boolean {
		if (matchesKey(data, "alt+t")) {
			this.#toggleRail();
			return true;
		}
		// Consume the submit while the selected thread is streaming: the editor
		// clears itself on submit, so letting Enter through would silently drop
		// the drafted question (pi-tui Editor#submitValue is not vetoable).
		if (!editorEmpty && matchesKey(data, "enter") && this.#selected()?.phase === "running") {
			this.#options.onRejectedSubmit?.();
			return true;
		}
		if (editorEmpty && matchesKey(data, "tab")) return this.#selectAdjacent(1);
		if (editorEmpty && matchesKey(data, "shift+tab")) return this.#selectAdjacent(-1);
		if (matchesKey(data, "alt+enter")) {
			if (!this.#selectedKey) return false;
			void this.#options.onPromoteThread(this.#selectedKey).catch(() => {});
			return true;
		}
		if (matchesKey(data, "alt+shift+d")) {
			return this.#selectedKey ? this.#options.onCloseThread(this.#selectedKey) : false;
		}
		if (matchesKey(data, "alt+c")) {
			if (!this.#selectedKey || !this.#options.canCopy(this.#selectedKey)) return false;
			void this.#options.onCopy(this.#selectedKey).catch(() => {});
			return true;
		}
		return false;
	}

	#selectAdjacent(delta: 1 | -1): boolean {
		const index = this.#threads.findIndex(thread => thread.key === this.#selectedKey);
		if (index < 0 || this.#threads.length < 2) return false;
		this.#persistCurrentDraft();
		this.#previewKey = undefined;
		this.#showDisplayedThread();
		const next = (index + delta + this.#threads.length) % this.#threads.length;
		return this.#options.onSelectThread(this.#threads[next]!.key);
	}

	#routeRailMouse(event: SgrMouseEvent, line: number): boolean {
		if (event.wheel !== null) {
			const maxOffset = Math.max(0, this.#threads.length - this.#railCapacity());
			this.#railOffset = Math.max(0, Math.min(maxOffset, this.#railOffset + event.wheel));
			this.#options.requestRender();
			return true;
		}
		const onNewButton = line === Math.max(0, this.#height - 1);
		const thread = onNewButton ? undefined : this.#threadAtRailLine(line);
		if (event.motion) {
			const nextPreview = thread?.key;
			const hoverChanged = onNewButton !== this.#newThreadHovered;
			const previewChanged = nextPreview !== this.#previewKey;
			this.#newThreadHovered = onNewButton;
			if (previewChanged) {
				this.#previewKey = nextPreview;
				this.#showDisplayedThread();
			}
			if (hoverChanged || previewChanged) this.#options.requestRender();
			return true;
		}
		if (event.leftClick && onNewButton) {
			this.#startNewThread();
			return true;
		}
		if (event.leftClick && thread) {
			this.#persistCurrentDraft();
			this.#previewKey = undefined;
			return this.#options.onSelectThread(thread.key);
		}
		return true;
	}

	#threadAtRailLine(line: number): BtwThreadView | undefined {
		const index = line + this.#railOffset;
		return index >= 0 ? this.#threads.at(index) : undefined;
	}

	#renderRail(width: number, height: number): string[] {
		const lines = Array.from({ length: height }, () => " ".repeat(width));
		const capacity = Math.max(0, height - 1);
		for (let row = 0; row < capacity; row++) {
			const thread = this.#threads.at(this.#railOffset + row);
			if (!thread) break;
			lines[row] = this.#renderThreadRow(thread, width);
		}
		if (height > 1) {
			const label = theme.bold(theme.fg("accent", "[ + New BTW ]"));
			const button = this.#newThreadHovered ? theme.bg("selectedBg", ` ${label} `) : label;
			lines[height - 1] = this.#fit(` ${button}`, width);
		}
		return lines;
	}

	#renderThreadRow(thread: BtwThreadView, width: number): string {
		const selected = thread.key === this.#selectedKey;
		const previewed = thread.key === this.#previewKey;
		const glyph = thread.error ? "×" : thread.phase === "running" ? "●" : thread.unread > 0 ? "•" : "○";
		const tone = thread.error
			? "error"
			: thread.phase === "running"
				? "warning"
				: thread.unread > 0
					? "accent"
					: "muted";
		const suffix = thread.unread > 0 ? ` ${thread.unread}` : thread.draft ? " d" : "";
		const marker = selected ? "▸" : previewed ? "›" : " ";
		const titleWidth = Math.max(1, width - 5 - suffix.length);
		const title = truncateToWidth(replaceTabs(thread.title), titleWidth);
		let line = this.#fit(` ${marker} ${theme.fg(tone, glyph)} ${title}${theme.fg("dim", suffix)}`, width);
		if (selected) line = theme.bold(line);
		if (previewed) line = theme.bg("selectedBg", line);
		return line;
	}
	#startNewThread(): void {
		this.#persistCurrentDraft();
		this.#previewKey = undefined;
		this.#showDisplayedThread();
		this.#options.onNewThread();
		this.#options.requestRender();
	}

	#showDisplayedThread(): void {
		const displayed = this.#displayed();
		const previousKey = this.#displayedKey;
		if (previousKey && previousKey !== displayed?.key)
			this.#scrollOffsets.set(previousKey, this.#pane.getScrollOffset());
		this.#displayedKey = displayed?.key;
		this.#options.statusLine.setRuntimeStatus(displayed?.status, displayed?.title);
		const sameRenderedRequest =
			displayed !== undefined &&
			displayed.key === previousKey &&
			displayed.request !== undefined &&
			this.#renderedTurns === displayed.turns &&
			this.#renderedTurnsLength === displayed.turns.length &&
			this.#renderedRequestInput === displayed.request.input &&
			this.#renderedRequestTimestamp === displayed.request.timestamp;
		const transcriptUnchanged =
			displayed !== undefined &&
			displayed.key === previousKey &&
			this.#renderedTurns === displayed.turns &&
			this.#renderedTurnsLength === displayed.turns.length &&
			this.#renderedRequestInput === displayed.request?.input &&
			this.#renderedRequestTimestamp === displayed.request?.timestamp &&
			this.#renderedRequestMessages === displayed.request?.messages &&
			this.#renderedRequestMessagesLength === (displayed.request?.messages.length ?? 0) &&
			this.#renderedStreamMessage === displayed.request?.streamMessage;
		const streamMessage = displayed?.request?.streamMessage;
		let updatedStream =
			sameRenderedRequest &&
			this.#renderedRequestMessages === displayed.request?.messages &&
			this.#renderedRequestMessagesLength === (displayed.request?.messages.length ?? 0) &&
			this.#renderedStreamMessage !== undefined &&
			streamMessage !== undefined &&
			this.#pane.updateStreamingAssistant(streamMessage);
		if (
			!updatedStream &&
			sameRenderedRequest &&
			this.#renderedStreamMessage !== undefined &&
			streamMessage === undefined
		) {
			const finalMessage = displayed.request?.messages.at(-1);
			updatedStream = finalMessage?.role === "assistant" && this.#pane.finalizeStreamingAssistant(finalMessage);
		}
		if (
			!updatedStream &&
			displayed !== undefined &&
			displayed.key === previousKey &&
			displayed.request === undefined &&
			this.#renderedRequestInput !== undefined &&
			this.#renderedTurnsLength + 1 === displayed.turns.length
		) {
			const completedTurn = displayed.turns.at(-1);
			if (
				completedTurn?.input === this.#renderedRequestInput &&
				completedTurn.timestamp === this.#renderedRequestTimestamp
			) {
				updatedStream = this.#pane.finalizeStreamingAssistant(
					sanitizeAssistantForReparentedHistory(completedTurn.assistantMessage),
				);
			}
		}
		if (!updatedStream && !transcriptUnchanged) this.#pane.rebuild(displayed ? this.#messages(displayed) : []);
		this.#renderedTurns = displayed?.turns;
		this.#renderedTurnsLength = displayed?.turns.length ?? 0;
		this.#renderedRequestInput = displayed?.request?.input;
		this.#renderedRequestTimestamp = displayed?.request?.timestamp;
		this.#renderedRequestMessages = displayed?.request?.messages;
		this.#renderedRequestMessagesLength = displayed?.request?.messages.length ?? 0;
		this.#renderedStreamMessage = displayed?.request?.streamMessage;
		if (displayed && displayed.key !== previousKey) {
			this.#pane.setScrollOffset(this.#scrollOffsets.get(displayed.key) ?? "bottom");
		}
	}

	#messages(thread: BtwThreadView): AgentMessage[] {
		const messages: AgentMessage[] = [];
		for (const turn of thread.turns) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: turn.input }, ...(turn.images ?? [])],
				timestamp: turn.timestamp,
			});
			if (turn.intermediateMessages) messages.push(...turn.intermediateMessages);
			messages.push(sanitizeAssistantForReparentedHistory(turn.assistantMessage));
		}
		if (thread.request) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: thread.request.input }, ...(thread.request.images ?? [])],
				timestamp: thread.request.timestamp,
			});
			messages.push(...thread.request.messages);
			if (thread.request.streamMessage) messages.push(thread.request.streamMessage);
		}
		return messages;
	}

	#displayed(): BtwThreadView | undefined {
		const key = this.#previewKey ?? this.#selectedKey;
		return key ? this.#threads.find(thread => thread.key === key) : undefined;
	}

	#selected(): BtwThreadView | undefined {
		return this.#selectedKey ? this.#threads.find(thread => thread.key === this.#selectedKey) : undefined;
	}

	#persistCurrentDraft(): void {
		if (!this.#selectedKey) return;
		const editor = this.#pane.getPasteTarget();
		this.#options.onDraftChange(
			this.#selectedKey,
			this.#pane.getEditorText(),
			editor?.pendingImages,
			editor?.pendingImageLinks,
		);
		this.#options.onPersistDraft(this.#selectedKey);
	}
	#clearAppViewportHoverNow(): void {
		this.#pane.clearAppViewportHover();
		if (this.#hoverClearTimer) {
			clearTimeout(this.#hoverClearTimer);
			this.#hoverClearTimer = undefined;
		}
		if (!this.#previewKey && !this.#railPeek && !this.#newThreadHovered && this.#railAnimation?.kind !== "peek") {
			return;
		}
		const hadPreview = this.#previewKey !== undefined;
		this.#previewKey = undefined;
		this.#newThreadHovered = false;
		if (hadPreview) this.#showDisplayedThread();
		if (this.#railCollapsed) {
			this.#hideRailPeek();
		} else {
			this.#railPeek = false;
			if (this.#railAnimation?.kind === "peek") this.#stopRailAnimation();
			this.#options.requestRender();
		}
	}

	#toggleRail(): void {
		const fromWidth = this.#railWidth(this.#width);
		this.#railCollapsed = !this.#railCollapsed;
		this.#railPeek = false;
		if (this.#hoverClearTimer) {
			clearTimeout(this.#hoverClearTimer);
			this.#hoverClearTimer = undefined;
		}
		if (this.#previewKey) {
			this.#previewKey = undefined;
			this.#showDisplayedThread();
		}
		this.#startRailAnimation(fromWidth, this.#railCollapsed ? 0 : this.#expandedRailWidth(this.#width), "toggle");
	}

	#showRailPeek(): void {
		const fromWidth = this.#railWidth(this.#width);
		this.#railPeek = true;
		this.#startRailAnimation(fromWidth, this.#expandedRailWidth(this.#width), "peek");
	}

	#hideRailPeek(): void {
		const fromWidth = this.#railWidth(this.#width);
		this.#railPeek = false;
		this.#startRailAnimation(fromWidth, 0, "peek");
	}

	#startRailAnimation(fromWidth: number, targetWidth: number, kind: "toggle" | "peek"): void {
		this.#stopRailAnimation();
		const expandedWidth = this.#expandedRailWidth(this.#width);
		const start = Math.max(0, Math.min(expandedWidth, fromWidth));
		const target = Math.max(0, Math.min(expandedWidth, targetWidth));
		if (start === target) {
			this.#options.requestRender();
			return;
		}
		this.#railAnimation = { fromWidth: start, targetWidth: target, frame: 0, kind };
		this.#railAnimationTimer = setInterval(() => {
			const animation = this.#railAnimation;
			if (!animation) return;
			animation.frame++;
			if (animation.frame >= RAIL_TOGGLE_ANIMATION_FRAMES) this.#stopRailAnimation();
			this.#options.requestRender();
		}, RAIL_TOGGLE_ANIMATION_FRAME_MS);
		this.#railAnimationTimer.unref();
		this.#options.requestRender();
	}

	#stopRailAnimation(): void {
		if (this.#railAnimationTimer) {
			clearInterval(this.#railAnimationTimer);
			this.#railAnimationTimer = undefined;
		}
		this.#railAnimation = undefined;
	}

	#ensureRailTargetVisible(): void {
		const key = this.#previewKey ?? this.#selectedKey;
		const index = this.#threads.findIndex(thread => thread.key === key);
		if (index < 0) {
			this.#railOffset = 0;
			return;
		}
		const capacity = this.#railCapacity();
		if (index < this.#railOffset) this.#railOffset = index;
		else if (index >= this.#railOffset + capacity) this.#railOffset = Math.max(0, index - capacity + 1);
	}

	#railCapacity(): number {
		return Math.max(1, this.#height - 1);
	}

	#railHandleRow(): number {
		return Math.floor((Math.max(1, this.#height) - 1) / 2);
	}

	#expandedRailWidth(totalWidth: number): number {
		const maxForTranscript = Math.max(6, totalWidth - 12);
		return Math.min(
			RAIL_MAX_WIDTH,
			maxForTranscript,
			Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_TARGET_WIDTH, Math.floor(totalWidth * 0.3))),
		);
	}

	#railWidth(totalWidth: number): number {
		const expandedWidth = this.#expandedRailWidth(totalWidth);
		const animation = this.#railAnimation;
		if (animation) {
			const progress = Math.min(1, animation.frame / RAIL_TOGGLE_ANIMATION_FRAMES);
			const eased = 1 - (1 - progress) ** 3;
			const from = Math.min(expandedWidth, animation.fromWidth);
			const target = Math.min(expandedWidth, animation.targetWidth);
			return Math.round(from + (target - from) * eased);
		}
		if (this.#railCollapsed && !this.#railPeek) return 0;
		return expandedWidth;
	}

	#sliceTranscriptTail(line: string, start: number, length: number): string {
		if (length <= 0) return "";
		const prefix = sliceWithWidth(line, 0, start, true);
		const tail = sliceWithWidth(line, start, length, true);
		const boundaryPad =
			tail.width > 0 ? Math.min(Math.max(0, start - prefix.width), Math.max(0, length - tail.width)) : 0;
		return `${padding(boundaryPad)}${tail.text}`;
	}

	#fit(text: string, width: number): string {
		const fitted = truncateToWidth(text, Math.max(1, width));
		const gap = width - visibleWidth(fitted);
		return gap > 0 ? `${fitted}${" ".repeat(gap)}` : fitted;
	}
}
