import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type ConversationPosition, continuesConversation } from "../modes/utils/conversation-position";
import type { AgentViewSession } from "./agent-session-handle";
import type { RestoredQueuedInput, RestoredQueuedMessage } from "./agent-session-types";
import type { CompactMode } from "./compact-modes";

export interface CompactionQueuedMessage {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
}

/** The request belongs to a particular conversation, not whichever branch the view shows next. */
export interface YieldCompaction extends ConversationPosition {
	text: string;
	instructions?: string;
	mode?: CompactMode;
}

export function queueEntriesForDraft(
	{ steering, followUp }: RestoredQueuedInput,
	{ request, messages }: Pick<SessionCommandQueue, "request" | "messages">,
): (RestoredQueuedMessage & { imageLinks?: (string | undefined)[] })[] {
	return [
		...steering,
		...messages.filter(message => message.mode === "steer"),
		...followUp,
		...(request ? [{ text: request.text }] : []),
		...messages.filter(message => message.mode === "followUp"),
	];
}

interface CommandQueueHost {
	settleSubmissions(): Promise<void>;
	hasPendingSubmission(): boolean;
	/** Whether the captured session can still be served, independent of pane focus. */
	isCurrent(): boolean;
	restore(): void;
	changed(): void;
	/** Main can release the barrier just before its existing before-flush hook returns. */
	execute(request: YieldCompaction, release: () => void): Promise<void>;
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
	#executing = false;
	readonly #submissions = new Set<Promise<void>>();

	get isRunning(): boolean {
		return this.#watcher !== undefined;
	}

	get isFlushing(): boolean {
		return this.#flushing !== undefined;
	}

	get holdsInput(): boolean {
		return Boolean(this.request || this.#executing || this.isFlushing || (this.isRunning && this.messages.length));
	}

	/** Reserve work still in view-side preparation, until it reaches session admission. */
	trackSubmission(admission: Promise<void>): void {
		this.#submissions.add(admission);
		const remove = () => this.#submissions.delete(admission);
		void admission.then(remove, remove);
	}

	takeForRestore(): { request: YieldCompaction | undefined; messages: CompactionQueuedMessage[] } {
		const { request, messages } = this;
		this.request = undefined;
		this.messages = [];
		this.origin = undefined;
		return { request, messages };
	}

	/** An active request or another consumer's drain owns delivery. Reentrant flushes do not join it. */
	flush(operation: () => Promise<void>): Promise<void> {
		if (this.request || this.#executing || this.#flushing) return Promise.resolve();
		this.#flushing = Promise.resolve()
			.then(() => {
				if (!this.request && !this.#executing) return operation();
			})
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
			while (this.messages.length && !this.request && !session.isCompacting) {
				if (session.isSessionTransitioning) {
					await session.waitForSessionTransition();
					continue;
				}
				if (this.origin && !continuesConversation(session.sessionManager, this.origin)) {
					host.restore();
					return;
				}
				const message = this.messages[0]!;
				await host.execute(message);
				const index = this.messages.indexOf(message);
				if (index >= 0) this.messages.splice(index, 1);
			}
			if (this.messages.length === 0) this.origin = undefined;
			host.changed();
		});
	}

	run(session: AgentViewSession, host: CommandQueueHost): Promise<void> {
		if (!this.#watcher) {
			// Keep a worker mirror current even when the pane that queued the request loses focus.
			const detach = session.subscribe(() => {});
			this.#watcher = this.#watch(session, host).finally(() => {
				detach();
				this.#watcher = undefined;
			});
		}
		return this.#watcher;
	}

	async #watch(session: AgentViewSession, host: CommandQueueHost): Promise<void> {
		let request = this.request;
		if (!request) return;
		while (true) {
			await session.waitForIdle();
			await host.settleSubmissions();
			await Promise.allSettled(this.#submissions);
			await session.waitForAdmittedSubmissions();
			if (session.isSessionTransitioning) await session.waitForSessionTransition();
			await session.waitForRunEnd();
			await this.#flushing;
			if (!host.isCurrent()) return;
			if (this.request && this.request !== request) {
				request = this.request;
				continue;
			}
			if (!this.request && this.messages.length === 0) return;
			if (
				!session.isStreaming &&
				!session.isRetrying &&
				!session.isSessionTransitioning &&
				!session.hasAdmittedSubmission &&
				!session.isRunActive &&
				session.queuedMessageCount === 0 &&
				!host.hasPendingSubmission() &&
				this.#submissions.size === 0
			) {
				break;
			}
			await Bun.sleep(10);
		}
		if (!continuesConversation(session.sessionManager, request)) {
			host.restore();
			return;
		}
		const withdrawn = !this.request;
		this.request = undefined;
		this.origin = request;
		this.#executing = true;
		try {
			host.changed();
			if (session.isCompacting) {
				if (!withdrawn) host.alreadyCompacting?.();
				while (session.isCompacting) await Bun.sleep(10);
			} else if (!withdrawn) {
				await host.execute(request, () => {
					this.#executing = false;
				});
			}
			if (this.#executing) {
				this.#executing = false;
				if (host.isCurrent()) await host.flush();
			}
		} finally {
			this.#executing = false;
		}
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
