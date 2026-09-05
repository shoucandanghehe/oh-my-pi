import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { BtwManager } from "@oh-my-pi/pi-coding-agent/session/btw-manager";
import {
	BTW_THREAD_CUSTOM_TYPE,
	type BtwThreadEvent,
	type BtwThreadModelRef,
} from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import {
	EphemeralConversation,
	type EphemeralConversationCheckpoint,
	type EphemeralConversationSideOptions,
	type EphemeralConversationStatus,
	type EphemeralTurnResult,
} from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const MODEL: BtwThreadModelRef = { provider: "anthropic", id: "claude-sonnet-4-5" };
const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function userText(message: AgentMessage | undefined): string {
	if (message?.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	for (const part of message.content) {
		if (part.type === "text") return part.text;
	}
	return "";
}

function immediateConversation(checkpoint?: EphemeralConversationCheckpoint): EphemeralConversation {
	return new EphemeralConversation({
		snapshotBaseMessages: () => [],
		sideSessionId: checkpoint?.sideSessionId ?? `side-${crypto.randomUUID()}`,
		checkpoint,
		runTurn: async messages => {
			const text = userText(messages.at(-1));
			return { replyText: `reply:${text}`, assistantMessage: assistant(`reply:${text}`) };
		},
	});
}

describe("BtwManager", () => {
	it("reports the side runtime model and its own committed usage", async () => {
		const sideModel = {
			id: "side-model",
			name: "Side Model",
			provider: "anthropic",
			contextWindow: 1000,
			thinking: false,
		} as unknown as EphemeralConversationStatus["model"];
		const sideUsage: Usage = {
			input: 400,
			output: 80,
			reasoningTokens: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 500,
			contextTokens: 500,
			premiumRequests: 1,
			cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 },
		};
		const conversation = new EphemeralConversation({
			snapshotBaseMessages: () => [{ role: "user", content: "Main context", timestamp: 1 }],
			sideSessionId: "side-session",
			getRuntimeState: () => ({ model: sideModel, thinkingLevel: undefined, isStreaming: false }),
			runTurn: async () => ({
				replyText: "Side answer",
				assistantMessage: { ...assistant("Side answer"), model: sideModel.id, usage: sideUsage },
			}),
		});

		await conversation.prompt("Side question");

		expect(conversation.status).toMatchObject({
			sessionId: "side-session",
			model: { id: "side-model", name: "Side Model" },
			isStreaming: false,
			stats: {
				tokens: { input: 400, output: 80, reasoning: 20, total: 500 },
				premiumRequests: 1,
				cost: 1,
				contextUsage: { tokens: 500, contextWindow: 1000, percent: 50 },
			},
		});
		expect(conversation.status?.latestAssistantMessage?.content).toEqual([{ type: "text", text: "Side answer" }]);
	});

	it("upgrades one completed QuickAsk into a durable child without changing its identity or duplicating its turn", async () => {
		const events: BtwThreadEvent[] = [];
		const sideOptions: EphemeralConversationSideOptions = { readOnlyTools: true, shareSummaryWithMain: () => {} };
		const created: Array<{
			checkpoint: EphemeralConversationCheckpoint | undefined;
			sideOptions: EphemeralConversationSideOptions | undefined;
		}> = [];
		const manager = new BtwManager({
			entries: [],
			appendEvent: event => events.push(event),
			createConversation: (_model, checkpoint, options) => {
				created.push({ checkpoint, sideOptions: options });
				return immediateConversation(checkpoint);
			},
			nextKey: () => "thread-1",
			now: () => 100,
			createSideOptions: () => sideOptions,
		});

		const key = manager.createQuick("Why?", "anchor-1", MODEL);
		await manager.prompt(key, "Why?");
		const before = manager.thread(key);
		expect(before).toMatchObject({ key: "thread-1", kind: "quick", phase: "ready" });
		expect(before?.turns).toHaveLength(1);
		expect(events).toEqual([]);

		expect(manager.continueQuick(key)).toBe(true);
		const after = manager.thread(key);
		expect(after).toBe(before);
		expect(after).toMatchObject({ key: "thread-1", kind: "child", phase: "ready" });
		expect(after?.turns).toHaveLength(1);
		expect(manager.children.map(thread => thread.key)).toEqual(["thread-1"]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ op: "create", key: "thread-1", anchorLeafId: "anchor-1" });
		expect(created).toHaveLength(2);
		expect(created[0]?.sideOptions).toBeUndefined();
		expect(created[1]?.sideOptions).toBe(sideOptions);
		expect(created[1]?.checkpoint?.turns).toHaveLength(1);
	});

	it("keeps durable side replies unbounded instead of inheriting the IRC flood limit", async () => {
		let dedupeReply: boolean | undefined;
		const longReply = "x".repeat(6_000);
		const manager = new BtwManager({
			entries: [],
			appendEvent: () => {},
			createConversation: () =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "side-long",
					runTurn: async (_messages, options) => {
						dedupeReply = options.dedupeReply;
						return { replyText: longReply, assistantMessage: assistant(longReply) };
					},
				}),
			nextKey: () => "thread-long",
			now: () => 100,
		});
		const key = manager.createQuick("Long?", "anchor-1", MODEL);

		const result = await manager.prompt(key, "Long?");

		expect(dedupeReply).toBe(false);
		expect(result.replyText).toBe(longReply);
		expect(result.replyText).not.toContain("[...truncated]");
	});

	it("allows different durable children to run concurrently without crossing phase, draft, turn, or unread state", async () => {
		const pending = new Map<string, PromiseWithResolvers<EphemeralTurnResult>>();
		let sequence = 0;
		const manager = new BtwManager({
			entries: [],
			appendEvent: () => {},
			createConversation: (_model, checkpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: checkpoint?.sideSessionId ?? `side-${++sequence}`,
					checkpoint,
					runTurn: async messages => {
						const text = userText(messages.at(-1));
						const deferred = Promise.withResolvers<EphemeralTurnResult>();
						pending.set(text, deferred);
						return deferred.promise;
					},
				}),
			nextKey: () => `thread-${++sequence}`,
			now: () => sequence * 100,
		});

		const first = manager.createQuick("First", "anchor-1", MODEL);
		const firstInitial = manager.prompt(first, "First");
		await Promise.resolve();
		pending.get("First")?.resolve({ replyText: "one", assistantMessage: assistant("one") });
		await firstInitial;
		manager.continueQuick(first);
		const second = manager.createQuick("Second", "anchor-1", MODEL);
		const secondInitial = manager.prompt(second, "Second");
		await Promise.resolve();
		pending.get("Second")?.resolve({ replyText: "two", assistantMessage: assistant("two") });
		await secondInitial;
		manager.continueQuick(second);
		manager.setDraft(first, "draft one");
		manager.setDraft(second, "draft two");

		const firstRun = manager.prompt(first, "A");
		const secondRun = manager.prompt(second, "B");
		await Promise.resolve();
		expect(manager.thread(first)).toMatchObject({ phase: "running", draft: "" });
		expect(manager.thread(second)).toMatchObject({ phase: "running", draft: "" });
		pending.get("B")?.resolve({ replyText: "bee", assistantMessage: assistant("bee") });
		await secondRun;
		expect(manager.thread(first)?.phase).toBe("running");
		expect(manager.thread(second)).toMatchObject({ phase: "ready", unread: 2 });
		pending.get("A")?.resolve({ replyText: "aye", assistantMessage: assistant("aye") });
		await firstRun;
		expect(manager.thread(first)?.turns.map(turn => turn.replyText)).toEqual(["one", "aye"]);
		expect(manager.thread(second)?.turns.map(turn => turn.replyText)).toEqual(["two", "bee"]);
	});

	it("journals promotion removal before transition and can revoke it without replacing the live thread", async () => {
		const events: BtwThreadEvent[] = [];
		const manager = new BtwManager({
			entries: [],
			appendEvent: event => events.push(event),
			createConversation: (_model, checkpoint) => immediateConversation(checkpoint),
			nextKey: () => "thread-1",
			now: () => 100,
		});
		const key = manager.createQuick("Promote?", "anchor-1", MODEL);
		await manager.prompt(key, "Promote?");
		manager.continueQuick(key);
		const liveThread = manager.thread(key);

		expect(manager.preparePromotion(key)).toBe(true);
		expect(manager.thread(key)).toBe(liveThread);
		expect(events.map(event => event.op)).toEqual(["create", "remove"]);
		expect(manager.rollbackPromotion(key)).toBe(true);
		expect(manager.thread(key)).toBe(liveThread);
		expect(events.map(event => event.op)).toEqual(["create", "remove", "create"]);
	});

	it("creates a durable child directly, journaling it with a frozen snapshot before the first turn", async () => {
		const events: BtwThreadEvent[] = [];
		const frozen: string[] = [];
		let sequence = 0;
		const manager = new BtwManager({
			entries: [],
			appendEvent: event => events.push(event),
			createConversation: (_model, checkpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => {
						frozen.push("snapshot");
						return [{ role: "user", content: "main", timestamp: Date.now() }];
					},
					sideSessionId: checkpoint?.sideSessionId ?? `side-${++sequence}`,
					checkpoint,
					runTurn: async messages => {
						const text = userText(messages.at(-1));
						return { replyText: `reply:${text}`, assistantMessage: assistant(`reply:${text}`) };
					},
				}),
			nextKey: () => `thread-${++sequence}`,
			now: () => sequence * 100,
		});

		const key = manager.createChild("Direct?", "anchor-1", MODEL);
		expect(manager.thread(key)).toMatchObject({ kind: "child", phase: "ready", title: "Direct?" });
		expect(manager.children.map(thread => thread.key)).toEqual([key]);
		expect(manager.activeKey).toBe(key);
		expect(frozen).toEqual(["snapshot"]);
		expect(events.map(event => event.op)).toEqual(["create"]);
		expect(events[0]).toMatchObject({ op: "create", key, anchorLeafId: "anchor-1" });

		await manager.prompt(key, "Direct?");
		expect(manager.thread(key)?.turns.map(turn => turn.replyText)).toEqual(["reply:Direct?"]);
		expect(events.map(event => event.op)).toEqual(["create", "request", "turn"]);
	});

	it("binds side options to every durable thread and streams thinking deltas through prompt", async () => {
		const sideOptionsSeen: unknown[] = [];
		const sideSourcesSeen: unknown[] = [];
		const thinkingDeltas: string[] = [];
		const manager = new BtwManager({
			entries: [],
			appendEvent: () => {},
			createConversation: (_model, checkpoint, sideOptions) => {
				sideOptionsSeen.push(sideOptions);
				return new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: checkpoint?.sideSessionId ?? "side-1",
					checkpoint,
					runTurn: async (_messages, options) => {
						options.onThinkingDelta?.("think-");
						options.onThinkingDelta?.("ing");
						return { replyText: "Answer", assistantMessage: assistant("Answer") };
					},
				});
			},
			createSideOptions: source => {
				sideSourcesSeen.push(source);
				return { readOnlyTools: true, shareSummaryWithMain: () => {} };
			},
			nextKey: () => "thread-1",
			now: () => 100,
		});

		const key = manager.createChild("Why?", "anchor-1", MODEL);
		await manager.prompt(key, "Why?", undefined, delta => thinkingDeltas.push(delta));

		expect(sideOptionsSeen).toEqual([{ readOnlyTools: true, shareSummaryWithMain: expect.any(Function) }]);
		expect(sideSourcesSeen).toEqual([{ threadKey: "thread-1", threadTitle: "Why?" }]);
		expect(thinkingDeltas).toEqual(["think-", "ing"]);
	});
	it("does not append a late turn after the manager is abandoned", async () => {
		const deferred = Promise.withResolvers<EphemeralTurnResult>();
		const events: BtwThreadEvent[] = [];
		const manager = new BtwManager({
			entries: [],
			appendEvent: event => events.push(event),
			createConversation: () =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "side-abandon",
					runTurn: async () => deferred.promise,
				}),
			nextKey: () => "thread-abandon",
			now: () => 100,
		});
		const key = manager.createChild("Why?", "anchor-1", MODEL);
		const prompt = manager.prompt(key, "Why?");
		await Promise.resolve();

		manager.abandon();
		deferred.resolve({ replyText: "late", assistantMessage: assistant("late") });
		await prompt;

		expect(events.map(event => event.op)).toEqual(["create", "request"]);
	});

	it("persists and resumes a durable request interrupted by paused exit", async () => {
		const entries: CustomEntry<BtwThreadEvent>[] = [];
		const appendEvent = (event: BtwThreadEvent): void => {
			const sequence = entries.length + 1;
			entries.push({
				type: "custom",
				customType: BTW_THREAD_CUSTOM_TYPE,
				data: event,
				id: `event-${sequence}`,
				parentId: sequence === 1 ? null : `event-${sequence - 1}`,
				timestamp: new Date(sequence * 1_000).toISOString(),
			});
		};
		const turnStarted = Promise.withResolvers<void>();
		const interrupted = new BtwManager({
			entries: [],
			appendEvent,
			createConversation: () =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "side-paused",
					runTurn: async (_messages, options) => {
						turnStarted.resolve();
						const result = Promise.withResolvers<EphemeralTurnResult>();
						const abort = (): void => result.reject(options.signal?.reason);
						if (options.signal?.aborted) abort();
						else options.signal?.addEventListener("abort", abort, { once: true });
						return result.promise;
					},
				}),
			nextKey: () => "thread-paused",
			now: () => 100,
		});
		const key = interrupted.createChild("Pause me", "anchor-1", MODEL);
		const pending = interrupted.prompt(key, "Finish after resume");
		await turnStarted.promise;

		interrupted.prepareForPausedExit();
		await pending.catch(() => undefined);

		const restored = new BtwManager({
			entries,
			appendEvent,
			createConversation: (_model, checkpoint) => immediateConversation(checkpoint),
			nextKey: () => "unused",
			now: () => 200,
		});
		const result = await restored.continuePaused();

		expect(result).toEqual({ continued: 1, skipped: [], complete: true });
		expect(restored.thread(key)?.turns.map(turn => turn.input)).toEqual(["Finish after resume"]);
	});
});
