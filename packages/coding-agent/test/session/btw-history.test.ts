import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { BtwHistoryStore, type BtwHistoryRecord } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { TempDir } from "@oh-my-pi/pi-utils";

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
		timestamp: 12,
	};
}

function record(id: string): BtwHistoryRecord {
	return {
		version: 1,
		id,
		title: "Investigate image",
		createdAt: 10,
		anchorLeafId: "main-leaf",
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		sideSessionId: "side-session",
		baseMessages: [{ role: "user", content: [{ type: "text", text: "Frozen Main" }], timestamp: 1 }],
		turns: [],
		draft: "",
		draftImages: [],
		draftImageLinks: [],
		readThrough: 0,
		phase: "ready",
	};
}

function image(): ImageContent {
	return { type: "image", data: Buffer.alloc(1500, 19).toString("base64"), mimeType: "image/png" };
}

describe("BtwHistoryStore", () => {
	it("round-trips complete frozen context, tool turn, media, draft link positions and resumable request through disk", async () => {
		using temp = TempDir.createSync("@btw-rich-sidecar-");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		const imageData = image();
		const original = record("thread-a");
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: 11,
		};
		original.baseMessages = [
			{ role: "user", content: [{ type: "text", text: "Frozen Main" }, imageData], timestamp: 1 },
		];
		original.turns = [
			{
				input: "",
				images: [imageData],
				prefixMessages: [original.baseMessages[0]!],
				intermediateMessages: [toolResult],
				assistantMessage: assistant("Answer"),
				replyText: "Answer",
				timestamp: 12,
			},
		];
		original.draft = "Follow-up";
		original.draftImages = [imageData];
		original.draftImageLinks = [undefined, "local://figure.png"];
		original.readThrough = 1;
		original.phase = "running";
		original.pausedRequest = { input: "", images: [imageData], timestamp: 13 };
		const store = await BtwHistoryStore.open(temp.path(), blobs);
		const pending = store.upsert(original);
		// Mutating source while the write is queued cannot change the checkpoint.
		original.draft = "later mutation";
		(original.turns[0]!.intermediateMessages as AgentMessage[]).push(assistant("later output"));
		imageData.data = "corrupted after upsert";
		await pending;
		await store.flush();
		const filePath = path.join(temp.path(), "btw-history", "entry-thread-a.json");
		const disk = (await Bun.file(filePath).json()) as Omit<BtwHistoryRecord, "draftImageLinks"> & {
			draftImageLinks: (string | null)[];
		};
		expect(isBlobRef(disk.draftImages[0]!.data)).toBe(true);
		expect(isBlobRef(disk.turns[0]!.images![0]!.data)).toBe(true);
		expect(disk.draftImageLinks).toEqual([null, "local://figure.png"]);
		expect(disk.turns[0]!.intermediateMessages).toEqual([toolResult]);
		if (process.platform !== "win32") {
			expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
		}
		const restored = await BtwHistoryStore.open(temp.path(), blobs);
		expect(restored.getRecords()).toEqual([
			{
				...record("thread-a"),
				baseMessages: [{ role: "user", content: [{ type: "text", text: "Frozen Main" }, image()], timestamp: 1 }],
				turns: [
					{
						input: "",
						images: [image()],
						prefixMessages: [
							{ role: "user", content: [{ type: "text", text: "Frozen Main" }, image()], timestamp: 1 },
						],
						intermediateMessages: [toolResult],
						assistantMessage: assistant("Answer"),
						replyText: "Answer",
						timestamp: 12,
					},
				],
				draft: "Follow-up",
				draftImages: [image()],
				draftImageLinks: [undefined, "local://figure.png"],
				readThrough: 1,
				phase: "ready",
				pausedRequest: { input: "", images: [image()], timestamp: 13 },
			},
		]);
		await store.upsert({ ...store.getRecords()[0]!, phase: "ready", pausedRequest: undefined });
	});

	it("rejects concurrent revisions, including deletion, without losing the committed record", async () => {
		using temp = TempDir.createSync("@btw-history-cas-");
		const owner = await BtwHistoryStore.open(temp.path());
		await owner.upsert(record("thread-a"));
		const stale = await BtwHistoryStore.open(temp.path());
		const staleWriter = await BtwHistoryStore.open(temp.path());
		await owner.upsert({ ...record("thread-a"), draft: "owner's latest checkpoint" });
		await expect(staleWriter.upsert({ ...record("thread-a"), draft: "stale overwrite" })).rejects.toThrow("conflict");
		await expect(stale.remove("thread-a")).rejects.toThrow("conflict");
		await expect(stale.flush()).rejects.toThrow("conflict");
		const disk = await BtwHistoryStore.open(temp.path());
		expect(disk.getRecords()[0]?.draft).toBe("owner's latest checkpoint");
		await owner.remove("thread-a");
		expect((await BtwHistoryStore.open(temp.path())).getRecords()).toEqual([]);
	});

	it("latches a failed write until a fresh store is opened", async () => {
		using temp = TempDir.createSync("@btw-history-retry-");
		const store = await BtwHistoryStore.open(temp.path());
		const directory = path.join(temp.path(), "btw-history");
		await Bun.write(directory, "blocks directory creation");
		await expect(store.upsert(record("thread-retry"))).rejects.toThrow();
		await expect(store.flush()).rejects.toThrow();
		await expect(store.upsert(record("other-thread"))).rejects.toThrow();
		await fs.rm(directory);
		const reopened = await BtwHistoryStore.open(temp.path());
		await reopened.upsert(record("thread-retry"));
		expect((await BtwHistoryStore.open(temp.path())).getRecords().map(item => item.id)).toEqual(["thread-retry"]);
	});

	it("recovers running without a request as interrupted, preserving the original disk revision for CAS", async () => {
		using temp = TempDir.createSync("@btw-history-recovery-");
		const initial = await BtwHistoryStore.open(temp.path());
		await initial.upsert({ ...record("thread-b"), phase: "running" });
		// A process crash releases its lease; this test releases it by finishing the original writer.
		await initial.upsert({ ...record("thread-b"), phase: "ready" });
		const filePath = path.join(temp.path(), "btw-history", "entry-thread-b.json");
		await Bun.write(filePath, `${JSON.stringify({ ...record("thread-b"), phase: "running" })}\n`);
		const resumed = await BtwHistoryStore.open(temp.path());
		expect(resumed.getRecords()[0]).toMatchObject({ phase: "error", error: "Reply interrupted before completion" });
		await resumed.upsert({ ...resumed.getRecords()[0]!, phase: "ready", error: undefined });
		expect((await BtwHistoryStore.open(temp.path())).getRecords()[0]).toMatchObject({ phase: "ready" });
	});

	it("keeps undefined-artifacts sessions wholly in memory, including deletion", async () => {
		const store = await BtwHistoryStore.open(undefined);
		await store.upsert(record("memory-only"));
		await store.remove("memory-only");
		await store.flush();
		expect(store.getRecords()).toEqual([]);
	});
});
