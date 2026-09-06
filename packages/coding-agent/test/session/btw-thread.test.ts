import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import {
	BTW_THREAD_CUSTOM_TYPE,
	type BtwThreadEvent,
	restoreBtwThreads,
} from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveBlobRefsInEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

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

	it("round-trips journal image blobs and missing draft links while keeping legacy draft clears readable", async () => {
		using tempDir = TempDir.createSync("@btw-image-journal-");
		const blobStore = new BlobStore(tempDir.path());
		const image: ImageContent = {
			type: "image",
			data: Buffer.alloc(1500, 7).toString("base64"),
			mimeType: "image/png",
		};
		const firstTurn = {
			input: "",
			images: [image],
			replyText: "First",
			assistantMessage: assistant("First", 10),
			timestamp: 10,
		};
		const secondTurn = {
			input: "Again",
			images: [image],
			replyText: "Second",
			assistantMessage: assistant("Second", 20),
			timestamp: 20,
		};
		const events = [
			entry(1, {
				version: 1,
				op: "create",
				key: "thread-a",
				title: "Image",
				createdAt: 10,
				anchorLeafId: "main-leaf",
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				sideSessionId: "side-a",
				baseMessages: [],
				turns: [firstTurn],
			}),
			entry(2, { version: 1, op: "turn", key: "thread-a", turn: secondTurn }),
			entry(3, {
				version: 1,
				op: "draft",
				key: "thread-a",
				text: "",
				images: [image, image],
				imageLinks: [undefined, "local://image.png"],
			}),
			entry(4, { version: 1, op: "request", key: "thread-a", input: "", images: [image], timestamp: 30 }),
		];
		const persisted = events.map(event =>
			prepareEntryForPersistence(event, blobStore),
		) as CustomEntry<BtwThreadEvent>[];
		const draft = persisted[2]?.data;
		if (draft?.op !== "draft") throw new Error("Expected draft event");
		expect(isBlobRef(draft.images?.[0]?.data ?? "")).toBe(true);
		const loaded = JSON.parse(JSON.stringify(persisted)) as CustomEntry<BtwThreadEvent>[];
		await resolveBlobRefsInEntries(loaded, blobStore);

		const restored = restoreBtwThreads(loaded)[0]!;
		expect(restored.turns).toEqual([firstTurn, secondTurn]);
		expect(restored.draftImages).toEqual([image, image]);
		expect(restored.draftImageLinks).toEqual([undefined, "local://image.png"]);
		expect(restored.pausedRequest).toEqual({ input: "", images: [image], timestamp: 30 });
		expect(restored.phase).toBe("ready");

		loaded.push(entry(5, { version: 1, op: "draft", key: "thread-a", text: "Text only" }));
		expect(restoreBtwThreads(loaded)[0]).toMatchObject({
			draft: "Text only",
			draftImages: [],
			draftImageLinks: [],
		});
	});
});
