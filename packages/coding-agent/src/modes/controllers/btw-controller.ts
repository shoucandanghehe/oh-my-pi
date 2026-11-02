import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { serializeConversation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message } from "@oh-my-pi/pi-ai";
import { getMarkdownLinkUrls, type OverlayHandle, replaceTabs, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import { BtwPanelComponent } from "@oh-my-pi/pi-tui/overlays/btw-panel";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { displayArgsForToolCall } from "@oh-my-pi/pi-tui/chat/tool-args-reveal";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { logger, prompt, Snowflake, toError, withTimeout } from "@oh-my-pi/pi-utils";
import btwConversationPrompt from "../../prompts/system/btw-conversation.md" with { type: "text" };
import btwHandoffPrompt from "../../prompts/system/btw-handoff.md" with { type: "text" };
import { resolveSessionMarkdownLinkHrefs } from "../../internal-urls/hyperlink-targets";
import type { ContinuePausedAgentsResult } from "../../session/agent-session-types";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	BtwHistoryStore,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwRecordInject,
	getBtwTurnKey,
	getBtwTurns,
} from "../../session/btw-history";
import { beginBtwTurn, patchLatestBtwTurn } from "../../session/btw-turn";
import { BtwManager, type BtwThread } from "../../session/btw-manager";
import { BtwSessionStore } from "../../session/btw-session-store";
import type { BtwPromotionLifecycle, BtwPromotionRequest } from "../../session/btw-thread";
import type { AgentSession } from "../../session/agent-session";
import { projectBtwMessages } from "../../session/ephemeral-conversation";
import { assistantMessageWithReplyText } from "../../session/messages";
import { sessionCommandQueue } from "../../session/session-command-queue";
import { SessionPaneControls } from "../utils/pane-session-controls";
import { preparePaneInput } from "../utils/prepare-pane-input";
import type { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { parseQueueShorthand } from "@oh-my-pi/pi-tui/prompt/queue-input";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { shiftImageMarkers } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { copyToClipboard } from "../../utils/clipboard";
import type { BtwInjectState } from "@oh-my-pi/pi-tui/overlays/btw-inject";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import type { AgentViewSession, AgentViewSessionManager } from "../../session/agent-session-handle";
import type { DroppedPrompt } from "../../session/agent-session-types";
import { cfgBtwInject } from "../settings";
import { BtwConversationPane, type BtwThreadView } from "../components/btw-conversation-pane";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	threadKey?: string;
}

interface BtwWorkspaceRequest extends BtwRequest {
	threadKey: string;
}

interface BtwHistoryRequest extends BtwRequest {
	session: AgentViewSession;
	/** Manager of the view that asked; the request outlives focus changes. */
	sessionManager: AgentViewSessionManager;
	store: BtwHistoryStore;
	record: BtwHistoryRecord;
	history?: readonly BtwHistoryTurn[];
	conversationKey: string;
	/** At least one checkpoint belongs to this request; later failures must block lifecycle changes. */
	persisted: boolean;
	/**
	 * `btw.inject` eligibility when the question was asked, fixed for the request's life so the
	 * prompt instruction, the highlighted block, and the inject key always agree.
	 */
	injectEnabled: boolean;
	abortController: AbortController;
	question: string;
	images?: ImageContent[];
	leafId: string | null;
	sessionId: string;
	timestamp: number;
	assistantMessage?: AssistantMessage;
}

function isHistoryRequest(request: BtwRequest): request is BtwHistoryRequest {
	return "record" in request;
}

const memoryHistoryStores = new WeakMap<object, { sessionId: string; store: BtwSessionStore }>();

export class BtwController {
	#activeRequest: BtwRequest | undefined;

	#branchInFlight = false;
	#copyInFlight = false;
	#visible = false;
	#starting = false;
	#transitionCount = 0;
	#generation = 0;
	#store: BtwHistoryStore | undefined;
	#storePromise: Promise<BtwHistoryStore> | undefined;
	#storeSessionId: string | undefined;
	#storeArtifactsDir: string | undefined;
	#storeScope: string | undefined;
	#historyPanel: BtwHistoryPanel | undefined;
	#historyOverlay: OverlayHandle | undefined;
	readonly #writes = new Set<Promise<boolean>>();
	/**
	 * Inject state per answer turn (`getBtwTurnKey`). Only turns answered in this process with
	 * the inject instruction and a closed block get an entry, so history from an earlier run, or
	 * an answer asked while injecting was off, never sends. Record ids are unique, so entries
	 * outlive session changes.
	 */
	readonly #injects = new Map<string, "ready" | "sending" | "sent">();
	/**
	 * Sends awaiting dispatch, by text: a prompt the session drops comes back here instead of the
	 * editor. An idle send keeps its entry until its turn settles, since the session reports drops
	 * by text alone; a typed prompt identical to the block dropped meanwhile would land here.
	 */
	readonly #droppedInjects = new Map<string, (prompt: DroppedPrompt) => void>();
	/** Turns whose send waits for startup-deferred extensions; `dispose()` cancels them back to ready. */
	readonly #awaitingExtensions = new Set<string>();
	readonly #failedWrites = new Map<BtwHistoryRequest, Error>();
	readonly #sessionControls = new Map<string, SessionPaneControls>();
	#manager: BtwManager | undefined;
	#managerSessionId: string | undefined;
	#managerArtifactsDir: string | null | undefined;
	#openingManager: Promise<BtwManager> | undefined;
	#disposing: Promise<void> | undefined;
	#workspacePane: BtwConversationPane | undefined;
	#workspaceOverlay: OverlayHandle | undefined;

	constructor(
		private readonly ctx: InteractiveModeContext,
		private readonly configurePaneEditor?: (editor: CustomEditor, session: AgentSession, ui: TUI) => void,
	) {}

	/** /btw asks about the transcript on screen: the focused agent's session, else main. */
	get #sessionManager(): AgentViewSessionManager {
		return this.ctx.focusedAgentId ? this.ctx.viewSession.sessionManager : this.ctx.sessionManager;
	}

	/** Focused agents share main's artifacts directory; scope their history by session id. */
	get #historyScope(): string | undefined {
		return this.ctx.focusedAgentId ? this.#sessionManager.getSessionId() : undefined;
	}

	readonly label = "BTW";

	prepareForPausedExit(): void {
		this.#manager?.prepareForPausedExit();
	}

	async continuePaused(): Promise<ContinuePausedAgentsResult> {
		return (await this.#managerForCurrentSession()).continuePaused();
	}

	/** Whether the inline panel owns Escape. */
	hasActiveRequest(): boolean {
		const request = this.#activeRequest;
		return request !== undefined && this.ctx.btwContainer.children.includes(request.component);
	}

	canOpenThread(): boolean {
		if (
			(!this.ctx.workspaceEnabled && !this.ctx.ui.nativeRendering) ||
			this.#branchInFlight ||
			this.#managerSessionId !== this.ctx.sessionManager.getSessionId()
		)
			return false;
		const key = this.#activeRequest?.threadKey;
		return key !== undefined && this.#manager?.thread(key) !== undefined;
	}

	/** Whether plain `Enter` opens the visible inline thread in the workspace. */
	handlesOpenThreadKey(): boolean {
		const request = this.#activeRequest;
		return (
			request !== undefined && this.ctx.btwContainer.children.includes(request.component) && this.canOpenThread()
		);
	}

	canBranch(): boolean {
		const request = this.#activeRequest;
		if (request?.threadKey) return request.component.isBranchable() && this.#canPromoteThread(request.threadKey);
		if (request && isHistoryRequest(request)) return this.#branchUnavailableReason() === undefined;
		return this.#canPromoteThread(this.#manager?.activeKey);
	}

	/** Whether plain `b` is reserved by the visible inline panel. */
	handlesBranchKey(): boolean {
		const request = this.#activeRequest;
		if (!request || !this.ctx.btwContainer.children.includes(request.component)) return false;
		if (this.#branchInFlight) return true;
		return request.component.isBranchable() && this.canBranch();
	}

	#branchUnavailableReason(): string | undefined {
		if (this.#branchInFlight) return "a branch is already in progress";
		if ([...this.#injects.values()].includes("sending")) return "a /btw prompt is still sending";
		if (this.#transitionCount > 0) return "a session operation is in progress";
		const request = this.#activeRequest;
		if (!request || !this.#visible || request.component.isBranchable() !== true) return "the answer is not ready";
		if (!isHistoryRequest(request) || request.session !== this.ctx.session || this.ctx.focusedAgentId)
			return "only main-session answers can be branched";
		// Inline promotion carries one pair; do not silently drop earlier follow-ups.
		if (request.history?.length) return "multi-turn side conversations remain in BTW history";
		if (!request.assistantMessage || !request.leafId) return "the answer is unavailable";
		if (
			request.sessionId !== this.ctx.sessionManager.getSessionId() ||
			request.leafId !== this.ctx.sessionManager.getLeafId()
		)
			return "the session changed since /btw started";
		if (this.ctx.session.isStreaming) return "a turn is still running";
		return undefined;
	}

	canCopy(): boolean {
		if (this.#copyInFlight) return false;
		const request = this.#activeRequest;
		if (request?.component.isCopyable() === true) {
			return request.threadKey
				? this.#threadCopyText(request.threadKey) !== undefined
				: this.#visible && request.component.getCopyText() !== undefined;
		}
		return this.#threadCopyText(this.#manager?.activeKey) !== undefined;
	}

	/** Whether plain `c` is reserved by the visible inline panel. */
	handlesCopyKey(): boolean {
		const request = this.#activeRequest;
		return (
			request !== undefined &&
			this.ctx.btwContainer.children.includes(request.component) &&
			request.component.isCopyable()
		);
	}

	async handleCopy(threadKey?: string): Promise<boolean> {
		if (this.#copyInFlight) return false;
		if (!threadKey && this.#activeRequest && isHistoryRequest(this.#activeRequest)) {
			const request = this.#activeRequest;
			const copyText = request.component.getCopyText();
			if (!copyText || !this.#visible) return false;
			const copied = await this.#copyHistoryAnswer(copyText, request.record.id);
			if (copied && this.#activeRequest === request && this.#visible) request.component.markCopied();
			return copied;
		}
		const copyText = this.#threadCopyText(threadKey ?? this.#activeRequest?.threadKey ?? this.#manager?.activeKey);
		if (copyText === undefined) return false;
		this.#copyInFlight = true;
		this.ctx.ui.requestRender();
		try {
			await copyToClipboard(copyText);
			this.ctx.showStatus("Copied /btw answer to clipboard");
			return true;
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			this.#copyInFlight = false;
			this.ctx.ui.requestRender();
		}
	}

	async handleOpenThread(): Promise<boolean> {
		if (!this.canOpenThread()) return false;
		const request = this.#activeRequest;
		const manager = this.#manager;
		if (!request?.threadKey || !manager?.select(request.threadKey)) return false;
		if (!(await this.#openWorkspacePane(manager))) return false;
		this.#detachActiveRequest();
		return true;
	}

	async handleBranch(): Promise<boolean> {
		if (!this.canBranch()) return false;
		const request = this.#activeRequest;
		if (request && isHistoryRequest(request)) {
			const assistantMessage = request.assistantMessage;
			if (!assistantMessage || !request.leafId) return false;
			const promoted = await this.#promote({
				anchorLeafId: request.leafId,
				sessionId: request.sessionId,
				turns: [
					{
						input: request.question,
						images: request.images,
						replyText: getBtwLatestTurn(request.record).answer,
						assistantMessage,
						timestamp: request.timestamp,
					},
				],
			});
			if (promoted) await this.dispose();
			return promoted;
		}
		return this.#promoteThread(request?.threadKey ?? this.#manager?.activeKey);
	}

	handleEscape(): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("/btw branch is in progress", { dim: true });
			return true;
		}
		const request = this.#activeRequest;
		if (!request || !this.ctx.btwContainer.children.includes(request.component)) return false;
		if (isHistoryRequest(request)) {
			if (this.handleCancel()) return true;
			this.#hideInline();
		} else this.#closeActiveRequest();
		return true;
	}

	canFollowUp(): boolean {
		const request = this.#activeRequest;
		return (
			this.#visible &&
			!this.#starting &&
			!this.#branchInFlight &&
			this.#transitionCount === 0 &&
			request !== undefined &&
			isHistoryRequest(request) &&
			this.#isActiveRequest(request) &&
			request.sessionId === this.#sessionManager.getSessionId() &&
			getBtwLatestTurn(request.record).status === "complete"
		);
	}

	handleFollowUp(): boolean {
		const request = this.#activeRequest;
		if (!request || !isHistoryRequest(request) || !this.canFollowUp()) return false;
		return this.#showHistory(request.store).openFollowUp(request.record.id);
	}

	canInject(): boolean {
		const request = this.#activeRequest;
		return (
			this.#visible &&
			request !== undefined &&
			isHistoryRequest(request) &&
			this.#isActiveRequest(request) &&
			this.#canSend(request.record)
		);
	}

	handleInject(): boolean {
		const request = this.#activeRequest;
		if (!request || !isHistoryRequest(request) || !this.canInject()) return false;
		this.#inject(request.record);
		return true;
	}

	/**
	 * Whether side answers asked now may steer the main session: `btw.inject` is on, the main
	 * session is in view, and this host runs its turns (not a collab guest). Read once per
	 * surface (inline answer, history sheet), so one value gates the prompt instruction, the
	 * highlighted block, and the inject key there.
	 */
	#injectEnabled(): boolean {
		return cfgBtwInject.get(this.ctx.settings) && !this.ctx.focusedAgentId && !this.ctx.collabGuest;
	}

	/** The topic's latest answer is ready to send, and no branch or session move would race the new main-session turn. */
	#canSend(record: BtwHistoryRecord): boolean {
		return (
			!this.#starting &&
			!this.#branchInFlight &&
			this.#transitionCount === 0 &&
			this.#injects.get(getBtwTurnKey(record)) === "ready"
		);
	}

	/** How a turn's `<inject>` block shows in history: sent, pending on the latest turn, or plain text. */
	#injectState(record: BtwHistoryRecord, turnIndex: number): BtwInjectState | undefined {
		const state = this.#injects.get(getBtwTurnKey(record, turnIndex));
		if (state === "sent") return "sent";
		return state && turnIndex === getBtwTurns(record).length - 1 ? "pending" : undefined;
	}

	/**
	 * A prompt the session dropped before dispatch: if it is an inject in flight, take it back so
	 * the inject key stays its one retry path. Returns whether it was an inject.
	 */
	reclaimDroppedPrompt(prompt: DroppedPrompt): boolean {
		const reclaim = this.#droppedInjects.get(prompt.text);
		if (!reclaim) return false;
		this.#droppedInjects.delete(prompt.text);
		reclaim(prompt);
		return true;
	}

	/**
	 * Send the topic's steering prompt to the main session as a user message: a steer while the
	 * agent runs, else a new turn. Slash commands and templates are not expanded, so model-written
	 * text never runs as a command. The turn counts as sent once admitted. A send dropped or refused
	 * before it reached the transcript or the steer queue turns back to ready, with the inject key
	 * as its one retry path; a later failure keeps it sent, so it is never sent twice.
	 */
	#inject(record: BtwHistoryRecord): void {
		const text = getBtwRecordInject(record);
		if (!text) return;
		const key = getBtwTurnKey(record);
		const session = this.ctx.session;
		const settle = (sent: boolean, reason?: string): void => {
			this.#injects.set(key, sent ? "sent" : "ready");
			// Only the turn that was sent: a follow-up may have taken the panel while the send waited.
			const request = this.#activeRequest;
			if (request && isHistoryRequest(request) && getBtwTurnKey(request.record) === key)
				request.component.setInjected(sent);
			this.#refreshHistory();
			if (sent) return;
			if (reason) {
				this.ctx.showError(sanitizeErrorLine(`Cannot inject /btw prompt: ${reason}`));
				return;
			}
			const retry = appKey(this.ctx.keybindings, "app.btw.inject");
			this.ctx.showStatus(retry ? `/btw prompt not sent · ${retry} to retry` : "/btw prompt not sent", {
				dim: true,
			});
		};
		const send = (): void => {
			let admitted = false;
			let queued = false;
			let reclaimed = false;
			const lastUserMessage = () => session.messages.findLast(message => message.role === "user");
			const userBefore = lastUserMessage();
			const reclaim = (prompt: DroppedPrompt): void => {
				reclaimed = true;
				settle(false, prompt.reason);
			};
			this.#droppedInjects.set(text, reclaim);
			session
				.prompt(text, {
					expandPromptTemplates: false,
					streamingBehavior: "steer",
					throwOnDrop: true,
					onPromptQueued: () => {
						queued = true;
					},
					onPromptAdmitted: () => {
						admitted = true;
						settle(true);
					},
				})
				.then(
					// A drop while queueing resolves without admission: nothing was sent.
					() => {
						if (!admitted && !reclaimed) settle(false);
					},
					(error: unknown) => {
						if (reclaimed) return;
						const message = toError(error).message;
						// Already in the steer queue or the transcript: it was sent, so keep the mark.
						if (queued || lastUserMessage() !== userBefore) this.ctx.showError(sanitizeErrorLine(message));
						else settle(false, message);
					},
				)
				.finally(() => {
					if (this.#droppedInjects.get(text) === reclaim) this.#droppedInjects.delete(text);
				});
		};
		this.#injects.set(key, "sending");
		if (!session.hasPendingDeferredExtensions) {
			send();
			return;
		}
		// `prompt()` would wait for startup-deferred extensions before its own session-switch
		// checks run, so a `/new` in that wait could land this prompt in the new session. Wait
		// here instead: `dispose()` cancels the wait (and bumps the generation, so the late
		// settlement is ignored), and a session move in progress drops the send.
		const generation = this.#generation;
		const sessionId = this.ctx.sessionManager.getSessionId();
		this.#awaitingExtensions.add(key);
		session.loadDeferredExtensions().then(
			() => {
				if (generation !== this.#generation) return;
				this.#awaitingExtensions.delete(key);
				if (this.#transitionCount === 0 && sessionId === this.ctx.sessionManager.getSessionId()) send();
				else settle(false);
			},
			(error: unknown) => {
				if (generation !== this.#generation) return;
				this.#awaitingExtensions.delete(key);
				settle(false, toError(error).message);
			},
		);
	}

	handleCancel(): boolean {
		const request = this.#activeRequest;
		if (!request || !isHistoryRequest(request) || getBtwLatestTurn(request.record).status !== "running") return false;
		this.#updateRequest(request, { status: "cancelled", updatedAt: Date.now() });
		request.abortController.abort();
		this.ctx.terminalActivity.release(request);
		request.component.markAborted();
		void this.#persist(request);
		this.#refreshHistory();
		return true;
	}

	async dispose(): Promise<void> {
		if (this.#disposing) return this.#disposing;
		const disposing = this.#dispose();
		this.#disposing = disposing;
		try {
			await disposing;
		} finally {
			if (this.#disposing === disposing) this.#disposing = undefined;
		}
	}

	async #dispose(): Promise<void> {
		this.#generation++;
		for (const key of this.#awaitingExtensions) this.#injects.set(key, "ready");
		this.#awaitingExtensions.clear();
		this.#transitionCount++;
		try {
			await this.#openingManager?.catch(() => undefined);
			this.handleCancel();
			await this.flush();
			this.#closeHistory();
			this.#hideInline();
			this.#closeActiveRequest();
			await this.#store?.close();
			this.#store = undefined;
			this.#storePromise = undefined;
			this.#storeSessionId = undefined;
			this.#storeArtifactsDir = undefined;
			this.#storeScope = undefined;
			const manager = this.#manager;
			const sessionMatches =
				manager !== undefined &&
				this.#managerSessionId === this.ctx.sessionManager.getSessionId() &&
				this.#managerArtifactsDir === this.ctx.sessionManager.getLocalArtifactsDir();
			if (this.#workspacePane) {
				if (!sessionMatches) this.#workspacePane.abandon();
				this.#closeWorkspacePane();
			}
			if (sessionMatches) await manager.dispose();
			else await manager?.abandon();
			this.#clearSessionControls();
			this.#manager = undefined;
			this.#managerSessionId = undefined;
			this.#managerArtifactsDir = undefined;
		} finally {
			this.#transitionCount--;
		}
	}

	async flush(timeoutMs = 10_000): Promise<void> {
		await withTimeout(
			Promise.all([this.#drainWrites(), this.#manager?.flushEvents()]).then(() => undefined),
			timeoutMs,
			"BTW history is still being saved. The session operation was stopped; retry when storage responds.",
		);
	}

	async #drainWrites(): Promise<void> {
		const failuresAtStart = [...this.#failedWrites.keys()];
		for (const request of failuresAtStart) await this.#persist(request, true);
		while (this.#writes.size > 0) await Promise.all(this.#writes);
		const failure = this.#failedWrites.values().next().value;
		if (failure) {
			throw new Error(
				sanitizeErrorLine(
					`BTW history could not be saved: ${sanitizeErrorLine(failure)}. The session operation was stopped; retry after fixing storage. Unsaved answers remain in /btw.`,
					TRUNCATE_LENGTHS.RECAP,
				),
				{ cause: failure },
			);
		}
	}

	async withSessionMove(operation: () => Promise<boolean>): Promise<boolean> {
		const request = this.#activeRequest;
		if (
			this.#starting ||
			this.#branchInFlight ||
			this.#transitionCount > 0 ||
			(request && isHistoryRequest(request) && getBtwLatestTurn(request.record).status === "running") ||
			(request?.threadKey && this.#manager?.thread(request.threadKey)?.phase === "running") ||
			this.#manager?.children.some(thread => thread.phase === "running")
		) {
			this.ctx.showStatus("Wait for the current /btw answer to finish or cancel it before moving.", { dim: true });
			return false;
		}
		this.#transitionCount++;
		try {
			await this.flush();
			const moved = await operation();
			if (moved) await this.dispose();
			return moved;
		} catch (error) {
			this.ctx.showError(sanitizeErrorLine(error));
			return false;
		} finally {
			this.#transitionCount--;
		}
	}

	async #loadHistory(): Promise<BtwHistoryStore> {
		const sessionId = this.#sessionManager.getSessionId();
		const artifactsDir = this.#sessionManager.getArtifactsDir() ?? undefined;
		const scope = this.#historyScope;
		if (
			this.#storeSessionId !== sessionId ||
			this.#storeArtifactsDir !== artifactsDir ||
			this.#storeScope !== scope
		) {
			this.handleCancel();
			await this.flush();
			this.#closeHistory();
			if (this.#activeRequest && isHistoryRequest(this.#activeRequest)) {
				this.#hideInline();
				this.#closeActiveRequest();
			}
			if (
				this.#sessionManager.getSessionId() !== sessionId ||
				(this.#sessionManager.getArtifactsDir() ?? undefined) !== artifactsDir ||
				this.#historyScope !== scope
			) {
				throw new Error("The session changed while opening BTW history.");
			}
			this.#store = undefined;
			this.#storePromise = undefined;
			this.#storeSessionId = sessionId;
			this.#storeArtifactsDir = artifactsDir;
			this.#storeScope = scope;
		}
		this.#storePromise ??= BtwHistoryStore.open(artifactsDir, scope);
		const pending = this.#storePromise;
		try {
			const store = await pending;
			if (this.#storePromise === pending) this.#store = store;
			return store;
		} catch (error) {
			if (this.#storePromise === pending) this.#storePromise = undefined;
			throw error;
		}
	}

	async startFollowUp(
		recordId: string,
		question: string,
		signal?: AbortSignal,
		images?: ImageContent[],
	): Promise<boolean> {
		if (!question.trim() && !images?.length) return false;
		return this.#startHistory(question, recordId, signal, images);
	}

	async start(question: string, images?: ImageContent[], title?: string): Promise<boolean> {
		if (this.#branchInFlight) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return false;
		}
		if (question.trim() === "--history") {
			const opened = await this.#startHistory("");
			return opened && !images?.length;
		}
		if ((!this.ctx.workspaceEnabled && !this.ctx.ui.nativeRendering) || this.ctx.focusedAgentId) {
			return this.#startHistory(question, undefined, undefined, images, title);
		}
		const active = this.#activeRequest;
		if (active && isHistoryRequest(active) && getBtwLatestTurn(active.record).status === "running") {
			this.ctx.showStatus("A /btw question is still running. Wait for it or cancel it first.", { dim: true });
			return false;
		}
		const input = question.trim();
		const generation = this.#generation;
		const manager = await this.#managerForCurrentSession();
		if (generation !== this.#generation) return false;
		if (!input && !images?.length) {
			const opened = await this.#openWorkspacePane(manager);
			if (opened) this.#detachActiveRequest();
			return opened;
		}
		if (input === "--clear" || input === "clear") {
			this.#closeActiveRequest();
			if (this.ctx.ui.nativeRendering) this.#closeWorkspacePane();
			this.ctx.showStatus("Dismissed the inline BTW panel; the thread is kept", { dim: true });
			return !images?.length;
		}
		const model = this.ctx.session.model;
		const leafId = this.ctx.sessionManager.getLeafId();
		if (!model || !leafId) {
			this.ctx.showError(
				!model ? "No active model available for /btw." : "Cannot start /btw before Main has a leaf",
			);
			return false;
		}
		this.#closeActiveRequest();
		const previousKey = manager.activeKey;
		const threadKey = manager.createChild(input, leafId, { provider: model.provider, id: model.id }, title);
		if (this.#workspacePane && previousKey) manager.select(previousKey);
		const request = this.#showInlineThread(manager, threadKey);
		if (!request) return false;
		this.ctx.terminalActivity.set(request, "working");
		void this.#runInlineRequest(manager, request, input, images);
		try {
			// The background runner journals the request before its first await.
			// Only consume the detached draft once that admission is durable.
			await manager.flushEvents();
			return true;
		} catch {
			// The runner surfaces the persistence error in the inline panel.
			return false;
		}
	}

	async #startHistory(
		question: string,
		recordId?: string,
		signal?: AbortSignal,
		images?: ImageContent[],
		title?: string,
	): Promise<boolean> {
		if (signal?.aborted) return false;
		const trimmedQuestion = question.trim();
		if (this.#starting || this.#branchInFlight || this.#transitionCount > 0) {
			this.ctx.showStatus("A /btw action is in progress. Please wait.", { dim: true });
			return false;
		}
		const viewSession = this.ctx.focusedAgentId ? this.ctx.viewSession : this.ctx.session;
		const active = this.#activeRequest;
		if (active?.threadKey && this.#manager?.thread(active.threadKey)?.phase === "running") {
			this.ctx.showStatus(
				"A /btw question is still running in another session view. Wait for it or cancel it first.",
				{
					dim: true,
				},
			);
			return false;
		}
		if (active && isHistoryRequest(active) && getBtwLatestTurn(active.record).status === "running") {
			if (active.session !== viewSession) {
				this.ctx.showStatus(
					"A /btw question is still running in another session view. Wait for it or cancel it first.",
					{ dim: true },
				);
				return false;
			}
			if ((trimmedQuestion || images?.length) && active.sessionId === this.#sessionManager.getSessionId()) {
				this.ctx.showStatus("A /btw question is still running. Open /btw to view it or cancel it first.", {
					dim: true,
				});
				return false;
			}
		}
		const originalSessionId = this.#sessionManager.getSessionId();
		this.#starting = true;
		try {
			const store = await this.#loadHistory();
			const generation = this.#generation;
			const sessionId = this.#sessionManager.getSessionId();
			if (signal?.aborted || store !== this.#store || sessionId !== originalSessionId) return false;
			if (!trimmedQuestion && !images?.length) {
				const panel = this.#showHistory(store);
				// Tern: reopening lands on the side question put away while it answered.
				const active = this.#activeRequest;
				if (
					this.ctx.ui.nativeRendering &&
					active &&
					isHistoryRequest(active) &&
					active.store === store &&
					this.#isActiveRequest(active)
				) {
					panel.showRecord(active.record.id);
				}
				return true;
			}
			await this.flush();
			if (
				signal?.aborted ||
				generation !== this.#generation ||
				store !== this.#store ||
				sessionId !== this.#sessionManager.getSessionId()
			)
				return false;
			const previous = recordId ? store.getRecords().find(record => record.id === recordId) : undefined;
			if (recordId && (!previous || getBtwLatestTurn(previous).status === "running")) {
				this.ctx.showStatus("This side conversation is unavailable or still running.", { dim: true });
				return false;
			}
			if (!viewSession.model) {
				this.ctx.showError("No active model available for /btw.");
				return false;
			}
			await this.#sessionManager.ensureOnDisk();
			if (signal?.aborted || generation !== this.#generation || sessionId !== this.#sessionManager.getSessionId())
				return false;
			if (!previous) this.#closeHistory();
			if (this.#activeRequest && !isHistoryRequest(this.#activeRequest)) {
				this.#closeActiveRequest();
			}
			this.#activeRequest?.component.close();
			const now = Date.now();
			const leafId = this.#sessionManager.getLeafId();
			const { record, history, conversationKey } = beginBtwTurn(trimmedQuestion, leafId, previous, images, title);
			const injectEnabled = this.#injectEnabled();
			const request: BtwHistoryRequest = {
				component: new BtwPanelComponent({
					question: trimmedQuestion,
					title: record.title,
					tui: this.ctx.ui,
					canBranch: () => this.canBranch(),
					canFollowUp: () => this.canFollowUp(),
					canInject: injectEnabled ? () => this.canInject() : undefined,
					onAction: action => {
						if (action === "copy") void this.handleCopy();
						else if (action === "promote") void this.handleBranch();
						else if (action === "follow-up") this.handleFollowUp();
						else if (action === "inject") this.handleInject();
						else if (action === "close") this.handleEscape();
					},
				}),
				abortController: new AbortController(),
				question: trimmedQuestion,
				images,
				leafId,
				sessionId,
				timestamp: now,
				session: viewSession,
				sessionManager: this.#sessionManager,
				store,
				record,
				history,
				conversationKey,
				persisted: false,
				injectEnabled,
			};
			this.#activeRequest = request;
			// Tern shows the answer in the BTW history sheet (its body scrolls, its
			// markdown is native); the text renderer keeps the inline panel.
			const sheet = this.ctx.ui.nativeRendering;
			this.#visible = !sheet && (!previous || !this.#historyOverlay);
			this.ctx.btwContainer.clear();
			if (this.#visible) this.ctx.btwContainer.addChild(request.component);
			this.ctx.ui.requestRender();
			if (!(await this.#persist(request))) {
				if (this.#activeRequest === request) {
					this.#activeRequest = undefined;
					request.component.close();
					this.#hideInline();
					this.#store = undefined;
					this.#storePromise = undefined;
					this.#historyPanel?.update(store.getRecords());
				}
				return false;
			}
			if (
				generation !== this.#generation ||
				!this.#isActiveRequest(request) ||
				getBtwLatestTurn(request.record).status !== "running"
			)
				return false;
			if (signal?.aborted) {
				this.handleCancel();
				await this.flush();
				return false;
			}
			this.#refreshHistory();
			if (sheet && !previous) this.#showHistory(store).showRecord(record.id);
			this.ctx.terminalActivity.set(request, "working");
			void this.#runHistoryRequest(request);
			return true;
		} catch (error) {
			this.ctx.showError(sanitizeErrorLine(`Cannot open /btw history: ${toError(error).message}`));
			return false;
		} finally {
			this.#starting = false;
		}
	}

	#showHistory(store: BtwHistoryStore): BtwHistoryPanel {
		if (this.#historyOverlay && this.#historyPanel) {
			this.#refreshHistory();
			return this.#historyPanel;
		}
		this.#hideInline();
		const historySessionId = this.#sessionManager.getSessionId();
		const panel = new BtwHistoryPanel({
			records: this.#historyRecords(store),
			onClose: () => this.#closeHistory(),
			onCopy: record => {
				const answer = getBtwCopyText(record);
				if (answer !== undefined) void this.#copyHistoryAnswer(answer, record.id);
			},
			onCancel: record => {
				const request = this.#activeRequest;
				if (request && isHistoryRequest(request) && request.record.id === record.id) this.handleCancel();
			},
			canFollowUp: record =>
				!this.#starting &&
				!this.#branchInFlight &&
				this.#transitionCount === 0 &&
				getBtwLatestTurn(record).status !== "running" &&
				(!this.#activeRequest ||
					!isHistoryRequest(this.#activeRequest) ||
					getBtwLatestTurn(this.#activeRequest.record).status !== "running"),
			onFollowUp: (record, followUp, followUpSignal, images) => {
				if (historySessionId !== this.#sessionManager.getSessionId()) return Promise.resolve(false);
				return this.startFollowUp(record.id, followUp, followUpSignal, images);
			},
			onPasteImage: () => this.ctx.handleImagePaste(),
			onPasteImagePath: path => this.ctx.handleImagePathPaste(path),
			spaceHoldKeys: this.ctx.keybindings.getKeys("app.stt.pushToTalk"),
			spaceHold: input => this.ctx.dictationSpaceHold(input),
			requestRender: () => this.ctx.ui.requestRender(),
			inject: this.#injectEnabled()
				? {
						state: (record, turnIndex) => this.#injectState(record, turnIndex),
						canSend: record => this.#canSend(record),
						send: record => this.#inject(record),
					}
				: undefined,
			getHeight: () => this.ctx.ui.terminal.rows,
			// Tern has no inline panel: Esc puts the sheet away, `x` cancels.
			escapeHides: this.ctx.ui.nativeRendering,
		});
		this.#historyPanel = panel;
		this.#historyOverlay = this.ctx.ui.showOverlay(panel, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(panel);
		this.ctx.ui.requestRender();
		return panel;
	}

	#historyRecords(store: BtwHistoryStore): readonly BtwHistoryRecord[] {
		const records = store.getRecords();
		const request = this.#activeRequest;
		if (!request || !isHistoryRequest(request) || request.store !== store) return records;
		return records.map(record => (record.id === request.record.id ? request.record : record));
	}

	#refreshHistory(): void {
		if (this.#historyPanel && this.#store) this.#historyPanel.update(this.#historyRecords(this.#store));
	}

	#closeHistory(): void {
		const overlay = this.#historyOverlay;
		this.#historyOverlay = undefined;
		this.#historyPanel = undefined;
		if (!overlay) return;
		overlay.hide();
		// Closing while a BTW still answers keeps it running: text mode returns
		// to its inline panel; Tern has none, so it says how to get back.
		const request = this.#activeRequest;
		if (
			request &&
			isHistoryRequest(request) &&
			this.#isActiveRequest(request) &&
			getBtwLatestTurn(request.record).status === "running"
		) {
			if (this.ctx.ui.nativeRendering) {
				this.ctx.showStatus("/btw is still answering in the background · /btw to reopen it", { dim: true });
			} else {
				request.component.setAnswer(getBtwLatestTurn(request.record).answer);
				this.#visible = true;
				this.ctx.btwContainer.clear();
				this.ctx.btwContainer.addChild(request.component);
			}
		}
		this.ctx.ui.requestRender();
	}

	async #copyHistoryAnswer(answer: string, recordId: string): Promise<boolean> {
		if (this.#copyInFlight || !answer.trim()) return false;
		this.#copyInFlight = true;
		try {
			await copyToClipboard(replaceTabs(answer).trim());
			this.ctx.showStatus("Copied /btw answer to clipboard");
			this.#historyPanel?.markCopied(recordId, answer);
			return true;
		} catch (error) {
			this.ctx.showError(sanitizeErrorLine(error));
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	#showInlineThread(manager: BtwManager, threadKey: string): BtwWorkspaceRequest | undefined {
		const thread = manager.thread(threadKey);
		if (!thread) return undefined;
		this.#detachActiveRequest();
		const turn = thread.turns.at(-1);
		const request: BtwWorkspaceRequest = {
			threadKey,
			component: new BtwPanelComponent({
				question: thread.request?.input ?? turn?.input ?? thread.title,
				title: thread.title,
				tui: this.ctx.ui,
				canBranch: () => this.canBranch(),
				canOpenThread: this.ctx.workspaceEnabled || this.ctx.ui.nativeRendering,
				onAction: action => {
					if (action === "open") void this.handleOpenThread();
					else if (action === "copy") void this.handleCopy();
					else if (action === "promote") void this.handleBranch();
					else if (action === "close") this.handleEscape();
				},
			}),
		};
		if (turn) request.component.setAnswer(turn.replyText);
		if (thread.phase === "error") request.component.markError(thread.error ?? "BTW request failed");
		else if (thread.phase === "ready" && turn) request.component.markComplete();
		else if (thread.phase === "ready") request.component.markAborted();
		this.#activeRequest = request;
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		return request;
	}

	async #runInlineRequest(
		manager: BtwManager,
		request: BtwWorkspaceRequest,
		input: string,
		images?: ImageContent[],
	): Promise<void> {
		try {
			request.component.markRunning();
			const result = await manager.prompt(
				request.threadKey,
				input,
				delta => {
					if (this.#activeRequest === request) request.component.appendText(delta);
				},
				undefined,
				images,
			);
			if (this.#activeRequest !== request || !result) return;
			request.component.setAnswer(result.replyText);
			request.component.markComplete();
			manager.markRead(request.threadKey);
		} catch (error) {
			if (this.#activeRequest !== request) return;
			if (manager.thread(request.threadKey)?.phase === "ready") request.component.markAborted();
			else request.component.markError(error instanceof Error ? error.message : String(error));
		} finally {
			this.ctx.terminalActivity.release(request);
			this.#updateWorkspacePane();
		}
	}

	async #managerForCurrentSession(): Promise<BtwManager> {
		await this.#disposing;
		const sessionId = this.ctx.sessionManager.getSessionId();
		const artifactsDir = this.ctx.sessionManager.getLocalArtifactsDir();
		if (this.#manager && this.#managerSessionId === sessionId && this.#managerArtifactsDir === artifactsDir) {
			return this.#manager;
		}
		if (this.#openingManager) return this.#openingManager;
		const opening = this.#openManager(sessionId, artifactsDir);
		this.#openingManager = opening;
		try {
			return await opening;
		} finally {
			if (this.#openingManager === opening) this.#openingManager = undefined;
		}
	}

	async #openManager(sessionId: string, artifactsDir: string | null): Promise<BtwManager> {
		this.#closeActiveRequest();
		this.#workspacePane?.abandon();
		this.#closeWorkspacePane();
		if (this.#manager) {
			await this.#manager.dispose();
			await this.#manager.abandon();
		}
		this.#clearSessionControls();
		this.#manager = undefined;
		const owner = this.ctx.sessionManager;
		const previous = memoryHistoryStores.get(owner);
		const store =
			!artifactsDir && previous?.sessionId === sessionId
				? previous.store
				: await BtwSessionStore.open(artifactsDir ?? undefined, this.ctx.sessionManager.getCwd());
		if (!artifactsDir) memoryHistoryStores.set(owner, { sessionId, store });
		if (
			this.ctx.sessionManager.getSessionId() !== sessionId ||
			this.ctx.sessionManager.getLocalArtifactsDir() !== artifactsDir
		) {
			throw new Error("BTW session changed while opening its history");
		}
		const manager = new BtwManager({
			restoredThreads: store.getRecords(),
			appendEvent: event => store.appendEvent(event),
			removeSession: key => store.removeSession(key),
			flushEvents: () => store.flush(),
			closeEvents: () => store.close(),
			createConversation: (modelRef, checkpoint, sideOptions) => {
				const active = this.ctx.session.model;
				const model =
					active?.provider === modelRef.provider && active.id === modelRef.id
						? active
						: this.ctx.session.findModel(modelRef.provider, modelRef.id);
				if (!model) throw new Error(`BTW model is unavailable: ${modelRef.provider}/${modelRef.id}`);
				return this.ctx.session.createEphemeralConversation(btwConversationPrompt, checkpoint, model, sideOptions);
			},
			createSideOptions: threadKey => ({
				sessionManager: store.getSessionManager(threadKey),
				onSessionClosed: closed => store.adoptClosedSession(threadKey, closed),
				sendToMainSession: summary =>
					this.ctx.session.publishBtwSummary({
						threadKey,
						threadTitle: manager.thread(threadKey)?.title ?? "BTW",
						summary,
					}),
				approveSummary:
					this.ctx.workspaceEnabled || this.ctx.ui.nativeRendering
						? (summary, signal) => this.#approveThreadSummary(threadKey, summary, signal)
						: undefined,
			}),
			generateTitle: input => this.ctx.session.generateTitle(input),
			nextKey: () => `btw-${Snowflake.next()}`,
			now: Date.now,
			onChange: () => this.#updateWorkspacePane(),
		});
		this.#managerArtifactsDir = artifactsDir;
		this.#managerSessionId = sessionId;
		this.#manager = manager;
		return manager;
	}

	async #approveThreadSummary(threadKey: string, summary: string, signal?: AbortSignal): Promise<boolean> {
		const manager = this.#manager;
		if (signal?.aborted || !manager?.select(threadKey)) return false;
		if (!(await this.#openWorkspacePane(manager))) return false;
		if (signal?.aborted || manager !== this.#manager || !this.#workspacePane) return false;
		this.#detachActiveRequest();
		return this.#workspacePane.approveSummary(threadKey, summary, signal);
	}

	#createWorkspacePane(manager: BtwManager, ui: TUI): BtwConversationPane {
		const ownerSession = this.ctx.session;
		return new BtwConversationPane({
			ui,
			nativePane: ui !== this.ctx.ui,
			cwd: this.ctx.sessionManager.getCwd(),
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			followUpKeys: this.ctx.keybindings.getKeys("app.message.followUp"),
			dequeueKeys: this.ctx.keybindings.getKeys("app.message.dequeue"),
			hideThinkingBlock: () => this.ctx.hideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			resolveLinks: texts => resolveSessionMarkdownLinkHrefs(texts.flatMap(getMarkdownLinkUrls), ownerSession),
			requestRender: () => {
				if (this.#workspacePane) ui.requestComponentRender(this.#workspacePane);
				else ui.requestRender();
			},
			configureEditor: (editor, key) => {
				const session = key ? manager.thread(key)?.conversation.session : undefined;
				if (session) this.configurePaneEditor?.(editor, session, ui);
			},
			statusLine: this.ctx.statusLine.createPeer(this.ctx.session),
			onSubmit: (input, images, key, mode, links) => this.#submitPaneInput(manager, input, images, key, mode, links),
			onNewThread: () => this.#createChild(manager, "") !== undefined,
			canPromote: key => this.#canPromoteThread(key),
			canCopy: key => this.#threadCopyText(key) !== undefined,
			onCopy: key => this.handleCopy(key),
			transcriptActions: {
				copy: text =>
					copyToClipboard(text).then(
						() => this.ctx.showStatus("Copied to clipboard"),
						error => this.ctx.showError(`Copy failed: ${error instanceof Error ? error.message : String(error)}`),
					),
			},
			onClose: () => this.#closeWorkspacePane(),
			onDraftChange: (key, text, images, imageLinks) => {
				manager.setDraft(key, text, images, imageLinks);
			},
			onSelectThread: key => manager.select(key),
			onDisplayThread: key => {
				const thread = manager.thread(key);
				if (!thread || thread.conversation.extensionRunner) return;
				void thread.conversation.initializeExtensionRuntime().then(
					() => {
						if (this.#manager === manager) this.#updateWorkspacePane();
					},
					error =>
						this.ctx.showError(`BTW extension failed: ${error instanceof Error ? error.message : String(error)}`),
				);
			},
			onMarkRead: key => {
				manager.markRead(key);
			},
			onDequeue: key => {
				void this.#dequeueThread(manager, key);
			},
			onCloseThread: key => this.#closeThread(manager, key),
			onPromoteThread: key => this.#promoteThread(key),
			onPersistDraft: key => {
				manager.persistDraft(key);
			},
		});
	}

	async #openWorkspacePane(manager: BtwManager): Promise<boolean> {
		const native = this.ctx.ui.nativeRendering && this.ctx.nativeWorkspace;
		if (native) {
			try {
				await native.open(
					"btw",
					"BTW",
					ui => {
						this.#workspacePane = this.#createWorkspacePane(manager, ui);
						this.#updateWorkspacePane();
						return this.#workspacePane;
					},
					() => {
						this.#workspacePane = undefined;
					},
				);
				return true;
			} catch (error) {
				if (manager !== this.#manager) return false;
				this.ctx.showError(`Could not open native BTW pane: ${toError(error).message}`);
				return false;
			}
		}
		this.#workspacePane ??= this.#createWorkspacePane(manager, this.ctx.ui);
		this.#updateWorkspacePane();
		if (this.ctx.ui.nativeRendering) {
			if (!this.#workspaceOverlay) {
				this.#workspaceOverlay = this.ctx.ui.showOverlay(this.#workspacePane, {
					width: "100%",
					maxHeight: "100%",
				});
			}
			return true;
		}
		if (this.ctx.openBtwWorkspacePane(this.#workspacePane)) return true;
		this.#workspacePane.dispose();
		this.#workspacePane = undefined;
		this.ctx.showError("The terminal is too small to open the /btw pane");
		return false;
	}

	#closeWorkspacePane(): void {
		if (this.ctx.nativeWorkspace?.has("btw")) {
			this.ctx.nativeWorkspace.close("btw");
			return;
		}
		const pane = this.#workspacePane;
		if (!pane) return;
		this.#workspacePane = undefined;
		if (this.#workspaceOverlay) {
			this.#workspaceOverlay.hide();
			this.#workspaceOverlay = undefined;
			pane.dispose();
		} else this.ctx.closeBtwWorkspacePane();
	}

	/** Release native or retiring ANSI views without cancelling durable background work. */
	closeView(): void {
		if (this.#workspaceOverlay || this.ctx.ui.nativeRendering || this.ctx.nativeWorkspace?.has("btw")) {
			this.#closeWorkspacePane();
		}
	}

	#submitPaneInput(
		manager: BtwManager,
		input: string,
		images?: ImageContent[],
		sourceKey?: string,
		streamingBehavior: "steer" | "followUp" = "steer",
		imageLinks?: (string | undefined)[],
	): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return false;
		}
		const trimmed = input.trim();
		if (!trimmed && !images?.length) return false;
		const parsed = parseSlashCommand(trimmed);
		if (parsed?.name === "new") {
			const question = parsed.args;
			return question || images?.length
				? this.#createChildAndSend(manager, question, images)
				: this.#createChild(manager, "") !== undefined;
		}
		const key = sourceKey ?? manager.activeKey;
		return key
			? this.#sendThreadInput(key, trimmed, images, streamingBehavior, imageLinks)
			: this.#createChildAndSend(manager, trimmed, images);
	}

	#createChild(manager: BtwManager, input: string): string | undefined {
		if (this.#branchInFlight || manager !== this.#manager) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return undefined;
		}
		const activeKey = manager.activeKey;
		const active = activeKey ? manager.thread(activeKey) : undefined;
		if (!input.trim() && active?.phase === "ready" && active.request === undefined && active.turns.length === 0) {
			return active.key;
		}
		const model = this.ctx.session.model;
		const leafId = this.ctx.sessionManager.getLeafId();
		if (!model || !leafId) {
			this.ctx.showError(!model ? "No active model available for BTW." : "Cannot start BTW before Main has a leaf");
			return undefined;
		}
		return manager.createChild(input, leafId, { provider: model.provider, id: model.id });
	}

	/** Create a durable thread and send its first question. */
	#createChildAndSend(manager: BtwManager, input: string, images?: ImageContent[]): boolean {
		const key = this.#createChild(manager, input);
		if (!key) return false;
		this.#sendThreadInput(key, input, images);
		return true;
	}

	#sendThreadInput(
		key: string,
		input: string,
		images?: ImageContent[],
		streamingBehavior: "steer" | "followUp" = "steer",
		imageLinks?: (string | undefined)[],
	): boolean {
		const manager = this.#manager;
		const thread = manager?.thread(key);
		const trimmed = input.trim();
		if (!manager || !thread || (!trimmed && !images?.length)) return false;
		const parsed = parseSlashCommand(trimmed);
		const command = parsed ? `/${parsed.name}` : "";
		const argument = parsed?.args ?? "";
		if (command === "/help") {
			this.ctx.showStatus("BTW: /new · /queue · /stop · /retry · /compact · /tree · /handoff · /promote · /delete");
			return false;
		}
		if (command === "/delete") {
			void this.#closeThread(manager, key);
			return true;
		}
		if (command === "/handoff") {
			const messages = this.#completedThreadMessages(thread);
			if (!messages) {
				this.ctx.showError("Wait for a completed BTW reply before handing off to Main");
				return false;
			}
			const transcript: Message[] = [];
			for (const message of messages) {
				if (message.role === "user") transcript.push(message);
				else if (message.role === "assistant")
					transcript.push({ ...message, content: message.content.filter(block => block.type === "text") });
			}
			const handoff = prompt.render(btwHandoffPrompt, {
				conversation: serializeConversation(transcript),
				instruction: argument || undefined,
			});
			void this.ctx.session
				.sendUserMessage(handoff, { deliverAs: "followUp" })
				.then(() => this.ctx.showStatus("Handed BTW context to Main", { dim: true }))
				.catch(error =>
					this.ctx.showError(
						`Failed to hand off BTW context: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			manager.setDraft(key, "");
			manager.persistDraft(key);
			return true;
		}
		if (command === "/promote") {
			void this.#promoteThread(key);
			return true;
		}
		const session = thread.conversation.session;
		if (
			command === "/queue" ||
			command === "/compact" ||
			command === "/tree" ||
			command === "/continue" ||
			command === "/stop" ||
			command === "/retry" ||
			parseQueueShorthand(trimmed) !== undefined ||
			(session && (session.isCompacting || sessionCommandQueue(session).request))
		) {
			return this.#runThreadControl(manager, key, input, images, imageLinks, () =>
				this.#controlsFor(manager, key).submit(trimmed, images, streamingBehavior, imageLinks),
			);
		}
		if (parsed && (lookupBuiltinSlashCommand(parsed.name) || this.ctx.isKnownSlashCommand(trimmed))) {
			this.ctx.showError(`This command is not available in BTW: ${command}`);
			return false;
		}
		manager.setDraft(key, "");
		this.ctx.terminalActivity.set(thread, "working");
		void this.#controlsFor(manager, key)
			.submit(trimmed, images, streamingBehavior, imageLinks)
			.catch(error => {
				this.#restoreThreadDraft(manager, key, input, images, imageLinks);
				this.ctx.showError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => this.ctx.terminalActivity.release(thread));
		return true;
	}

	#restoreThreadDraft(
		manager: BtwManager,
		key: string,
		text: string,
		images?: readonly ImageContent[],
		links?: readonly (string | undefined)[],
	): void {
		const thread = manager.thread(key);
		if (!thread) return;
		const previousImages = thread.draftImages ?? [];
		manager.setDraft(
			key,
			[shiftImageMarkers(text, previousImages.length), thread.draft].filter(Boolean).join("\n\n"),
			[...previousImages, ...(images ?? [])],
			[...(thread.draftImageLinks ?? []), ...(links ?? images?.map(() => undefined) ?? [])],
		);
		if (manager === this.#manager) this.#workspacePane?.restoreDraft(key, text, images, links);
		manager.persistDraft(key);
	}

	#runThreadControl(
		manager: BtwManager,
		key: string,
		input: string,
		images: ImageContent[] | undefined,
		links: (string | undefined)[] | undefined,
		run: (session: AgentSession) => Promise<void>,
	): boolean {
		manager.setDraft(key, "");
		void manager
			.session(key)
			.then(run)
			.then(
				() => this.#updateWorkspacePane(),
				error => {
					this.#restoreThreadDraft(manager, key, input, images, links);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				},
			);
		return true;
	}

	#clearSessionControls(): void {
		for (const controls of this.#sessionControls.values()) controls.dispose();
		this.#sessionControls.clear();
	}

	#controlsFor(manager: BtwManager, key: string): SessionPaneControls {
		let controls = this.#sessionControls.get(key);
		if (controls) return controls;
		controls = new SessionPaneControls<AgentSession>({
			currentSession: () => manager.thread(key)?.conversation.session,
			ensureSession: async () => {
				await manager.thread(key)?.request?.admission.promise;
				return manager.session(key);
			},
			projectMessages: projectBtwMessages,
			restore: input => this.#restoreThreadDraft(manager, key, input.text, input.images, input.imageLinks),
			changed: () => this.#updateWorkspacePane(),
			error: message => this.ctx.showError(message),
			prepareInput: preparePaneInput,
			abort: () => manager.abort(key),
			prompt: (_session, input, mode, onPromptAdmitted) =>
				manager.prompt(key, input.text, undefined, undefined, input.images, mode, onPromptAdmitted).then(() => {}),
			knownCommand: text => this.ctx.isKnownSlashCommand(text),
			showTree: session => {
				if (!this.#workspacePane) throw new Error("Open the BTW pane before navigating");
				this.#workspacePane.showTree(session, (draft, images) => {
					if (draft !== undefined) this.#restoreThreadDraft(manager, key, draft, images);
					this.#updateWorkspacePane();
				});
			},
		});
		this.#sessionControls.set(key, controls);
		return controls;
	}

	async #dequeueThread(manager: BtwManager, key: string): Promise<void> {
		try {
			const restored = await this.#controlsFor(manager, key).dequeue();
			if (restored) this.#restoreThreadDraft(manager, key, restored.text, restored.images, restored.imageLinks);
			this.#updateWorkspacePane();
		} catch (error) {
			this.ctx.showError(`Cannot edit queued BTW input: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#threadMessages(thread: BtwThread): readonly AgentMessage[] {
		const manager = this.#manager;
		return (
			(manager && this.#controlsFor(manager, thread.key).getMessages()) ??
			projectBtwMessages(thread.conversation.sessionManager, thread.conversation.session)
		);
	}

	#completedThreadMessages(thread: BtwThread): readonly AgentMessage[] | undefined {
		if (thread.phase !== "ready") return undefined;
		const messages = this.#threadMessages(thread);
		if (!messages?.some(message => message.role === "user")) return undefined;
		const reply = messages.findLast(message => message.role === "user" || message.role === "assistant");
		return reply?.role === "assistant" && (reply.stopReason === "stop" || reply.stopReason === "length")
			? messages
			: undefined;
	}

	#threadStreamingMessage(thread: BtwThread): AssistantMessage | undefined {
		const streaming = thread.conversation.session?.agent.state.streamMessage;
		if (streaming?.role !== "assistant") return undefined;
		const committed = this.#threadMessages(thread)?.at(-1);
		return committed?.role === "assistant" && committed.timestamp === streaming.timestamp ? undefined : streaming;
	}

	#threadQueue(manager: BtwManager, key: string): BtwThreadView["queued"] {
		return this.#controlsFor(manager, key)
			.getPending()
			.map(group => ({
				...group,
				edits: group.edits.map(edit => () => {
					void edit()
						.then(restored => {
							if (restored)
								this.#restoreThreadDraft(manager, key, restored.text, restored.images, restored.imageLinks);
						})
						.catch(error => this.ctx.showError(String(error)));
				}),
			}));
	}

	#updateWorkspacePane(): void {
		const manager = this.#manager;
		const pane = this.#workspacePane;
		if (!manager) return;
		for (const child of manager.children) this.#controlsFor(manager, child.key).getPending();
		const inline = this.#activeRequest;
		const thread = inline?.threadKey ? manager.thread(inline.threadKey) : undefined;
		if (inline && thread) {
			const messages = thread.request
				? [...thread.request.messages, ...(thread.request.streamMessage ? [thread.request.streamMessage] : [])]
				: (thread.turns.at(-1)?.intermediateMessages ?? []);
			const activity = messages
				.flatMap(message =>
					message.role === "assistant"
						? message.content.flatMap(part => {
								if (part.type !== "toolCall") return [];
								const summary = toolRenderers[part.name]?.activitySummary?.(displayArgsForToolCall(part), {
									expanded: false,
									isPartial: thread.phase === "running",
								});
								return [
									replaceTabs(summary ? [summary.label, summary.detail].filter(Boolean).join(" ") : part.name),
								];
							})
						: [],
				)
				.join(" · ");
			inline.component.setToolActivity(activity || undefined);
		}
		if (!pane) return;
		const threads: BtwThreadView[] = manager.children.map(thread => ({
			key: thread.key,
			title: thread.title,
			phase: thread.phase,
			model: thread.model,
			error: thread.error,
			draft: thread.draft,
			draftImages: thread.draftImages,
			draftImageLinks: thread.draftImageLinks,
			messages: this.#threadMessages(thread),
			streamingMessage: this.#threadStreamingMessage(thread),
			queued: this.#threadQueue(manager, thread.key),
			controls: this.#controlsFor(manager, thread.key),
			extensionRunner: thread.conversation.extensionRunner,
			getTool: name => thread.conversation.getTool(name),
			isBuiltInTool: name => thread.conversation.session?.hasBuiltInTool(name) === true,
			unread: thread.unread,
			status: thread.conversation.status,
		}));
		pane.update(threads, manager.activeKey);
		const editor = pane.getPasteTarget();
		if (editor && this.ctx.dictationSpaceHold) {
			editor.spaceHold.keys = this.ctx.keybindings.getKeys("app.stt.pushToTalk");
			editor.spaceHold.handler ??= this.ctx.dictationSpaceHold(editor);
		}
	}

	async #closeThread(manager: BtwManager, key: string): Promise<boolean> {
		if (this.#branchInFlight || manager !== this.#manager) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return false;
		}
		try {
			if (!(await manager.remove(key, "deleted"))) return false;
			if (manager.children.length === 0) this.#closeWorkspacePane();
			return true;
		} catch (error) {
			this.ctx.showError(`Could not delete BTW thread: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	#threadCopyText(key: string | undefined): string | undefined {
		if (!key) return undefined;
		const replyText = this.#manager?.thread(key)?.turns.at(-1)?.replyText;
		if (replyText === undefined) return undefined;
		return replaceTabs(replyText).trim() || undefined;
	}

	#canPromoteThread(key: string | undefined): boolean {
		if (
			!key ||
			this.#branchInFlight ||
			this.#transitionCount > 0 ||
			this.#managerSessionId !== this.ctx.sessionManager.getSessionId() ||
			this.#manager?.children.some(candidate => candidate.phase === "running")
		) {
			return false;
		}
		const thread = this.#manager?.thread(key);
		return (
			thread?.phase === "ready" &&
			this.#completedThreadMessages(thread) !== undefined &&
			this.ctx.sessionManager.getEntry(thread.anchorLeafId) !== undefined &&
			!this.ctx.session.isStreaming
		);
	}

	async #promoteThread(key: string | undefined): Promise<boolean> {
		if (!key || !this.#canPromoteThread(key)) return false;
		const manager = this.#manager;
		const thread = manager?.thread(key);
		const sessionId = this.#managerSessionId;
		if (!manager || !thread || !sessionId) return false;
		const messages = this.#completedThreadMessages(thread);
		if (!messages) return false;
		const lifecycle: BtwPromotionLifecycle = {
			prepare: async () => {
				if (!manager.preparePromotion(key)) throw new Error("BTW thread is no longer promotable");
				await manager.flushEvents();
			},
			rollback: async () => {
				if (manager.rollbackPromotion(key)) await manager.flushEvents();
			},
		};
		const promoted = await this.#promote(
			{ anchorLeafId: thread.anchorLeafId, sessionId, turns: [...thread.turns], messages },
			lifecycle,
		);
		if (this.#manager !== manager) {
			await manager.abandon();
			return promoted;
		}
		if (!promoted) return false;
		await manager.completePromotion(key);
		if (this.#activeRequest?.threadKey === key) this.#detachActiveRequest();
		await manager.abandon();
		this.#manager = undefined;
		this.#managerSessionId = undefined;
		this.#managerArtifactsDir = undefined;
		if (this.#workspacePane) {
			this.#workspacePane.abandon();
			this.#closeWorkspacePane();
		}
		return true;
	}

	async #promote(request: BtwPromotionRequest, lifecycle?: BtwPromotionLifecycle): Promise<boolean> {
		const activeRequest = this.#activeRequest;
		this.#branchInFlight = true;
		activeRequest?.component.markBranching();
		this.ctx.ui.requestRender();
		try {
			await this.flush();
			return (await this.ctx.handleBtwBranch(request, lifecycle)) !== false;
		} catch (error) {
			this.ctx.showError(sanitizeErrorLine(`Cannot branch /btw: ${toError(error).message}`));
			return false;
		} finally {
			this.#branchInFlight = false;
			if (activeRequest && this.#activeRequest === activeRequest) activeRequest.component.markComplete();
			this.ctx.ui.requestRender();
		}
	}

	#persist(request: BtwHistoryRequest, retry = false): Promise<boolean> {
		const pending = retry ? request.store.retry(request.record) : request.store.upsert(request.record);
		const write = pending.then(
			() => {
				request.persisted = true;
				this.#failedWrites.delete(request);
				return true;
			},
			error => {
				if (request.persisted) this.#failedWrites.set(request, toError(error));
				logger.error("BTW history save failed", { error });
				if (request.sessionId === request.sessionManager.getSessionId()) {
					this.ctx.showError(sanitizeErrorLine(`Could not save /btw history: ${toError(error).message}`));
				}
				return false;
			},
		);
		this.#writes.add(write);
		void write.then(
			() => this.#writes.delete(write),
			() => this.#writes.delete(write),
		);
		return write;
	}

	#updateRequest(request: BtwHistoryRequest, patch: Partial<BtwHistoryTurn>): void {
		request.record = patchLatestBtwTurn(request.record, patch);
	}

	async #runHistoryRequest(request: BtwHistoryRequest): Promise<void> {
		try {
			const checkpoint = await request.store.readConversation(request.record.id);
			request.abortController.signal.throwIfAborted();
			const { replyText, assistantMessage } = await request.session.runBtwTurn({
				question: request.question,
				images: request.images,
				history: request.history,
				checkpoint,
				onCheckpoint: async (checkpoint, phase) => {
					if (phase === "frozen") request.abortController.signal.throwIfAborted();
					const current = request.store.getRecords().find(record => record.id === request.record.id);
					if (current && getBtwLatestTurn(current).createdAt !== getBtwLatestTurn(request.record).createdAt)
						return;
					request.store.stageConversation(request.record.id, checkpoint);
					if (phase === "frozen") {
						if (!(await this.#persist(request))) throw new Error("Could not save frozen BTW context");
					} else if (getBtwLatestTurn(request.record).status !== "running") {
						await Promise.all(this.#writes);
						const latest = request.store.getRecords().find(record => record.id === request.record.id);
						if (
							!this.#failedWrites.has(request) &&
							latest?.followUps?.length === request.record.followUps?.length
						)
							void this.#persist(request);
					}
				},
				// The same eligibility as the block and the key: no instruction where a block could never be sent.
				inject: request.injectEnabled,
				conversationKey: request.conversationKey,
				source: { threadKey: request.record.id, threadTitle: request.record.title ?? request.record.question },
				onTextDelta: delta => {
					const latest = getBtwLatestTurn(request.record);
					if (latest.status !== "running") return;
					this.#updateRequest(request, { answer: latest.answer + delta, updatedAt: Date.now() });
					if (this.#isActiveRequest(request)) {
						if (this.#visible) request.component.appendText(delta);
						this.#refreshHistory();
					}
				},
				signal: request.abortController.signal,
			});
			if (getBtwLatestTurn(request.record).status !== "running") return;
			this.#updateRequest(request, { answer: replyText, status: "complete", updatedAt: Date.now() });
			// Only an answer asked with the inject instruction can be sent, even if the setting is turned on later.
			if (request.injectEnabled && getBtwRecordInject(request.record) !== undefined) {
				this.#injects.set(getBtwTurnKey(request.record), "ready");
			}
			request.assistantMessage = assistantMessageWithReplyText(assistantMessage, replyText);
			if (this.#isActiveRequest(request)) {
				request.component.setAnswer(replyText);
				request.component.markComplete();
				// Tern: the sheet was put away while answering; say where the answer is.
				if (this.ctx.ui.nativeRendering && !this.#historyOverlay) {
					this.ctx.showStatus("/btw answer ready · /btw to read it");
				}
			}
		} catch (error) {
			if (getBtwLatestTurn(request.record).status !== "running") return;
			const cancelled = request.abortController.signal.aborted;
			const message = error instanceof Error ? error.message : String(error);
			this.#updateRequest(request, {
				status: cancelled ? "cancelled" : "error",
				updatedAt: Date.now(),
				...(cancelled ? {} : { error: message }),
			});
			if (this.#isActiveRequest(request)) {
				if (cancelled) request.component.markAborted();
				else request.component.markError(message);
			}
		} finally {
			this.ctx.terminalActivity.release(request);
		}
		void this.#persist(request);
		if (this.#isActiveRequest(request)) this.#refreshHistory();
	}

	#hideInline(): void {
		this.#visible = false;
		const request = this.#activeRequest;
		if (!request || isHistoryRequest(request)) this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	/** The request is current and its own session is still loaded, whichever view is on screen. */
	#isActiveRequest(request: BtwHistoryRequest): boolean {
		return this.#activeRequest === request && request.sessionId === request.sessionManager.getSessionId();
	}

	#closeActiveRequest(): void {
		const request = this.#activeRequest;
		if (!request) return;
		if (isHistoryRequest(request)) {
			if (getBtwLatestTurn(request.record).status === "running") this.handleCancel();
			this.#visible = false;
		} else if (request.threadKey) this.#manager?.thread(request.threadKey)?.abortController?.abort();
		this.ctx.terminalActivity.release(request);
		this.#detachActiveRequest();
	}
	#detachActiveRequest(): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}
}
