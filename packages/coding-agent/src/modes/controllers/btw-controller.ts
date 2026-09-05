import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import btwConversationPrompt from "../../prompts/system/btw-conversation.md" with { type: "text" };
import btwHandoffPrompt from "../../prompts/system/btw-handoff.md" with { type: "text" };
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import type { ContinuePausedAgentsResult } from "../../session/agent-session-types";
import { BtwManager } from "../../session/btw-manager";
import { BTW_THREAD_CUSTOM_TYPE, type BtwPromotionLifecycle, type BtwPromotionRequest } from "../../session/btw-thread";
import { sanitizeEphemeralAssistantForPromotion } from "../../session/messages";
import { replaceTabs } from "../../tools/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { BtwConversationPane, type BtwThreadView } from "../components/btw-conversation-pane";
import { BtwPanelComponent } from "../components/btw-panel";
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
	#manager: BtwManager | undefined;
	#managerSessionId: string | undefined;
	#workspacePane: BtwConversationPane | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	readonly label = "BTW";

	prepareForPausedExit(): void {
		this.#manager?.prepareForPausedExit();
	}

	continuePaused(): Promise<ContinuePausedAgentsResult> {
		return this.#managerForCurrentSession().continuePaused();
	}

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
		if (request?.component.isBranchable() === true) {
			if (request.threadKey) return this.#canPromoteThread(request.threadKey);
			return this.#branchUnavailableReason() === undefined;
		}
		return this.#canPromoteThread(this.#manager?.activeKey);
	}

	/** Whether plain `b` is currently reserved by the visible inline QuickAsk panel. */
	handlesBranchKey(): boolean {
		const request = this.#activeRequest;
		if (!request || !this.ctx.btwContainer.children.includes(request.component)) return false;
		if (this.#branchInFlight) return true;
		return request.component.isBranchable() && (request.threadKey ? this.canBranch() : true);
	}

	#branchUnavailableReason(): string | undefined {
		if (this.#branchInFlight) return "a branch is already in progress";
		if (this.#activeRequest?.component.isBranchable() !== true) return "the answer is not ready";
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
				: this.#lastCopyText !== undefined;
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
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest({
			abort: this.#activeRequest.abortController.signal.aborted === false,
			removeQuick: true,
		});
		return true;
	}

	dispose(): void {
		const manager = this.#manager;
		const sessionMatches = manager !== undefined && this.#managerSessionId === this.ctx.sessionManager.getSessionId();
		this.#closeActiveRequest({ abort: true, removeQuick: true });
		if (this.#workspacePane) {
			if (!sessionMatches) this.#workspacePane.abandon();
			this.#closeWorkspacePane();
		}
		if (sessionMatches) manager.dispose();
		else manager?.abandon();
		this.#manager = undefined;
		this.#managerSessionId = undefined;
	}

	async start(question: string): Promise<void> {
		if (this.#branchInFlight) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return;
		}
		if (!this.ctx.workspaceEnabled) {
			await this.#startLegacy(question);
			return;
		}
		this.#startWorkspace(question.trim());
	}

	#startWorkspace(input: string): void {
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
		if (!key || this.#branchInFlight || this.#managerSessionId !== this.ctx.sessionManager.getSessionId()) {
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
			return (await this.ctx.handleBtwBranch(request, lifecycle)) !== false;
		} finally {
			this.#branchInFlight = false;
			if (activeRequest && this.#activeRequest === activeRequest) activeRequest.component.markComplete();
			this.ctx.ui.requestRender();
		}
	}

	async #startLegacy(question: string): Promise<void> {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /btw <question>");
			return;
		}
		if (!this.ctx.session.model) {
			this.ctx.showError("No active model available for /btw.");
			return;
		}
		const request: BtwRequest = {
			component: new BtwPanelComponent({
				question: trimmedQuestion,
				tui: this.ctx.ui,
				canBranch: () => this.canBranch(),
			}),
			abortController: new AbortController(),
			question: trimmedQuestion,
			leafId: this.ctx.sessionManager.getLeafId(),
			sessionId: this.ctx.sessionManager.getSessionId(),
			timestamp: Date.now(),
		};
		this.ctx.terminalActivity.set(request, "working");
		this.#closeActiveRequest({ abort: true, removeQuick: true });
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		void this.#runLegacyRequest(request);
	}

	async #runLegacyRequest(request: BtwRequest): Promise<void> {
		try {
			const promptText = prompt.render(btwUserPrompt, { question: request.question });
			const { replyText, assistantMessage } = await this.ctx.session.runEphemeralTurn({
				promptText,
				onTextDelta: delta => {
					if (this.#activeRequest === request) request.component.appendText(delta);
				},
				signal: request.abortController.signal,
			});
			if (this.#activeRequest !== request) return;
			request.component.setAnswer(replyText);
			request.component.markComplete();
			const copyText = request.component.getCopyText();
			if (copyText !== undefined) {
				this.#lastQuestion = request.question;
				this.#lastReplyText = replyText;
				this.#lastCopyText = copyText;
				this.#lastAssistantMessage = sanitizeEphemeralAssistantForPromotion(assistantMessage, replyText);
				this.#lastLeafId = request.leafId;
				this.#lastSessionId = request.sessionId;
				this.#lastTimestamp = request.timestamp;
			} else {
				this.#clearCompletedState();
			}
		} catch (error) {
			if (this.#activeRequest !== request) return;
			if (request.abortController.signal.aborted) request.component.markAborted();
			else request.component.markError(error instanceof Error ? error.message : String(error));
		} finally {
			this.ctx.terminalActivity.release(request);
		}
	}

	#closeActiveRequest(options: { abort: boolean; removeQuick: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
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
