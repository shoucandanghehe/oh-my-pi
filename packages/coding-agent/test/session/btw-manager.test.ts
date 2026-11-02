import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, ModelSpec, Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BtwSessionStore } from "@oh-my-pi/pi-coding-agent/session/btw-session-store";
import { BtwManager, type BtwManagerOptions } from "@oh-my-pi/pi-coding-agent/session/btw-manager";
import type { BtwThreadEvent, BtwThreadModelRef } from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import {
	type EphemeralConversationCheckpoint,
	type EphemeralConversationSideOptions,
	type EphemeralTurnResult,
} from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { BTW_SUMMARY_MESSAGE_TYPE, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readAgentsPaused } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	TestEphemeralConversation as EphemeralConversation,
	disposeTestEphemeralConversations,
} from "../helpers/ephemeral-conversation";
import { createMainWriteTool, sendToMainSessionCall } from "../helpers/btw-send-to-main";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

afterEach(disposeTestEphemeralConversations);

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

function immediateConversation(
	checkpoint?: EphemeralConversationCheckpoint,
	sideOptions?: EphemeralConversationSideOptions,
): EphemeralConversation {
	return new EphemeralConversation({
		snapshotBaseMessages: () => [],
		sideSessionId: checkpoint?.sideSessionId ?? `side-${crypto.randomUUID()}`,
		checkpoint,
		sessionManager: sideOptions?.sessionManager,
		onSessionClosed: sideOptions?.onSessionClosed,
		runTurn: async messages => {
			const text = userText(messages.at(-1));
			return { replyText: `reply:${text}`, assistantMessage: assistant(`reply:${text}`) };
		},
	});
}

function storedManager(
	store: BtwSessionStore,
	options: Omit<BtwManagerOptions, "restoredThreads" | "appendEvent" | "flushEvents">,
): BtwManager {
	const restoredThreads = store.getRecords();
	const manager = new BtwManager({
		...options,
		restoredThreads,
		createSideOptions: key => ({
			...options.createSideOptions?.(key),
			sessionManager: store.getSessionManager(key),
			onSessionClosed: closed => store.adoptClosedSession(key, closed),
		}),
		appendEvent: event => store.appendEvent(event),
		flushEvents: () => store.flush(),
		removeSession: key => store.removeSession(key),
		closeEvents: () => store.close(),
	});
	return manager;
}

describe("BtwManager", () => {
	it("keeps an explicit title after restoring an unprompted thread instead of auto-naming its first turn", async () => {
		using directory = TempDir.createSync("@pi-btw-title-");
		const options = {
			createConversation: (
				_model: BtwThreadModelRef,
				checkpoint?: EphemeralConversationCheckpoint,
				sideOptions?: EphemeralConversationSideOptions,
			) => immediateConversation(checkpoint, sideOptions),
			generateTitle: async () => "Generated heading",
			nextKey: () => "explicit-title",
			now: () => 100,
		};
		const manager = storedManager(await BtwSessionStore.open(directory.path(), directory.path()), options);
		const key = manager.createChild("Long template content", "anchor-1", MODEL, "/sitrep");
		await manager.dispose();
		const restored = storedManager(await BtwSessionStore.open(directory.path(), directory.path()), options);
		await restored.prompt(key, "Long template content");
		await restored.dispose();
		const stored = await BtwSessionStore.open(directory.path(), directory.path());
		try {
			expect(stored.getRecords()[0]?.title).toBe("/sitrep");
			expect(stored.getRecords()[0]?.turns.map(turn => turn.input)).toEqual(["Long template content"]);
		} finally {
			await stored.close();
		}
	});

	it("reports the side runtime model and its own committed usage", async () => {
		const sideModel = buildModel({
			id: "side-model",
			name: "Side Model",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 256,
		} as ModelSpec<Api>) as Model<Api>;
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

	it("restores an unprompted thread with its creation-time context and keeps that context across completed turns", async () => {
		const store = await BtwSessionStore.open(undefined, process.cwd());
		const mainMessages: AgentMessage[] = [{ role: "user", content: "Original Main context", timestamp: 1 }];
		const requests: AgentMessage[][] = [];
		const restore = () =>
			storedManager(store, {
				createConversation: (_model, checkpoint, sideOptions) =>
					new EphemeralConversation({
						snapshotBaseMessages: () => structuredClone(mainMessages),
						sideSessionId: checkpoint?.sideSessionId ?? "side-frozen",
						checkpoint,
						sessionManager: sideOptions?.sessionManager,
						onSessionClosed: sideOptions?.onSessionClosed,
						runTurn: async messages => {
							requests.push(messages);
							const text = userText(messages.at(-1));
							return { replyText: `reply:${text}`, assistantMessage: assistant(`reply:${text}`) };
						},
					}),
				nextKey: () => "thread-frozen",
				now: () => 100,
			});
		const manager = restore();
		const key = manager.createChild("Why?", "anchor-1", MODEL);
		await store.flush();
		mainMessages.push({ role: "user", content: "Later Main context", timestamp: 2 });

		const beforeFirstTurn = restore();
		await beforeFirstTurn.prompt(key, "Why?");
		expect(requests[0]?.filter(message => message.role === "user").map(userText)).toEqual([
			"Original Main context",
			"Why?",
		]);

		await store.flush();
		const afterFirstTurn = restore();
		await afterFirstTurn.prompt(key, "Follow up");
		expect(requests[1]?.filter(message => message.role === "user").map(userText)).toEqual([
			"Original Main context",
			"Why?",
			"Follow up",
		]);
		expect(requests[1]?.filter(message => message.role === "assistant").map(message => message.content)).toEqual([
			[{ type: "text", text: "reply:Why?" }],
		]);
		expect(afterFirstTurn.children.map(thread => thread.key)).toEqual([key]);
		expect(afterFirstTurn.thread(key)?.turns.map(turn => turn.replyText)).toEqual(["reply:Why?", "reply:Follow up"]);
		expect(mainMessages.map(userText)).toEqual(["Original Main context", "Later Main context"]);
	});

	it("flushes an edited draft before a session moves away", async () => {
		const store = await BtwSessionStore.open(undefined, process.cwd());
		const options = {
			createConversation: (
				_model: BtwThreadModelRef,
				checkpoint?: EphemeralConversationCheckpoint,
				sideOptions?: EphemeralConversationSideOptions,
			) => immediateConversation(checkpoint, sideOptions),
			nextKey: () => "thread-draft",
			now: () => 100,
		};
		const manager = storedManager(store, options);
		const key = manager.createChild("Question?", "anchor-1", MODEL);
		await store.flush();
		manager.setDraft(key, "Follow up after moving");

		await manager.flushEvents();

		expect(storedManager(store, options).thread(key)?.draft).toBe("Follow up after moving");
	});

	it("allows different durable children to run concurrently without crossing phase, draft, turn, or unread state", async () => {
		const pending = new Map<string, PromiseWithResolvers<EphemeralTurnResult>>();
		const started = new Map(
			["First", "Second", "A", "B"].map(text => [text, Promise.withResolvers<void>()] as const),
		);
		let sequence = 0;
		const manager = new BtwManager({
			restoredThreads: [],
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
						started.get(text)?.resolve();
						return deferred.promise;
					},
				}),
			nextKey: () => `thread-${++sequence}`,
			now: () => sequence * 100,
		});

		const first = manager.createChild("First", "anchor-1", MODEL);
		const second = manager.createChild("Second", "anchor-1", MODEL);
		const firstInitial = manager.prompt(first, "First");
		const secondInitial = manager.prompt(second, "Second");
		await Promise.all([started.get("First")!.promise, started.get("Second")!.promise]);
		expect(manager.thread(first)?.phase).toBe("running");
		expect(manager.thread(second)?.phase).toBe("running");
		pending.get("Second")?.resolve({ replyText: "two", assistantMessage: assistant("two") });
		await secondInitial;
		expect(manager.thread(first)?.phase).toBe("running");
		pending.get("First")?.resolve({ replyText: "one", assistantMessage: assistant("one") });
		await firstInitial;
		manager.markRead(first);
		manager.setDraft(first, "draft one");
		manager.setDraft(second, "draft two");

		const firstRun = manager.prompt(first, "A");
		const secondRun = manager.prompt(second, "B");
		await Promise.all([started.get("A")!.promise, started.get("B")!.promise]);
		expect(manager.thread(first)).toMatchObject({ phase: "running", draft: "" });
		expect(manager.thread(second)).toMatchObject({ phase: "running", draft: "" });
		pending.get("B")?.resolve({ replyText: "bee", assistantMessage: assistant("bee") });
		await secondRun;
		expect(manager.thread(first)?.phase).toBe("running");
		expect(manager.thread(second)).toMatchObject({ phase: "ready", unread: 2 });
		expect(manager.thread(first)?.unread).toBe(0);
		pending.get("A")?.resolve({ replyText: "aye", assistantMessage: assistant("aye") });
		await firstRun;
		expect(manager.thread(first)?.turns.map(turn => turn.replyText)).toEqual(["one", "aye"]);
		expect(manager.thread(second)?.turns.map(turn => turn.replyText)).toEqual(["two", "bee"]);
		expect(manager.thread(first)?.unread).toBe(1);
		expect(manager.thread(second)?.unread).toBe(2);
		await manager.dispose();
	});

	it("steers a running BTW and delivers follow-ups without changing Main or losing queued input", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let samples = 0;
		const delivered: string[] = [];
		const replies = ["First answer", "Correction answer", "Follow-up answer"];
		const sideStreamFn: StreamFn = (_model, context) => {
			const stream = new AssistantMessageEventStream();
			delivered.push(userText(context.messages.findLast(message => message.role === "user")));
			const sample = samples++;
			const finish = (): void => {
				stream.push({ type: "done", reason: "stop", message: assistant(replies[sample]!) });
			};
			if (sample === 0) {
				started.resolve();
				void release.promise.then(finish);
			} else {
				queueMicrotask(finish);
			}
			return stream;
		};
		const mainMessage: AgentMessage = { role: "user", content: "Main context", timestamp: 1 };
		const parent = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Shared prefix"], messages: [mainMessage], tools: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => async () => "key",
				authStorage: { usage: { ingestHeaders: () => {} }, oauth: { identity: () => undefined } },
				hasLazyRuntimeMetadata: () => false,
			} as never,
			sideStreamFn,
			memoryEnabled: false,
		});
		const manager = new BtwManager({
			restoredThreads: [],
			appendEvent: () => {},
			createConversation: (_model, checkpoint, options) =>
				parent.createEphemeralConversation("Side instructions", checkpoint, model, options),
			nextKey: () => "steered-thread",
			now: () => 100,
		});
		const key = manager.createChild("First", "main-leaf", MODEL);
		const first = manager.prompt(key, "First");
		try {
			await started.promise;
			expect(await manager.prompt(key, "Correction")).toBeUndefined();
			expect(await manager.prompt(key, "After", undefined, undefined, undefined, "followUp")).toBeUndefined();
			const session = await manager.session(key);
			expect(session.getQueuedMessages()).toMatchObject({ steering: ["Correction"], followUp: ["After"] });
			release.resolve();
			await first;
			await session.waitForIdle();
			expect(manager.thread(key)!.turns.map(turn => ({ input: turn.input, reply: turn.replyText }))).toEqual([
				{ input: "First", reply: "First answer" },
				{ input: "Correction", reply: "Correction answer" },
				{ input: "After", reply: "Follow-up answer" },
			]);
			expect(delivered).toEqual([
				expect.stringContaining("First"),
				expect.stringContaining("Correction"),
				expect.stringContaining("After"),
			]);
			expect(parent.messages).toEqual([mainMessage]);
			expect(session.getQueuedMessages()).toMatchObject({ steering: [], followUp: [] });
		} finally {
			release.resolve();
			await first.catch(() => undefined);
			await manager.dispose();
			await parent.dispose();
		}
	});

	it("restores attachment-only draft edits and replays submitted images without crossing threads or changing Main", async () => {
		const firstImage: ImageContent = { type: "image", data: "Zmlyc3Q=", mimeType: "image/png" };
		const secondImage: ImageContent = { type: "image", data: "c2Vjb25k", mimeType: "image/png" };
		const mainMessages: AgentMessage[] = [{ role: "user", content: "Main context", timestamp: 1 }];
		const store = await BtwSessionStore.open(undefined, process.cwd());
		const requests: AgentMessage[][] = [];
		let sequence = 0;
		const createConversation = (
			_model: BtwThreadModelRef,
			checkpoint?: EphemeralConversationCheckpoint,
			sideOptions?: EphemeralConversationSideOptions,
		) =>
			new EphemeralConversation({
				snapshotBaseMessages: () => mainMessages,
				sideSessionId: checkpoint?.sideSessionId ?? `side-${sequence}`,
				checkpoint,
				sessionManager: sideOptions?.sessionManager,
				onSessionClosed: sideOptions?.onSessionClosed,
				runTurn: async messages => {
					requests.push(messages);
					return { replyText: "Seen", assistantMessage: assistant("Seen") };
				},
			});
		const restore = () =>
			storedManager(store, {
				createConversation,
				nextKey: () => `thread-${++sequence}`,
				now: () => sequence * 100,
			});
		const manager = restore();
		const first = manager.createChild("First", "main-leaf", MODEL);
		const second = manager.createChild("Second", "main-leaf", MODEL);
		manager.setDraft(first, "", [firstImage]);
		manager.persistDraft(first);
		manager.setDraft(first, "", [secondImage, firstImage], [undefined, "local://first.png"]);
		expect(manager.persistDraft(first)).toBe(true);
		manager.select(second);
		manager.setDraft(second, "Other draft", [firstImage], ["local://other.png"]);
		manager.persistDraft(second);
		manager.select(first);
		expect(manager.thread(first)?.draftImages).toEqual([secondImage, firstImage]);
		await store.flush();

		const restored = restore();
		const draft = restored.thread(first)!;
		expect(draft.draftImageLinks).toEqual([undefined, "local://first.png"]);
		await restored.prompt(first, draft.draft, undefined, undefined, draft.draftImages);
		expect(requests[0]?.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "" }, secondImage, firstImage],
		});
		await store.flush();
		const afterSubmit = restore();
		expect(afterSubmit.thread(first)).toMatchObject({ draft: "", draftImages: [], draftImageLinks: [] });
		expect(afterSubmit.thread(second)).toMatchObject({
			draft: "Other draft",
			draftImages: [firstImage],
			draftImageLinks: ["local://other.png"],
		});
		await afterSubmit.prompt(first, "Follow up");
		expect(requests[1]?.filter(message => message.role === "user").map(message => message.content)).toEqual([
			"Main context",
			[{ type: "text", text: "" }, secondImage, firstImage],
			[{ type: "text", text: "Follow up" }],
		]);
		expect(mainMessages).toEqual([{ role: "user", content: "Main context", timestamp: 1 }]);
	});

	it("removes a prepared promotion from sidecar history and restores its draft on rollback", async () => {
		const store = await BtwSessionStore.open(undefined, process.cwd());
		const manager = storedManager(store, {
			createConversation: (_model, checkpoint, sideOptions) => immediateConversation(checkpoint, sideOptions),
			nextKey: () => "thread-1",
			now: () => 100,
		});
		const key = manager.createChild("Promote?", "anchor-1", MODEL);
		await manager.prompt(key, "Promote?");
		const liveThread = manager.thread(key);
		const image: ImageContent = { type: "image", data: "ZHJhZnQ=", mimeType: "image/png" };
		manager.setDraft(key, "", [image], ["local://draft.png"]);
		manager.persistDraft(key);

		expect(manager.preparePromotion(key)).toBe(true);
		expect(manager.thread(key)).toBe(liveThread);
		await store.flush();
		expect(store.getRecords()).toEqual([]);
		expect(manager.rollbackPromotion(key)).toBe(true);
		expect(manager.thread(key)).toBe(liveThread);
		await store.flush();
		expect(store.getRecords()[0]).toMatchObject({
			draft: "",
			draftImages: [image],
			draftImageLinks: ["local://draft.png"],
		});
		const restored = storedManager(store, {
			createConversation: (_model, checkpoint, sideOptions) => immediateConversation(checkpoint, sideOptions),
			nextKey: () => "unused",
			now: () => 200,
		});
		await restored.prompt(key, "Continue after rollback");
		expect(restored.thread(key)?.turns.map(turn => turn.replyText)).toEqual([
			"reply:Promote?",
			"reply:Continue after rollback",
		]);
	});

	it("creates a durable child with a frozen snapshot before the first turn", async () => {
		const store = await BtwSessionStore.open(undefined, process.cwd());
		const mainMessages: AgentMessage[] = [{ role: "user", content: "Main before creation", timestamp: 1 }];
		const requests: AgentMessage[][] = [];
		const manager = storedManager(store, {
			createConversation: (_model, checkpoint, sideOptions) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => structuredClone(mainMessages),
					sideSessionId: checkpoint?.sideSessionId ?? "side-before-prompt",
					checkpoint,
					sessionManager: sideOptions?.sessionManager,
					onSessionClosed: sideOptions?.onSessionClosed,
					runTurn: async messages => {
						requests.push(messages);
						const text = userText(messages.at(-1));
						return { replyText: `reply:${text}`, assistantMessage: assistant(`reply:${text}`) };
					},
				}),
			nextKey: () => "thread-before-prompt",
			now: () => 100,
		});

		const key = manager.createChild("Direct?", "anchor-1", MODEL);
		mainMessages.push({ role: "user", content: "Main after creation", timestamp: 2 });

		await manager.prompt(key, "Direct?");
		expect(requests[0]?.filter(message => message.role === "user").map(userText)).toEqual([
			"Main before creation",
			"Direct?",
		]);
		await store.flush();
		expect(store.getRecords()[0]?.turns.map(turn => turn.replyText)).toEqual(["reply:Direct?"]);
		expect(store.getRecords()[0]?.baseMessages.map(userText)).toEqual(["Main before creation"]);
	});

	it("names the first turn, persists its title, and sends Main a summary with that title", async () => {
		const model = buildModel({
			id: "btw-first-turn",
			name: "BTW First Turn",
			api: "anthropic-messages",
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const summary = "The package is @oh-my-pi/pi-coding-agent.";
		const directory = TempDir.createSync("@pi-btw-title-");
		let store = await BtwSessionStore.open(directory.path(), directory.path());
		let sideRequests = 0;
		const sideStreamFn: StreamFn = (_model, context) => {
			const stream = new AssistantMessageEventStream();
			const request = ++sideRequests;
			queueMicrotask(() => {
				if (request === 1) {
					const toolCalls = [
						{ type: "toolCall" as const, id: "read-package", name: "read", arguments: {} },
						sendToMainSessionCall("share-package", summary),
					];
					const message = assistant("");
					message.content = toolCalls;
					message.stopReason = "toolUse";
					for (const [contentIndex, toolCall] of toolCalls.entries()) {
						stream.push({ type: "toolcall_start", contentIndex, partial: message });
						stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
					}
					stream.push({ type: "done", reason: "toolUse", message });
					return;
				}
				const readResult = context.messages.find(
					message => message.role === "toolResult" && message.toolCallId === "read-package",
				);
				const text = JSON.stringify(readResult?.content).includes("@oh-my-pi/pi-coding-agent")
					? "Read the package name."
					: "Package read unavailable.";
				stream.push({ type: "done", reason: "stop", message: assistant(text) });
			});
			return stream;
		};
		const readTool: AgentTool = {
			name: "read",
			label: "Read Package",
			description: "Read the package name",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				const manifest = await Bun.file(new URL("../../package.json", import.meta.url)).json();
				return { content: [{ type: "text", text: manifest.name }], details: {} };
			},
		};
		const extensionRunner = {
			clearManagedTimers: () => {},
			consumeToolCallEmitted: () => false,
			getRegisteredTool: () => undefined,
			getUIContext: () => ({ select: async () => "Approve" }),
			hasHandlers: () => false,
			hasUI: () => true,
			runScoped: <T>(run: () => T): T => run(),
		} as never;
		const wrappedReadTool = new ExtensionToolWrapper(readTool, extensionRunner);
		const write = createMainWriteTool();
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [wrappedReadTool, write] },
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "done", reason: "stop", message: assistant("Summary received.") });
					});
					return stream;
				},
				convertToLlm,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" }),
			modelRegistry: { getApiKey: async () => "key", resolver: () => async () => "key" } as never,
			extensionRunner,
			toolRegistry: new Map<string, AgentTool>([
				["read", wrappedReadTool],
				["write", write],
			]),
			builtInToolNames: ["read", "write"],
			sideStreamFn,
		});
		try {
			const options: Omit<BtwManagerOptions, "restoredThreads" | "appendEvent" | "flushEvents"> = {
				createConversation: (_model, checkpoint, sideOptions) =>
					session.createEphemeralConversation("side instructions", checkpoint, model, sideOptions),
				createSideOptions: threadKey => ({
					sendToMainSession: sharedSummary =>
						session.publishBtwSummary({
							threadKey,
							threadTitle: manager.thread(threadKey)!.title,
							summary: sharedSummary,
						}),
				}),
				generateTitle: async () => "Package identity",
				nextKey: () => "thread-capabilities",
				now: () => 100,
			};
			const manager = storedManager(store, options);
			const key = manager.createChild("Identify package", "main-leaf", { provider: model.provider, id: model.id });
			const result = await manager.prompt(key, "Read the package and share its identity.");
			await session.waitForIdle();

			expect(result?.replyText).toBe("Read the package name.");
			expect(
				session.agent.state.messages.find(
					message => message.role === "custom" && message.customType === BTW_SUMMARY_MESSAGE_TYPE,
				),
			).toMatchObject({
				attribution: "agent",
				details: {
					summaries: [{ threadKey: key, threadTitle: "Package identity", summary }],
				},
			});
			await store.close();
			store = await BtwSessionStore.open(directory.path(), directory.path());
			expect(store.getRecords().find(record => record.key === key)?.title).toBe("Package identity");
			const restored = storedManager(store, options);
			expect(restored.thread(key)?.title).toBe("Package identity");
			const followup = await restored.prompt(key, "What did you read?");
			expect(followup?.replyText).toBe("Read the package name.");
			expect(
				restored.thread(key)?.turns[0]?.intermediateMessages?.filter(message => message.role === "toolResult"),
			).toMatchObject([
				{ toolCallId: "read-package", isError: false },
				{ toolCallId: "share-package", isError: false },
			]);
		} finally {
			await session.dispose();
			await store.close();
			directory.removeSync();
		}
	});
	it("does not append a late turn after the manager is abandoned", async () => {
		const deferred = Promise.withResolvers<EphemeralTurnResult>();
		const started = Promise.withResolvers<void>();
		const events: BtwThreadEvent[] = [];
		const manager = new BtwManager({
			restoredThreads: [],
			appendEvent: event => events.push(event),
			createConversation: () =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "side-abandon",
					runTurn: async () => {
						started.resolve();
						return deferred.promise;
					},
				}),
			nextKey: () => "thread-abandon",
			now: () => 100,
		});
		const key = manager.createChild("Why?", "anchor-1", MODEL);
		const prompt = manager.prompt(key, "Why?");
		await started.promise;

		await manager.abandon();
		deferred.resolve({ replyText: "late", assistantMessage: assistant("late") });
		await prompt;

		expect(events.map(event => event.op)).toEqual(["create", "request"]);
	});

	it.each(["dispose", "abandon"] as const)(
		"releases a running thread's file lease on %s so the same process can resume it",
		async method => {
			using directory = TempDir.createSync("@btw-manager-close-");
			const store = await BtwSessionStore.open(directory.path(), directory.path());
			const started = Promise.withResolvers<void>();
			const interrupted = storedManager(store, {
				createConversation: (_model, checkpoint, sideOptions) =>
					new EphemeralConversation({
						snapshotBaseMessages: () => [],
						sideSessionId: "side-reopen",
						checkpoint,
						sessionManager: sideOptions?.sessionManager,
						onSessionClosed: sideOptions?.onSessionClosed,
						runTurn: async (_messages, options) => {
							const result = Promise.withResolvers<EphemeralTurnResult>();
							options.signal?.addEventListener("abort", () => result.reject(options.signal?.reason), {
								once: true,
							});
							started.resolve();
							return result.promise;
						},
					}),
				nextKey: () => "thread-reopen",
				now: () => 100,
			});
			const key = interrupted.createChild("Resume me", "anchor-1", MODEL);
			const pending = interrupted.prompt(key, "Unfinished question").catch(() => undefined);
			await started.promise;
			await interrupted[method]();
			await interrupted[method]();
			await pending;

			const reopened = await BtwSessionStore.open(directory.path(), directory.path());
			const resumed = storedManager(reopened, {
				createConversation: (_model, checkpoint, sideOptions) => immediateConversation(checkpoint, sideOptions),
				nextKey: () => "unused",
				now: () => 200,
			});
			try {
				expect(await resumed.continuePaused()).toEqual({ continued: 1, skipped: [], complete: true });
				expect(resumed.thread(key)?.turns.at(-1)?.replyText).toBe("reply:Unfinished question");
				expect(readAgentsPaused(reopened.getSessionManager(key).getBranch())).toBeUndefined();
				const questions = reopened
					.getSessionManager(key)
					.buildSessionContext()
					.messages.filter(message => message.role === "user");
				expect(questions.map(userText)).toEqual(["Unfinished question"]);
			} finally {
				await resumed.dispose();
			}
		},
		10_000,
	);

	it("preserves an image-only paused request across disposal and a failed continuation", async () => {
		using directory = TempDir.createSync("@btw-paused-image-");
		let store = await BtwSessionStore.open(directory.path(), directory.path());
		const image: ImageContent = { type: "image", data: "cGF1c2Vk", mimeType: "image/png" };
		const images = [image];
		const turnStarted = Promise.withResolvers<void>();
		const interrupted = storedManager(store, {
			createConversation: (_model, checkpoint, sideOptions) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "side-paused",
					checkpoint,
					sessionManager: sideOptions?.sessionManager,
					onSessionClosed: sideOptions?.onSessionClosed,
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
		const pending = interrupted.prompt(key, "", undefined, undefined, images);
		await turnStarted.promise;
		images.length = 0;
		const draftImage: ImageContent = { type: "image", data: "ZHJhZnQ=", mimeType: "image/png" };
		interrupted.setDraft(key, "Next question", [draftImage], ["local://next.png"]);

		interrupted.prepareForPausedExit();
		await interrupted.dispose();
		await pending.catch(() => undefined);
		store = await BtwSessionStore.open(directory.path(), directory.path());
		expect(readAgentsPaused(store.getSessionManager(key).getBranch())).toMatchObject({ agentIds: [MAIN_AGENT_ID] });
		expect(store.getSessionManager(key).buildSessionContext().messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "" }, image],
		});

		const requests: AgentMessage[][] = [];
		let fail = true;
		const restore = () =>
			storedManager(store, {
				createConversation: (_model, checkpoint, sideOptions) =>
					new EphemeralConversation({
						snapshotBaseMessages: () => [],
						sideSessionId: checkpoint?.sideSessionId ?? "side-paused",
						checkpoint,
						sessionManager: sideOptions?.sessionManager,
						onSessionClosed: sideOptions?.onSessionClosed,
						runTurn: async messages => {
							requests.push(messages);
							if (fail) throw new Error("Provider unavailable");
							return { replyText: "Resumed", assistantMessage: assistant("Resumed") };
						},
					}),
				nextKey: () => "unused",
				now: () => 200,
			});
		const restored = restore();
		const failed = await restored.continuePaused();
		expect(failed).toMatchObject({ continued: 0, complete: false });
		expect(failed.skipped).toEqual([expect.stringContaining("Provider unavailable")]);
		expect(failed.skipped[0]).toContain("Pause me");
		await store.flush();
		fail = false;
		const retried = restore();
		expect(await retried.continuePaused()).toEqual({ continued: 1, skipped: [], complete: true });
		expect(
			requests.map(messages => {
				const message = messages.at(-1);
				return message?.role === "user" ? message.content : undefined;
			}),
		).toEqual([
			[{ type: "text", text: "" }, image],
			[{ type: "text", text: "" }, image],
		]);
		expect(readAgentsPaused(store.getSessionManager(key).getBranch())).toBeUndefined();
		expect(retried.thread(key)).toMatchObject({
			draft: "Next question",
			draftImages: [draftImage],
			draftImageLinks: ["local://next.png"],
		});
	});

	it("stops only the selected request, retains its draft and runtime, and accepts another turn", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<EphemeralTurnResult>();
		let samples = 0;
		let sequence = 0;
		const manager = new BtwManager({
			restoredThreads: [],
			appendEvent: () => {},
			createConversation: () =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: `stop-side-${sequence}`,
					runTurn: async () => {
						if (samples++ === 0) {
							started.resolve();
							return release.promise;
						}
						return { replyText: "Continued", assistantMessage: assistant("Continued") };
					},
				}),
			nextKey: () => `stop-thread-${++sequence}`,
			now: () => 100,
		});
		const key = manager.createChild("Question", "main-leaf", MODEL);
		const parked = manager.createChild("Parked", "main-leaf", MODEL);
		await manager.abort(parked);
		expect(manager.thread(parked)?.conversation.session).toBeUndefined();
		const pending = manager.prompt(key, "Question").catch(() => undefined);
		try {
			await started.promise;
			const session = manager.thread(key)!.conversation.session!;
			const controller = manager.thread(key)!.abortController!;
			manager.setDraft(
				key,
				"Unsent correction",
				[{ type: "image", mimeType: "image/png", data: "draft" }],
				["local://draft.png"],
			);
			await manager.abort(key);
			await pending;
			expect(controller.signal.aborted).toBe(true);
			expect(manager.thread(key)).toMatchObject({
				phase: "ready",
				error: undefined,
				request: undefined,
				draft: "Unsent correction",
				draftImages: [{ data: "draft" }],
				draftImageLinks: ["local://draft.png"],
			});
			expect(manager.thread(key)!.conversation.session).toBe(session);
			expect(session.isStreaming).toBe(false);
			expect((await manager.prompt(key, "Next question"))?.replyText).toBe("Continued");
		} finally {
			release.resolve({ replyText: "Late", assistantMessage: assistant("Late") });
			await pending;
			await manager.dispose();
		}
	});

	it("expands the loaded child's file prompts on idle and running user turns, but not internal side turns", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<EphemeralTurnResult>();
		const delivered: string[] = [];
		const manager = new BtwManager({
			restoredThreads: [],
			appendEvent: () => {},
			createConversation: () =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "local-templates",
					runTurn: async messages => {
						const text = userText(messages.findLast(message => message.role === "user"));
						delivered.push(text);
						if (text === "Expanded idle") {
							started.resolve();
							return release.promise;
						}
						return { replyText: text, assistantMessage: assistant(text) };
					},
				}),
			nextKey: () => "local-templates",
			now: () => 100,
		});
		const key = manager.createChild("Question", "main-leaf", MODEL);
		const session = await manager.session(key);
		session.setSlashCommands([{ name: "local", description: "", content: "Expanded $ARGUMENTS", source: "test" }]);
		const conversation = manager.thread(key)!.conversation;
		await conversation.prompt("/local internal");
		const first = manager.prompt(key, "/local idle");
		try {
			await started.promise;
			await manager.prompt(key, "/local running");
			release.resolve({ replyText: "Idle answer", assistantMessage: assistant("Idle answer") });
			await first;
			await session.waitForIdle();
			expect(delivered).toEqual(["/local internal", "Expanded idle", expect.stringContaining("Expanded running")]);
		} finally {
			release.resolve({ replyText: "Idle answer", assistantMessage: assistant("Idle answer") });
			await first.catch(() => undefined);
			await manager.dispose();
		}
	});

	it("keeps the first input ahead of a steer submitted while its initial persistence flush is pending", async () => {
		const flush = Promise.withResolvers<void>();
		const admissions: string[] = [];
		const manager = new BtwManager({
			restoredThreads: [],
			appendEvent: () => {},
			flushEvents: () => flush.promise,
			createConversation: (_model, checkpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "startup-order",
					checkpoint,
					runTurn: async messages => {
						const text = userText(messages.at(-1));
						return { replyText: `reply:${text}`, assistantMessage: assistant(`reply:${text}`) };
					},
				}),
			nextKey: () => "startup-order",
			now: () => 100,
		});
		const key = manager.createChild("First", "main-leaf", MODEL);
		const first = manager.prompt(key, "First", undefined, undefined, undefined, "steer", () =>
			admissions.push("First"),
		);
		const session = await manager.session(key);
		const second = manager.prompt(key, "Correction", undefined, undefined, undefined, "steer", () =>
			admissions.push("Correction"),
		);
		expect(admissions).toEqual([]);
		try {
			flush.resolve();
			await Promise.all([first, second]);
			await session.waitForIdle();
			expect(admissions).toEqual(["First", "Correction"]);
			expect(
				session.sessionManager
					.buildSessionContext()
					.messages.filter(message => message.role === "user")
					.map(userText),
			).toEqual(["First", "Correction"]);
		} finally {
			flush.resolve();
			await Promise.allSettled([first, second]);
			await manager.dispose();
		}
	});

	it("retains a prepared input on paused exit and requires continue before admitting another input after cold restore", async () => {
		using directory = TempDir.createSync("@btw-pause-before-admission-");
		const store = await BtwSessionStore.open(directory.path(), directory.path());
		const samples: string[] = [];
		const options = {
			createConversation: (
				_model: BtwThreadModelRef,
				checkpoint?: EphemeralConversationCheckpoint,
				sideOptions?: EphemeralConversationSideOptions,
			) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: checkpoint?.sideSessionId ?? "pending-input",
					checkpoint,
					sessionManager: sideOptions?.sessionManager,
					onSessionClosed: sideOptions?.onSessionClosed,
					runTurn: async messages => {
						const text = userText(messages.at(-1));
						samples.push(text);
						return { replyText: `reply:${text}`, assistantMessage: assistant(`reply:${text}`) };
					},
				}),
			nextKey: () => "pending-input",
			now: () => 100,
		};
		const manager = storedManager(store, options);
		const key = manager.createChild("First", "main-leaf", MODEL);
		await manager.prompt(key, "First");
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const blocked = spyOn(store, "flush").mockImplementationOnce(async () => {
			entered.resolve();
			await gate.promise;
		});
		const pending = manager.prompt(key, "Prepared later");
		try {
			await entered.promise;
			manager.prepareForPausedExit();
			gate.resolve();
			await pending;
		} finally {
			blocked.mockRestore();
			gate.resolve();
			await pending.catch(() => undefined);
			await manager.dispose();
		}
		const reopened = await BtwSessionStore.open(directory.path(), directory.path());
		const restored = storedManager(reopened, options);
		try {
			await expect(restored.prompt(key, "Do not bypass pause")).rejects.toThrow("run /continue");
			expect(await restored.continuePaused()).toMatchObject({ continued: 1, complete: true });
			expect(samples).toEqual(["First", "Prepared later"]);
			const session = await restored.session(key);
			expect(session.messages.filter(message => message.role === "user").map(userText)).toEqual([
				"First",
				"Prepared later",
			]);
			expect(session.hasPausedAgents()).toBe(false);
		} finally {
			await restored.dispose();
		}
	});

	it("rebuilds a usable runtime after deleting its standard journal fails", async () => {
		using directory = TempDir.createSync("@btw-delete-failed-runtime-");
		const store = await BtwSessionStore.open(directory.path(), directory.path());
		const options = {
			createConversation: (
				_model: BtwThreadModelRef,
				checkpoint?: EphemeralConversationCheckpoint,
				sideOptions?: EphemeralConversationSideOptions,
			) => immediateConversation(checkpoint, sideOptions),
			nextKey: () => "delete-failure",
			now: () => 100,
		};
		const manager = storedManager(store, options);
		const key = manager.createChild("First", "main-leaf", MODEL);
		await manager.prompt(key, "First");
		const fail = spyOn(store, "removeSession").mockRejectedValueOnce(new Error("Deletion failed"));
		try {
			await expect(manager.remove(key, "deleted")).rejects.toThrow("Deletion failed");
		} finally {
			fail.mockRestore();
		}
		try {
			expect((await manager.prompt(key, "After failed delete"))?.replyText).toBe("reply:After failed delete");
			expect(manager.thread(key)?.turns.map(turn => turn.input)).toEqual(["First", "After failed delete"]);
			await store.flush();
			expect(
				(await BtwSessionStore.readRecords(directory.path(), directory.path())).map(thread => thread.key),
			).toEqual([key]);
		} finally {
			await manager.dispose();
		}
	});

	it("hands off the standard in-memory transcript and draft when its runtime is disposed", async () => {
		const store = await BtwSessionStore.open(undefined, process.cwd());
		const options = {
			createConversation: (
				_model: BtwThreadModelRef,
				checkpoint?: EphemeralConversationCheckpoint,
				sideOptions?: EphemeralConversationSideOptions,
			) => immediateConversation(checkpoint, sideOptions),
			nextKey: () => "memory-transfer",
			now: () => 100,
		};
		const manager = storedManager(store, options);
		const key = manager.createChild("First", "main-leaf", MODEL);
		await manager.prompt(key, "First");
		manager.setDraft(key, "Unsent draft", [{ type: "image", mimeType: "image/png", data: "draft" }]);
		await manager.dispose();
		const restored = storedManager(store, options);
		try {
			expect(restored.thread(key)).toMatchObject({ draft: "Unsent draft", draftImages: [{ data: "draft" }] });
			expect(store.getSessionManager(key).getSessionFile()).toBeUndefined();
			expect((await restored.prompt(key, "Follow up"))?.replyText).toBe("reply:Follow up");
			expect(restored.thread(key)?.turns.map(turn => turn.input)).toEqual(["First", "Follow up"]);
		} finally {
			await restored.dispose();
		}
	});
});
