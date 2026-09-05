import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import {
	BTW_THREAD_CUSTOM_TYPE,
	type BtwThreadEvent,
	restoreBtwThreads,
} from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function entry(sequence: number, data: BtwThreadEvent): CustomEntry<BtwThreadEvent> {
	return {
		type: "custom",
		customType: BTW_THREAD_CUSTOM_TYPE,
		data,
		id: `event-${sequence}`,
		parentId: "main-leaf",
		timestamp: new Date(sequence * 1_000).toISOString(),
	};
}

describe("restoreBtwThreads", () => {
	it("replays durable child turns, draft, read state, and terminal failure without reordering children", () => {
		const firstTurn = { input: "First?", replyText: "One", assistantMessage: assistant("One", 10), timestamp: 10 };
		const secondTurn = { input: "Second?", replyText: "Two", assistantMessage: assistant("Two", 20), timestamp: 20 };
		const otherTurn = {
			input: "Other?",
			replyText: "Other",
			assistantMessage: assistant("Other", 15),
			timestamp: 15,
		};
		const events = [
			entry(1, {
				version: 1,
				op: "create",
				key: "thread-a",
				title: "First?",
				createdAt: 10,
				anchorLeafId: "anchor-a",
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				sideSessionId: "side-a",
				baseMessages: [],
				turns: [firstTurn],
			}),
			entry(2, {
				version: 1,
				op: "create",
				key: "thread-b",
				title: "Other?",
				createdAt: 15,
				anchorLeafId: "anchor-b",
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				sideSessionId: "side-b",
				baseMessages: [],
				turns: [otherTurn],
			}),
			entry(3, { version: 1, op: "turn", key: "thread-a", turn: secondTurn }),
			entry(4, { version: 1, op: "draft", key: "thread-a", text: "unsent follow-up" }),
			entry(5, { version: 1, op: "read", key: "thread-a", through: 1 }),
			entry(6, { version: 1, op: "request", key: "thread-a" }),
			entry(7, { version: 1, op: "terminal", key: "thread-a", error: "provider unavailable" }),
		];

		const threads = restoreBtwThreads(events);

		expect(threads.map(thread => thread.key)).toEqual(["thread-a", "thread-b"]);
		expect(threads[0]).toMatchObject({
			draft: "unsent follow-up",
			phase: "error",
			error: "provider unavailable",
			readThrough: 1,
		});
		expect(threads[0]?.turns).toEqual([firstTurn, secondTurn]);
	});

	it("replaces a child's frozen Main anchor without discarding its side turns", () => {
		const turn = { input: "Before?", replyText: "Kept", assistantMessage: assistant("Kept", 10), timestamp: 10 };
		const refreshedBase = [{ role: "user" as const, content: "new Main", timestamp: 20 }];
		const events = [
			entry(1, {
				version: 1,
				op: "create",
				key: "thread-a",
				title: "Before?",
				createdAt: 10,
				anchorLeafId: "anchor-old",
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				sideSessionId: "side-old",
				baseMessages: [],
				turns: [turn],
			}),
			entry(2, {
				version: 1,
				op: "refresh",
				key: "thread-a",
				anchorLeafId: "anchor-new",
				sideSessionId: "side-new",
				baseMessages: refreshedBase,
			}),
		];

		expect(restoreBtwThreads(events)[0]).toMatchObject({
			anchorLeafId: "anchor-new",
			sideSessionId: "side-new",
			baseMessages: refreshedBase,
			turns: [turn],
		});
	});

	it("removes a promoted child instead of restoring a second writable copy", () => {
		const turn = { input: "Promote?", replyText: "Yes", assistantMessage: assistant("Yes", 10), timestamp: 10 };
		const events = [
			entry(1, {
				version: 1,
				op: "create",
				key: "thread-a",
				title: "Promote?",
				createdAt: 10,
				anchorLeafId: "anchor-a",
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				sideSessionId: "side-a",
				baseMessages: [],
				turns: [turn],
			}),
			entry(2, { version: 1, op: "remove", key: "thread-a", reason: "promoted" }),
		];

		expect(restoreBtwThreads(events)).toEqual([]);
	});
});
