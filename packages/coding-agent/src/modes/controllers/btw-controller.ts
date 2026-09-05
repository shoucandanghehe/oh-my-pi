import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { type OverlayHandle, replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import { BtwPanelComponent } from "@oh-my-pi/pi-tui/overlays/btw-panel";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { logger, prompt, Snowflake, toError, withTimeout } from "@oh-my-pi/pi-utils";
import btwConversationPrompt from "../../prompts/system/btw-conversation.md" with { type: "text" };
import btwHandoffPrompt from "../../prompts/system/btw-handoff.md" with { type: "text" };
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	BtwHistoryStore,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
} from "../../session/btw-history";
import { BtwManager } from "../../session/btw-manager";
import { BTW_THREAD_CUSTOM_TYPE, type BtwPromotionLifecycle, type BtwPromotionRequest } from "../../session/btw-thread";
import { copyToClipboard } from "../../utils/clipboard";
import { BtwConversationPane, type BtwThreadView } from "../components/btw-conversation-pane";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
	leafId: string | null;
	sessionId: string;
	timestamp: number;
	threadKey?: string;
}

interface BtwHistoryRequest extends BtwRequest {
	session: InteractiveModeContext["session"];
	/** Manager of the view that asked; the request outlives focus changes. */
	sessionManager: InteractiveModeContext["sessionManager"];
	store: BtwHistoryStore;
	record: BtwHistoryRecord;
	history?: readonly BtwHistoryTurn[];
	/** At least one checkpoint belongs to this request; later failures must block lifecycle changes. */
	persisted: boolean;
	conversationKey: string;
}

function isHistoryRequest(request: BtwRequest): request is BtwHistoryRequest {
	return "record" in request;
}

function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#lastQuestion: string | undefined;
	#lastReplyText: string | undefined;
	#lastAssistantMessage: AssistantMessage | undefined;
	#lastLeafId: string | null | undefined;
	#lastSessionId: string | undefined;
	#lastTimestamp: number | undefined;
	#branchInFlight = false;
	#lastCopyText: string | undefined;
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
	readonly #failedWrites = new Map<BtwHistoryRequest, Error>();
	#manager: BtwManager | undefined;
	#managerSessionId: string | undefined;
	#workspacePane: BtwConversationPane | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	/** /btw asks about the transcript on screen: the focused agent's session, else main. */
	get #sessionManager(): InteractiveModeContext["sessionManager"] {
		return this.ctx.focusedAgentId ? this.ctx.viewSession.sessionManager : this.ctx.sessionManager;
	}

	/** Focused agents share main's artifacts directory; scope their history by session id. */
	get #historyScope(): string | undefined {
		return this.ctx.focusedAgentId ? this.#sessionManager.getSessionId() : undefined;
	}

	/** Whether the inline panel owns Escape. */
	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	canContinue(): boolean {
		if (this.#branchInFlight || this.#managerSessionId !== this.ctx.sessionManager.getSessionId()) return false;
		const request = this.#activeRequest;
		if (!request?.threadKey || request.component.isBranchable() !== true) return false;
		const thread = this.#manager?.thread(request.threadKey);
		return thread?.kind === "quick" && thread.phase === "ready" && thread.turns.length > 0;
	}

	/** Whether plain `Enter` is currently reserved by the visible inline QuickAsk panel. */
	handlesContinueKey(): boolean {
		const request = this.#activeRequest;
		return request !== undefined && this.ctx.btwContainer.children.includes(request.component) && this.canContinue();
	}

	canBranch(): boolean {
		if (this.#branchInFlight) return false;
		const request = this.#activeRequest;
		if (request?.threadKey) return request.component.isBranchable() && this.#canPromoteThread(request.threadKey);
		if (request && isHistoryRequest(request)) return this.#branchUnavailableReason() === undefined;
		return this.#canPromoteThread(this.#manager?.activeKey);
	}

	/** Whether plain `b` is currently reserved by the visible inline QuickAsk panel. */
	handlesBranchKey(): boolean {
		const request = this.#activeRequest;
		if (!request || !this.ctx.btwContainer.children.includes(request.component)) return false;
		if (this.#branchInFlight) return true;
		return request.component.isBranchable() && this.canBranch();
	}

	#branchUnavailableReason(): string | undefined {
		if (this.#branchInFlight) return "a branch is already in progress";
		if (this.#transitionCount > 0) return "a session operation is in progress";
		const request = this.#activeRequest;
		if (!request || !this.#visible || request.component.isBranchable() !== true)
			return "the answer is not ready";
		if (!isHistoryRequest(request) || request.session !== this.ctx.session || this.ctx.focusedAgentId)
			return "only main-session answers can be branched";
		// Inline promotion carries one pair; do not silently drop earlier follow-ups.
		if (request.history?.length) return "multi-turn side conversations remain in BTW history";
		if (
			!this.#lastQuestion ||
			!this.#lastReplyText ||
			!this.#lastAssistantMessage ||
			this.#lastTimestamp === undefined
		) {
			return "the answer is unavailable";
		}
		if (!this.#lastLeafId) return "the session has no branch point";
		if (
			this.#lastSessionId !== this.ctx.sessionManager.getSessionId() ||
			this.#lastLeafId !== this.ctx.sessionManager.getLeafId()
		) {
			return "the session changed since /btw started";
		}
		if (this.ctx.session.isStreaming) return "a turn is still running";
		return undefined;
	}

	canCopy(): boolean {
		if (this.#copyInFlight) return false;
		const request = this.#activeRequest;
		if (request?.component.isCopyable() === true) {
			return request.threadKey
				? this.#threadCopyText(request.threadKey) !== undefined
				: this.#visible && this.#lastCopyText !== undefined;
		}
		return this.#threadCopyText(this.#manager?.activeKey) !== undefined;
	}

	/** Whether plain `c` is currently reserved by the visible inline QuickAsk panel. */
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
			if (this.#lastCopyText === undefined || !this.#visible) return false;
			const request = this.#activeRequest;
			const copied = await this.#copyHistoryAnswer(this.#lastCopyText, request.record.id);
			if (copied && this.#activeRequest === request && this.#visible) request.component.markCopied();
			return copied;
		}
		const copyText = threadKey
			? this.#threadCopyText(threadKey)
			: this.#activeRequest?.threadKey
				? this.#threadCopyText(this.#activeRequest.threadKey)
				: this.#activeRequest
					? this.#lastCopyText
					: this.#threadCopyText(this.#manager?.activeKey);
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

	async handleContinue(): Promise<boolean> {
		if (!this.canContinue()) return false;
		const request = this.#activeRequest;
		const manager = this.#manager;
		if (!request?.threadKey || !manager?.continueQuick(request.threadKey)) return false;
		this.#detachActiveRequest();
		this.#clearCompletedState();
		if (!this.#openWorkspacePane(manager)) return false;
		this.ctx.showStatus("Continued /btw as a durable side thread", { dim: true });
		return true;
	}

	async handleBranch(): Promise<boolean> {
		const request = this.#activeRequest;
		if (!this.canBranch()) {
			if (!request?.threadKey) {
				const unavailableReason = this.#branchUnavailableReason();
				if (unavailableReason) {
					this.ctx.showStatus(`/btw branch unavailable: ${unavailableReason}`, { dim: true });
				}
			}
			return false;
		}
		if (request?.threadKey) return this.#promoteThread(request.threadKey);
		if (request) {
			if (
				this.#lastQuestion === undefined ||
				this.#lastReplyText === undefined ||
				this.#lastAssistantMessage === undefined ||
				this.#lastTimestamp === undefined ||
				this.#lastLeafId === null ||
				this.#lastLeafId === undefined
			) {
				return false;
			}
			if (this.#lastSessionId === undefined) return false;
			const promoted = await this.#promote({
				anchorLeafId: this.#lastLeafId,
				sessionId: this.#lastSessionId,
				turns: [
					{
						input: this.#lastQuestion,
						replyText: this.#lastReplyText,
						assistantMessage: this.#lastAssistantMessage,
						timestamp: this.#lastTimestamp,
					},
				],
			});
			if (promoted && this.#activeRequest === request) {
				this.#closeActiveRequest({ abort: false, removeQuick: false });
			}
			return promoted;
		}
		const activeKey = this.#manager?.activeKey;
		return activeKey ? this.#promoteThread(activeKey) : false;
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
		} else this.#closeActiveRequest({ abort: true, removeQuick: true });
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

	handleCancel(): boolean {
		const request = this.#activeRequest;
		if (!request || !isHistoryRequest(request) || getBtwLatestTurn(request.record).status !== "running")
			return false;
		this.#updateRequest(request, { status: "cancelled", updatedAt: Date.now() });
		request.abortController.abort();
		request.component.markAborted();
		void this.#persist(request);
		this.#refreshHistory();
		return true;
	}

	async dispose(): Promise<void> {
		this.#generation++;
		this.#transitionCount++;
		try {
			this.handleCancel();
			await this.flush();
			this.#closeHistory();
			this.#hideInline();
			this.#closeActiveRequest({ abort: true, removeQuick: true });
			this.#store = undefined;
			this.#storePromise = undefined;
			this.#storeSessionId = undefined;
			this.#storeArtifactsDir = undefined;
			this.#storeScope = undefined;
			const manager = this.#manager;
			const sessionMatches = manager !== undefined && this.#managerSessionId === this.ctx.sessionManager.getSessionId();
			if (this.#workspacePane) {
				if (!sessionMatches) this.#workspacePane.abandon();
				this.#closeWorkspacePane();
			}
			if (sessionMatches) manager.dispose();
			else manager?.abandon();
			this.#manager = undefined;
			this.#managerSessionId = undefined;
		} finally {
			this.#transitionCount--;
		}
	}

	async flush(timeoutMs = 10_000): Promise<void> {
		await withTimeout(
			this.#drainWrites(),
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
				this.#closeActiveRequest({ abort: false, removeQuick: false });
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

	async startFollowUp(recordId: string, question: string, signal?: AbortSignal): Promise<boolean> {
		if (!question.trim()) return false;
		return this.#startHistory(question, recordId, signal);
	}

	async start(question: string): Promise<void> {
		if (this.#branchInFlight) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return;
		}
		if (!this.ctx.workspaceEnabled || this.ctx.focusedAgentId) {
			await this.#startHistory(question);
			return;
		}
		this.#startWorkspace(question.trim());
	}

	#startWorkspace(input: string): void {
		const active = this.#activeRequest;
		if (active && isHistoryRequest(active) && getBtwLatestTurn(active.record).status === "running") {
			this.ctx.showStatus("A /btw question is still running in another session view. Wait for it or cancel it first.", {
				dim: true,
			});
			return;
		}
		if (this.#historyOverlay) this.#closeHistory();
		if (active && isHistoryRequest(active)) this.#closeActiveRequest({ abort: false, removeQuick: false });
		const manager = this.#managerForCurrentSession();
		if (!input) {
			this.#openWorkspacePane(manager);
			return;
		}
		if (input === "--clear" || input === "clear") {
			if (!this.#activeRequest) {
				this.ctx.showStatus("No QuickAsk is open; durable side threads are kept", { dim: true });
				return;
			}
			this.#closeActiveRequest({ abort: true, removeQuick: true });
			this.ctx.showStatus("Dismissed the current QuickAsk; durable side threads are kept", { dim: true });
			return;
		}
		const model = this.ctx.session.model;
		const leafId = this.ctx.sessionManager.getLeafId();
		if (!model || !leafId) {
			this.ctx.showError(
				!model ? "No active model available for /btw." : "Cannot start /btw before Main has a leaf",
			);
			return;
		}
		this.#closeActiveRequest({ abort: true, removeQuick: true });
		const threadKey = manager.createQuick(input, leafId, { provider: model.provider, id: model.id });
		const request: BtwRequest = {
			component: new BtwPanelComponent({
				question: input,
				tui: this.ctx.ui,
				canBranch: () => this.canBranch(),
				continueToThread: true,
			}),
			abortController: new AbortController(),
			question: input,
			leafId,
			sessionId: this.ctx.sessionManager.getSessionId(),
			timestamp: Date.now(),
			threadKey,
		};
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		this.ctx.terminalActivity.set(request, "working");
		void this.#runQuickRequest(manager, request);
	}

	async #startHistory(question: string, recordId?: string, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return false;
		const trimmedQuestion = question.trim();
		if (this.#starting || this.#branchInFlight || this.#transitionCount > 0) {
			this.ctx.showStatus("A /btw action is in progress. Please wait.", { dim: true });
			return false;
		}
		const viewSession = this.ctx.focusedAgentId ? this.ctx.viewSession : this.ctx.session;
		const active = this.#activeRequest;
		if (active?.threadKey && this.#manager?.thread(active.threadKey)?.phase === "running") {
			this.ctx.showStatus("A /btw question is still running in another session view. Wait for it or cancel it first.", {
				dim: true,
			});
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
			if (trimmedQuestion && active.sessionId === this.#sessionManager.getSessionId()) {
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
			if (!trimmedQuestion) {
				const panel = this.#showHistory(store);
				// Tern: reopening lands on the side question put away while it answered.
				const active = this.#activeRequest;
				if (this.ctx.ui.nativeRendering && active?.store === store && this.#isActiveRequest(active)) {
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
				this.#closeActiveRequest({ abort: true, removeQuick: true });
			}
			this.#activeRequest?.component.close();
			this.#clearCompletedState();
			const now = Date.now();
			const leafId = this.#sessionManager.getLeafId();
			const turn: BtwHistoryTurn = {
				question: trimmedQuestion,
				answer: "",
				status: "running",
				createdAt: now,
				updatedAt: now,
			};
			const record: BtwHistoryRecord = previous
				? { ...previous, followUps: [...(previous.followUps ?? []), turn] }
				: { ...turn, id: Snowflake.next(), leafId };
			const history = previous ? getBtwTurns(previous) : undefined;
			const transportEpoch = (history?.findLastIndex(item => item.status !== "complete") ?? -1) + 1;
			const request: BtwHistoryRequest = {
				component: new BtwPanelComponent({
					question: trimmedQuestion,
					tui: this.ctx.ui,
					canBranch: () => this.canBranch(),
					canFollowUp: () => this.canFollowUp(),
				}),
				abortController: new AbortController(),
				question: trimmedQuestion,
				leafId,
				sessionId,
				timestamp: now,
				session: viewSession,
				sessionManager: this.#sessionManager,
				store,
				record,
				history,
				conversationKey: `btw:${record.id}:${transportEpoch}`,
				persisted: false,
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
			onFollowUp: (record, followUp, followUpSignal) => {
				if (historySessionId !== this.#sessionManager.getSessionId()) return Promise.resolve(false);
				return this.startFollowUp(record.id, followUp, followUpSignal);
			},
			spaceHold: input => this.ctx.dictationSpaceHold(input),
			requestRender: () => this.ctx.ui.requestRender(),
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
		if (request && isHistoryRequest(request) && this.#isActiveRequest(request) && getBtwLatestTurn(request.record).status === "running") {
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

	async #runQuickRequest(manager: BtwManager, request: BtwRequest): Promise<void> {
		try {
			const result = await manager.prompt(request.threadKey!, request.question, delta => {
				if (this.#activeRequest === request) request.component.appendText(delta);
			});
			if (this.#activeRequest !== request) return;
			request.component.setAnswer(result.replyText);
			request.component.markComplete();
		} catch (error) {
			if (this.#activeRequest !== request) return;
			if (manager.thread(request.threadKey!)?.phase === "ready") request.component.markAborted();
			else request.component.markError(error instanceof Error ? error.message : String(error));
		} finally {
			this.ctx.terminalActivity.release(request);
			this.#updateWorkspacePane();
		}
	}

	#managerForCurrentSession(): BtwManager {
		const sessionId = this.ctx.sessionManager.getSessionId();
		if (this.#manager && this.#managerSessionId === sessionId) return this.#manager;
		this.#closeActiveRequest({ abort: true, removeQuick: true });
		this.#workspacePane?.abandon();
		this.#closeWorkspacePane();
		this.#manager?.abandon();
		this.#managerSessionId = sessionId;
		this.#manager = new BtwManager({
			entries: this.ctx.sessionManager.getEntries(),
			appendEvent: event => {
				if (this.ctx.sessionManager.getSessionId() !== sessionId) return;
				this.ctx.sessionManager.appendCustomEntry(BTW_THREAD_CUSTOM_TYPE, event);
			},
			createConversation: (modelRef, checkpoint, sideOptions) => {
				const active = this.ctx.session.model;
				const model =
					active?.provider === modelRef.provider && active.id === modelRef.id
						? active
						: this.ctx.session.findModel(modelRef.provider, modelRef.id);
				if (!model) throw new Error(`BTW model is unavailable: ${modelRef.provider}/${modelRef.id}`);
				return this.ctx.session.createEphemeralConversation(btwConversationPrompt, checkpoint, model, sideOptions);
			},
			createSideOptions: source => ({
				readOnlyTools: true,
				shareSummaryWithMain: summary => this.ctx.session.publishBtwSummary({ ...source, summary }),
			}),
			nextKey: () => `btw-${Snowflake.next()}`,
			now: Date.now,
			onChange: () => this.#updateWorkspacePane(),
		});
		return this.#manager;
	}

	#openWorkspacePane(manager: BtwManager): boolean {
		if (!this.#workspacePane) {
			this.#workspacePane = new BtwConversationPane({
				ui: this.ctx.ui,
				cwd: this.ctx.sessionManager.getCwd(),
				expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
				hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
				proseOnlyThinking: () => this.ctx.proseOnlyThinking,
				requestRender: () => this.ctx.ui.requestRender(),
				statusLine: this.ctx.statusLine.createPeer(this.ctx.session),
				onSubmit: input => this.#submitPaneInput(manager, input),
				onNewThread: () => this.#createChild(manager, "") !== undefined,
				canCopy: key => this.#threadCopyText(key) !== undefined,
				onCopy: key => this.handleCopy(key),
				onClose: () => this.#closeWorkspacePane(),
				onDraftChange: (key, text) => {
					manager.setDraft(key, text);
				},
				onSelectThread: key => manager.select(key),
				onMarkRead: key => {
					manager.markRead(key);
				},
				onCloseThread: key => this.#closeThread(manager, key),
				onPromoteThread: key => this.#promoteThread(key),
				onRejectedSubmit: () =>
					this.ctx.showStatus("A BTW reply is still streaming — wait for it to finish", { dim: true }),
				onPersistDraft: key => {
					manager.persistDraft(key);
				},
			});
		}
		this.#updateWorkspacePane();
		if (this.ctx.openBtwWorkspacePane(this.#workspacePane)) return true;
		this.#workspacePane.dispose();
		this.#workspacePane = undefined;
		this.ctx.showError("The terminal is too small to open the /btw pane");
		return false;
	}

	#closeWorkspacePane(): void {
		if (!this.#workspacePane) return;
		this.#workspacePane = undefined;
		const manager = this.#manager;
		if (manager && this.#managerSessionId === this.ctx.sessionManager.getSessionId()) {
			for (const thread of manager.children) {
				if (
					thread.phase === "ready" &&
					thread.request === undefined &&
					thread.turns.length === 0 &&
					!thread.draft.trim()
				) {
					manager.remove(thread.key, "deleted");
				}
			}
		}
		this.ctx.closeBtwWorkspacePane();
	}

	#submitPaneInput(manager: BtwManager, input: string): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return false;
		}
		const trimmed = input.trim();
		if (!trimmed) return false;
		const commandEnd = trimmed.indexOf(" ");
		const command = commandEnd < 0 ? trimmed : trimmed.slice(0, commandEnd);
		if (command === "/new") {
			const question = commandEnd < 0 ? "" : trimmed.slice(commandEnd + 1).trim();
			return question ? this.#createChildAndSend(manager, question) : this.#createChild(manager, "") !== undefined;
		}
		const key = manager.activeKey;
		return key ? this.#sendThreadInput(key, trimmed) : this.#createChildAndSend(manager, trimmed);
	}

	#createChild(manager: BtwManager, input: string): string | undefined {
		if (this.#branchInFlight || manager !== this.#manager) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return undefined;
		}
		const activeKey = manager.activeKey;
		const active = activeKey ? manager.thread(activeKey) : undefined;
		if (
			!input.trim() &&
			active?.kind === "child" &&
			active.phase === "ready" &&
			active.request === undefined &&
			active.turns.length === 0
		) {
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

	/** Create a durable child from the pane (no QuickAsk hop) and send its first question. */
	#createChildAndSend(manager: BtwManager, input: string): boolean {
		const key = this.#createChild(manager, input);
		if (!key) return false;
		this.#sendThreadInput(key, input);
		return true;
	}

	#sendThreadInput(key: string, input: string): boolean {
		const manager = this.#manager;
		const thread = manager?.thread(key);
		const trimmed = input.trim();
		if (!manager || !thread || thread.kind !== "child" || !trimmed) return false;
		const commandEnd = trimmed.indexOf(" ");
		const command = commandEnd < 0 ? trimmed : trimmed.slice(0, commandEnd);
		const argument = commandEnd < 0 ? "" : trimmed.slice(commandEnd + 1).trim();
		if (command === "/help") {
			this.ctx.showStatus("BTW actions: /new [question] · /handoff [direction] · /promote · /delete");
			return false;
		}
		if (command === "/clear") {
			this.ctx.showStatus("Start a new durable BTW thread with /new", { dim: true });
			return false;
		}
		if (command === "/delete") return this.#closeThread(manager, key);
		if (command === "/handoff") {
			if (thread.phase === "running" || thread.turns.length === 0) {
				this.ctx.showError("Wait for a completed BTW reply before handing off to Main");
				return false;
			}
			const handoff = prompt.render(btwHandoffPrompt, {
				turns: thread.turns.map(turn => ({ input: turn.input, replyText: turn.replyText })),
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
		if (thread.phase === "running") {
			this.ctx.showStatus("A BTW reply is still streaming — wait for it to finish", { dim: true });
			return false;
		}
		manager.setDraft(key, "");
		this.ctx.terminalActivity.set(thread, "working");
		void manager
			.prompt(key, trimmed)
			.catch(error => {
				if (thread.phase === "error") this.ctx.showError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => this.ctx.terminalActivity.release(thread));
		return true;
	}

	#updateWorkspacePane(): void {
		const manager = this.#manager;
		const pane = this.#workspacePane;
		if (!manager || !pane) return;
		const threads: BtwThreadView[] = manager.children.map(thread => ({
			key: thread.key,
			title: thread.title,
			phase: thread.phase,
			model: thread.model,
			error: thread.error,
			draft: thread.draft,
			turns: thread.turns,
			getTool: name => thread.conversation.getTool(name),
			unread: thread.unread,
			status: thread.conversation.status,
			request: thread.request
				? {
						input: thread.request.input,
						messages: thread.request.messages,
						streamMessage: thread.request.streamMessage,
						timestamp: thread.request.timestamp,
					}
				: undefined,
		}));
		pane.update(threads, manager.activeKey);
	}

	#closeThread(manager: BtwManager, key: string): boolean {
		if (this.#branchInFlight || manager !== this.#manager) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return false;
		}
		if (!manager.remove(key, "deleted")) return false;
		if (manager.children.length === 0) this.#closeWorkspacePane();
		return true;
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
			thread.turns.length > 0 &&
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
		// Promotion switches the session, after which `abandon()` must not write
		// into the new session's journal — so persist every unflushed draft now,
		// before the branch is attempted. No-op when a draft is already stored.
		for (const candidate of manager.children) {
			if (candidate.kind === "child") manager.persistDraft(candidate.key);
		}
		const lifecycle: BtwPromotionLifecycle | undefined =
			thread.kind === "child"
				? {
						prepare: () => {
							if (!manager.preparePromotion(key)) throw new Error("BTW thread is no longer promotable");
						},
						rollback: () => {
							manager.rollbackPromotion(key);
						},
					}
				: undefined;
		const promoted = await this.#promote(
			{ anchorLeafId: thread.anchorLeafId, sessionId, turns: [...thread.turns] },
			lifecycle,
		);
		if (this.#manager !== manager) {
			manager.abandon();
			return promoted;
		}
		if (!promoted) return false;
		if (thread.kind === "child") manager.completePromotion(key);
		else manager.remove(key, "promoted");
		if (this.#activeRequest?.threadKey === key) this.#detachActiveRequest();
		manager.abandon();
		this.#manager = undefined;
		this.#managerSessionId = undefined;
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
		const followUps = request.record.followUps;
		if (followUps?.length) {
			request.record = {
				...request.record,
				followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1]!, ...patch }],
			};
		} else {
			request.record = { ...request.record, ...patch };
		}
	}

	async #runHistoryRequest(request: BtwHistoryRequest): Promise<void> {
		try {
			const promptText = prompt.render(btwUserPrompt, { question: request.question });
			const model = request.session.model;
			if (!model) throw new Error("No active model available for /btw.");
			const history: Message[] = [];
			for (const turn of request.history ?? []) {
				history.push({
					role: "user",
					content: [{ type: "text", text: prompt.render(btwUserPrompt, { question: turn.question }) }],
					attribution: "agent",
					timestamp: turn.createdAt,
				});
				if (!turn.answer) continue;
				history.push({
					role: "assistant",
					content: [{ type: "text", text: turn.answer }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: turn.updatedAt,
				});
			}
			const { replyText, assistantMessage } = await request.session.runEphemeralTurn({
				promptText,
				history,
				conversationKey: request.conversationKey,
				// /btw answers are read in full and saved to history: keep the
				// repeated-line collapse, but not the 4 KiB cap meant for one-liners.
				replyMaxBytes: Number.POSITIVE_INFINITY,
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
			if (this.#isActiveRequest(request)) {
				request.component.setAnswer(replyText);
				request.component.markComplete();
				// Tern: the sheet was put away while answering; say where the answer is.
				if (this.ctx.ui.nativeRendering && !this.#historyOverlay) {
					this.ctx.showStatus("/btw answer ready · /btw to read it");
				}
				const copyText = request.component.getCopyText();
				if (copyText !== undefined) {
					this.#lastQuestion = request.question;
					this.#lastReplyText = replyText;
					this.#lastCopyText = copyText;
					this.#lastAssistantMessage = assistantMessageWithReplyText(assistantMessage, replyText);
					this.#lastLeafId = request.leafId;
					this.#lastSessionId = request.sessionId;
					this.#lastTimestamp = request.timestamp;
				} else this.#clearCompletedState();
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

	#closeActiveRequest(options: { abort: boolean; removeQuick: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		if (options.abort && isHistoryRequest(request) && getBtwLatestTurn(request.record).status === "running") {
			this.handleCancel();
		}
		this.#activeRequest = undefined;
		if (isHistoryRequest(request)) this.#visible = false;
		this.ctx.terminalActivity.release(request);
		this.#clearCompletedState();
		if (options.abort) request.abortController.abort();
		if (options.removeQuick && request.threadKey) this.#manager?.remove(request.threadKey, "deleted");
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#detachActiveRequest(): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		this.ctx.terminalActivity.release(request);
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#clearCompletedState(): void {
		this.#lastQuestion = undefined;
		this.#lastReplyText = undefined;
		this.#lastAssistantMessage = undefined;
		this.#lastCopyText = undefined;
		this.#lastLeafId = undefined;
		this.#lastSessionId = undefined;
		this.#lastTimestamp = undefined;
	}
}
