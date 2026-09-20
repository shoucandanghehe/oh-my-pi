import type { ImageContent } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import btwConversationPrompt from "../../prompts/system/btw-conversation.md" with { type: "text" };
import btwHandoffPrompt from "../../prompts/system/btw-handoff.md" with { type: "text" };
import type { ContinuePausedAgentsResult } from "../../session/agent-session-types";
import { BtwManager } from "../../session/btw-manager";
import { BTW_THREAD_CUSTOM_TYPE, type BtwPromotionLifecycle, type BtwPromotionRequest } from "../../session/btw-thread";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { BtwConversationPane, type BtwThreadView } from "../components/btw-conversation-pane";
import { BtwPanelComponent } from "@oh-my-pi/pi-tui/overlays/btw-panel";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	threadKey: string;
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#branchInFlight = false;
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

	canOpenThread(): boolean {
		if (
			!this.ctx.workspaceEnabled ||
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
		return (
			(!request || request.component.isBranchable()) &&
			this.#canPromoteThread(request?.threadKey ?? this.#manager?.activeKey)
		);
	}

	/** Whether plain `b` is reserved by the visible inline panel. */
	handlesBranchKey(): boolean {
		const request = this.#activeRequest;
		if (!request || !this.ctx.btwContainer.children.includes(request.component)) return false;
		if (this.#branchInFlight) return true;
		return request.component.isBranchable() && this.canBranch();
	}

	canCopy(): boolean {
		return (
			!this.#copyInFlight &&
			this.#threadCopyText(this.#activeRequest?.threadKey ?? this.#manager?.activeKey) !== undefined
		);
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
		if (!request || !manager?.select(request.threadKey)) return false;
		if (!this.#openWorkspacePane(manager)) return false;
		this.#detachActiveRequest();
		return true;
	}

	async handleBranch(): Promise<boolean> {
		if (!this.canBranch()) return false;
		return this.#promoteThread(this.#activeRequest?.threadKey ?? this.#manager?.activeKey);
	}

	handleEscape(): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("/btw branch is in progress", { dim: true });
			return true;
		}
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest();
		return true;
	}

	dispose(): void {
		const manager = this.#manager;
		const sessionMatches = manager !== undefined && this.#managerSessionId === this.ctx.sessionManager.getSessionId();
		this.#closeActiveRequest();
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
		const input = question.trim();
		const manager = this.#managerForCurrentSession();
		if (!input) {
			if (this.ctx.workspaceEnabled) {
				if (this.#openWorkspacePane(manager)) this.#detachActiveRequest();
			} else if (manager.activeKey) {
				this.#showInlineThread(manager, manager.activeKey);
			} else {
				this.ctx.showStatus("Usage: /btw <question>");
			}
			return;
		}
		if (input === "--clear" || input === "clear") {
			this.#closeActiveRequest();
			this.ctx.showStatus("Dismissed the inline BTW panel; the thread is kept", { dim: true });
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
		this.#closeActiveRequest();
		const previousKey = manager.activeKey;
		const threadKey = manager.createChild(input, leafId, { provider: model.provider, id: model.id });
		if (this.#workspacePane && previousKey) manager.select(previousKey);
		const request = this.#showInlineThread(manager, threadKey);
		if (!request) return;
		this.ctx.terminalActivity.set(request, "working");
		void this.#runInlineRequest(manager, request, input);
	}

	#showInlineThread(manager: BtwManager, threadKey: string): BtwRequest | undefined {
		const thread = manager.thread(threadKey);
		if (!thread) return undefined;
		this.#detachActiveRequest();
		const turn = thread.turns.at(-1);
		const request: BtwRequest = {
			threadKey,
			component: new BtwPanelComponent({
				question: thread.request?.input ?? turn?.input ?? thread.title,
				tui: this.ctx.ui,
				canBranch: () => this.canBranch(),
				canOpenThread: this.ctx.workspaceEnabled,
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

	async #runInlineRequest(manager: BtwManager, request: BtwRequest, input: string): Promise<void> {
		try {
			request.component.markRunning();
			const result = await manager.prompt(request.threadKey, input, delta => {
				if (this.#activeRequest === request) request.component.appendText(delta);
			});
			if (this.#activeRequest !== request) return;
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

	#managerForCurrentSession(): BtwManager {
		const sessionId = this.ctx.sessionManager.getSessionId();
		if (this.#manager && this.#managerSessionId === sessionId) return this.#manager;
		this.#closeActiveRequest();
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
				requestRender: () => {
					if (this.#workspacePane) this.ctx.ui.requestComponentRender(this.#workspacePane);
					else this.ctx.ui.requestRender();
				},
				statusLine: this.ctx.statusLine.createPeer(this.ctx.session),
				onSubmit: (input, images, key) => this.#submitPaneInput(manager, input, images, key),
				onNewThread: () => this.#createChild(manager, "") !== undefined,
				canCopy: key => this.#threadCopyText(key) !== undefined,
				onCopy: key => this.handleCopy(key),
				onClose: () => this.#closeWorkspacePane(),
				onDraftChange: (key, text, images, imageLinks) => {
					manager.setDraft(key, text, images, imageLinks);
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
		this.ctx.closeBtwWorkspacePane();
	}

	#submitPaneInput(manager: BtwManager, input: string, images?: ImageContent[], sourceKey?: string): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return false;
		}
		const trimmed = input.trim();
		if (!trimmed && !images?.length) return false;
		const commandEnd = trimmed.indexOf(" ");
		const command = commandEnd < 0 ? trimmed : trimmed.slice(0, commandEnd);
		if (command === "/new") {
			const question = commandEnd < 0 ? "" : trimmed.slice(commandEnd + 1).trim();
			return question || images?.length
				? this.#createChildAndSend(manager, question, images)
				: this.#createChild(manager, "") !== undefined;
		}
		const key = sourceKey ?? manager.activeKey;
		return key ? this.#sendThreadInput(key, trimmed, images) : this.#createChildAndSend(manager, trimmed, images);
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

	#sendThreadInput(key: string, input: string, images?: ImageContent[]): boolean {
		const manager = this.#manager;
		const thread = manager?.thread(key);
		const trimmed = input.trim();
		if (!manager || !thread || (!trimmed && !images?.length)) return false;
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
			.prompt(key, trimmed, undefined, undefined, images)
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
			draftImages: thread.draftImages,
			draftImageLinks: thread.draftImageLinks,
			turns: thread.turns,
			getTool: name => thread.conversation.getTool(name),
			unread: thread.unread,
			status: thread.conversation.status,
			request: thread.request
				? {
						input: thread.request.input,
						images: thread.request.images,
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
			manager.persistDraft(candidate.key);
		}
		const lifecycle: BtwPromotionLifecycle = {
			prepare: () => {
				if (!manager.preparePromotion(key)) throw new Error("BTW thread is no longer promotable");
			},
			rollback: () => {
				manager.rollbackPromotion(key);
			},
		};
		const promoted = await this.#promote(
			{ anchorLeafId: thread.anchorLeafId, sessionId, turns: [...thread.turns] },
			lifecycle,
		);
		if (this.#manager !== manager) {
			manager.abandon();
			return promoted;
		}
		if (!promoted) return false;
		manager.completePromotion(key);
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

	#detachActiveRequest(): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#closeActiveRequest(): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#manager?.thread(request.threadKey)?.abortController?.abort();
		this.ctx.terminalActivity.release(request);
		this.#detachActiveRequest();
	}
}
