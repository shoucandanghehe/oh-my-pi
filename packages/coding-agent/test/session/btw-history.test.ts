import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import type { RestoredBtwThread } from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import { BtwSessionStore } from "@oh-my-pi/pi-coding-agent/session/btw-session-store";
import { readAgentsPaused } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm, createCompactionSummaryMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { seedBtwConversation } from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
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

function record(key: string): RestoredBtwThread {
	return {
		key,
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

function createThread(store: BtwSessionStore, thread: RestoredBtwThread): void {
	seedBtwConversation(store.getSessionManager(thread.key), thread);
	store.appendEvent({
		version: 1,
		key: thread.key,
		op: "create",
		title: thread.title,
		createdAt: thread.createdAt,
		anchorLeafId: thread.anchorLeafId,
		model: thread.model,
		sideSessionId: thread.sideSessionId,
		baseMessages: thread.baseMessages,
		turns: thread.turns,
	});
}

describe("BtwSessionStore", () => {
	it("opens standard journals without importing or modifying old JSON checkpoints", async () => {
		using temp = TempDir.createSync("@btw-no-auto-migration-");
		const sourcePath = path.join(temp.path(), "btw-history", "entry-old-thread.json");
		const source = `${JSON.stringify({ version: 1, id: "old-thread", draft: "Unmigrated draft" })}\n`;
		await Bun.write(sourcePath, source);
		const store = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			expect(store.getRecords()).toEqual([]);
			expect(await Bun.file(sourcePath).text()).toBe(source);
			expect(await Bun.file(`${sourcePath}.legacy`).exists()).toBe(false);
		} finally {
			await store.close();
		}
	});

	it("preserves oversized frozen summary images through reload and full journal rewrites", async () => {
		using temp = TempDir.createSync("@btw-frozen-summary-image-");
		const frame: ImageContent = {
			type: "image",
			data: Buffer.alloc(400_000, 23).toString("base64"),
			mimeType: "image/png",
		};
		const original = record("thread-summary-image");
		original.baseMessages = [
			createCompactionSummaryMessage("Archived Main context", 1000, new Date(0).toISOString(), {
				blocks: [{ type: "text", text: "Before frame" }, frame, { type: "text", text: "After frame" }],
			}),
			...original.baseMessages,
		];
		const initial = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			createThread(initial, original);
			await initial.flush();
		} finally {
			await initial.close();
		}

		const reopened = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			await reopened.getSessionManager(original.key).rewriteEntries();
		} finally {
			await reopened.close();
		}
		const [restored] = await BtwSessionStore.readRecords(temp.path(), temp.path());
		const images = convertToLlm([...restored!.baseMessages]).flatMap(message =>
			typeof message.content === "string"
				? []
				: message.content.filter((block): block is ImageContent => block.type === "image"),
		);
		expect(images.map(image => new Bun.CryptoHasher("sha256").update(image.data).digest("hex"))).toEqual([
			new Bun.CryptoHasher("sha256").update(frame.data).digest("hex"),
		]);
		expect(restored!.baseMessages).toEqual(original.baseMessages);
	});

	it("restores complete tool history and draft attachments through standard session readers", async () => {
		using temp = TempDir.createSync("@btw-standard-history-");
		const original = record("thread-standard");
		const toolCall: AssistantMessage = {
			...assistant("Inspecting"),
			content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "file.txt" } }],
			stopReason: "toolUse",
		};
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "original\ttool output" }],
			details: { source: "file.txt", opaque: { cursor: "provider-cursor" } },
			isError: false,
			timestamp: 11,
		};
		original.turns = [
			{
				input: "Inspect file",
				images: [image()],
				prefixMessages: [{ role: "developer", content: "Image description", timestamp: 10 }],
				intermediateMessages: [toolCall, toolResult],
				assistantMessage: assistant("The file contains text."),
				replyText: "The file contains text.",
				timestamp: 10,
			},
		];
		original.draft = "Next question";
		original.draftImages = [image()];
		original.draftImageLinks = [undefined, "local://draft.png"];
		original.readThrough = 1;
		const initial = await BtwSessionStore.open(temp.path(), temp.path());
		createThread(initial, original);
		initial.appendEvent({
			version: 1,
			key: original.key,
			op: "draft",
			text: original.draft,
			images: original.draftImages,
			imageLinks: original.draftImageLinks,
		});
		initial.appendEvent({ version: 1, key: original.key, op: "read", through: 1 });
		await initial.flush();
		await initial.close();

		const store = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			const manager = store.getSessionManager(original.key);
			await store.flush();
			const restored = store.getRecords()[0]!;
			expect(restored).toMatchObject({
				key: original.key,
				sideSessionId: original.sideSessionId,
				baseMessages: original.baseMessages,
				draft: original.draft,
				draftImages: original.draftImages,
				draftImageLinks: original.draftImageLinks,
				readThrough: 1,
			});
			expect(restored.turns[0]).toMatchObject(original.turns[0]!);
			const persistedPath = manager.getSessionFile()!;
			const normalReader = await SessionManager.open(persistedPath, undefined, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			try {
				const messages = normalReader.buildSessionContext().messages;
				expect(messages).toContainEqual(toolCall);
				expect(messages).toContainEqual(toolResult);
				expect(messages).toContainEqual(original.turns[0]!.assistantMessage);
				const messageEntries = normalReader.getEntries().filter(entry => entry.type === "message");
				const callEntry = messageEntries.find(
					entry =>
						entry.message.role === "assistant" &&
						entry.message.content.some(part => part.type === "toolCall" && part.id === "read-1"),
				);
				const resultEntry = messageEntries.find(
					entry => entry.message.role === "toolResult" && entry.message.toolCallId === "read-1",
				);
				expect(resultEntry?.parentId).toBe(callEntry?.id);
				expect(callEntry?.message).toEqual(toolCall);
			} finally {
				await normalReader.close();
			}
		} finally {
			await store.close();
		}

		const reopened = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			expect(reopened.getRecords()).toHaveLength(1);
			expect(reopened.getRecords()[0]!.turns[0]!.intermediateMessages).toEqual([toolCall, toolResult]);
			reopened.appendEvent({ version: 1, key: original.key, op: "remove", reason: "deleted" });
			await reopened.flush();
			const canonicalFile = reopened.getSessionManager(original.key).getSessionFile()!;
			const failDeletion = spyOn(reopened.getSessionManager(original.key), "dropSession").mockRejectedValue(
				new Error("Deletion failed"),
			);
			try {
				await expect(reopened.removeSession(original.key)).rejects.toThrow("Deletion failed");
				expect(reopened.getRecords().map(thread => thread.key)).toEqual([original.key]);
			} finally {
				failDeletion.mockRestore();
			}
			await reopened.removeSession(original.key);
			expect(await Bun.file(canonicalFile).exists()).toBe(false);
		} finally {
			await reopened.close();
		}
		const deleted = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			expect(deleted.getRecords()).toEqual([]);
		} finally {
			await deleted.close();
		}
	});

	it("persists an unprompted thread and its draft even when the inherited context has no assistant", async () => {
		using temp = TempDir.createSync("@btw-standard-blank-");
		const original = record("thread-blank");
		const store = await BtwSessionStore.open(temp.path(), temp.path());
		const manager = store.getSessionManager(original.key);
		createThread(store, original);
		store.appendEvent({ version: 1, key: original.key, op: "draft", text: "Unsent question", images: [image()] });
		await store.flush();
		expect(await Bun.file(manager.getSessionFile()!).exists()).toBe(true);
		await store.close();
		const restored = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			expect(restored.getRecords()).toMatchObject([
				{
					key: original.key,
					draft: "Unsent question",
					draftImages: [image()],
					turns: [],
				},
			]);
		} finally {
			await restored.close();
		}
	});

	it("refuses a second writer while allowing read-only history snapshots", async () => {
		using temp = TempDir.createSync("@btw-standard-owner-");
		const original = record("thread-owner");
		const store = await BtwSessionStore.open(temp.path(), temp.path());
		createThread(store, original);
		await store.flush();
		try {
			await expect(BtwSessionStore.open(temp.path(), temp.path())).rejects.toThrow("already open");
			expect((await BtwSessionStore.readRecords(temp.path(), temp.path())).map(thread => thread.key)).toEqual([
				original.key,
			]);
		} finally {
			await store.close();
		}
		const replacement = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			expect(replacement.getRecords().map(thread => thread.key)).toEqual([original.key]);
		} finally {
			await replacement.close();
		}
	});

	it("recovers an input lost before dispatch but never resurrects it across an explicit clear", async () => {
		using temp = TempDir.createSync("@btw-interrupted-admission-");
		const original = record("thread-pending");
		const store = await BtwSessionStore.open(temp.path(), temp.path());
		createThread(store, original);
		store.appendEvent({
			version: 1,
			key: original.key,
			op: "request",
			input: "Prepared before crash",
			images: [image()],
			timestamp: 13,
		});
		await store.flush();
		await store.close();

		const recovered = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			const manager = recovered.getSessionManager(original.key);
			expect(manager.buildSessionContext().messages).toEqual([...original.baseMessages]);
			expect(readAgentsPaused(manager.getBranch())).toMatchObject({
				pendingPrompt: { text: "Prepared before crash", images: [image()] },
			});
			manager.appendResetBoundary();
			expect(readAgentsPaused(manager.getBranch())).toBeUndefined();
			await recovered.flush();
		} finally {
			await recovered.close();
		}
		const cleared = await BtwSessionStore.open(temp.path(), temp.path());
		try {
			const manager = cleared.getSessionManager(original.key);
			expect(manager.buildSessionContext().messages).toEqual([]);
			expect(readAgentsPaused(manager.getBranch())).toBeUndefined();
		} finally {
			await cleared.close();
		}
	});
});
