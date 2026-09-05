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
import * as fs from "node:fs";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type AppViewportHoverProvider,
	type Component,
	componentContains,
	type EditorTopBorder,
	type Focusable,
	type MouseRoutable,
	matchesKey,
	renderTargeted,
	type SgrMouseEvent,
	type TargetedRender,
	type TextSelectionRange,
	type TUI,
	type ViewportHeightAware,
	type WorkspacePaneHeaderProvider,
} from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRegistry, AgentStatus } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries, visitEntriesFromFileStream } from "../../session/session-loader";
import { replaceTabs } from "../../tools/render-utils";
import { renderWorkspacePaneHeader } from "../shared";
import { fgAnsi } from "../theme/color";
import { theme } from "../theme/theme";
import type { AgentHubRemote } from "./agent-hub";
import { ChatTranscriptPane } from "./chat-transcript-pane";
import { StatusLineComponent } from "./status-line";

type PaneStatusLine = Pick<StatusLineComponent, "getTopBorder" | "dispose">;

export interface AgentTranscriptViewerDeps {
	agentId: string;
	/** Persisted entry to reveal on first paint when opened from an activity row. */
	initialEntryId?: string;
	registry: AgentRegistry;
	/** Collab guest: read transcript from the host instead of a local file. */
	remote?: AgentHubRemote;
	/** Revive+prompt path for messageable local agents. Lazy to avoid touching the global. */
	lifecycle?: () => AgentLifecycleManager;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	createStatusLine: (session: AgentSession) => PaneStatusLine;
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
const AUTO_CLOSE_FRAME_MS = 16;
const AUTO_CLOSE_DURATION_MS = 3_000;
const AUTO_CLOSE_FRAMES = Math.ceil(AUTO_CLOSE_DURATION_MS / AUTO_CLOSE_FRAME_MS);

const SENTINEL_BYTES = 4096;
const ASYNC_LOCAL_LOAD_THRESHOLD_BYTES = 2 * 1024 * 1024;

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

function readFileRangeSync(file: string, offset: number, length: number): Buffer {
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

function sentinelsFromFile(file: string, size: number): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({ offset, bytes: readFileRangeSync(file, offset, length) }));
}

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
	#localState: LocalTranscriptState | undefined;
	#localUnavailable = "";
	#localLoadToken = 0;
	#localLoading: { path: string; dev: number; ino: number } | undefined;
	// Remote transcript state (incremental; the host caps each read).
	#remoteBytes = 0;
	#remoteFetchInFlight = false;
	#remoteToken = 0;
	#remoteUnavailable = false;
	#remoteError = "";
	#hasRemoteData = false;

	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;
	#statusLine: PaneStatusLine | undefined;
	#statusLineSession: AgentSession | null;
	#autoClose: { frame: number; onComplete: () => void } | undefined;
	#autoCloseTimer: NodeJS.Timeout | undefined;
	#autoCloseAbandoned = false;
	#lastRenderedBodyRows = 1;

	constructor(private readonly deps: AgentTranscriptViewerDeps) {
		const displayId = replaceTabs(deps.agentId);
		this.#statusLineSession = deps.registry.get(deps.agentId)?.session ?? null;
		this.#statusLine = this.#statusLineSession ? deps.createStatusLine(this.#statusLineSession) : undefined;
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
		const ref = this.deps.registry.get(this.deps.agentId);
		if (!ref || ref.kind === "advisor" || ref.status === "aborted") return false;
		return Boolean(this.deps.remote || this.deps.lifecycle);
	}

	get focused(): boolean {
		return this.#pane.focused;
	}

	set focused(focused: boolean) {
		if (focused) this.#abandonAutoClose();
		this.#pane.focused = focused;
		if (!focused) this.#pane.clearAppViewportHover();
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

	startAutoClose(onComplete: () => void): void {
		if (this.#disposed || this.#autoCloseAbandoned || this.#autoClose) return;
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
			this.deps.ui.requestComponentRender(this);
		}, AUTO_CLOSE_FRAME_MS);
		this.#autoCloseTimer.unref();
		this.deps.ui.requestComponentRender(this);
	}

	cancelAutoClose(): void {
		if (!this.#autoClose) return;
		this.#clearAutoCloseTimer();
		this.#autoClose = undefined;
		this.deps.ui.requestComponentRender(this);
	}

	dispose(): void {
		this.#disposed = true;
		this.#clearAutoCloseTimer();
		this.#autoClose = undefined;
		this.#stopPolling();
		this.#localLoadToken++;
		this.#localLoading = undefined;
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
		if (this.deps.remote) {
			this.#fetchRemote();
			return;
		}
		const sessionFile = this.deps.registry.get(this.deps.agentId)?.sessionFile;
		if (!sessionFile) {
			this.#clearLocal("none");
			return;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(sessionFile);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const loading = this.#localLoading;
		if (loading && loading.path === sessionFile && loading.dev === stat.dev && loading.ino === stat.ino) return;
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
		if (!this.#localState && !this.#localLoading && this.#localUnavailable === reason) return;
		this.#localLoadToken++;
		this.#localLoading = undefined;
		this.#localState = undefined;
		this.#localUnavailable = reason;
		this.#rebuild([]);
	}

	#canAppendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): boolean {
		if (state.path !== sessionFile || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.size)
			return false;
		for (const sentinel of state.sentinels) {
			let current: Buffer;
			try {
				current = readFileRangeSync(sessionFile, sentinel.offset, sentinel.bytes.byteLength);
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
		if (stat.size < ASYNC_LOCAL_LOAD_THRESHOLD_BYTES) {
			this.#localLoadToken++;
			this.#localLoading = undefined;
			this.#loadLocalFullSync(sessionFile, stat);
			return;
		}
		const token = ++this.#localLoadToken;
		this.#localLoading = { path: sessionFile, dev: stat.dev, ino: stat.ino };
		this.#localState = undefined;
		this.#localUnavailable = "";
		this.#rebuild([]);
		void this.#loadLocalFullAsync(sessionFile, stat, token);
	}

	#loadLocalFullSync(sessionFile: string, stat: fs.Stats): void {
		let data: Buffer;
		try {
			data = fs.readFileSync(sessionFile);
		} catch (err) {
			logger.debug("transcript viewer: read failed", { err: String(err) });
			return;
		}
		let post: fs.Stats;
		try {
			post = fs.statSync(sessionFile);
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
		this.#rebuild(this.#extractMessages(parseSessionEntries(complete)));
	}

	async #loadLocalFullAsync(sessionFile: string, stat: fs.Stats, token: number): Promise<void> {
		const batch: SessionMessageEntry[] = [];
		const decoder = new TextDecoder();
		let pending = "";
		try {
			await visitEntriesFromFileStream(
				sessionFile,
				entry => {
					if (entry.type !== "message") return;
					batch.push(entry);
					if (batch.length < 128) return;
					this.#append(batch.splice(0));
				},
				{
					maxBytes: stat.size,
					yieldEveryEntries: 128,
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
		if (batch.length > 0) this.#append(batch);
		let sentinels: LocalTranscriptSentinel[];
		try {
			sentinels = sentinelsFromFile(sessionFile, stat.size);
		} catch (err) {
			this.#localLoading = undefined;
			logger.debug("transcript viewer: sentinel load failed", { err: String(err) });
			return;
		}
		this.#localState = {
			path: sessionFile,
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			offset: stat.size,
			pending,
			sentinels,
		};
		this.#localLoading = undefined;
		this.deps.requestRender();
	}

	#appendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): void {
		let chunk: string;
		try {
			chunk = readFileRangeSync(sessionFile, state.offset, stat.size - state.offset).toString("utf-8");
		} catch (err) {
			logger.debug("transcript viewer: tail read failed", { err: String(err) });
			this.#loadLocalFull(sessionFile, stat);
			return;
		}
		const combined = state.pending + chunk;
		const lastNewline = combined.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : "";
		const parsed = complete ? this.#extractMessages(parseSessionEntries(complete)) : [];
		let sentinels: LocalTranscriptSentinel[];
		try {
			sentinels = sentinelsFromFile(sessionFile, stat.size);
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
		if (parsed.length > 0) this.#append(parsed);
	}

	#fetchRemote(): void {
		const remote = this.deps.remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const id = this.deps.agentId;
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
						this.deps.requestRender();
					}
					return;
				}
				if (result.error) {
					this.#remoteError = result.error;
					this.#hasRemoteData = true;
					this.#remoteUnavailable = false;
					this.#stopPolling();
					this.deps.requestRender();
					return;
				}
				if (result.newSize < fromByte) {
					// Host transcript rotated/truncated — drop the stale rendered rows
					// before restarting; otherwise the post-rotation fetch would stack
					// new content under the pre-rotation history.
					this.#remoteBytes = 0;
					this.#remoteError = "";
					this.#hasRemoteData = false;
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
					const parsed = this.#extractMessages(parseSessionEntries(completeChunk));
					if (parsed.length > 0) {
						this.#append(parsed);
						return;
					}
				}
				// First completed fetch (even empty) clears the "Loading…" placeholder.
				if (firstData) this.deps.requestRender();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteFetchInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id, error: String(error) });
			});
	}

	/** Filter persisted entries to transcript messages. */
	#extractMessages(entries: FileEntry[]): SessionMessageEntry[] {
		return entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
	}

	#rebuild(entries: SessionMessageEntry[]): void {
		this.#pane.rebuildEntries(entries);
	}

	#append(entries: SessionMessageEntry[]): void {
		this.#pane.appendEntries(entries);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		this.#abandonAutoClose();
		return this.#pane.routeMouse(event, line, col);
	}

	handleInput(data: string): void {
		this.#abandonAutoClose();
		this.#pane.handleInput(data);
	}

	#submit(trimmed: string): void {
		this.#pane.setNotice(undefined);
		const id = this.deps.agentId;
		if (this.deps.remote) {
			this.deps.remote.chat(id, trimmed);
			this.deps.requestRender();
			return;
		}
		const lifecycle = this.deps.lifecycle;
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
			this.deps.requestRender();
		})();
		this.deps.requestRender();
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
		const lines = this.#pane.render(width);
		this.#lastRenderedBodyRows = lines.length;
		return this.#autoClose
			? renderPetrificationFrame(lines, this.#autoClose.frame, 1, this.#lastRenderedBodyRows + 1)
			: lines;
	}

	renderWorkspaceHeader(width: number, focused: boolean): string {
		const ref = this.deps.registry.get(this.deps.agentId);
		const name = replaceTabs(this.deps.agentId);
		const status = ref?.status ? ` ${statusBadge(ref.status)}` : "";
		const action = focused
			? width >= 48
				? theme.fg("dim", this.#sendable ? " · Enter send · Hub · Esc" : " · Hub · Esc")
				: width >= 34
					? theme.fg("dim", " · Esc")
					: ""
			: "";
		const header = renderWorkspacePaneHeader(name, width, focused, `${status}${action}`);
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
	#getEditorTopBorder(availableWidth: number): EditorTopBorder {
		const ref = this.deps.registry.get(this.deps.agentId);
		const session = ref?.session ?? null;
		if (session !== this.#statusLineSession) {
			this.#statusLine?.dispose();
			this.#statusLine = session ? this.deps.createStatusLine(session) : undefined;
			this.#statusLineSession = session;
		}
		if (this.#statusLine) return this.#statusLine.getTopBorder(availableWidth);
		return StatusLineComponent.getErrorTopBorder(
			`Status unavailable (${ref?.status ?? "missing"}) · ${this.deps.agentId} · live AgentSession missing`,
			availableWidth,
		);
	}

	#placeholder(): string {
		if (this.deps.remote) {
			if (this.#remoteError) return this.#remoteError;
			if (this.#remoteUnavailable) return "Transcript lives on the host — not available.";
			return this.#hasRemoteData ? "No messages yet." : "Loading transcript from host…";
		}
		if (this.#localLoading) return "Loading transcript…";
		if (!this.deps.registry.get(this.deps.agentId)?.sessionFile) return "No session file available yet.";
		return "No messages yet.";
	}
}
