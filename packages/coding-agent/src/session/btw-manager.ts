import { type AgentMessage, PAUSE_SHUTDOWN_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import type { ContinuePausedAgentsResult } from "./agent-session-types";
import {
	type BtwPausedRequest,
	type BtwThreadEvent,
	type BtwThreadModelRef,
	type RestoredBtwThread,
	restoreBtwThreads,
} from "./btw-thread";
import type {
	EphemeralConversation,
	EphemeralConversationCheckpoint,
	EphemeralConversationSideOptions,
	EphemeralTurnResult,
} from "./ephemeral-conversation";
import type { BtwSummarySource } from "./messages";
import type { SessionEntry } from "./session-entries";

export type BtwThreadKind = "quick" | "child";
export type BtwThreadPhase = "ready" | "running" | "error";

export interface BtwThreadRequest {
	input: string;
	messages: AgentMessage[];
	streamMessage: Extract<AgentMessage, { role: "assistant" }> | undefined;
	timestamp: number;
}

export interface BtwManagerOptions {
	entries: Iterable<SessionEntry>;
	appendEvent: (event: BtwThreadEvent) => void;
	createConversation: (
		model: BtwThreadModelRef,
		checkpoint: EphemeralConversationCheckpoint | undefined,
		sideOptions?: EphemeralConversationSideOptions,
	) => EphemeralConversation;
	/** Builds durable side capabilities bound to the source BTW thread. */
	createSideOptions?: (source: BtwSummarySource) => EphemeralConversationSideOptions;
	nextKey: () => string;
	now: () => number;
	onChange?: () => void;
}

interface BtwThreadOptions {
	key: string;
	kind: BtwThreadKind;
	title: string;
	createdAt: number;
	anchorLeafId: string;
	model: BtwThreadModelRef;
	conversation: EphemeralConversation;
	phase?: BtwThreadPhase;
	error?: string;
	draft?: string;
	readThrough?: number;
	pausedRequest?: BtwPausedRequest;
}

export class BtwThread {
	readonly key: string;
	readonly title: string;
	readonly createdAt: number;
	anchorLeafId: string;
	readonly model: BtwThreadModelRef;
	conversation: EphemeralConversation;
	kind: BtwThreadKind;
	phase: BtwThreadPhase;
	error: string | undefined;
	draft: string;
	persistedDraft: string;
	readThrough: number;
	request: BtwThreadRequest | undefined;
	abortController: AbortController | undefined;
	pausedRequest: BtwPausedRequest | undefined;

	constructor(options: BtwThreadOptions) {
		this.key = options.key;
		this.kind = options.kind;
		this.title = options.title;
		this.createdAt = options.createdAt;
		this.anchorLeafId = options.anchorLeafId;
		this.model = options.model;
		this.conversation = options.conversation;
		this.phase = options.phase ?? "ready";
		this.error = options.error;
		this.draft = options.draft ?? "";
		this.persistedDraft = this.draft;
		this.readThrough = Math.min(options.readThrough ?? 0, options.conversation.turns.length);
		this.pausedRequest = options.pausedRequest;
	}

	get turns() {
		return this.conversation.turns;
	}

	get unread(): number {
		return Math.max(0, this.turns.length - this.readThrough);
	}
}

/** Owns the singleton QuickAsk slot and every durable BTW child in creation order. */
export class BtwManager {
	readonly #appendEvent: BtwManagerOptions["appendEvent"];
	readonly #createConversation: BtwManagerOptions["createConversation"];
	readonly #createSideOptions: BtwManagerOptions["createSideOptions"];
	readonly #nextKey: BtwManagerOptions["nextKey"];
	readonly #now: BtwManagerOptions["now"];
	readonly #onChange: BtwManagerOptions["onChange"];
	readonly #threads = new Map<string, BtwThread>();
	readonly #childKeys: string[] = [];
	readonly #preparedPromotions = new Set<string>();
	#quickKey: string | undefined;
	#activeKey: string | undefined;

	constructor(options: BtwManagerOptions) {
		this.#appendEvent = options.appendEvent;
		this.#createConversation = options.createConversation;
		this.#createSideOptions = options.createSideOptions;
		this.#nextKey = options.nextKey;
		this.#now = options.now;
		this.#onChange = options.onChange;
		for (const restored of restoreBtwThreads(options.entries)) this.#restore(restored);
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

	get quickKey(): string | undefined {
		return this.#quickKey;
	}

	thread(key: string): BtwThread | undefined {
		return this.#threads.get(key);
	}

	createQuick(question: string, anchorLeafId: string, model: BtwThreadModelRef): string {
		if (this.#quickKey) {
			const previous = this.#threads.get(this.#quickKey);
			previous?.abortController?.abort();
			this.#threads.delete(this.#quickKey);
		}
		const key = this.#nextKey();
		const title =
			question
				.replace(/[\r\n\t ]+/g, " ")
				.trim()
				.slice(0, 60) || "BTW";
		const thread = new BtwThread({
			key,
			kind: "quick",
			title,
			createdAt: this.#now(),
			anchorLeafId,
			model,
			conversation: this.#createConversation(model, undefined),
		});
		this.#threads.set(key, thread);
		this.#quickKey = key;
		this.#onChange?.();
		return key;
	}

	continueQuick(key: string): boolean {
		const thread = this.#threads.get(key);
		if (thread?.kind !== "quick" || thread.phase !== "ready" || thread.turns.length === 0) return false;
		const sideOptions = this.#createSideOptions?.({ threadKey: thread.key, threadTitle: thread.title });
		if (sideOptions) {
			const checkpoint = thread.conversation.checkpoint();
			thread.conversation = this.#createConversation(thread.model, checkpoint, sideOptions);
		}
		thread.kind = "child";
		this.#quickKey = undefined;
		this.#childKeys.push(key);
		this.#activeKey = key;
		this.#appendEvent(this.#createEvent(thread));
		this.#onChange?.();
		return true;
	}

	/**
	 * Create a durable child thread directly, journaling it before any turn runs.
	 * The first prompt is driven by the caller via {@link prompt}.
	 */
	createChild(input: string, anchorLeafId: string, model: BtwThreadModelRef): string {
		const key = this.#nextKey();
		const title =
			input
				.replace(/[\r\n\t ]+/g, " ")
				.trim()
				.slice(0, 60) || "BTW";
		const thread = new BtwThread({
			key,
			kind: "child",
			title,
			createdAt: this.#now(),
			anchorLeafId,
			model,
			conversation: this.#createConversation(
				model,
				undefined,
				this.#createSideOptions?.({ threadKey: key, threadTitle: title }),
			),
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
		if (thread?.kind !== "child") return false;
		this.#activeKey = key;
		this.#onChange?.();
		return true;
	}

	setDraft(key: string, text: string): boolean {
		const thread = this.#threads.get(key);
		if (!thread || thread.draft === text) return false;
		thread.draft = text;
		this.#onChange?.();
		return true;
	}

	persistDraft(key: string): boolean {
		const thread = this.#threads.get(key);
		if (thread?.kind !== "child" || thread.persistedDraft === thread.draft) return false;
		this.#appendEvent({ version: 1, op: "draft", key, text: thread.draft });
		thread.persistedDraft = thread.draft;
		return true;
	}

	markRead(key: string): boolean {
		const thread = this.#threads.get(key);
		if (thread?.kind !== "child" || thread.readThrough === thread.turns.length) return false;
		thread.readThrough = thread.turns.length;
		this.#appendEvent({ version: 1, op: "read", key, through: thread.readThrough });
		this.#onChange?.();
		return true;
	}

	preparePromotion(key: string): boolean {
		const thread = this.#threads.get(key);
		if (thread?.kind !== "child" || thread.phase === "running" || this.#preparedPromotions.has(key)) {
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
		return true;
	}

	completePromotion(key: string): boolean {
		if (!this.#preparedPromotions.delete(key)) return false;
		return this.#forget(key);
	}

	remove(key: string, reason: "deleted" | "promoted"): boolean {
		const thread = this.#threads.get(key);
		if (!thread) return false;
		const abortController = thread.abortController;
		thread.request = undefined;
		thread.abortController = undefined;
		abortController?.abort();
		if (thread.kind === "child" && !this.#preparedPromotions.has(key)) {
			this.#appendEvent({ version: 1, op: "remove", key, reason });
		}
		this.#preparedPromotions.delete(key);
		return this.#forget(key);
	}

	async prompt(
		key: string,
		input: string,
		onTextDelta?: (delta: string) => void,
		onThinkingDelta?: (delta: string) => void,
	): Promise<EphemeralTurnResult> {
		const thread = this.#threads.get(key);
		if (!thread) throw new Error(`Unknown BTW thread: ${key}`);
		if (thread.pausedRequest) throw new Error("BTW thread is paused; run /continue before sending another message");
		if (thread.phase === "running") throw new Error("BTW thread already has a reply in progress");
		const trimmed = input.trim();
		if (!trimmed) throw new Error("BTW input must not be empty");
		if (thread.kind === "child" && (thread.draft || thread.persistedDraft)) {
			thread.draft = "";
			this.persistDraft(key);
		}
		const request: BtwThreadRequest = {
			input: trimmed,
			messages: [],
			streamMessage: undefined,
			timestamp: this.#now(),
		};
		const abortController = new AbortController();
		thread.request = request;
		thread.abortController = abortController;
		thread.phase = "running";
		thread.error = undefined;
		if (thread.kind === "child") {
			this.#appendEvent({
				version: 1,
				op: "request",
				key,
				input: request.input,
				timestamp: request.timestamp,
			});
		}
		this.#onChange?.();
		try {
			const result = await thread.conversation.prompt(trimmed, {
				dedupeReply: false,
				signal: abortController.signal,
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
			if (thread.kind === "child") {
				const turn = thread.turns.at(-1);
				if (turn) this.#appendEvent({ version: 1, op: "turn", key, turn });
			}
			return result;
		} catch (error) {
			if (thread.request !== request) throw error;
			const aborted = abortController.signal.aborted;
			thread.phase = aborted ? "ready" : "error";
			thread.error = aborted ? undefined : error instanceof Error ? error.message : String(error);
			if (thread.kind === "child") {
				this.#appendEvent({ version: 1, op: "terminal", key, error: thread.error });
			}
			throw error;
		} finally {
			if (thread.request === request) {
				thread.request = undefined;
				thread.abortController = undefined;
				this.#onChange?.();
			}
		}
	}

	prepareForPausedExit(): void {
		let changed = false;
		for (const thread of this.#threads.values()) {
			if (thread.kind !== "child" || !thread.request) continue;
			thread.pausedRequest = {
				input: thread.request.input,
				timestamp: thread.request.timestamp,
			};
			const abortController = thread.abortController;
			thread.request = undefined;
			thread.abortController = undefined;
			thread.phase = "ready";
			abortController?.abort(PAUSE_SHUTDOWN_ABORT_REASON);
			changed = true;
		}
		if (changed) this.#onChange?.();
	}

	async continuePaused(): Promise<ContinuePausedAgentsResult> {
		const paused = this.children.filter(thread => thread.pausedRequest !== undefined);
		const skipped: string[] = [];
		let continued = 0;
		await Promise.all(
			paused.map(async thread => {
				const request = thread.pausedRequest;
				if (!request) return;
				thread.pausedRequest = undefined;
				try {
					await this.prompt(thread.key, request.input);
					continued++;
				} catch (error) {
					thread.pausedRequest = request;
					thread.phase = "ready";
					thread.error = error instanceof Error ? error.message : String(error);
					this.#appendEvent({
						version: 1,
						op: "request",
						key: thread.key,
						input: request.input,
						timestamp: request.timestamp,
					});
					skipped.push(`${thread.title}: ${thread.error}`);
					this.#onChange?.();
				}
			}),
		);
		return { continued, skipped, complete: skipped.length === 0 };
	}

	dispose(): void {
		for (const thread of this.#threads.values()) {
			if (thread.kind === "child") this.persistDraft(thread.key);
			const abortController = thread.abortController;
			thread.request = undefined;
			thread.abortController = undefined;
			abortController?.abort();
		}
	}

	/** Stop old-session work after a successful session transition without writing into the new session. */
	abandon(): void {
		for (const thread of this.#threads.values()) {
			thread.request = undefined;
			thread.abortController?.abort();
			thread.abortController = undefined;
		}
		this.#threads.clear();
		this.#childKeys.length = 0;
		this.#preparedPromotions.clear();
		this.#quickKey = undefined;
		this.#activeKey = undefined;
	}

	#createEvent(thread: BtwThread): Extract<BtwThreadEvent, { op: "create" }> {
		const checkpoint = thread.conversation.checkpoint();
		return {
			version: 1,
			op: "create",
			key: thread.key,
			title: thread.title,
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
		const childIndex = this.#childKeys.indexOf(key);
		if (childIndex >= 0) this.#childKeys.splice(childIndex, 1);
		if (this.#quickKey === key) this.#quickKey = undefined;
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
			kind: "child",
			title: restored.title,
			createdAt: restored.createdAt,
			anchorLeafId: restored.anchorLeafId,
			model: restored.model,
			conversation: this.#createConversation(
				restored.model,
				checkpoint,
				this.#createSideOptions?.({ threadKey: restored.key, threadTitle: restored.title }),
			),
			phase: restored.phase,
			error: restored.error,
			draft: restored.draft,
			pausedRequest: restored.pausedRequest,
			readThrough: restored.readThrough,
		});
		this.#threads.set(thread.key, thread);
		this.#childKeys.push(thread.key);
	}
}
