import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import btwConversationPrompt from "../../prompts/system/btw-conversation.md" with { type: "text" };
import btwHandoffPrompt from "../../prompts/system/btw-handoff.md" with { type: "text" };
import { resolveSessionMarkdownLinks } from "../../internal-urls/hyperlink-targets";
import type { ContinuePausedAgentsResult } from "../../session/agent-session-types";
import { BtwHistoryStore, type BtwHistoryRecord } from "../../session/btw-history";
import { BtwManager, type BtwThread } from "../../session/btw-manager";
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

const memoryHistoryStores = new WeakMap<object, { sessionId: string; store: BtwHistoryStore }>();

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#branchInFlight = false;
	#copyInFlight = false;
	#manager: BtwManager | undefined;
	#managerSessionId: string | undefined;
	#managerArtifactsDir: string | null | undefined;
	#openingManager: Promise<BtwManager> | undefined;
	#disposing: Promise<void> | undefined;
	#generation = 0;
	#workspacePane: BtwConversationPane | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	readonly label = "BTW";

	prepareForPausedExit(): void {
		this.#manager?.prepareForPausedExit();
	}

	async continuePaused(): Promise<ContinuePausedAgentsResult> {
		return (await this.#managerForCurrentSession()).continuePaused();
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
		await this.#openingManager?.catch(() => undefined);
		const manager = this.#manager;
		const sessionMatches = manager !== undefined && this.#managerSessionId === this.ctx.sessionManager.getSessionId();
		this.#closeActiveRequest();
		if (this.#workspacePane) {
			if (!sessionMatches) this.#workspacePane.abandon();
			this.#closeWorkspacePane();
		}
		if (sessionMatches) await manager.dispose();
		else await manager?.abandon();
		this.#manager = undefined;
		this.#managerSessionId = undefined;
		this.#managerArtifactsDir = undefined;
	}

	async start(question: string): Promise<void> {
		if (this.#branchInFlight) {
			this.ctx.showStatus("Wait for the current BTW promotion to finish", { dim: true });
			return;
		}
		const input = question.trim();
		const generation = this.#generation;
		const manager = await this.#managerForCurrentSession();
		if (generation !== this.#generation) return;
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
		this.#manager = undefined;
		let store: BtwHistoryStore;
		if (
			artifactsDir &&
			!(await Bun.file(path.join(artifactsDir, "btw-history", ".migrated-v1")).exists()) &&
			this.ctx.sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === BTW_THREAD_CUSTOM_TYPE)
		) {
			throw new Error(
				"This session has BTW history in Main; run the one-time BTW sidecar migration before opening it",
			);
		}
		if (artifactsDir) {
			store = await BtwHistoryStore.open(artifactsDir);
		} else {
			const owner = this.ctx.sessionManager;
			const previous = memoryHistoryStores.get(owner);
			store = previous?.sessionId === sessionId ? previous.store : await BtwHistoryStore.open(undefined);
			memoryHistoryStores.set(owner, { sessionId, store });
		}
		if (
			this.ctx.sessionManager.getSessionId() !== sessionId ||
			this.ctx.sessionManager.getLocalArtifactsDir() !== artifactsDir
		) {
			throw new Error("BTW session changed while opening its history");
		}
		const manager = new BtwManager({
			restoredThreads: [...store.getRecords()]
				.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
				.map(({ id, version: _version, phase, ...record }) => {
					if (phase === "running") throw new Error(`BTW history ${id} was not recovered`);
					return structuredClone({ ...record, key: id, phase });
				}),
			appendEvent: event => {
				if (this.ctx.sessionManager.getSessionId() !== sessionId || this.#managerArtifactsDir !== artifactsDir) {
					return;
				}
				let write: Promise<void>;
				if (event.op === "remove") {
					write = store.remove(event.key);
				} else {
					const thread = manager.thread(event.key);
					if (!thread) throw new Error(`Unknown BTW thread: ${event.key}`);
					write = store.upsert(this.#historyRecord(thread));
				}
				void write.catch(error =>
					this.ctx.showError(
						`BTW history write failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			},
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
			createSideOptions: source => ({
				readOnlyTools: true,
				shareSummaryWithMain: summary => this.ctx.session.publishBtwSummary({ ...source, summary }),
			}),
			nextKey: () => `btw-${Snowflake.next()}`,
			now: Date.now,
			onChange: () => this.#updateWorkspacePane(),
		});
		this.#managerArtifactsDir = artifactsDir;
		this.#managerSessionId = sessionId;
		this.#manager = manager;
		return manager;
	}

	#historyRecord(thread: BtwThread): BtwHistoryRecord {
		const checkpoint = thread.conversation.checkpoint();
		if (!checkpoint.baseMessages) throw new Error("BTW thread has no frozen Main snapshot");
		const pausedRequest =
			thread.phase === "running" && thread.request
				? { input: thread.request.input, images: thread.request.images, timestamp: thread.request.timestamp }
				: thread.pausedRequest;
		return {
			version: 1,
			id: thread.key,
			title: thread.title,
			createdAt: thread.createdAt,
			anchorLeafId: thread.anchorLeafId,
			model: thread.model,
			sideSessionId: checkpoint.sideSessionId,
			baseMessages: checkpoint.baseMessages,
			turns: checkpoint.turns,
			draft: thread.draft,
			draftImages: thread.draftImages,
			draftImageLinks: thread.draftImageLinks,
			readThrough: thread.readThrough,
			phase: thread.phase,
			error: thread.error,
			pausedRequest,
		};
	}

	#openWorkspacePane(manager: BtwManager): boolean {
		if (!this.#workspacePane) {
			const ownerSession = this.ctx.session;
			this.#workspacePane = new BtwConversationPane({
				ui: this.ctx.ui,
				cwd: this.ctx.sessionManager.getCwd(),
				expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
				hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
				proseOnlyThinking: () => this.ctx.proseOnlyThinking,
				resolveLinks: texts => resolveSessionMarkdownLinks(texts, ownerSession),
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
				onDisplayThread: key => {
					const thread = manager.thread(key);
					if (!thread || thread.conversation.extensionRunner) return;
					void thread.conversation.initializeExtensionRuntime().then(
						() => {
							if (this.#manager === manager) this.#updateWorkspacePane();
						},
						error =>
							this.ctx.showError(
								`BTW extension failed: ${error instanceof Error ? error.message : String(error)}`,
							),
					);
				},
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
		if (command === "/delete") {
			void this.#closeThread(manager, key);
			return true;
		}
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
			extensionRunner: thread.conversation.extensionRunner,
			getTool: name => thread.conversation.getTool(name),
			isBuiltInTool: name => Boolean(thread.conversation.getTool(name)) && this.ctx.session.hasBuiltInTool(name),
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
		// Flush pending BTW drafts before promotion changes the parent session.
		for (const candidate of manager.children) {
			manager.persistDraft(candidate.key);
		}
		try {
			await manager.flushEvents();
		} catch (error) {
			this.ctx.showError(`Cannot promote BTW: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
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
			{ anchorLeafId: thread.anchorLeafId, sessionId, turns: [...thread.turns] },
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
