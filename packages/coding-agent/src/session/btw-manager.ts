import { type AgentMessage, PAUSE_SHUTDOWN_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "./agent-session";
import { AGENTS_PAUSED_CUSTOM_TYPE, readAgentsPaused } from "./exit-diagnostics";
import type { ContinuePausedAgentsResult } from "./agent-session-types";
import { USER_INTERRUPT_LABEL } from "./messages";
import type { BtwThreadEvent, BtwThreadModelRef, RestoredBtwThread } from "./btw-thread";
import type {
	EphemeralConversation,
	EphemeralConversationCheckpoint,
	EphemeralConversationSideOptions,
	EphemeralTurnResult,
} from "./ephemeral-conversation";

export type BtwThreadPhase = "ready" | "running" | "error";

export interface BtwThreadRequest {
	input: string;
	images?: ImageContent[];
	messages: AgentMessage[];
	streamMessage: Extract<AgentMessage, { role: "assistant" }> | undefined;
	timestamp: number;
	admission: PromiseWithResolvers<void>;
	settled: PromiseWithResolvers<void>;
	userMessage?: Extract<AgentMessage, { role: "user" }>;
}

export interface BtwManagerOptions {
	restoredThreads: readonly RestoredBtwThread[];
	appendEvent: (event: BtwThreadEvent) => void;
	flushEvents?: () => Promise<void>;
	closeEvents?: () => Promise<void>;
	removeSession?: (key: string) => Promise<void>;
	createConversation: (
		model: BtwThreadModelRef,
		checkpoint: EphemeralConversationCheckpoint | undefined,
		sideOptions?: EphemeralConversationSideOptions,
	) => EphemeralConversation;
	/** Builds durable side capabilities bound to the BTW thread `threadKey`. */
	createSideOptions?: (threadKey: string) => EphemeralConversationSideOptions;
	/** Names a thread from its first question; null keeps the question-derived title. */
	generateTitle?: (input: string) => Promise<string | null>;
	nextKey: () => string;
	now: () => number;
	onChange?: () => void;
}

interface BtwThreadOptions {
	key: string;
	title: string;
	titleExplicit?: boolean;
	createdAt: number;
	anchorLeafId: string;
	model: BtwThreadModelRef;
	conversation: EphemeralConversation;
	phase?: BtwThreadPhase;
	error?: string;
	draft?: string;
	draftImages?: ImageContent[];
	draftImageLinks?: (string | undefined)[];
	readThrough?: number;
}

export class BtwThread {
	readonly key: string;
	title: string;
	readonly titleExplicit: boolean;
	readonly createdAt: number;
	anchorLeafId: string;
	readonly model: BtwThreadModelRef;
	conversation: EphemeralConversation;
	phase: BtwThreadPhase;
	error: string | undefined;
	draft: string;
	draftImages: ImageContent[];
	draftImageLinks: (string | undefined)[];
	readThrough: number;
	request: BtwThreadRequest | undefined;
	abortController: AbortController | undefined;

	constructor(options: BtwThreadOptions) {
		this.key = options.key;
		this.title = options.title;
		this.titleExplicit = options.titleExplicit ?? false;
		this.createdAt = options.createdAt;
		this.anchorLeafId = options.anchorLeafId;
		this.model = options.model;
		this.conversation = options.conversation;
		this.phase = options.phase ?? "ready";
		this.error = options.error;
		this.draft = options.draft ?? "";
		this.draftImages = options.draftImages ?? [];
		this.draftImageLinks = options.draftImageLinks ?? [];
		this.readThrough = Math.min(options.readThrough ?? 0, options.conversation.turns.length);
	}

	get turns() {
		return this.conversation.turns;
	}

	get unread(): number {
		return Math.max(0, this.turns.length - this.readThrough);
	}
}

/** Owns every durable BTW thread in creation order. */
export class BtwManager {
	readonly #appendEvent: BtwManagerOptions["appendEvent"];
	readonly #flushEvents: BtwManagerOptions["flushEvents"];
	readonly #closeEvents: BtwManagerOptions["closeEvents"];
	readonly #removeSession: BtwManagerOptions["removeSession"];
	readonly #createConversation: BtwManagerOptions["createConversation"];
	readonly #createSideOptions: BtwManagerOptions["createSideOptions"];
	readonly #generateTitle: BtwManagerOptions["generateTitle"];
	readonly #nextKey: BtwManagerOptions["nextKey"];
	readonly #now: BtwManagerOptions["now"];
	readonly #onChange: BtwManagerOptions["onChange"];
	readonly #threads = new Map<string, BtwThread>();
	readonly #childKeys: string[] = [];
	readonly #preparedPromotions = new Set<string>();
	readonly #dirtyDrafts = new Set<string>();
	#activeKey: string | undefined;
	readonly #subscriptions = new Map<string, () => void>();

	constructor(options: BtwManagerOptions) {
		this.#appendEvent = options.appendEvent;
		this.#flushEvents = options.flushEvents;
		this.#closeEvents = options.closeEvents;
		this.#removeSession = options.removeSession;
		this.#createConversation = options.createConversation;
		this.#createSideOptions = options.createSideOptions;
		this.#generateTitle = options.generateTitle;
		this.#nextKey = options.nextKey;
		this.#now = options.now;
		this.#onChange = options.onChange;
		for (const restored of options.restoredThreads) this.#restore(restored);
		this.#activeKey = this.#childKeys[0];
	}

	get children(): readonly BtwThread[] {
		return this.#childKeys.flatMap(key => {
			const thread = this.#threads.get(key);
			return thread ? [thread] : [];
		});
	}

	get activeKey(): string | undefined {
		return this.#activeKey;
	}

	thread(key: string): BtwThread | undefined {
		return this.#threads.get(key);
	}

	async session(key: string): Promise<AgentSession> {
		const thread = this.#threads.get(key);
		if (!thread) throw new Error(`Unknown BTW thread: ${key}`);
		await thread.conversation.initializeExtensionRuntime();
		const session = thread.conversation.session;
		if (!session) throw new Error(`BTW thread has no initialized session: ${key}`);
		if (!this.#subscriptions.has(key)) {
			const unsubscribe = session.subscribe(event => {
				if (this.#threads.get(key) !== thread || thread.conversation.session !== session) return;
				if (event.type === "message_end" && event.message.role === "user" && thread.request) {
					thread.request.userMessage ??= event.message;
				}
				if (event.type === "agent_start") {
					thread.phase = "running";
					thread.error = undefined;
				} else if (event.type === "agent_end") {
					thread.error = session.agent.state.error;
					thread.phase = thread.error ? "error" : "ready";
					if (!thread.request) {
						this.#appendEvent({ version: 1, key, op: "terminal", error: thread.error });
					}
				}
				this.#onChange?.();
			});
			const detachEntries = session.sessionManager.subscribeToEntries(() => {
				if (this.#threads.get(key) === thread && thread.conversation.session === session) this.#onChange?.();
			});
			this.#subscriptions.set(key, () => {
				unsubscribe();
				detachEntries();
			});
		}
		return session;
	}

	/**
	 * Create a durable child thread directly, journaling it before any turn runs.
	 * The first prompt is driven by the caller via {@link prompt}.
	 */
	createChild(input: string, anchorLeafId: string, model: BtwThreadModelRef, title?: string): string {
		const key = this.#nextKey();
		const threadTitle =
			title ||
			input
				.replace(/[\r\n\t ]+/g, " ")
				.trim()
				.slice(0, 60) ||
			"BTW";
		const thread = new BtwThread({
			key,
			title: threadTitle,
			titleExplicit: Boolean(title),
			createdAt: this.#now(),
			anchorLeafId,
			model,
			conversation: this.#createConversation(model, undefined, this.#createSideOptions?.(key)),
		});
		thread.conversation.freeze();
		this.#threads.set(key, thread);
		this.#childKeys.push(key);
		this.#activeKey = key;
		this.#appendEvent(this.#createEvent(thread));
		this.#onChange?.();
		return key;
	}

	select(key: string): boolean {
		const thread = this.#threads.get(key);
		if (!thread) return false;
		this.#activeKey = key;
		this.#onChange?.();
		return true;
	}

	setDraft(key: string, text: string, images?: ImageContent[], imageLinks?: (string | undefined)[]): boolean {
		const thread = this.#threads.get(key);
		if (!thread) return false;
		const imagesChanged =
			thread.draftImages.length !== (images?.length ?? 0) ||
			thread.draftImages.some((image, index) => image !== images?.[index]);
		const linksChanged =
			thread.draftImageLinks.length !== (imageLinks?.length ?? 0) ||
			thread.draftImageLinks.some((link, index) => link !== imageLinks?.[index]);
		if (thread.draft === text && !imagesChanged && !linksChanged) return false;
		thread.draft = text;
		if (imagesChanged) thread.draftImages = images ? [...images] : [];
		if (linksChanged) thread.draftImageLinks = imageLinks ? [...imageLinks] : [];
		this.#dirtyDrafts.add(key);
		this.#onChange?.();
		return true;
	}

	persistDraft(key: string): boolean {
		const thread = this.#threads.get(key);
		if (!thread || !this.#dirtyDrafts.has(key)) return false;
		this.#appendEvent({
			version: 1,
			op: "draft",
			key,
			text: thread.draft,
			images: thread.draftImages.length ? thread.draftImages : undefined,
			imageLinks: thread.draftImageLinks.length ? thread.draftImageLinks : undefined,
		});
		this.#dirtyDrafts.delete(key);
		return true;
	}

	markRead(key: string): boolean {
		const thread = this.#threads.get(key);
		if (!thread || thread.readThrough === thread.turns.length) return false;
		thread.readThrough = thread.turns.length;
		this.#appendEvent({ version: 1, op: "read", key, through: thread.readThrough });
		this.#onChange?.();
		return true;
	}

	preparePromotion(key: string): boolean {
		const thread = this.#threads.get(key);
		if (!thread || thread.phase === "running" || this.#preparedPromotions.has(key)) {
			return false;
		}
		this.#appendEvent({ version: 1, op: "remove", key, reason: "promoted" });
		this.#preparedPromotions.add(key);
		return true;
	}

	rollbackPromotion(key: string): boolean {
		const thread = this.#threads.get(key);
		if (!thread || !this.#preparedPromotions.delete(key)) return false;
		this.#appendEvent(this.#createEvent(thread));
		if (thread.draft || thread.draftImages.length || thread.draftImageLinks.length) this.#dirtyDrafts.add(key);
		this.persistDraft(key);
		return true;
	}

	async completePromotion(key: string): Promise<boolean> {
		if (!this.#preparedPromotions.delete(key)) return false;
		this.#subscriptions.get(key)?.();
		this.#subscriptions.delete(key);
		await this.#threads.get(key)?.conversation.disposeExtensionRuntime();
		await this.#removeSession?.(key);
		return this.#forget(key);
	}

	async remove(key: string, reason: "deleted" | "promoted"): Promise<boolean> {
		const thread = this.#threads.get(key);
		if (!thread) return false;
		const abortController = thread.abortController;
		thread.request = undefined;
		thread.abortController = undefined;
		abortController?.abort();
		if (!this.#preparedPromotions.has(key)) {
			this.#appendEvent({ version: 1, op: "remove", key, reason });
		}
		await this.#flushEvents?.();
		this.#subscriptions.get(key)?.();
		this.#subscriptions.delete(key);
		try {
			await thread.conversation.disposeExtensionRuntime();
			await this.#removeSession?.(key);
		} catch (error) {
			thread.conversation = this.#createConversation(thread.model, undefined, this.#createSideOptions?.(key));
			thread.conversation.freeze();
			thread.phase = "ready";
			thread.error = undefined;
			this.#onChange?.();
			throw error;
		}
		this.#preparedPromotions.delete(key);
		return this.#forget(key);
	}

	/** Stop only this thread's current work, without creating or disposing its runtime. */
	async abort(key: string): Promise<void> {
		const thread = this.#threads.get(key);
		if (!thread) throw new Error(`Unknown BTW thread: ${key}`);
		const request = thread.request;
		if (request && thread.abortController) {
			thread.abortController.abort(USER_INTERRUPT_LABEL);
			await request.settled.promise;
		} else {
			await thread.conversation.session?.abort({ reason: USER_INTERRUPT_LABEL });
		}
		this.#onChange?.();
	}

	async prompt(
		key: string,
		input: string,
		onTextDelta?: (delta: string) => void,
		onThinkingDelta?: (delta: string) => void,
		images?: ImageContent[],
		streamingBehavior: "steer" | "followUp" = "steer",
		onPromptAdmitted?: () => void,
	): Promise<EphemeralTurnResult | undefined> {
		const thread = this.#threads.get(key);
		if (!thread) throw new Error(`Unknown BTW thread: ${key}`);
		if (readAgentsPaused(thread.conversation.sessionManager.getBranch())) {
			throw new Error("BTW thread is paused; run /continue before sending another message");
		}
		if (thread.phase === "running" || thread.conversation.isRunning) {
			await thread.request?.admission.promise;
			const session = await this.session(key);
			await session.prompt(input, {
				images,
				streamingBehavior,
				expandPromptTemplates: true,
				runCommands: false,
				onPromptAdmitted,
			});
			this.setDraft(key, "");
			this.persistDraft(key);
			this.#onChange?.();
			return undefined;
		}
		const trimmed = input.trim();
		if (!trimmed && !images?.length) throw new Error("BTW input must not be empty");
		const requestImages = images?.length ? [...images] : undefined;
		if (!thread.titleExplicit && thread.turns.length === 0 && trimmed) void this.#nameThread(thread, trimmed);
		this.setDraft(key, "");
		this.persistDraft(key);
		const admission = Promise.withResolvers<void>();
		void admission.promise.catch(() => {});
		const request: BtwThreadRequest = {
			input: trimmed,
			images: requestImages,
			messages: [],
			streamMessage: undefined,
			timestamp: this.#now(),
			admission,
			settled: Promise.withResolvers<void>(),
		};
		return this.#runRequest(thread, request, onTextDelta, onThinkingDelta, onPromptAdmitted);
	}

	async #runRequest(
		thread: BtwThread,
		request: BtwThreadRequest,
		onTextDelta?: (delta: string) => void,
		onThinkingDelta?: (delta: string) => void,
		onPromptAdmitted?: () => void,
	): Promise<EphemeralTurnResult | undefined> {
		const key = thread.key;
		const abortController = new AbortController();
		thread.request = request;
		thread.abortController = abortController;
		thread.phase = "running";
		thread.error = undefined;
		this.#appendEvent({
			version: 1,
			op: "request",
			key,
			input: request.input,
			images: request.images,
			timestamp: request.timestamp,
		});
		this.#onChange?.();
		try {
			await this.#flushEvents?.();
			await this.session(key);
			const result = await thread.conversation.prompt(request.input, {
				images: request.images,
				dedupeReply: false,
				signal: abortController.signal,
				expandPromptTemplates: true,
				onPromptAdmitted: () => {
					request.admission.resolve();
					onPromptAdmitted?.();
				},
				onTextDelta: delta => {
					if (thread.request !== request) return;
					onTextDelta?.(delta);
				},
				onThinkingDelta: delta => {
					if (thread.request !== request) return;
					onThinkingDelta?.(delta);
				},
				onMessage: event => {
					if (thread.request !== request) return;
					if (event.type === "update") {
						request.streamMessage = event.message;
					} else {
						request.streamMessage = undefined;
						request.messages.push(event.message);
					}
					this.#onChange?.();
				},
			});
			if (thread.request !== request) return result;
			thread.phase = "ready";
			thread.error = undefined;
			const turn = thread.turns.at(-1);
			if (turn) this.#appendEvent({ version: 1, op: "turn", key, turn });
			await this.#flushEvents?.();
			return result;
		} catch (error) {
			request.admission.reject(error);
			if (abortController.signal.reason === PAUSE_SHUTDOWN_ABORT_REASON) return undefined;
			if (thread.request !== request) throw error;
			const aborted = abortController.signal.aborted;
			thread.phase = aborted ? "ready" : "error";
			thread.error = aborted ? undefined : error instanceof Error ? error.message : String(error);
			this.#appendEvent({ version: 1, op: "terminal", key, error: thread.error });
			await this.#flushEvents?.();
			throw error;
		} finally {
			if (thread.request === request) {
				thread.request = undefined;
				thread.abortController = undefined;
				this.#onChange?.();
			}
			request.settled.resolve();
		}
	}

	async #nameThread(thread: BtwThread, input: string): Promise<void> {
		let title: string | null | undefined;
		try {
			title = await this.#generateTitle?.(input);
		} catch (error) {
			logger.warn("BTW thread title generation failed", { error: String(error) });
			return;
		}
		if (!title || this.#threads.get(thread.key) !== thread) return;
		thread.title = title;
		this.#appendEvent({ version: 1, op: "title", key: thread.key, title });
		this.#onChange?.();
	}

	prepareForPausedExit(): void {
		for (const thread of this.#threads.values()) {
			this.persistDraft(thread.key);
			if (thread.phase !== "running") continue;
			const session = thread.conversation.session;
			const request = thread.request;
			const pendingPrompt =
				request && (!request.userMessage || !session?.isMessageRecorded(request.userMessage))
					? { text: request.input, images: request.images, attribution: "agent" as const }
					: undefined;
			if (session) {
				session.recordAgentsPaused([MAIN_AGENT_ID], pendingPrompt);
			} else {
				const manager = thread.conversation.sessionManager;
				manager.appendCustomEntry(AGENTS_PAUSED_CUSTOM_TYPE, {
					pausedAt: new Date().toISOString(),
					agentIds: [MAIN_AGENT_ID],
					pendingPrompt,
				});
				manager.flushSync();
			}
			request?.admission.reject(PAUSE_SHUTDOWN_ABORT_REASON);
			thread.request = undefined;
			thread.abortController?.abort(PAUSE_SHUTDOWN_ABORT_REASON);
			thread.abortController = undefined;
			thread.phase = "ready";
		}
		this.#onChange?.();
	}

	async continuePaused(): Promise<ContinuePausedAgentsResult> {
		const skipped: string[] = [];
		let continued = 0;
		let complete = true;
		await Promise.all(
			this.children.map(async thread => {
				try {
					const session = await this.session(thread.key);
					if (!session.hasPausedAgents()) return;
					const result = await session.continuePausedAgents();
					continued += result.continued;
					skipped.push(...result.skipped.map(detail => `${thread.title}: ${detail}`));
					complete &&= result.complete;
				} catch (error) {
					thread.phase = "error";
					thread.error = error instanceof Error ? error.message : String(error);
					skipped.push(`${thread.title}: ${thread.error}`);
					complete = false;
				} finally {
					this.#onChange?.();
				}
			}),
		);
		return { continued, skipped, complete };
	}

	flushEvents(): Promise<void> {
		for (const thread of this.#threads.values()) this.persistDraft(thread.key);
		return this.#flushEvents?.() ?? Promise.resolve();
	}

	async dispose(): Promise<void> {
		this.prepareForPausedExit();
		try {
			await this.#flushEvents?.();
		} finally {
			try {
				for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
				this.#subscriptions.clear();
				await Promise.all([...this.#threads.values()].map(thread => thread.conversation.disposeExtensionRuntime()));
			} finally {
				await this.#closeEvents?.();
			}
		}
	}

	/** Stop old-session work after a successful session transition without writing into the new session. */
	async abandon(): Promise<void> {
		this.prepareForPausedExit();
		const threads = [...this.#threads.values()];
		for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
		this.#subscriptions.clear();
		for (const thread of threads) {
			thread.request = undefined;
			thread.abortController?.abort();
			thread.abortController = undefined;
		}
		this.#threads.clear();
		this.#childKeys.length = 0;
		this.#preparedPromotions.clear();
		this.#dirtyDrafts.clear();
		this.#activeKey = undefined;
		try {
			await Promise.all(threads.map(thread => thread.conversation.disposeExtensionRuntime()));
		} finally {
			await this.#closeEvents?.();
		}
	}

	#createEvent(thread: BtwThread): Extract<BtwThreadEvent, { op: "create" }> {
		const checkpoint = thread.conversation.checkpoint();
		return {
			version: 1,
			op: "create",
			key: thread.key,
			title: thread.title,
			...(thread.titleExplicit ? { titleExplicit: true } : {}),
			createdAt: thread.createdAt,
			anchorLeafId: thread.anchorLeafId,
			model: thread.model,
			sideSessionId: checkpoint.sideSessionId,
			baseMessages: checkpoint.baseMessages,
			turns: checkpoint.turns,
		};
	}

	#forget(key: string): boolean {
		if (!this.#threads.delete(key)) return false;
		this.#subscriptions.get(key)?.();
		this.#subscriptions.delete(key);
		this.#dirtyDrafts.delete(key);
		const childIndex = this.#childKeys.indexOf(key);
		if (childIndex >= 0) this.#childKeys.splice(childIndex, 1);
		if (this.#activeKey === key) {
			this.#activeKey = this.#childKeys.at(Math.min(childIndex, this.#childKeys.length - 1));
		}
		this.#onChange?.();
		return true;
	}

	#restore(restored: RestoredBtwThread): void {
		const checkpoint: EphemeralConversationCheckpoint = {
			baseMessages: restored.baseMessages,
			turns: restored.turns,
			sideSessionId: restored.sideSessionId,
		};
		const thread = new BtwThread({
			key: restored.key,
			title: restored.title,
			titleExplicit: restored.titleExplicit,
			createdAt: restored.createdAt,
			anchorLeafId: restored.anchorLeafId,
			model: restored.model,
			conversation: this.#createConversation(restored.model, checkpoint, this.#createSideOptions?.(restored.key)),
			phase: restored.phase,
			error: restored.error,
			draft: restored.draft,
			draftImages: restored.draftImages,
			draftImageLinks: restored.draftImageLinks,
			readThrough: restored.readThrough,
		});
		this.#threads.set(thread.key, thread);
		this.#childKeys.push(thread.key);
	}
}
