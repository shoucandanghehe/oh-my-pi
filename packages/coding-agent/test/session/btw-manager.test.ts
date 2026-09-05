import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, ModelSpec, Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BtwManager, type BtwManagerOptions } from "@oh-my-pi/pi-coding-agent/session/btw-manager";
import {
	BTW_THREAD_CUSTOM_TYPE,
	type BtwThreadEvent,
	type BtwThreadModelRef,
	restoreBtwThreads,
} from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import {
	EphemeralConversation,
	type EphemeralConversationCheckpoint,
	type EphemeralConversationStatus,
	type EphemeralTurnResult,
} from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { BTW_SUMMARY_MESSAGE_TYPE, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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

function journalEntries(events: readonly BtwThreadEvent[]): CustomEntry<BtwThreadEvent>[] {
	return events.map((data, index) => ({
		type: "custom",
		customType: BTW_THREAD_CUSTOM_TYPE,
		data,
		id: `event-${index + 1}`,
		parentId: "main-leaf",
		timestamp: new Date(index * 1_000).toISOString(),
	}));
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
		const events: BtwThreadEvent[] = [];
		const mainMessages: AgentMessage[] = [{ role: "user", content: "Original Main context", timestamp: 1 }];
		const requests: AgentMessage[][] = [];
		const restore = () =>
			new BtwManager({
				entries: journalEntries(JSON.parse(JSON.stringify(events)) as BtwThreadEvent[]),
				appendEvent: event => events.push(event),
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
		mainMessages.push({ role: "user", content: "Later Main context", timestamp: 2 });

		const beforeFirstTurn = restore();
		await beforeFirstTurn.prompt(key, "Why?");
		expect(requests[0]?.filter(message => message.role === "user").map(userText)).toEqual([
			"Original Main context",
			"Why?",
		]);

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

		const first = manager.createChild("First", "anchor-1", MODEL);
		const second = manager.createChild("Second", "anchor-1", MODEL);
		const firstInitial = manager.prompt(first, "First");
		const secondInitial = manager.prompt(second, "Second");
		await Promise.resolve();
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
		await Promise.resolve();
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
		const events: BtwThreadEvent[] = [];
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
			new BtwManager({
				entries: journalEntries(JSON.parse(JSON.stringify(events)) as BtwThreadEvent[]),
				appendEvent: event => events.push(event),
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

		const restored = restore();
		const draft = restored.thread(first)!;
		expect(draft.draftImageLinks).toEqual([undefined, "local://first.png"]);
		await restored.prompt(first, draft.draft, undefined, undefined, draft.draftImages);
		expect(requests[0]?.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "" }, secondImage, firstImage],
		});
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

	it("journals promotion removal before transition and can revoke it without replacing the live thread", async () => {
		const events: BtwThreadEvent[] = [];
		const manager = new BtwManager({
			entries: [],
			appendEvent: event => events.push(event),
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
		expect(restoreBtwThreads(journalEntries(events))).toEqual([]);
		expect(manager.rollbackPromotion(key)).toBe(true);
		expect(manager.thread(key)).toBe(liveThread);
		expect(restoreBtwThreads(journalEntries(events))[0]).toMatchObject({
			draft: "",
			draftImages: [image],
			draftImageLinks: ["local://draft.png"],
		});
		const restored = new BtwManager({
			entries: journalEntries(events),
			appendEvent: event => events.push(event),
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

	it("creates a durable child directly, journaling it with a frozen snapshot before the first turn", async () => {
		const events: BtwThreadEvent[] = [];
		const mainMessages: AgentMessage[] = [{ role: "user", content: "Main before creation", timestamp: 1 }];
		const requests: AgentMessage[][] = [];
		const manager = new BtwManager({
			entries: [],
			appendEvent: event => events.push(event),
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
		expect(restoreBtwThreads(journalEntries(events))[0]?.turns.map(turn => turn.replyText)).toEqual([
			"reply:Direct?",
		]);
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
		const events: BtwThreadEvent[] = [];
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
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [readTool] },
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
			extensionRunner: {
				clearManagedTimers: () => {},
				consumeToolCallEmitted: () => false,
				getUIContext: () => ({ select: async () => "Approve" }),
				hasHandlers: () => false,
				hasUI: () => true,
				runScoped: <T>(run: () => T): T => run(),
			} as never,
			sideStreamFn,
		});
		try {
			const options: Omit<BtwManagerOptions, "entries"> = {
				appendEvent: event => events.push(event),
				createConversation: (_model, checkpoint, sideOptions) =>
					session.createEphemeralConversation("side instructions", checkpoint, model, sideOptions),
				createSideOptions: source => ({
					readOnlyTools: true,
					shareSummaryWithMain: sharedSummary => session.publishBtwSummary({ ...source, summary: sharedSummary }),
				}),
				nextKey: () => "thread-capabilities",
				now: () => 100,
			};
			const manager = new BtwManager({ ...options, entries: [] });
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
			const restored = new BtwManager({
				...options,
				entries: journalEntries(JSON.parse(JSON.stringify(events)) as BtwThreadEvent[]),
			});
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

	it("preserves an image-only paused request across restart and a failed continuation", async () => {
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
		const image: ImageContent = { type: "image", data: "cGF1c2Vk", mimeType: "image/png" };
		const images = [image];
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
		const pending = interrupted.prompt(key, "", undefined, undefined, images);
		await turnStarted.promise;
		images.length = 0;
		const draftImage: ImageContent = { type: "image", data: "ZHJhZnQ=", mimeType: "image/png" };
		interrupted.setDraft(key, "Next question", [draftImage], ["local://next.png"]);

		interrupted.prepareForPausedExit();
		await pending.catch(() => undefined);
		expect(interrupted.thread(key)?.pausedRequest?.images).toEqual([image]);

		const requests: AgentMessage[][] = [];
		let fail = true;
		const restore = () =>
			new BtwManager({
				entries: JSON.parse(JSON.stringify(entries)) as CustomEntry<BtwThreadEvent>[],
				appendEvent,
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
