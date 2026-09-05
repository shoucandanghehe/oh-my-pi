import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { BtwManager } from "@oh-my-pi/pi-coding-agent/session/btw-manager";
import type { BtwThreadEvent, BtwThreadModelRef } from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import {
	EphemeralConversation,
	type EphemeralConversationCheckpoint,
	type EphemeralTurnResult,
} from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";

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
	it("upgrades one completed QuickAsk into a durable child without changing its identity or duplicating its turn", async () => {
		const events: BtwThreadEvent[] = [];
		const manager = new BtwManager({
			entries: [],
			appendEvent: event => events.push(event),
			createConversation: (_model, checkpoint) => immediateConversation(checkpoint),
			nextKey: () => "thread-1",
			now: () => 100,
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

	it("refreshes the frozen Main snapshot while replaying committed side turns", async () => {
		const events: BtwThreadEvent[] = [];
		const calls: AgentMessage[][] = [];
		let mainContext = "main-old";
		let sequence = 0;
		const manager = new BtwManager({
			entries: [],
			appendEvent: event => events.push(event),
			createConversation: (_model, checkpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [{ role: "user", content: mainContext, timestamp: Date.now() }],
					sideSessionId: checkpoint?.sideSessionId ?? `side-${++sequence}`,
					checkpoint,
					runTurn: async messages => {
						calls.push(messages);
						const text = userText(messages.at(-1));
						return { replyText: `reply:${text}`, assistantMessage: assistant(`reply:${text}`) };
					},
				}),
			nextKey: () => `thread-${++sequence}`,
			now: () => sequence * 100,
		});
		const key = manager.createQuick("First", "anchor-old", MODEL);
		await manager.prompt(key, "First");
		manager.continueQuick(key);

		mainContext = "main-new";
		expect(manager.refresh(key, "anchor-new")).toBe(true);
		await manager.prompt(key, "Again");

		expect(calls[1]?.filter(message => message.role === "user").map(userText)).toEqual([
			"main-new",
			"First",
			"Again",
		]);
		expect(manager.thread(key)?.anchorLeafId).toBe("anchor-new");
		expect(events.map(event => event.op)).toEqual(["create", "refresh", "request", "turn"]);
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
});
