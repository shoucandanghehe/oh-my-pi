/**
 * Fullscreen transcript viewer.
 *
 * `AgentHubOverlayComponent.openChat` mounts this as a `fullscreen` overlay
 * (`ui.showOverlay(..., { fullscreen: true })`), so it borrows the terminal's
 * alternate screen buffer (the vim/less idiom) and paints the whole screen — no
 * compositing into the live transcript's scrollback. It shows subagent,
 * advisor, and collab-guest transcripts outside Main.
 *
 * Local transcripts tail complete JSONL entries by file identity and sentinels.
 * A live local session adds its current assistant partial as a transient tail
 * until the complete entry arrives; rewrites and rotations rebuild the history.
 * Collab guests read the host's byte-capped transcript instead.
 */
import type * as fs from "node:fs";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import { editorKey } from "../chrome/keybinding-hints";
import { componentContains, renderTargeted, type TargetedRender } from "../tui";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import type { VirtualRowAnchor } from "../tui";
import type { KeyId } from "../app-keybindings";
import type { AssistantThinkingRenderer, ExtensionPresentationSource, MessageRenderer } from "../chat/extension-types";
import type { SessionMessageEntryLike } from "../chat/transcript-entry";
import { renderWorkspacePaneHeader } from "../chrome/shared";
import type { EditorTopBorder } from "../components/composer";
import { matchesKey } from "../keys";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
import type { TextSelectionRange } from "../text-selection";
import type { Component, Focusable, TUI } from "../tui";
import { replaceTabs } from "../utils";
import type { ViewportHeightAware, WorkspacePaneHeaderProvider } from "../workspace-layout";
import type { AgentHubRegistry, AgentHubSession, AgentLifecycleLike, AgentStatus } from "./agent-hub-types";
import { theme } from "../theme/theme";
import type { AppViewportHoverProvider } from "../tui";
import { Container } from "../tui";
import { fgAnsi } from "../theme/color";
import type { AgentHubRemote } from "./agent-hub";
import { sanitizeErrorLine } from "../chrome/error-block";
import { formatContextUsage } from "../chrome/context-thresholds";
import { node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, escCloseButton, hintsRow, overlayCard } from "../native/overlay";
import { ChatTranscriptPane } from "../chat/chat-transcript-pane";
import { StatusLineComponent } from "../status-line/component";
import type { CustomEditor } from "../prompt/custom-editor";
import { ExtensionWidgets } from "../chrome/extension-widgets";

type PaneStatusLine = Pick<StatusLineComponent, "getTopBorder" | "dispose"> &
	Partial<Pick<StatusLineComponent, "setHookStatus" | "render">>;

/** Parsed message and model metadata relevant to a transcript viewer. */
export type AgentTranscriptEntry =
	| SessionMessageEntryLike
	| { type: "model_change"; model: string }
	| { type: "session"; cwd: string };

/** Local filesystem and session parsing capabilities supplied by the host. */
export interface AgentTranscriptSource {
	/**
	 * Sync primitives drive the first paint and the incremental tail. When the
	 * host also supplies `promises.readFile` (e.g. passes `node:fs` itself), full
	 * reloads after rotation/rewrite read the file off the UI thread.
	 */
	fs: Pick<typeof fs, "openSync" | "closeSync" | "readSync" | "readFileSync" | "statSync"> & {
		promises?: Pick<typeof fs.promises, "readFile">;
	};
	parseEntries(text: string): AgentTranscriptEntry[];
	/** Stream complete session headers, message entries, and model changes from a bounded snapshot. */
	visitEntries(
		filePath: string,
		visit: (entry: AgentTranscriptEntry) => void | boolean,
		options: {
			maxBytes?: number;
			yieldEveryEntries?: number;
			shouldContinue?: () => boolean;
			onTrailingPartial?: (bytes: Uint8Array) => void;
			onBytesConsumed?: (bytes: number) => void;
			throwIfMissing?: boolean;
		},
	): Promise<unknown>;
}

export interface AgentTranscriptViewerDeps {
	agentId: string;
	transcript: AgentTranscriptSource;
	/** Persisted entry to reveal on first paint when opened from an activity row. */
	initialEntryId?: string;
	registry: AgentHubRegistry;
	/** Collab guest: read transcript from the host instead of a local file. */
	remote?: AgentHubRemote;
	/** Revive+prompt path for messageable local agents. Lazy to avoid touching the global. */
	lifecycle?: () => Pick<AgentLifecycleLike, "ensureLive">;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	getAssistantThinkingRenderers?: () => readonly AssistantThinkingRenderer[];
	resolveLinks?: (texts: readonly string[], cwd: string) => Promise<ReadonlyMap<string, string>>;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandThinkingBlocks?: () => boolean;
	expandKeys: KeyId[];
	/** Build a status line for the current live session resolved by the host. */
	createStatusLine: (agentId: string) => PaneStatusLine | undefined;
	/** Resolve the current session-owned presentation without granting an interactive UI host. */
	getExtensionPresentation?: (agentId: string) => ExtensionPresentationSource | undefined;
	getStatusLineTransparent?: () => boolean;
	/** Keys that toggle the Agent Hub (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	requestRender: () => void;
	/** Close just this viewer (Esc), returning to its owner. */
	onClose: () => void;
	/** Handle a Hub toggle key according to the viewer's host context. */
	onHubToggle: () => void;
}

/** How often to re-stat a file-backed transcript for growth (advisor/live tail). */
const POLL_MS = 250;
/** Every Nth idle poll re-verifies sentinels, catching same-size/mtime rewrites. */
const IDLE_SENTINEL_CHECK_EVERY = 5;
const AUTO_CLOSE_FRAME_MS = 16;
const AUTO_CLOSE_DURATION_MS = 3_000;
const AUTO_CLOSE_FRAMES = Math.ceil(AUTO_CLOSE_DURATION_MS / AUTO_CLOSE_FRAME_MS);

const SENTINEL_BYTES = 4096;
const ASYNC_LOCAL_LOAD_THRESHOLD_BYTES = 2 * 1024 * 1024;
function sameAssistantTurn(left: AssistantMessage, right: AssistantMessage): boolean {
	if (left.timestamp !== right.timestamp || left.provider !== right.provider || left.model !== right.model)
		return false;
	return left.responseId === undefined || right.responseId === undefined || left.responseId === right.responseId;
}

interface LocalTranscriptSentinel {
	offset: number;
	bytes: Buffer;
}

interface LocalTranscriptState {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	offset: number;
	pending: string;
	sentinels: LocalTranscriptSentinel[];
}

function readFileRangeSync(fs: AgentTranscriptSource["fs"], file: string, offset: number, length: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
		return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
	} finally {
		fs.closeSync(fd);
	}
}

function sentinelOffsets(size: number): number[] {
	if (size <= 0) return [];
	const length = Math.min(SENTINEL_BYTES, size);
	return [...new Set([0, Math.max(0, Math.floor((size - length) / 2)), Math.max(0, size - length)])];
}

function sentinelsFromBuffer(buffer: Buffer): LocalTranscriptSentinel[] {
	const size = buffer.byteLength;
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({
		offset,
		bytes: Buffer.from(buffer.subarray(offset, offset + length)),
	}));
}

function sentinelsFromFile(fs: AgentTranscriptSource["fs"], file: string, size: number): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({ offset, bytes: readFileRangeSync(fs, file, offset, length) }));
}

/**
 * `sanitizeErrorLine` width for described text, which the terminal truncates
 * itself: effectively unbounded, but within the native truncate's i32 range.
 */
const NATIVE_LINE_WIDTH = 0x7fff_ffff;

const STATUS_TONE: Record<AgentStatus, TspTone> = {
	running: "success",
	idle: "accent",
	parked: "muted",
	aborted: "error",
};

function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("success", "running");
		case "idle":
			return theme.fg("accent", "idle");
		case "parked":
			return theme.fg("muted", "parked");
		case "aborted":
			return theme.fg("error", "aborted");
	}
}

function stoneNoise(row: number, col: number): number {
	const mixed = Math.imul(row + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(col + 0xc2b2ae35, 0x27d4eb2f);
	const hashed = (mixed ^ (mixed >>> 16)) >>> 0;
	return hashed / 4294967296;
}

const STONE_GRADIENT_STEPS = 6;
const STONE_GRADIENT_SETTLE_PROGRESS = 0.24;
let stoneGradientCache: { key: string; ansi: readonly string[] } | undefined;

function hexRgb(hex: string): readonly [number, number, number] {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function stoneGradientAnsi(): readonly string[] {
	const lightHex = theme.getColorHex("muted");
	const darkHex = theme.getColorHex("dim");
	const mode = theme.getColorMode();
	const key = `${mode}:${lightHex}:${darkHex}`;
	if (stoneGradientCache?.key === key) return stoneGradientCache.ansi;

	const light = hexRgb(lightHex);
	const dark = hexRgb(darkHex);
	const ansi = Array.from({ length: STONE_GRADIENT_STEPS }, (_value, index) => {
		const ratio = index / (STONE_GRADIENT_STEPS - 1);
		const channels = light.map((channel, channelIndex) =>
			Math.round(channel + ((dark[channelIndex] ?? channel) - channel) * ratio),
		);
		const hex = `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
		return fgAnsi(hex, mode);
	});
	stoneGradientCache = { key, ansi };
	return ansi;
}

function ansiSequenceEnd(text: string, start: number): number {
	const kind = text.charCodeAt(start + 1);
	if (kind === 0x5b) {
		for (let index = start + 2; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return index + 1;
		}
		return text.length;
	}
	if (kind === 0x5d) {
		for (let index = start + 2; index < text.length; index++) {
			if (text.charCodeAt(index) === 0x07) return index + 1;
			if (text.charCodeAt(index) === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2;
		}
		return text.length;
	}
	if (kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
		for (let index = start + 2; index < text.length; index++) {
			if (text.charCodeAt(index) === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2;
		}
		return text.length;
	}
	return Math.min(text.length, start + 2);
}

function foregroundAnsiAfterSgr(sequence: string, current: string): string {
	if (!sequence.startsWith("\x1b[") || !sequence.endsWith("m")) return current;
	const params = sequence.slice(2, -1);
	if (params === "") return "\x1b[39m";
	const tokens = params.split(";");
	let foreground = current;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (token.startsWith("38:")) {
			foreground = `\x1b[${token}m`;
			continue;
		}
		const value = Number(token || "0");
		if (value === 0 || value === 39) {
			foreground = "\x1b[39m";
			continue;
		}
		if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
			foreground = `\x1b[${value}m`;
			continue;
		}
		if (value !== 38) continue;
		const mode = tokens[index + 1];
		const last = mode === "2" ? index + 4 : mode === "5" ? index + 2 : index;
		if (last === index || last >= tokens.length) continue;
		foreground = `\x1b[${tokens.slice(index, last + 1).join(";")}m`;
		index = last;
	}
	return foreground;
}

function renderPetrificationFrame(
	lines: readonly string[],
	frame: number,
	rowOffset: number,
	totalRows: number,
): string[] {
	const progress = Math.min(1, (frame + 1) / AUTO_CLOSE_FRAMES);
	const height = Math.max(1, totalRows);
	const totalCols = Math.max(1, ...lines.map(line => Bun.stringWidth(Bun.stripANSI(line))));
	const gradient = stoneGradientAnsi();

	return lines.map((line, row) => {
		const absoluteRow = Math.max(0, rowOffset + row);
		const rowRatio = absoluteRow / Math.max(1, height - 1);
		if (progress < rowRatio * 0.58 * 0.85 - 0.02) return line;

		let index = 0;
		let col = 0;
		let changed = false;
		let rendered = "";
		let originalForeground = "\x1b[39m";
		while (index < line.length) {
			if (line.charCodeAt(index) === 0x1b) {
				const end = ansiSequenceEnd(line, index);
				const sequence = line.slice(index, end);
				rendered += sequence;
				originalForeground = foregroundAnsiAfterSgr(sequence, originalForeground);
				index = end;
				continue;
			}

			const codePoint = line.codePointAt(index);
			if (codePoint === undefined) break;
			const glyph = String.fromCodePoint(codePoint);
			index += glyph.length;
			const glyphWidth = Bun.stringWidth(glyph);
			if (glyphWidth <= 0 || glyph === " ") {
				rendered += glyph;
				if (glyphWidth > 0) col += glyphWidth;
				continue;
			}

			const colRatio = col / Math.max(1, totalCols - 1);
			const noise = stoneNoise(absoluteRow, col);
			const threshold = Math.max(
				0,
				Math.min(0.85, (rowRatio * 0.58 + colRatio * 0.42) * 0.85 + (noise - 0.5) * 0.04),
			);
			if (progress < threshold) {
				rendered += glyph;
			} else {
				changed = true;
				const age = progress - threshold;
				const step = Math.min(
					gradient.length - 1,
					Math.floor((age / STONE_GRADIENT_SETTLE_PROGRESS) * gradient.length),
				);
				const stoneForeground = gradient[Math.max(0, step)] ?? gradient.at(-1) ?? theme.getFgAnsi("dim");
				rendered += `${stoneForeground}${glyph}${originalForeground}`;
			}
			col += glyphWidth;
		}
		return changed ? rendered : line;
	});
}

export class AgentTranscriptViewer
	implements
		Component,
		Focusable,
		MouseRoutable,
		TargetedRender,
		ViewportHeightAware,
		WorkspacePaneHeaderProvider,
		AppViewportHoverProvider
{
	readonly #pane: ChatTranscriptPane;
	readonly #deps: AgentTranscriptViewerDeps;
	#model: string | undefined;
	readonly #widgets: ExtensionWidgets;
	readonly #belowEditor = new Container();
	#extensionPresentation: ExtensionPresentationSource | undefined;
	#detachPresentation: (() => void) | undefined;
	#localState: LocalTranscriptState | undefined;
	#localUnavailable = "";
	#localLoadToken = 0;
	#localLoading: { path: string; dev: number; ino: number } | undefined;
	#liveAssistant: AssistantMessage | undefined;
	#sourceCwd: string | undefined;
	// Remote transcript state (incremental; the host caps each read).
	#remoteBytes = 0;
	#remoteFetchInFlight = false;
	#remoteToken = 0;
	#remoteUnavailable = false;
	#remoteError = "";
	#hasRemoteData = false;

	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;
	/** Idle polls since the sentinels were last verified. */
	#idlePolls = 0;
	/** Last described node and the visible inputs it was built from. */
	#nativeCache: { signature: string; node: NativeNode } | undefined;

	#statusLine: PaneStatusLine | undefined;
	#statusLineSession: AgentHubSession | null = null;
	#autoClose: { frame: number; onComplete: () => void } | undefined;
	#autoCloseTimer: NodeJS.Timeout | undefined;
	#autoCloseAbandoned = false;
	#lastRenderedBodyRows = 1;

	constructor(deps: AgentTranscriptViewerDeps) {
		this.#deps = deps;
		const displayId = replaceTabs(deps.agentId);
		this.#statusLineSession = deps.registry.get(deps.agentId)?.session ?? null;
		this.#statusLine = this.#statusLineSession ? deps.createStatusLine(deps.agentId) : undefined;
		this.#widgets = new ExtensionWidgets(deps.ui);
		this.#belowEditor.addChild(this.#widgets.below);
		this.#belowEditor.addChild({ render: width => this.#statusLine?.render?.(width) ?? [] });
		const resolveLinks = deps.resolveLinks;
		this.#pane = new ChatTranscriptPane({
			builder: {
				ui: deps.ui,
				getTool: deps.getTool,
				isBuiltInTool: deps.isBuiltInTool,
				getMessageRenderer: deps.getMessageRenderer,
				getAssistantThinkingRenderers: deps.getAssistantThinkingRenderers,
				resolveLinks:
					!deps.remote && resolveLinks ? texts => resolveLinks(texts, this.#sourceCwd ?? deps.cwd) : undefined,
				cwd: deps.cwd,
				hideThinkingBlock: deps.hideThinkingBlock,
				proseOnlyThinking: deps.proseOnlyThinking,
				expandThinkingBlocks: deps.expandThinkingBlocks,
				// Charts are for the main session's answers, not parked subagent, advisor, or guest transcripts.
				tableCharts: false,
				requestRender: deps.requestRender,
			},
			initialEntryId: deps.initialEntryId,
			editor: this.#sendable
				? {
						label: `Message ${displayId}`,
						placeholder: `Message ${displayId}…`,
						images: !deps.remote,
						onSubmit: (text, images) => {
							this.#submit(text, images);
							return true;
						},
					}
				: {
						label: "read-only · advisor",
						placeholder: "read-only · advisor",
						readOnly: true,
					},
			expandKeys: deps.expandKeys,
			aboveEditor: this.#widgets.above,
			belowEditor: this.#belowEditor,
			renderWorkspaceHeader: (width, focused) => this.renderWorkspaceHeader(width, focused),
			getEditorTopBorder: availableWidth => this.#getEditorTopBorder(availableWidth),
			getPlaceholder: () => this.#placeholder(),
			getNotice: () => (this.#remoteError && !this.#pane.isEmpty ? this.#remoteError : undefined),
			onInput: data => {
				for (const key of deps.hubKeys) {
					if (!matchesKey(data, key)) continue;
					deps.onHubToggle();
					return true;
				}
				return false;
			},
			onClose: deps.onClose,
		});
		// First paint loads synchronously so the initial entry can be revealed
		// immediately; later full reloads from the poll may go async.
		this.#refresh(false);
		this.#pollTimer = setInterval(() => this.#refresh(true), POLL_MS);
		this.#pollTimer.unref?.();
	}

	/** Advisor and aborted-agent transcripts are read-only. */
	get #sendable(): boolean {
		const ref = this.#deps.registry.get(this.#deps.agentId);
		if (!ref || ref.kind === "advisor" || ref.status === "aborted") return false;
		return Boolean(this.#deps.remote || this.#deps.lifecycle);
	}

	get focused(): boolean {
		return this.#pane.focused;
	}

	set focused(focused: boolean) {
		if (focused) this.#abandonAutoClose();
		this.#pane.focused = focused;
		if (!focused) this.#pane.clearAppViewportHover();
	}

	getPasteTarget(): CustomEditor | undefined {
		return this.#sendable ? this.#pane.getPasteTarget() : undefined;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#pane.setUseTerminalCursor(useTerminalCursor);
	}

	setViewportHeight(height: number): void {
		this.#pane.setViewportHeight(height);
	}

	setTextSelectionActive(active: boolean): void {
		this.#pane.setTextSelectionActive(active);
	}

	wantsAppViewportHover(): boolean {
		return this.#pane.wantsAppViewportHover();
	}

	clearAppViewportHover(): void {
		this.#pane.clearAppViewportHover();
	}

	getTextSelection(selection: TextSelectionRange): string | undefined {
		return this.#pane.getTextSelection(selection);
	}

	getTextSelectionInset(row: number): number {
		return this.#pane.getTextSelectionInset(row);
	}

	getTextSelectionRightInset(row: number): number {
		return this.#pane.getTextSelectionRightInset(row);
	}

	getTextSelectionScrollOffset(row: number): number | undefined {
		return this.#pane.getTextSelectionScrollOffset(row);
	}

	getTextSelectionAnchor(row: number): VirtualRowAnchor | undefined {
		return this.#pane.getTextSelectionAnchor(row);
	}

	resolveTextSelectionAnchor(anchor: VirtualRowAnchor): number | undefined {
		return this.#pane.resolveTextSelectionAnchor(anchor);
	}

	get autoCloseProtected(): boolean {
		return this.focused || this.#autoCloseAbandoned;
	}

	startAutoClose(onComplete: () => void): void {
		if (this.#disposed || this.autoCloseProtected || this.#autoClose) return;
		this.#autoClose = { frame: 0, onComplete };
		this.#autoCloseTimer = setInterval(() => {
			const animation = this.#autoClose;
			if (!animation || this.#disposed) return;
			animation.frame++;
			if (animation.frame >= AUTO_CLOSE_FRAMES) {
				this.#clearAutoCloseTimer();
				this.#autoClose = undefined;
				animation.onComplete();
				return;
			}
			this.#deps.ui.requestComponentRender(this);
		}, AUTO_CLOSE_FRAME_MS);
		this.#autoCloseTimer.unref();
		this.#deps.ui.requestComponentRender(this);
	}

	cancelAutoClose(): void {
		if (!this.#autoClose) return;
		this.#clearAutoCloseTimer();
		this.#autoClose = undefined;
		this.#deps.ui.requestComponentRender(this);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clearAutoCloseTimer();
		this.#autoClose = undefined;
		this.#stopPolling();
		this.#localLoadToken++;
		this.#localLoading = undefined;
		this.#remoteToken++;
		this.#detachPresentation?.();
		this.#detachPresentation = undefined;
		this.#widgets.clear();
		this.#statusLine?.dispose();
		this.#pane.dispose();
	}

	#stopPolling(): void {
		if (!this.#pollTimer) return;
		clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	// ========================================================================
	// Transcript loading
	// ========================================================================

	/** Refresh the transcript from a local file or remote host. */
	#refresh(allowAsync: boolean): void {
		if (this.#disposed) return;
		this.#syncSessionPresentation();
		if (this.#deps.remote) {
			this.#fetchRemote();
			return;
		}
		this.#refreshLocalTranscript();
		this.#syncLiveAssistant();
	}

	#refreshLocalTranscript(): void {
		const sessionFile = this.#deps.registry.get(this.#deps.agentId)?.sessionFile;
		if (!sessionFile) {
			this.#clearLocal("none");
			return;
		}
		let stat: fs.Stats;
		try {
			stat = this.#deps.transcript.fs.statSync(sessionFile);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const loading = this.#localLoading;
		if (loading && loading.path === sessionFile && loading.dev === stat.dev && loading.ino === stat.ino) return;
		const state = this.#localState;
		if (state) {
			// Idle fast path: an unchanged identity/size/mtime costs one stat;
			// sentinels are re-read only every Nth idle poll so a rewrite that
			// keeps size and mtime is still noticed.
			if (
				state.path === sessionFile &&
				state.dev === stat.dev &&
				state.ino === stat.ino &&
				stat.size === state.size &&
				stat.mtimeMs === state.mtimeMs
			) {
				if (++this.#idlePolls < IDLE_SENTINEL_CHECK_EVERY) return;
				this.#idlePolls = 0;
				if (this.#canAppendLocal(sessionFile, stat, state)) return;
				this.#loadLocalFull(sessionFile, stat, allowAsync);
				return;
			}
			if (stat.size > state.size && this.#canAppendLocal(sessionFile, stat, state)) {
				this.#appendLocal(sessionFile, stat, state, allowAsync);
				return;
			}
		}
		this.#loadLocalFull(sessionFile, stat, allowAsync);
	}

	#syncLiveAssistant(): void {
		if (this.#deps.remote) return;
		const state = this.#deps.registry.get(this.#deps.agentId)?.session?.agent?.state;
		const streamMessage = state?.streamMessage;
		let assistant = streamMessage?.role === "assistant" ? streamMessage : undefined;
		if (!assistant && state && this.#liveAssistant) {
			const last = state.messages.at(-1);
			assistant =
				last?.role === "assistant" && sameAssistantTurn(this.#liveAssistant, last) ? last : this.#liveAssistant;
		}
		if (assistant === this.#liveAssistant) return;
		this.#liveAssistant = assistant;
		this.#pane.setLiveAssistant(assistant);
	}

	#clearLocal(reason: string): void {
		if (!this.#localState && !this.#localLoading && this.#localUnavailable === reason) return;
		this.#localLoadToken++;
		this.#localLoading = undefined;
		this.#localState = undefined;
		this.#localUnavailable = reason;
		this.#model = undefined;
		this.#sourceCwd = undefined;
		this.#rebuild([]);
	}

	#canAppendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): boolean {
		if (state.path !== sessionFile || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.size)
			return false;
		for (const sentinel of state.sentinels) {
			let current: Buffer;
			try {
				current = readFileRangeSync(
					this.#deps.transcript.fs,
					sessionFile,
					sentinel.offset,
					sentinel.bytes.byteLength,
				);
			} catch (err) {
				// The file can be unlinked/rotated between statSync and this read.
				// Treat as not-appendable so #refresh falls back to a guarded full load.
				logger.debug("transcript viewer: sentinel read failed", { err: String(err) });
				return false;
			}
			if (!current.equals(sentinel.bytes)) return false;
		}
		return true;
	}

	#loadLocalFull(sessionFile: string, stat: fs.Stats, allowAsync: boolean): void {
		if (stat.size < ASYNC_LOCAL_LOAD_THRESHOLD_BYTES && !allowAsync) {
			this.#localLoadToken++;
			this.#localLoading = undefined;
			this.#loadLocalFullSync(sessionFile, stat);
			return;
		}
		const token = ++this.#localLoadToken;
		this.#localLoading = { path: sessionFile, dev: stat.dev, ino: stat.ino };
		this.#localState = undefined;
		this.#localUnavailable = "";
		this.#model = undefined;
		this.#rebuild([]);
		void this.#loadLocalFullAsync(sessionFile, stat, token);
	}

	#loadLocalFullSync(sessionFile: string, stat: fs.Stats): void {
		let data: Buffer;
		try {
			data = this.#deps.transcript.fs.readFileSync(sessionFile);
		} catch (err) {
			logger.debug("transcript viewer: read failed", { err: String(err) });
			return;
		}
		// The file may have grown between the earlier `statSync` and this read.
		// Anchor the tail cursor to what we actually consumed so the next poll's
		// `#appendLocal` never re-renders bytes already in the rebuilt transcript;
		// re-stat for mtime/identity so the post-read clock matches what's on disk.
		let post: fs.Stats;
		try {
			post = this.#deps.transcript.fs.statSync(sessionFile);
		} catch {
			post = stat;
		}
		const text = data.toString("utf-8");
		const lastNewline = text.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
		const pending = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
		this.#localUnavailable = "";
		this.#localState = {
			path: sessionFile,
			dev: post.dev,
			ino: post.ino,
			size: data.byteLength,
			mtimeMs: post.mtimeMs,
			offset: data.byteLength,
			pending,
			sentinels: sentinelsFromBuffer(data),
		};
		this.#sourceCwd = undefined;
		this.#model = undefined;
		this.#rebuild(this.#extractMessages(this.#deps.transcript.parseEntries(complete)));
	}

	async #loadLocalFullAsync(sessionFile: string, stat: fs.Stats, token: number): Promise<void> {
		this.#sourceCwd = undefined;
		const batch: AgentTranscriptEntry[] = [];
		const decoder = new TextDecoder();
		let pending = "";
		let bytesConsumed = 0;
		try {
			await this.#deps.transcript.visitEntries(
				sessionFile,
				entry => {
					batch.push(entry);
					if (batch.length < 128) return;
					this.#append(this.#extractMessages(batch));
					batch.length = 0;
				},
				{
					maxBytes: stat.size,
					yieldEveryEntries: 128,
					throwIfMissing: true,
					onBytesConsumed: bytes => {
						bytesConsumed += bytes;
					},
					shouldContinue: () => token === this.#localLoadToken && !this.#disposed,
					onTrailingPartial: bytes => {
						pending = decoder.decode(bytes);
					},
				},
			);
		} catch (err) {
			if (token === this.#localLoadToken) {
				this.#localLoading = undefined;
				logger.debug("transcript viewer: incremental load failed", { err: String(err) });
			}
			return;
		}
		if (token !== this.#localLoadToken || this.#disposed) return;
		if (batch.length > 0) this.#append(this.#extractMessages(batch));
		let sentinels: LocalTranscriptSentinel[];
		try {
			sentinels = sentinelsFromFile(this.#deps.transcript.fs, sessionFile, bytesConsumed);
		} catch (err) {
			this.#localLoading = undefined;
			logger.debug("transcript viewer: sentinel load failed", { err: String(err) });
			return;
		}
		this.#localState = {
			path: sessionFile,
			dev: stat.dev,
			ino: stat.ino,
			size: bytesConsumed,
			mtimeMs: stat.mtimeMs,
			offset: bytesConsumed,
			pending,
			sentinels,
		};
		this.#localLoading = undefined;
		this.#deps.requestRender();
	}

	#appendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState, allowAsync: boolean): void {
		let chunk: string;
		try {
			chunk = readFileRangeSync(
				this.#deps.transcript.fs,
				sessionFile,
				state.offset,
				stat.size - state.offset,
			).toString("utf-8");
		} catch (err) {
			logger.debug("transcript viewer: tail read failed", { err: String(err) });
			this.#loadLocalFull(sessionFile, stat, allowAsync);
			return;
		}
		const combined = state.pending + chunk;
		const lastNewline = combined.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : "";
		const previousModel = this.#model;
		const parsed = complete ? this.#extractMessages(this.#deps.transcript.parseEntries(complete)) : [];
		let sentinels: LocalTranscriptSentinel[];
		try {
			sentinels = sentinelsFromFile(this.#deps.transcript.fs, sessionFile, stat.size);
		} catch (err) {
			// File unlinked/rotated mid-poll: fall back to a guarded full reload
			// instead of letting the open escape the poll timer.
			logger.debug("transcript viewer: sentinel recompute failed", { err: String(err) });
			this.#loadLocalFull(sessionFile, stat, allowAsync);
			return;
		}
		this.#localState = {
			...state,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			offset: stat.size,
			pending: lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined,
			sentinels,
		};
		if (parsed.length > 0) {
			this.#append(parsed);
		} else if (this.#model !== previousModel) {
			this.#deps.requestRender();
		}
	}

	#fetchRemote(): void {
		const remote = this.#deps.remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const id = this.#deps.agentId;
		const fromByte = this.#remoteBytes;
		this.#remoteFetchInFlight = true;
		const token = ++this.#remoteToken;
		void remote
			.readTranscript(id, fromByte)
			.then(result => {
				if (token !== this.#remoteToken || this.#disposed) return;
				this.#remoteFetchInFlight = false;
				if (!result) {
					if (!this.#hasRemoteData && !this.#remoteUnavailable) {
						this.#remoteUnavailable = true;
						this.#deps.requestRender();
					}
					return;
				}
				if (result.error) {
					this.#remoteError = result.error;
					this.#hasRemoteData = true;
					this.#remoteUnavailable = false;
					this.#stopPolling();
					this.#deps.requestRender();
					return;
				}
				if (result.newSize < fromByte) {
					// Host transcript rotated/truncated — drop the stale rendered rows
					// before restarting; otherwise the post-rotation fetch would stack
					// new content under the pre-rotation history.
					this.#remoteBytes = 0;
					this.#remoteError = "";
					this.#hasRemoteData = false;
					this.#model = undefined;
					this.#sourceCwd = undefined;
					this.#rebuild([]);
					this.#fetchRemote();
					return;
				}
				this.#remoteUnavailable = false;
				this.#remoteError = "";
				const firstData = !this.#hasRemoteData;
				this.#hasRemoteData = true;
				const lastNewline = result.text.lastIndexOf("\n");
				if (lastNewline >= 0) {
					const completeChunk = result.text.slice(0, lastNewline + 1);
					this.#remoteBytes = fromByte + Buffer.byteLength(completeChunk, "utf-8");
					const previousModel = this.#model;
					const parsed = this.#extractMessages(this.#deps.transcript.parseEntries(completeChunk));
					if (parsed.length > 0) {
						this.#append(parsed);
						return;
					}
					if (this.#model !== previousModel) {
						this.#deps.requestRender();
						return;
					}
				}
				// First completed fetch (even empty) clears the "Loading…" placeholder.
				if (firstData) this.#deps.requestRender();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteFetchInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id, error: String(error) });
			});
	}

	/** Filter to message entries, tracking the model from the first assistant / a model_change. */
	#extractMessages(entries: AgentTranscriptEntry[]): SessionMessageEntryLike[] {
		const messages: SessionMessageEntryLike[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(entry);
				if (!this.#model && entry.message.role === "assistant") this.#model = entry.message.model;
			} else if (entry.type === "model_change") {
				this.#model = entry.model;
			} else if (entry.type === "session") {
				this.#sourceCwd = entry.cwd;
			}
		}
		return messages;
	}

	#rebuild(entries: SessionMessageEntryLike[]): void {
		const live = this.#liveAssistant;
		this.#liveAssistant = undefined;
		this.#pane.rebuildEntries(entries);
		this.#restoreLiveAssistant(live, entries);
	}

	#append(entries: SessionMessageEntryLike[]): void {
		const live = this.#liveAssistant;
		if (live) this.#pane.setLiveAssistant(undefined);
		this.#liveAssistant = undefined;
		this.#pane.appendEntries(entries);
		this.#restoreLiveAssistant(live, entries);
	}

	#restoreLiveAssistant(live: AssistantMessage | undefined, entries: SessionMessageEntryLike[]): void {
		if (
			live &&
			!entries.some(entry => entry.message.role === "assistant" && sameAssistantTurn(live, entry.message))
		) {
			this.#liveAssistant = live;
			this.#pane.setLiveAssistant(live);
		}
		this.#syncLiveAssistant();
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		this.#abandonAutoClose();
		return this.#pane.routeMouse(event, line, col);
	}

	handleInput(data: string): void {
		this.#abandonAutoClose();
		this.#pane.handleInput(data);
	}

	#submit(trimmed: string, images?: ImageContent[]): void {
		this.#pane.setNotice(undefined);
		const id = this.#deps.agentId;
		if (this.#deps.remote) {
			this.#deps.remote.chat(id, trimmed);
			this.#deps.requestRender();
			return;
		}
		const lifecycle = this.#deps.lifecycle;
		if (!lifecycle) return;
		void (async () => {
			try {
				// Revives a parked agent; returns the live session for running/idle.
				const session = await lifecycle().ensureLive(id);
				// Steers a mid-turn agent; sends a normal prompt to an idle one.
				await session.prompt(trimmed, { streamingBehavior: "steer", images });
			} catch (error) {
				this.#pane.setNotice(error instanceof Error ? error.message : String(error));
			}
			this.#deps.requestRender();
		})();
		this.#deps.requestRender();
	}

	// ========================================================================
	// Render
	// ========================================================================

	containsComponent(component: Component): boolean {
		return componentContains(this.#pane, component);
	}

	renderTargeted(width: number, targets: readonly Component[]): readonly string[] {
		const lines = renderTargeted(this.#pane, width, targets);
		this.#lastRenderedBodyRows = lines.length;
		return this.#autoClose
			? renderPetrificationFrame(lines, this.#autoClose.frame, 1, this.#lastRenderedBodyRows + 1)
			: lines;
	}

	invalidate(): void {
		this.#pane.invalidate();
	}

	render(width: number): readonly string[] {
		this.#syncSessionPresentation();
		const lines = this.#pane.render(width);
		this.#lastRenderedBodyRows = lines.length;
		return this.#autoClose
			? renderPetrificationFrame(lines, this.#autoClose.frame, 1, this.#lastRenderedBodyRows + 1)
			: lines;
	}

	/** The top-right `esc` runs Esc. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") this.#pane.handleInput("\x1b");
	}


	/**
	 * Header, transcript body (the builder's container, which describes its own
	 * blocks), notice, message editor, stats and key hints. Scrolling is the
	 * terminal's, so the j/k/g/G scroll hints are omitted.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const ref = this.#deps.registry.get(this.#deps.agentId);
		const notice = this.#notice ?? (this.#remoteError && !this.#builder.isEmpty ? this.#remoteError : undefined);
		const placeholder = this.#builder.isEmpty ? this.#placeholder(NATIVE_LINE_WIDTH) : undefined;
		const progress = this.#deps.observers?.getSession(this.#deps.agentId)?.progress;
		const stats = progress
			? [progress.contextTokens, progress.contextWindow, progress.durationMs, progress.toolCount, progress.cost]
			: undefined;
		const signature = JSON.stringify([
			ref?.status,
			ref?.kind,
			ref?.parentId,
			this.#model,
			notice,
			placeholder,
			stats,
			this.#deps.expandKeys[0],
		]);
		const cached = this.#nativeCache;
		if (cached?.signature === signature) return cached.node;

		const id = this.#deps.agentId;
		const children: NativeChild[] = [];
		// Top row: the agent's meta on the left, a clickable `esc` (close) on the right.
		const top: NativeChild[] = [];
		if (ref) {
			const kindTag = ref.parentId ? `${ref.kind} ${theme.sep.dot} of ${ref.parentId}` : ref.kind;
			const meta: NativeChild[] = [
				text([span(id, "strong")]),
				node("badge", { text: ref.status, tone: STATUS_TONE[ref.status] }),
				text([span(kindTag, "dim")], { truncate: "end" }),
			];
			if (this.#model) meta.push(text([span(this.#model, "muted")], { truncate: "end" }));
			top.push(node("row", { gap: "sm", align: "center", grow: 1, min: { w: 0 } }, meta, "meta"));
		} else {
			top.push(node("spacer", { grow: 1 }));
		}
		top.push(escCloseButton());
		children.push(node("row", { gap: "md", align: "center" }, top, "top"));
		children.push(
			placeholder === undefined
				? node("col", { grow: 1 }, [this.#builder.container], "transcript")
				: node("text", { spans: [span(placeholder, "dim")], wrap: "word" }, undefined, "placeholder"),
		);
		if (notice) {
			children.push(
				node(
					"text",
					{ text: sanitizeErrorLine(notice, NATIVE_LINE_WIDTH), tone: "error", truncate: "end" },
					undefined,
					"notice",
				),
			);
		}
		if (this.#editor) children.push(this.#editor);
		if (progress) {
			const statSpans: TspSpan[] = [];
			const sep = (): void => {
				if (statSpans.length > 0) statSpans.push(span(theme.sep.dot, "dim"));
			};
			if (progress.toolCount > 0) {
				statSpans.push(span(`${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}`, "dim"));
			}
			if (
				progress.contextTokens &&
				progress.contextTokens > 0 &&
				!(progress.contextWindow && progress.contextWindow > 0)
			) {
				sep();
				statSpans.push(span(formatNumber(progress.contextTokens), "dim"));
			}
			if (progress.durationMs > 0) {
				sep();
				statSpans.push(span(formatDuration(progress.durationMs), "dim"));
			}
			if (progress.cost > 0) {
				sep();
				statSpans.push(span(`$${progress.cost.toFixed(2)}`, "statusLineCost"));
			}
			const statsRow: NativeChild[] = [];
			if (
				progress.contextTokens &&
				progress.contextTokens > 0 &&
				progress.contextWindow &&
				progress.contextWindow > 0
			) {
				const fraction = progress.contextTokens / progress.contextWindow;
				statsRow.push(
					node("progress", {
						value: Math.min(1, fraction),
						label: formatContextUsage(fraction * 100, progress.contextWindow),
						max: { w: "24ch" },
					}),
				);
			}
			if (statSpans.length > 0) statsRow.push(text(statSpans, { truncate: "end" }));
			if (statsRow.length > 0) children.push(node("row", { gap: "md", align: "center" }, statsRow, "stats"));
		}
		children.push(
			hintsRow([
				this.#editor ? actionHint("tui.input.submit", "send") : undefined,
				{ keys: [this.#deps.expandKeys[0] ?? "ctrl+o"], label: "expand" },
			]),
		);
		const head = [span("Agent Hub", "accent"), span(` ${theme.sep.dot} `, "dim"), span(id, "accent")];
		const described = overlayCard("omp.hub.transcript", head, children);
		this.#nativeCache = { signature, node: described };
		return described;
	}

	renderWorkspaceHeader(width: number, focused: boolean): string {
		const ref = this.#deps.registry.get(this.#deps.agentId);
		const name = replaceTabs(this.#deps.agentId);
		const status = ref?.status ? ` ${statusBadge(ref.status)}` : "";
		const model = this.#model ? theme.fg("muted", ` ${theme.sep.dot} ${replaceTabs(this.#model)}`) : "";
		const action = focused
			? width >= 48
				? theme.fg("dim", this.#sendable ? " · Enter send · Hub · Esc" : " · Hub · Esc")
				: width >= 34
					? theme.fg("dim", " · Esc")
					: ""
			: "";
		const header = renderWorkspacePaneHeader(name, width, focused, `${status}${model}${action}`);
		return this.#autoClose
			? (renderPetrificationFrame([header], this.#autoClose.frame, 0, this.#lastRenderedBodyRows + 1)[0] ?? "")
			: header;
	}

	#abandonAutoClose(): void {
		if (!this.#autoClose) return;
		this.#autoCloseAbandoned = true;
		this.cancelAutoClose();
	}

	#clearAutoCloseTimer(): void {
		if (!this.#autoCloseTimer) return;
		clearInterval(this.#autoCloseTimer);
		this.#autoCloseTimer = undefined;
	}
	#syncSessionPresentation(): void {
		const session = this.#deps.registry.get(this.#deps.agentId)?.session ?? null;
		const presentation = this.#deps.remote ? undefined : this.#deps.getExtensionPresentation?.(this.#deps.agentId);
		const sessionChanged = session !== this.#statusLineSession;
		if (sessionChanged || presentation !== this.#extensionPresentation) {
			this.#statusLine?.dispose();
			this.#statusLine = session ? this.#deps.createStatusLine(this.#deps.agentId) : undefined;
			this.#statusLineSession = session;
		}
		if (sessionChanged && this.#liveAssistant) {
			this.#pane.setLiveAssistant(undefined);
			this.#liveAssistant = undefined;
		}
		if (sessionChanged && this.#deps.resolveLinks && !this.#deps.remote) {
			this.#localLoadToken++;
			this.#localLoading = undefined;
			this.#localState = undefined;
			this.#pane.invalidateLinkContext();
		}
		if (presentation === this.#extensionPresentation) return;
		this.#detachPresentation?.();
		this.#detachPresentation = undefined;
		this.#widgets.clear();
		this.#extensionPresentation = presentation;
		if (!presentation) return;
		this.#detachPresentation = presentation.observePresentation({
			setWidget: (key, content, options) => {
				try {
					this.#widgets.setWidget(key, content, options);
				} catch (error) {
					logger.error("Pane extension widget failed", { agentId: this.#deps.agentId, key, error });
					this.#pane.setNotice(
						`Extension widget ${key}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				this.#deps.requestRender();
			},
			setStatus: (key, text) => {
				this.#statusLine?.setHookStatus?.(key, text);
				this.#deps.requestRender();
			},
		});
	}

	#getEditorTopBorder(availableWidth: number): EditorTopBorder {
		if (this.#statusLine) return this.#statusLine.getTopBorder(availableWidth);
		const ref = this.#deps.registry.get(this.#deps.agentId);
		return StatusLineComponent.getErrorTopBorder(
			`Status unavailable (${ref?.status ?? "missing"}) · ${this.#deps.agentId} · live session missing`,
			availableWidth,
			this.#deps.getStatusLineTransparent?.(),
		);
	}

	#placeholder(): string {
		if (this.#deps.remote) {
			if (this.#remoteError) return this.#remoteError;
			if (this.#remoteUnavailable) return "Transcript lives on the host — not available.";
			return this.#hasRemoteData ? "No messages yet." : "Loading transcript from host…";
		}
		if (this.#localLoading) return "Loading transcript…";
		if (!this.#deps.registry.get(this.#deps.agentId)?.sessionFile) return "No session file available yet.";
		return "No messages yet.";
	}
}
