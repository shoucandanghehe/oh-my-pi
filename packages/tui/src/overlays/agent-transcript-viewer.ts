/**
 * Fullscreen transcript viewer.
 *
 * `AgentHubOverlayComponent.openChat` mounts this as a `fullscreen` overlay
 * (`ui.showOverlay(..., { fullscreen: true })`), so it borrows the terminal's
 * alternate screen buffer (the vim/less idiom) and paints the whole screen — no
 * compositing into the live transcript's scrollback. It renders a parked
 * subagent / advisor / collab-guest transcript that has no live in-view session.
 *
 * Local transcripts tail append-only growth: unchanged file identity plus stable
 * sentinels means only newly appended JSONL is parsed and rendered. Rewrites,
 * truncation, rotation, or sentinel drift fall back to a full rebuild so changed
 * historical entries cannot leave stale components behind. Collab guests use the
 * same append path over the host's byte-capped transcript reads.
 */
import type * as fs from "node:fs";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import { editorKey } from "../chrome/keybinding-hints";
import { componentContains, renderTargeted, type TargetedRender } from "../tui";
import type { KeyId } from "../app-keybindings";
import type { MessageRenderer } from "../chat/extension-types";
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
import type { AgentHubRemote } from "./agent-hub";
import { sanitizeErrorLine } from "../chrome/error-block";
import { formatContextUsage } from "../chrome/context-thresholds";
import { node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../native/node";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";
import { ChatTranscriptPane } from "../chat/chat-transcript-pane";
import { StatusLineComponent } from "../status-line/component";

type PaneStatusLine = Pick<StatusLineComponent, "getTopBorder" | "dispose">;

/** Parsed message and model metadata relevant to a transcript viewer. */
export type AgentTranscriptEntry = SessionMessageEntryLike | { type: "model_change"; model: string };

/** Local filesystem and session parsing capabilities supplied by the host. */
export interface AgentTranscriptSource {
	fs: Pick<typeof fs, "openSync" | "closeSync" | "readSync" | "readFileSync" | "statSync">;
	parseEntries(text: string): AgentTranscriptEntry[];
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
	lifecycle?: () => AgentLifecycleLike;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	/** Build a status line for the current live session resolved by the host. */
	createStatusLine: (agentId: string) => PaneStatusLine;
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

const SENTINEL_BYTES = 4096;

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

export class AgentTranscriptViewer
	implements Component, Focusable, MouseRoutable, TargetedRender, ViewportHeightAware, WorkspacePaneHeaderProvider
{
	readonly #pane: ChatTranscriptPane;
	readonly #deps: AgentTranscriptViewerDeps;
	#model: string | undefined;
	#localState: LocalTranscriptState | undefined;
	#localUnavailable = "";
	// Remote transcript state (incremental; the host caps each read).
	#remoteBytes = 0;
	#remoteFetchInFlight = false;
	#remoteToken = 0;
	#remoteUnavailable = false;
	#remoteError = "";
	#hasRemoteData = false;

	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;
	/** Last described node and the visible inputs it was built from. */
	#nativeCache: { signature: string; node: NativeNode } | undefined;

	#statusLine: PaneStatusLine | undefined;
	#statusLineSession: AgentHubSession | null;

	constructor(deps: AgentTranscriptViewerDeps) {
		this.#deps = deps;
		const displayId = replaceTabs(deps.agentId);
		this.#statusLineSession = deps.registry.get(deps.agentId)?.session ?? null;
		this.#statusLine = this.#statusLineSession ? deps.createStatusLine(deps.agentId) : undefined;
		this.#pane = new ChatTranscriptPane({
			builder: {
				ui: deps.ui,
				getTool: deps.getTool,
				isBuiltInTool: deps.isBuiltInTool,
				getMessageRenderer: deps.getMessageRenderer,
				cwd: deps.cwd,
				hideThinkingBlock: deps.hideThinkingBlock,
				proseOnlyThinking: deps.proseOnlyThinking,
				requestRender: deps.requestRender,
			},
			initialEntryId: deps.initialEntryId,
			editor: this.#sendable
				? {
						label: `Message ${displayId}`,
						placeholder: `Message ${displayId}…`,
						onSubmit: text => {
							this.#submit(text);
							return true;
						},
					}
				: {
						label: "read-only · advisor",
						placeholder: "read-only · advisor",
						readOnly: true,
					},
			expandKeys: deps.expandKeys,
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
		this.#refresh();
		this.#pollTimer = setInterval(() => this.#refresh(), POLL_MS);
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
		this.#pane.focused = focused;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#pane.setUseTerminalCursor(useTerminalCursor);
	}

	setViewportHeight(height: number): void {
		this.#pane.setViewportHeight(height);
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

	dispose(): void {
		this.#disposed = true;
		this.#stopPolling();
		this.#remoteToken++;
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
	#refresh(): void {
		if (this.#disposed) return;
		if (this.#deps.remote) {
			this.#fetchRemote();
			return;
		}
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
		const state = this.#localState;
		if (state && this.#canAppendLocal(sessionFile, stat, state)) {
			if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) return;
			if (stat.size > state.size) {
				this.#appendLocal(sessionFile, stat, state);
				return;
			}
		}
		this.#loadLocalFull(sessionFile, stat);
	}

	#clearLocal(reason: string): void {
		if (!this.#localState && this.#localUnavailable === reason) return;
		this.#localState = undefined;
		this.#localUnavailable = reason;
		this.#model = undefined;
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

	#loadLocalFull(sessionFile: string, stat: fs.Stats): void {
		let data: Buffer;
		try {
			data = this.#deps.transcript.fs.readFileSync(sessionFile);
		} catch (err) {
			// Leave #localState unchanged so a transient read error retries next poll.
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
		// A reader that opens the file mid-append sees a trailing partial line
		// (no terminating newline). Carry those bytes as `pending` so the next
		// poll's `#appendLocal` joins them with the completion bytes instead of
		// parsing a headless line fragment and dropping the entry.
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
		this.#model = undefined;
		this.#rebuild(this.#extractMessages(this.#deps.transcript.parseEntries(complete)));
	}

	#appendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): void {
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
			this.#loadLocalFull(sessionFile, stat);
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
			this.#loadLocalFull(sessionFile, stat);
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
			}
		}
		return messages;
	}

	#rebuild(entries: SessionMessageEntryLike[]): void {
		this.#pane.rebuildEntries(entries);
	}

	#append(entries: SessionMessageEntryLike[]): void {
		this.#pane.appendEntries(entries);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		return this.#pane.routeMouse(event, line, col);
	}

	handleInput(data: string): void {
		this.#pane.handleInput(data);
	}

	#submit(trimmed: string): void {
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
				await session.prompt(trimmed, { streamingBehavior: "steer" });
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
		return renderTargeted(this.#pane, width, targets);
	}

	invalidate(): void {
		this.#pane.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#pane.render(width);
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
		if (ref) {
			const kindTag = ref.parentId ? `${ref.kind} ${theme.sep.dot} of ${ref.parentId}` : ref.kind;
			const meta: NativeChild[] = [
				text([span(id, "strong")]),
				node("badge", { text: ref.status, tone: STATUS_TONE[ref.status] }),
				text([span(kindTag, "dim")], { truncate: "end" }),
			];
			if (this.#model) meta.push(text([span(this.#model, "muted")], { truncate: "end" }));
			children.push(node("row", { gap: "sm", align: "center" }, meta, "meta"));
		}
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
				{ keys: ["escape"], label: "close" },
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
		return renderWorkspacePaneHeader(name, width, focused, `${status}${model}${action}`);
	}

	#getEditorTopBorder(availableWidth: number): EditorTopBorder {
		const ref = this.#deps.registry.get(this.#deps.agentId);
		const session = ref?.session ?? null;
		if (session !== this.#statusLineSession) {
			this.#statusLine?.dispose();
			this.#statusLine = session ? this.#deps.createStatusLine(this.#deps.agentId) : undefined;
			this.#statusLineSession = session;
		}
		if (this.#statusLine) return this.#statusLine.getTopBorder(availableWidth);
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
		if (!this.#deps.registry.get(this.#deps.agentId)?.sessionFile) return "No session file available yet.";
		return "No messages yet.";
	}
}
