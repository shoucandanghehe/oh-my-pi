import { expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { BtwHistoryStore, readLegacyBtwThreadSidecars } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { restoreLegacyBtwJournal } from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
const assistant: AssistantMessage = {
	role: "assistant",
	api: "anthropic-messages",
	provider: "anthropic",
	model: model.id,
	content: [{ type: "text", text: "Original answer", textSignature: "old-replay-signature" }],
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 2,
};
const savedTurn = {
	input: "Original question",
	assistantMessage: assistant,
	replyText: "Original answer",
	timestamp: 1,
};

it("keeps pre-port topic headings and native checkpoints outside the lightweight BTW records", async () => {
	using temp = TempDir.createSync("@pi-btw-legacy-");
	const directory = path.join(temp.path(), "btw-history");
	const record = {
		id: "legacy-topic",
		leafId: "main-anchor",
		status: "complete" as const,
		question: "Original question",
		answer: "Original answer",
		createdAt: 1,
		updatedAt: 2,
	};
	await Bun.write(path.join(directory, "entry-legacy-topic.json"), JSON.stringify(record));
	await Bun.write(path.join(directory, "entry-legacy-topic.title"), "/sitrep");
	await Bun.write(
		path.join(directory, "entry-legacy-topic.conversation"),
		JSON.stringify({
			answers: ["Original answer"],
			baseMessages: [],
			sideSessionId: "legacy-lineage",
			model,
			turns: [savedTurn],
		}),
	);
	const history = await BtwHistoryStore.open(temp.path());
	try {
		const [topic] = history.getRecords();
		expect(topic).toEqual({ ...record, title: "/sitrep" });
		if (!topic) throw new Error("Expected topic");
		const checkpoint = await history.readConversation(topic.id);
		expect(checkpoint?.turns[0]?.assistantMessage.content).toEqual(assistant.content);
		await history.upsert({ ...topic, answer: "Edited answer" });
	} finally {
		await history.close();
	}
	const reopened = await BtwHistoryStore.open(temp.path());
	try {
		expect(await reopened.readConversation("legacy-topic")).toMatchObject({
			sideSessionId: "legacy-lineage",
			turns: [
				{ replyText: "Edited answer", assistantMessage: { content: [{ type: "text", text: "Edited answer" }] } },
			],
		});
	} finally {
		await reopened.close();
	}
});

it("reads old full-thread JSON without mistaking it for lightweight history", async () => {
	using temp = TempDir.createSync("@pi-btw-legacy-thread-");
	await Bun.write(
		path.join(temp.path(), "btw-history", "entry-legacy-thread.json"),
		JSON.stringify({
			version: 1,
			id: "legacy-thread",
			title: "Two-turn topic",
			createdAt: 1,
			anchorLeafId: "main-anchor",
			model,
			baseMessages: [{ role: "user", content: "Frozen Main", timestamp: 0 }],
			sideSessionId: "legacy-child",
			turns: [savedTurn],
			draft: "Half written",
			draftImages: [],
			draftImageLinks: [null, "https://example.com/note"],
			readThrough: 1,
			phase: "running",
		}),
	);
	const legacy = await readLegacyBtwThreadSidecars(temp.path());
	expect(legacy).toMatchObject([
		{
			key: "legacy-thread",
			title: "Two-turn topic",
			sideSessionId: "legacy-child",
			anchorLeafId: "main-anchor",
			turns: [{ input: "Original question", replyText: "Original answer" }],
			draft: "Half written",
			draftImageLinks: [undefined, "https://example.com/note"],
			phase: "error",
		},
	]);
	const history = await BtwHistoryStore.open(temp.path());
	try {
		expect(history.getRecords()).toEqual([]);
	} finally {
		await history.close();
	}
});

it("recovers pending input and retains delete markers from the original parent journal", () => {
	const entries: SessionEntry[] = [
		{
			op: "create",
			key: "kept",
			title: "Current topic",
			createdAt: 0,
			anchorLeafId: "anchor",
			model,
			sideSessionId: "kept-lineage",
			turns: [],
			baseMessages: [],
		},
		{
			op: "create",
			key: "deleted",
			title: "Old topic",
			createdAt: 0,
			anchorLeafId: "anchor",
			model,
			sideSessionId: "deleted-lineage",
			turns: [],
			baseMessages: [],
		},
		{ op: "turn", key: "kept", turn: savedTurn },
		{ op: "request", key: "kept", input: "Awaiting reply", timestamp: 4 },
		{ op: "remove", key: "deleted", reason: "deleted" },
	].map((data, index) => ({
		type: "custom",
		customType: "btw-thread",
		data: { version: 1, ...data },
		id: String(index),
		parentId: index === 0 ? null : String(index - 1),
		timestamp: new Date(index).toISOString(),
	}));
	expect(restoreLegacyBtwJournal(entries)).toMatchObject([
		{
			key: "kept",
			sideSessionId: "kept-lineage",
			turns: [savedTurn],
			phase: "ready",
			pausedRequest: { input: "Awaiting reply", timestamp: 4 },
		},
	]);
});
