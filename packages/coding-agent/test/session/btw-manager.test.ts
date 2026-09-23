import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, ModelSpec, Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BtwHistoryStore, type BtwHistoryRecord } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { BtwManager, type BtwManagerOptions, type BtwThread } from "@oh-my-pi/pi-coding-agent/session/btw-manager";
import type { BtwThreadEvent, BtwThreadModelRef } from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import {
	EphemeralConversation,
	type EphemeralConversationCheckpoint,
	type EphemeralConversationStatus,
	type EphemeralTurnResult,
} from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { BTW_SUMMARY_MESSAGE_TYPE, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

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

function historyRecord(thread: BtwThread): BtwHistoryRecord {
	const checkpoint = thread.conversation.checkpoint();
	if (!checkpoint.baseMessages) throw new Error("BTW thread has no frozen Main snapshot");
	return {
		version: 1,
		id: thread.key,
		title: thread.title,
		createdAt: thread.createdAt,
		anchorLeafId: thread.anchorLeafId,
		model: thread.model,
		sideSessionId: checkpoint.sideSessionId,
		baseMessages: checkpoint.baseMessages,
		turns: checkpoint.turns,
		draft: thread.draft,
		draftImages: thread.draftImages,
		draftImageLinks: thread.draftImageLinks,
		readThrough: thread.readThrough,
		phase: thread.phase,
		error: thread.error,
		pausedRequest:
			thread.phase === "running" && thread.request
				? { input: thread.request.input, images: thread.request.images, timestamp: thread.request.timestamp }
				: thread.pausedRequest,
	};
}

function storedManager(
	store: BtwHistoryStore,
	options: Omit<BtwManagerOptions, "restoredThreads" | "appendEvent" | "flushEvents">,
): BtwManager {
	const restoredThreads = [...store.getRecords()]
		.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
		.map(({ id, version: _version, phase, ...record }) => {
			if (phase === "running") throw new Error(`BTW history ${id} was not recovered`);
			return structuredClone({ ...record, key: id, phase });
		});
	const manager = new BtwManager({
		...options,
		restoredThreads,
		appendEvent: event => {
			if (event.op === "remove") {
				void store.remove(event.key);
				return;
			}
			const thread = manager.thread(event.key);
			if (!thread) throw new Error(`Unknown BTW thread: ${event.key}`);
			void store.upsert(historyRecord(thread));
		},
		flushEvents: () => store.flush(),
		closeEvents: () => store.close(),
	});
	return manager;
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

	it("restores an unprompted thread with its creation-time context and keeps that context across completed turns", async () => {
		const store = await BtwHistoryStore.open(undefined);
		const mainMessages: AgentMessage[] = [{ role: "user", content: "Original Main context", timestamp: 1 }];
		const requests: AgentMessage[][] = [];
		const restore = () =>
			storedManager(store, {
				createConversation: (_model, checkpoint) =>
					new EphemeralConversation({
						snapshotBaseMessages: () => structuredClone(mainMessages),
						sideSessionId: checkpoint?.sideSessionId ?? "side-frozen",
						checkpoint,
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

	it("allows different durable children to run concurrently without crossing phase, draft, turn, or unread state", async () => {
		const pending = new Map<string, PromiseWithResolvers<EphemeralTurnResult>>();
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
		for (let attempt = 0; attempt < 100 && !pending.has("Second"); attempt++) await Promise.resolve();
		expect(pending.has("First")).toBe(true);
		expect(pending.has("Second")).toBe(true);
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
		for (let attempt = 0; attempt < 100 && !pending.has("B"); attempt++) await Promise.resolve();
		expect(pending.has("A")).toBe(true);
		expect(pending.has("B")).toBe(true);
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
	});

	it("restores attachment-only draft edits and replays submitted images without crossing threads or changing Main", async () => {
		const firstImage: ImageContent = { type: "image", data: "Zmlyc3Q=", mimeType: "image/png" };
		const secondImage: ImageContent = { type: "image", data: "c2Vjb25k", mimeType: "image/png" };
		const mainMessages: AgentMessage[] = [{ role: "user", content: "Main context", timestamp: 1 }];
		const store = await BtwHistoryStore.open(undefined);
		const requests: AgentMessage[][] = [];
		let sequence = 0;
		const createConversation = (_model: BtwThreadModelRef, checkpoint?: EphemeralConversationCheckpoint) =>
			new EphemeralConversation({
				snapshotBaseMessages: () => mainMessages,
				sideSessionId: checkpoint?.sideSessionId ?? `side-${sequence}`,
				checkpoint,
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
		const store = await BtwHistoryStore.open(undefined);
		const manager = storedManager(store, {
			createConversation: (_model, checkpoint) => immediateConversation(checkpoint),
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
			createConversation: (_model, checkpoint) => immediateConversation(checkpoint),
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
		const store = await BtwHistoryStore.open(undefined);
		const mainMessages: AgentMessage[] = [{ role: "user", content: "Main before creation", timestamp: 1 }];
		const requests: AgentMessage[][] = [];
		const manager = storedManager(store, {
			createConversation: (_model, checkpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => structuredClone(mainMessages),
					sideSessionId: checkpoint?.sideSessionId ?? "side-before-prompt",
					checkpoint,
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

	it("reads and shares an approved summary with Main during its first turn, then restores native tool history", async () => {
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
		const store = await BtwHistoryStore.open(undefined);
		let sideRequests = 0;
		const sideStreamFn: StreamFn = (_model, context) => {
			const stream = new AssistantMessageEventStream();
			const request = ++sideRequests;
			queueMicrotask(() => {
				if (request === 1) {
					const toolCalls = [
						{ type: "toolCall" as const, id: "read-package", name: "read", arguments: {} },
						{
							type: "toolCall" as const,
							id: "share-package",
							name: "shareSummaryWithMain",
							arguments: { summary },
						},
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
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [wrappedReadTool] },
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
			toolRegistry: new Map([["read", wrappedReadTool]]),
			builtInToolNames: ["read"],
			sideStreamFn,
		});
		try {
			const options: Omit<BtwManagerOptions, "restoredThreads" | "appendEvent" | "flushEvents"> = {
				createConversation: (_model, checkpoint, sideOptions) =>
					session.createEphemeralConversation("side instructions", checkpoint, model, sideOptions),
				createSideOptions: source => ({
					readOnlyTools: true,
					shareSummaryWithMain: sharedSummary => session.publishBtwSummary({ ...source, summary: sharedSummary }),
				}),
				nextKey: () => "thread-capabilities",
				now: () => 100,
			};
			const manager = storedManager(store, options);
			const key = manager.createChild("Identify package", "main-leaf", { provider: model.provider, id: model.id });
			const result = await manager.prompt(key, "Read the package and share its identity.");
			await session.waitForIdle();

			expect(result.replyText).toBe("Read the package name.");
			expect(
				session.agent.state.messages.find(
					message => message.role === "custom" && message.customType === BTW_SUMMARY_MESSAGE_TYPE,
				),
			).toMatchObject({
				attribution: "agent",
				details: {
					summaries: [{ threadKey: key, threadTitle: "Identify package", summary }],
				},
			});
			const restored = storedManager(store, options);
			const followup = await restored.prompt(key, "What did you read?");
			expect(followup.replyText).toBe("Read the package name.");
			expect(
				restored.thread(key)?.turns[0]?.intermediateMessages?.filter(message => message.role === "toolResult"),
			).toMatchObject([
				{ toolCallId: "read-package", isError: false },
				{ toolCallId: "share-package", isError: false },
			]);
		} finally {
			await session.dispose();
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
			const store = await BtwHistoryStore.open(directory.path());
			const started = Promise.withResolvers<void>();
			const interrupted = storedManager(store, {
				createConversation: () =>
					new EphemeralConversation({
						snapshotBaseMessages: () => [],
						sideSessionId: "side-reopen",
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

			const reopened = await BtwHistoryStore.open(directory.path());
			const resumed = storedManager(reopened, {
				createConversation: (_model, checkpoint) => immediateConversation(checkpoint),
				nextKey: () => "unused",
				now: () => 200,
			});
			try {
				expect(await resumed.continuePaused()).toEqual({ continued: 1, skipped: [], complete: true });
				expect(resumed.thread(key)?.turns.at(-1)?.replyText).toBe("reply:Unfinished question");
				expect((await BtwHistoryStore.open(directory.path())).getRecords()[0]?.pausedRequest).toBeUndefined();
				expect(store.getRecords()[0]?.pausedRequest?.input).toBe("Unfinished question");
			} finally {
				await resumed.dispose();
			}
		},
		10_000,
	);

	it("preserves an image-only paused request across disposal and a failed continuation", async () => {
		const store = await BtwHistoryStore.open(undefined);
		const image: ImageContent = { type: "image", data: "cGF1c2Vk", mimeType: "image/png" };
		const images = [image];
		const turnStarted = Promise.withResolvers<void>();
		const interrupted = storedManager(store, {
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
		const pending = interrupted.prompt(key, "", undefined, undefined, images);
		await turnStarted.promise;
		images.length = 0;
		const draftImage: ImageContent = { type: "image", data: "ZHJhZnQ=", mimeType: "image/png" };
		interrupted.setDraft(key, "Next question", [draftImage], ["local://next.png"]);

		interrupted.prepareForPausedExit();
		await interrupted.dispose();
		await pending.catch(() => undefined);
		expect(interrupted.thread(key)?.pausedRequest?.images).toEqual([image]);
		await store.flush();

		const requests: AgentMessage[][] = [];
		let fail = true;
		const restore = () =>
			storedManager(store, {
				createConversation: (_model, checkpoint) =>
					new EphemeralConversation({
						snapshotBaseMessages: () => [],
						sideSessionId: checkpoint?.sideSessionId ?? "side-paused",
						checkpoint,
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
		expect(await restored.continuePaused()).toEqual({
			continued: 0,
			skipped: ["Pause me: Provider unavailable"],
			complete: false,
		});
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
		expect(retried.thread(key)?.pausedRequest).toBeUndefined();
		expect(retried.thread(key)).toMatchObject({
			draft: "Next question",
			draftImages: [draftImage],
			draftImageLinks: ["local://next.png"],
		});
	});
});
