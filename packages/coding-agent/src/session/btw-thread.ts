import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { EphemeralConversationTurn } from "./ephemeral-conversation";
import type { SessionEntry } from "./session-entries";

export const BTW_THREAD_CUSTOM_TYPE = "btw-thread";
const BTW_THREAD_EVENT_VERSION = 1;

export interface BtwThreadModelRef {
	provider: string;
	id: string;
}

export interface BtwPromotionRequest {
	anchorLeafId: string;
	sessionId: string;
	turns: readonly EphemeralConversationTurn[];
}

export interface BtwPausedRequest {
	input: string;
	timestamp: number;
}

export interface BtwPromotionLifecycle {
	prepare(): void;
	rollback(): void;
}

interface BtwThreadEventBase {
	version: 1;
	key: string;
}

export type BtwThreadEvent =
	| (BtwThreadEventBase & {
			op: "create";
			title: string;
			createdAt: number;
			anchorLeafId: string;
			model: BtwThreadModelRef;
			sideSessionId: string;
			baseMessages: readonly AgentMessage[];
			turns: readonly EphemeralConversationTurn[];
	  })
	| (BtwThreadEventBase & { op: "turn"; turn: EphemeralConversationTurn })
	| (BtwThreadEventBase & { op: "draft"; text: string })
	| (BtwThreadEventBase & { op: "read"; through: number })
	| (BtwThreadEventBase & { op: "request"; input?: string; timestamp?: number })
	| (BtwThreadEventBase & { op: "terminal"; error?: string })
	| (BtwThreadEventBase & { op: "remove"; reason: "deleted" | "promoted" });

export interface RestoredBtwThread {
	key: string;
	title: string;
	createdAt: number;
	anchorLeafId: string;
	model: BtwThreadModelRef;
	sideSessionId: string;
	baseMessages: readonly AgentMessage[];
	turns: readonly EphemeralConversationTurn[];
	draft: string;
	readThrough: number;
	phase: "ready" | "error";
	error?: string;
	pausedRequest?: BtwPausedRequest;
}

interface MutableRestoredBtwThread {
	key: string;
	title: string;
	createdAt: number;
	anchorLeafId: string;
	model: BtwThreadModelRef;
	sideSessionId: string;
	baseMessages: readonly AgentMessage[];
	turns: EphemeralConversationTurn[];
	draft: string;
	readThrough: number;
	phase: "ready" | "running" | "error";
	error?: string;
	pausedRequest?: BtwPausedRequest;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function parseModelRef(value: unknown): BtwThreadModelRef | undefined {
	const data = objectRecord(value);
	if (!data || typeof data.provider !== "string" || !data.provider || typeof data.id !== "string" || !data.id) {
		return undefined;
	}
	return { provider: data.provider, id: data.id };
}

function parseEvent(value: unknown): BtwThreadEvent | undefined {
	const data = objectRecord(value);
	if (data?.version !== BTW_THREAD_EVENT_VERSION || typeof data.key !== "string" || !data.key) return undefined;
	const base = { version: BTW_THREAD_EVENT_VERSION, key: data.key } as const;
	if (data.op === "create") {
		const model = parseModelRef(data.model);
		if (
			!model ||
			typeof data.title !== "string" ||
			typeof data.createdAt !== "number" ||
			!Number.isFinite(data.createdAt) ||
			typeof data.anchorLeafId !== "string" ||
			!data.anchorLeafId ||
			typeof data.sideSessionId !== "string" ||
			!data.sideSessionId ||
			!Array.isArray(data.baseMessages) ||
			!Array.isArray(data.turns)
		) {
			return undefined;
		}
		return {
			...base,
			op: "create",
			title: data.title,
			createdAt: data.createdAt,
			anchorLeafId: data.anchorLeafId,
			model,
			sideSessionId: data.sideSessionId,
			baseMessages: data.baseMessages as AgentMessage[],
			turns: data.turns as EphemeralConversationTurn[],
		};
	}
	if (data.op === "turn" && objectRecord(data.turn)) {
		return { ...base, op: "turn", turn: data.turn as unknown as EphemeralConversationTurn };
	}
	if (data.op === "draft" && typeof data.text === "string") return { ...base, op: "draft", text: data.text };
	if (data.op === "read" && typeof data.through === "number" && Number.isInteger(data.through) && data.through >= 0) {
		return { ...base, op: "read", through: data.through };
	}
	if (data.op === "request") {
		if (data.input === undefined && data.timestamp === undefined) return { ...base, op: "request" };
		if (
			typeof data.input !== "string" ||
			!data.input ||
			typeof data.timestamp !== "number" ||
			!Number.isFinite(data.timestamp)
		) {
			return undefined;
		}
		return { ...base, op: "request", input: data.input, timestamp: data.timestamp };
	}
	if (data.op === "terminal" && (data.error === undefined || typeof data.error === "string")) {
		return { ...base, op: "terminal", error: data.error };
	}
	if (data.op === "remove" && (data.reason === "deleted" || data.reason === "promoted")) {
		return { ...base, op: "remove", reason: data.reason };
	}
	return undefined;
}

/** Replay the append-only BTW child journal embedded in a parent session. */
export function restoreBtwThreads(entries: Iterable<SessionEntry>): RestoredBtwThread[] {
	const threads = new Map<string, MutableRestoredBtwThread>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BTW_THREAD_CUSTOM_TYPE) continue;
		const event = parseEvent(entry.data);
		if (!event) continue;
		if (event.op === "create") {
			if (threads.has(event.key)) continue;
			threads.set(event.key, {
				key: event.key,
				title: event.title,
				createdAt: event.createdAt,
				anchorLeafId: event.anchorLeafId,
				model: event.model,
				sideSessionId: event.sideSessionId,
				baseMessages: event.baseMessages,
				turns: [...event.turns],
				draft: "",
				readThrough: 0,
				phase: "ready",
			});
			continue;
		}
		const thread = threads.get(event.key);
		if (!thread) continue;
		switch (event.op) {
			case "turn":
				thread.turns.push(event.turn);
				thread.phase = "ready";
				thread.pausedRequest = undefined;
				thread.error = undefined;
				break;
			case "draft":
				thread.draft = event.text;
				break;
			case "read":
				thread.readThrough = Math.min(event.through, thread.turns.length);
				break;
			case "request":
				thread.phase = "running";
				thread.error = undefined;
				thread.pausedRequest =
					event.input !== undefined && event.timestamp !== undefined
						? { input: event.input, timestamp: event.timestamp }
						: undefined;
				break;
			case "terminal":
				thread.phase = event.error ? "error" : "ready";
				thread.error = event.error;
				thread.pausedRequest = undefined;
				break;
			case "remove":
				threads.delete(event.key);
				break;
		}
	}
	return [...threads.values()].map(thread => {
		const interrupted = thread.phase === "running" && thread.pausedRequest === undefined;
		return {
			...thread,
			phase: thread.phase === "running" ? (interrupted ? "error" : "ready") : thread.phase,
			error: interrupted ? "Reply interrupted before completion" : thread.error,
		};
	});
}
