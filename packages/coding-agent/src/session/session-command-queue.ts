import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentViewSession } from "./agent-session-handle";
import type { CompactMode } from "./compact-modes";
import { continuesConversation, type ConversationPosition } from "../modes/utils/conversation-position";

export interface CompactionQueuedMessage {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
}

export interface YieldCompaction extends ConversationPosition {
	text: string;
	instructions?: string;
	mode?: CompactMode;
}

interface CommandQueueHost {
	/** Host submission dispatch may precede admission into AgentSession. */
	settleSubmissions(): Promise<void>;
	isCurrent(): boolean;
	hasPendingSubmission(): boolean;
	restore(): void;
	changed(): void;
	execute(request: YieldCompaction): Promise<void>;
	flush(): Promise<void>;
	alreadyCompacting?(): void;
}

/** One deferred-command barrier per standard session, shared by Main and side views. */
export class SessionCommandQueue {
	request: YieldCompaction | undefined;
	messages: CompactionQueuedMessage[] = [];
	origin: ConversationPosition | undefined;
	#watcher: Promise<void> | undefined;
	#flushing: Promise<void> | undefined;

	get isRunning(): boolean {
		return this.#watcher !== undefined;
	}

	get isFlushing(): boolean {
		return this.#flushing !== undefined;
	}

	flush(operation: () => Promise<void>): Promise<void> {
		this.#flushing ??= Promise.resolve()
			.then(operation)
			.finally(() => {
				this.#flushing = undefined;
			});
		return this.#flushing;
	}

	drain(
		session: AgentViewSession,
		host: {
			execute(message: CompactionQueuedMessage): Promise<void>;
			restore(): void;
			changed(): void;
		},
	): Promise<void> {
		return this.flush(async () => {
			if (this.request) return;
			if (this.origin && !continuesConversation(session.sessionManager, this.origin)) {
				host.restore();
				return;
			}
			this.origin = undefined;
			while (this.messages.length && !this.request && !session.isCompacting) {
				const message = this.messages[0]!;
				await host.execute(message);
				const index = this.messages.indexOf(message);
				if (index >= 0) this.messages.splice(index, 1);
			}
			host.changed();
		});
	}

	run(session: AgentViewSession, host: CommandQueueHost): Promise<void> {
		this.#watcher ??= this.#watch(session, host).finally(() => {
			this.#watcher = undefined;
		});
		return this.#watcher;
	}

	async #watch(session: AgentViewSession, host: CommandQueueHost): Promise<void> {
		let request = this.request;
		let withdrawn = false;
		if (!request) return;
		while (true) {
			await session.waitForIdle();
			await host.settleSubmissions();
			await session.waitForAdmittedSubmissions();
			if (session.isSessionTransitioning) await session.waitForSessionTransition();
			if (session.hasPendingAsyncWork()) await session.settleAsyncWork();
			if (!host.isCurrent()) return;
			if (this.request !== request) {
				if (!this.request) {
					if (this.messages.length === 0) return;
					// Held input keeps the withdrawn barrier's branch binding.
					withdrawn = true;
					break;
				}
				request = this.request;
				continue;
			}
			if (
				!session.isStreaming &&
				!session.isRetrying &&
				!session.isSessionTransitioning &&
				!session.hasAdmittedSubmission &&
				!session.hasPendingAsyncWork() &&
				session.queuedMessageCount === 0 &&
				!host.hasPendingSubmission()
			)
				break;
			await Bun.sleep(10);
		}
		if (!continuesConversation(session.sessionManager, request)) {
			host.restore();
			return;
		}
		this.request = undefined;
		this.origin = { sessionId: request.sessionId, leafId: request.leafId };
		host.changed();
		if (session.isCompacting) {
			host.alreadyCompacting?.();
			while (session.isCompacting) await Bun.sleep(10);
			await host.flush();
			if (this.request) await this.#watch(session, host);
			return;
		}
		if (withdrawn) await host.flush();
		else await host.execute(request);
		if (this.request) await this.#watch(session, host);
	}
}

const queues = new WeakMap<AgentViewSession, SessionCommandQueue>();

export function sessionCommandQueue(session: AgentViewSession): SessionCommandQueue {
	let queue = queues.get(session);
	if (!queue) {
		queue = new SessionCommandQueue();
		queues.set(session, queue);
	}
	return queue;
}
