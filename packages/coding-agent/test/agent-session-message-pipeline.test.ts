import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	AppendOnlyContextManager,
	type StreamFn,
} from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type Context,
	clearCustomApis,
	type ImageContent,
	type Message,
	type Model,
	type ModelSpec,
	registerCustomApi,
	type SimpleStreamOptions,
	type TextContent,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { type MnemopiSessionState, setMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { createAgentSession, type ExtensionContext, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { obfuscateProviderContext, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BtwManager } from "@oh-my-pi/pi-coding-agent/session/btw-manager";
import {
	BTW_SUMMARY_MESSAGE_TYPE,
	type BtwSummaryMessageDetails,
	convertToLlm,
	wrapSteeringForModel,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import sideChannelNoToolsReminder from "../src/prompts/system/side-channel-no-tools.md" with { type: "text" };
import sideChannelReadonlyReminder from "../src/prompts/system/side-channel-readonly.md" with { type: "text" };
import { ToolContextStore } from "../src/tools/context";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function createAgent(): Agent {
	return new Agent({
		initialState: {
			systemPrompt: ["system prompt"],
			messages: [],
			tools: [],
		},
	});
}

function createModelRegistryStub(key = "key") {
	return {
		getApiKey: vi.fn(async () => key),
		resolver: vi.fn(() => async () => key),
	};
}

function getConvertedUserText(message: Message | undefined): string {
	if (message?.role !== "user") {
		throw new Error("Expected converted user message");
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	const text = message.content.find((content): content is TextContent => content.type === "text");
	if (!text) {
		throw new Error("Expected converted text content");
	}
	return text.text;
}

async function withNativeDialectEnv<T>(fn: () => Promise<T>): Promise<T> {
	const previous = Bun.env.PI_DIALECT;
	delete Bun.env.PI_DIALECT;
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete Bun.env.PI_DIALECT;
		} else {
			Bun.env.PI_DIALECT = previous;
		}
	}
}

describe("AgentSession message pipeline", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("applies transformContext before convertToLlm", async () => {
		const inputMessages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		const transformedMessages: AgentMessage[] = [
			...inputMessages,
			{ role: "user", content: "injected context", timestamp: Date.now() },
		];
		const convertedMessages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "converted" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		];
		const transformContext = vi.fn(async (messages: AgentMessage[], signal?: AbortSignal) => {
			expect(signal).toBe(abortController.signal);
			return [...messages, ...transformedMessages.slice(messages.length)];
		});
		const convertToLlm = vi.fn(async (_messages: AgentMessage[]) => {
			return convertedMessages;
		});
		const abortController = new AbortController();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext,
			convertToLlm,
		});
		sessions.push(session);

		const result = await session.convertMessagesToLlm(inputMessages, abortController.signal);

		expect(transformContext).toHaveBeenCalledWith(inputMessages, abortController.signal);
		expect(convertToLlm).toHaveBeenCalledWith(transformedMessages);
		expect(result).toEqual(convertedMessages);
	});

	it("marks queued user steers without changing the public queue text", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);
		// #queueUserMessage schedules an idle-queue drain that would agent.continue()
		// and pop the steer before we can inspect it; stub it out to observe the queue.
		vi.spyOn(session.agent, "continue").mockResolvedValue(undefined);

		await session.sendUserMessage("raw <steer> &", { deliverAs: "steer" });

		expect(session.getQueuedMessages().steering).toEqual(["raw <steer> &"]);
		const queued = session.agent.popLastSteer();
		if (queued?.role !== "user") {
			throw new Error("Expected queued user steer");
		}
		expect(queued.steering).toBe(true);
		expect(queued.content).toEqual([{ type: "text", text: "raw <steer> &" }]);
		session.clearQueue();
	});

	it("resolves image attachments from submitted messages, not tool-result images", () => {
		const userImage: ImageContent = { type: "image", data: "user-image", mimeType: "image/png" };
		const toolImage: ImageContent = { type: "image", data: "tool-image", mimeType: "image/png" };
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "inspect this" }, userImage],
			timestamp: Date.now(),
		});
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "eval-1",
			toolName: "eval",
			content: [{ type: "text", text: "plot output" }, toolImage],
			timestamp: Date.now(),
			isError: false,
		});

		const attachments = session.getImageAttachments();
		const sourcePath = attachments[0]?.sourcePath;
		if (!sourcePath) {
			throw new Error("Expected attachment sourcePath to be populated");
		}
		expect(attachments).toEqual([{ label: "Image #1", uri: "attachment://1", image: userImage, sourcePath }]);
	});

	it("normalizes historical WebP on the main provider request path", async () => {
		using tempDir = TempDir.createSync("@pi-stb-main-path-");
		const api = "test-stb-main-path";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const seed = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			"base64",
		);
		const webpData = Buffer.from(await new Bun.Image(seed).resize(2, 2).webp({ quality: 90 }).bytes()).toBase64();
		const historicalImage: ImageContent = {
			type: "image",
			data: webpData,
			// Confirm byte sniffing catches persisted blocks with stale metadata.
			mimeType: "image/png",
		};
		const model = buildModel({
			id: "stb-main-path",
			name: "STB main path",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text", "image"],
			imageInputDecoder: "stb",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		try {
			session.agent.appendMessage({
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "screenshot" }, historicalImage],
				isError: false,
				timestamp: 1,
			});

			await session.sendUserMessage("continue");

			expect(contexts).toHaveLength(1);
			const outboundImages: ImageContent[] = [];
			for (const message of contexts[0]!.messages) {
				if (typeof message.content === "string") continue;
				for (const part of message.content) {
					if (part.type === "image") outboundImages.push(part);
				}
			}
			expect(outboundImages).toHaveLength(1);
			expect(outboundImages[0]!.mimeType).not.toBe("image/webp");
			expect(Buffer.from(outboundImages[0]!.data.slice(0, 16), "base64").toString("ascii", 8, 12)).not.toBe("WEBP");
			expect(historicalImage.mimeType).toBe("image/png");
			expect(Buffer.from(historicalImage.data.slice(0, 16), "base64").toString("ascii", 8, 12)).toBe("WEBP");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("continues a user turn when an attached WebP is undecodable by an STB model", async () => {
		using tempDir = TempDir.createSync("@pi-stb-corrupt-attachment-");
		const api = "test-stb-corrupt-attachment";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "stb-corrupt-attachment",
			name: "STB corrupt attachment",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text", "image"],
			imageInputDecoder: "stb",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		try {
			// Session persistence accepts historical image blocks without MIME
			// metadata, so exercise that runtime shape through the real provider path.
			const corrupt = {
				type: "image",
				data: Buffer.from("RIFF0000WEBPbroken-attachment").toBase64(),
			} as unknown as ImageContent;

			await session.sendUserMessage([{ type: "text", text: "inspect this" }, corrupt]);

			expect(contexts).toHaveLength(1);
			const userMessage = contexts[0]!.messages.find(message => message.role === "user");
			// The date/cwd reminder rides on the first user turn (#7404); the contract
			// here is that the undecodable WebP is replaced by the placeholder text.
			expect(userMessage?.content).toEqual([
				{ type: "text", text: expect.stringContaining("<system-reminder>") },
				{ type: "text", text: "inspect this" },
				{ type: "text", text: "[image omitted: WebP could not be decoded for this model]" },
			]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("keeps stored steering text raw while pre-LLM conversion wraps it", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext: wrapSteeringForModel,
			convertToLlm,
		});
		sessions.push(session);
		const raw: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "steer with <xml> & ampersand" }],
			steering: true,
			timestamp: 1,
		};
		session.agent.appendMessage(raw);

		const converted = await session.convertMessagesToLlm(session.messages);

		expect(session.messages[0]).toBe(raw);
		expect(raw.content).toEqual([{ type: "text", text: "steer with <xml> & ampersand" }]);
		const convertedText = getConvertedUserText(converted[0]);
		expect(convertedText).toContain("<system-notice>");
		expect(convertedText).not.toContain("<message>");
		expect(convertedText).toContain("steer with <xml> & ampersand");
		expect(convertedText).not.toContain("&lt;xml&gt;");
		expect(convertedText).not.toContain("&amp;");
	});

	it("composes session payload hooks into direct side-request options", async () => {
		const sessionOnPayload = vi.fn(async (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			session: true,
		}));
		const requestOnPayload = vi.fn(async () => undefined);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onPayload: sessionOnPayload,
		});
		sessions.push(session);
		const options: SimpleStreamOptions = {
			apiKey: "key",
			onPayload: requestOnPayload,
		};

		const prepared = session.prepareSimpleStreamOptions(options);
		const result = await prepared.onPayload?.({ original: true });

		expect(sessionOnPayload).toHaveBeenCalledWith({ original: true }, undefined);
		expect(requestOnPayload).toHaveBeenCalledWith({ original: true, session: true }, undefined);
		expect(result).toEqual({ original: true, session: true });
	});
	it("keeps ephemeral side-channel cache key separate from provider routing while preserving websocket state", async () => {
		const api = "test-ephemeral-side-channel";
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-model",
			name: "Side Model",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const promptCacheKey = "inherited-parent-cache";
		const session = new AgentSession({
			agent: new Agent({
				promptCacheKey,
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			preferWebsockets: true,
		});
		sessions.push(session);
		const cacheSessionId = session.sessionId;

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Answer");
		expect(capturedOptions?.promptCacheKey).toBe(promptCacheKey);
		expect(capturedOptions?.sessionId).toStartWith(`${cacheSessionId}:side:`);
		expect(capturedOptions?.sessionId).not.toBe(cacheSessionId);
		expect(capturedOptions?.preferWebsockets).toBe(true);
		expect(capturedOptions?.providerSessionState).toBe(session.providerSessionState);
	});

	it("snapshots each side conversation on its first prompt and keeps one provider lineage", async () => {
		const model = buildModel({
			id: "side-stream-model",
			name: "Side Stream Model",
			api: "anthropic",
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const capturedOptions: SimpleStreamOptions[] = [];
		const capturedContexts: Context[] = [];
		const sideStreamFn: StreamFn = (_model, context, options) => {
			capturedContexts.push(context);
			capturedOptions.push(options ?? {});
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const text = `Side answer ${capturedContexts.length}`;
				const message = createAssistantMessage(text);
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			sideStreamFn,
		});
		sessions.push(session);

		const conversation = session.createEphemeralConversation("side instructions");
		const first = await conversation.prompt("Question 1?");
		const refreshedConversation = session.createEphemeralConversation("side instructions");
		session.agent.appendMessage({ role: "user", content: "late main turn", timestamp: Date.now() });
		const second = await conversation.prompt("Question 2?");
		const refreshed = await refreshedConversation.prompt("Question after refresh?");

		expect(first.replyText).toBe("Side answer 1");
		expect(second.replyText).toBe("Side answer 2");
		expect(conversation.turns.map(turn => turn.input)).toEqual(["Question 1?", "Question 2?"]);
		expect(refreshed.replyText).toBe("Side answer 3");
		expect(capturedOptions[0]?.sessionId).toStartWith(`${session.sessionId}:side:`);
		expect(capturedOptions[1]?.sessionId).toBe(capturedOptions[0]?.sessionId);
		expect(capturedContexts).toHaveLength(3);
		const [firstContext, secondContext] = capturedContexts;
		if (!firstContext || !secondContext) throw new Error("Expected both side-conversation provider contexts");
		expect(secondContext.messages.slice(0, firstContext.messages.length)).toEqual(firstContext.messages);
		const secondUsers = capturedContexts[1]?.messages.filter(
			(message): message is Extract<Message, { role: "user" }> => message.role === "user",
		);
		expect(secondUsers?.map(getConvertedUserText)).toEqual(["Question 1?", "Question 2?"]);
		expect(capturedContexts[1]?.messages.some(message => JSON.stringify(message).includes("late main turn"))).toBe(
			false,
		);
		expect(capturedContexts[2]?.messages.some(message => JSON.stringify(message).includes("late main turn"))).toBe(
			true,
		);
	});

	it("streams durable tool messages and preserves capability history across restore", async () => {
		const model = buildModel({
			id: "kimi-k3.5",
			name: "Kimi K3.5",
			api: "anthropic-messages",
			provider: "kimi-code",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const capturedContexts: Context[] = [];
		const capturedOptions: SimpleStreamOptions[] = [];
		const deltas: string[] = [];
		const liveMessageEvents: string[] = [];
		const endedMessages: AgentMessage[] = [];
		let executions = 0;
		const sideStreamFn: StreamFn = (_model, context, options) => {
			capturedContexts.push(context);
			capturedOptions.push(options ?? {});
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (capturedContexts.length === 1) {
					const toolCall = {
						type: "toolCall" as const,
						id: "side-call-1",
						name: "side_tool",
						arguments: {},
					};
					const message = createAssistantMessage("");
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
					return;
				}
				const text = capturedContexts.length === 2 ? "Recovered without tools" : "Follow-up answer";
				const message = createAssistantMessage(text);
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const tool: AgentTool = {
			name: "side_tool",
			label: "Side Tool",
			description: "Must remain unavailable in side conversations",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "executed" }], details: {} };
			},
		};
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [tool],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			sideStreamFn,
		});
		sessions.push(session);

		const conversation = session.createEphemeralConversation("side instructions");
		expect(conversation.getTool("side_tool")?.label).toBe("Side Tool");
		const first = await conversation.prompt("Question?", {
			onTextDelta: delta => deltas.push(delta),
			onMessage: event => {
				liveMessageEvents.push(`${event.type}:${event.message.role}`);
				if (event.type === "end") endedMessages.push(event.message);
			},
		});

		expect(first.replyText).toBe("Recovered without tools");
		expect(deltas).toEqual(["Recovered without tools"]);
		expect(executions).toBe(0);
		expect(capturedContexts).toHaveLength(2);
		expect(capturedContexts[0]?.tools?.map(tool => tool.name)).toEqual(["side_tool"]);
		expect(capturedOptions[0]?.promptCacheKey).toBe(session.sessionId);
		expect(capturedOptions[1]?.sessionId).toBe(capturedOptions[0]?.sessionId);
		expect(capturedContexts[1]?.messages.find(message => message.role === "toolResult")).toMatchObject({
			role: "toolResult",
			toolCallId: "side-call-1",
			toolName: "side_tool",
			isError: true,
		});
		const checkpoint = conversation.checkpoint();
		expect(checkpoint.turns[0]?.intermediateMessages).toHaveLength(2);
		expect(liveMessageEvents.filter(event => event.startsWith("end:"))).toEqual([
			"end:assistant",
			"end:toolResult",
			"end:assistant",
		]);
		expect(endedMessages.slice(0, 2)).toMatchObject([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "side-call-1", name: "side_tool" }],
			},
			{
				role: "toolResult",
				toolCallId: "side-call-1",
				toolName: "side_tool",
				isError: true,
			},
		]);

		const restored = session.createEphemeralConversation("side instructions", checkpoint, undefined, {
			readOnlyTools: true,
		});
		await restored.prompt("Follow up?");

		expect(capturedContexts).toHaveLength(3);
		expect(capturedOptions[2]?.sessionId).toBe(capturedOptions[0]?.sessionId);
		expect(capturedContexts[2]?.messages.find(message => message.role === "toolResult")).toMatchObject({
			toolCallId: "side-call-1",
			isError: true,
		});
		const restoredMessages = capturedContexts[2]?.messages ?? [];
		const reminderIndex = (text: string): number =>
			restoredMessages.findIndex(
				message =>
					message.role === "developer" &&
					JSON.stringify(message.content) === JSON.stringify([{ type: "text", text }]),
			);
		const userIndex = (text: string): number =>
			restoredMessages.findIndex(message => message.role === "user" && getConvertedUserText(message) === text);
		const noToolsIndex = reminderIndex(sideChannelNoToolsReminder);
		const readonlyIndex = reminderIndex(sideChannelReadonlyReminder);
		const quickUserIndex = userIndex("Question?");
		const durableUserIndex = userIndex("Follow up?");
		expect(noToolsIndex).toBeGreaterThanOrEqual(0);
		expect(noToolsIndex).toBeLessThan(quickUserIndex);
		expect(readonlyIndex).toBeGreaterThan(quickUserIndex);
		expect(readonlyIndex).toBeLessThan(durableUserIndex);
	});

	it("prompts for a durable BTW summary without waiting for Main's transcript preview", async () => {
		const model = buildModel({
			id: "btw-summary-approval",
			name: "BTW Summary Approval",
			api: "anthropic-messages",
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		let requests = 0;
		const sideStreamFn: StreamFn = () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const toolCall = {
						type: "toolCall" as const,
						id: "share-summary-call",
						name: "shareSummaryWithMain",
						arguments: { summary: "Cache invalidation must happen after commit." },
					};
					const message = createAssistantMessage("");
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
					return;
				}
				const text = "The summary was not shared.";
				const message = createAssistantMessage(text);
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const select = vi.fn(async (_title: string) => "Deny");
		const previewWait = vi.fn(async () => {
			throw new Error("BTW tools must not wait for Main's transcript preview");
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"tools.approvalMode": "yolo",
		});
		const modelRegistry = createModelRegistryStub() as never;
		const toolContextStore = new ToolContextStore(() => ({
			sessionManager,
			modelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings,
		}));
		const extensionRunner = {
			clearManagedTimers: () => {},
			consumeToolCallEmitted: () => false,
			getUIContext: () => ({ select }),
			hasHandlers: () => false,
			hasUI: () => true,
			waitForToolApprovalPreview: previewWait,
		};
		const shareWithMain = vi.fn(async (_summary: string) => {});
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
				getToolContext: toolCall => toolContextStore.getContext(toolCall),
			}),
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: extensionRunner as never,
			sideStreamFn,
		});
		sessions.push(session);

		const conversation = session.createEphemeralConversation("side instructions", undefined, undefined, {
			readOnlyTools: true,
			shareSummaryWithMain: shareWithMain,
		});
		const result = await conversation.prompt("Share what we found with Main.");

		expect(result.replyText).toBe("The summary was not shared.");
		expect(shareWithMain).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[0]).toContain("Cache invalidation must happen after commit.");
		expect(previewWait).not.toHaveBeenCalled();
	});

	it("shares an approved durable BTW summary with Main as attributed inbound context", async () => {
		const model = buildModel({
			id: "btw-summary-ingress",
			name: "BTW Summary Ingress",
			api: "anthropic-messages",
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const summary = "Cache entries must be invalidated after the transaction commits.";
		const mainContexts: Context[] = [];
		const mainStreamFn: StreamFn = (_model, context) => {
			mainContexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(mainContexts.length === 1 ? "Main ready." : "Summary received.");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		let sideRequests = 0;
		const sideStreamFn: StreamFn = () => {
			sideRequests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (sideRequests === 1) {
					const toolCall = {
						type: "toolCall" as const,
						id: "share-summary-call",
						name: "shareSummaryWithMain",
						arguments: { summary },
					};
					const message = createAssistantMessage("");
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
					return;
				}
				const message = createAssistantMessage("Summary shared.");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const select = vi.fn(async (_title: string) => "Approve");
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
				streamFn: mainStreamFn,
				convertToLlm,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"tools.approvalMode": "yolo",
			}),
			modelRegistry: createModelRegistryStub() as never,
			extensionRunner: {
				clearManagedTimers: () => {},
				consumeToolCallEmitted: () => false,
				getUIContext: () => ({ select }),
				hasHandlers: () => false,
				hasUI: () => true,
				runScoped: <T>(run: () => T): T => run(),
			} as never,
			sideStreamFn,
		});
		sessions.push(session);
		const manager = new BtwManager({
			entries: [],
			appendEvent: () => {},
			createConversation: (_modelRef, checkpoint, sideOptions) =>
				session.createEphemeralConversation("side instructions", checkpoint, model, sideOptions),
			createSideOptions: source => ({
				readOnlyTools: true,
				shareSummaryWithMain: sharedSummary =>
					session.publishBtwSummary({
						...source,
						summary: sharedSummary,
					}),
			}),
			nextKey: () => "btw-cache",
			now: () => 123,
		});
		const threadKey = manager.createChild("Investigate cache invalidation", "main-leaf", {
			provider: model.provider,
			id: model.id,
		});

		const result = await manager.prompt(threadKey, "Share the conclusion with Main.");
		await session.waitForIdle();

		expect(result.replyText).toBe("Summary shared.");
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[0]).toContain("Allow tool: shareSummaryWithMain");
		expect(select.mock.calls[0]?.[0]).toContain(summary);
		const record = session.agent.state.messages.find(
			message => message.role === "custom" && message.customType === BTW_SUMMARY_MESSAGE_TYPE,
		);
		expect(record).toMatchObject({
			role: "custom",
			customType: BTW_SUMMARY_MESSAGE_TYPE,
			attribution: "agent",
			display: true,
			details: {
				summaries: [
					{
						threadKey: "btw-cache",
						threadTitle: "Investigate cache invalidation",
						summary,
					},
				],
			} satisfies BtwSummaryMessageDetails,
		});
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		const inbound = mainContexts
			.at(-1)
			?.messages.find(
				message => message.role === "developer" && JSON.stringify(message.content).includes("<btw-summary"),
			);
		expect(JSON.stringify(inbound?.content)).toContain("btw-cache");
		expect(JSON.stringify(inbound?.content)).toContain("Investigate cache invalidation");
		expect(JSON.stringify(inbound?.content)).toContain(summary);
	});

	it("blocks inherited object-key tool names in read-only side conversations", async () => {
		const model = buildModel({
			id: "readonly-side-model",
			name: "Readonly Side Model",
			api: "anthropic-messages",
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		let requests = 0;
		let executions = 0;
		const sideStreamFn: StreamFn = () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const toolCall = {
						type: "toolCall" as const,
						id: "inherited-name-call",
						name: "constructor",
						arguments: {},
					};
					const message = createAssistantMessage("");
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
					return;
				}
				const message = createAssistantMessage("Recovered without executing");
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: "Recovered without executing",
					partial: message,
				});
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const tool: AgentTool = {
			name: "constructor",
			label: "Inherited key",
			description: "Must remain unavailable in read-only side conversations",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "executed" }], details: {} };
			},
		};
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [tool],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			sideStreamFn,
		});
		sessions.push(session);

		const conversation = session.createEphemeralConversation("side instructions", undefined, undefined, {
			readOnlyTools: true,
		});
		const result = await conversation.prompt("Try the inherited name");

		expect(result.replyText).toBe("Recovered without executing");
		expect(executions).toBe(0);
		expect(result.intermediateMessages?.find(message => message.role === "toolResult")).toMatchObject({
			role: "toolResult",
			toolCallId: "inherited-name-call",
			toolName: "constructor",
			isError: true,
		});
	});

	it("migrates a legacy side-conversation checkpoint without refreshing Main context or provider lineage", async () => {
		const model = buildModel({
			id: "restored-side-model",
			name: "Restored Side Model",
			api: "anthropic",
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const capturedOptions: SimpleStreamOptions[] = [];
		const capturedContexts: Context[] = [];
		const sideStreamFn: StreamFn = (_model, context, options) => {
			capturedContexts.push(context);
			capturedOptions.push(options ?? {});
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const text = `Restored answer ${capturedContexts.length}`;
				const message = createAssistantMessage(text);
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [{ role: "user", content: "anchor main turn", timestamp: Date.now() }],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			sideStreamFn,
		});
		sessions.push(session);

		const original = session.createEphemeralConversation("side instructions");
		await original.prompt("Question 1?", { dedupeReply: false });
		const checkpoint = original.checkpoint();
		const firstTurn = checkpoint.turns[0];
		if (!firstTurn) throw new Error("Expected one side-conversation turn");
		const { prefixMessages: _prefixMessages, ...legacyTurn } = firstTurn;
		const legacyCheckpoint = {
			...checkpoint,
			baseMessages: [
				...checkpoint.baseMessages,
				{
					role: "developer" as const,
					content: [{ type: "text" as const, text: sideChannelNoToolsReminder }],
					attribution: "agent" as const,
					timestamp: Date.now(),
				},
			],
			turns: [legacyTurn],
		};
		expect(legacyCheckpoint.baseMessages).toHaveLength(checkpoint.baseMessages.length + 1);
		session.agent.appendMessage({ role: "user", content: "late main turn", timestamp: Date.now() });
		const restored = session.createEphemeralConversation("side instructions", legacyCheckpoint);
		await restored.prompt("Question 2?", { dedupeReply: false });
		const firstMessages = capturedContexts[0]?.messages ?? [];
		const restoredPrefix = (capturedContexts[1]?.messages ?? []).slice(0, firstMessages.length);
		expect(restoredPrefix.map(({ timestamp: _timestamp, ...message }) => message)).toEqual(
			firstMessages.map(({ timestamp: _timestamp, ...message }) => message),
		);
		expect(
			capturedContexts[1]?.messages.some(
				message =>
					message.role === "developer" &&
					JSON.stringify(message.content) === JSON.stringify([{ type: "text", text: sideChannelNoToolsReminder }]),
			),
		).toBe(true);
		expect(restored.turns.map(turn => turn.input)).toEqual(["Question 1?", "Question 2?"]);
		expect(capturedOptions[1]?.sessionId).toBe(capturedOptions[0]?.sessionId);
		expect(capturedContexts[1]?.messages.some(message => JSON.stringify(message).includes("late main turn"))).toBe(
			false,
		);
		const restoredUsers = capturedContexts[1]?.messages.filter(
			(message): message is Extract<Message, { role: "user" }> => message.role === "user",
		);
		expect(restoredUsers?.map(getConvertedUserText)).toEqual(["anchor main turn", "Question 1?", "Question 2?"]);
	});

	it("rotates ephemeral side-channel credentials on Google Resource exhausted", async () => {
		const api = "test-ephemeral-google-resource-exhausted";
		const googleErrorMessage = "Google API error (429): Resource exhausted. Please try again later.";
		const keys: unknown[] = [];
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			keys.push(options?.apiKey);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (options?.apiKey === "next-key") {
					const message = createAssistantMessage("Recovered");
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Recovered", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					return;
				}

				const error = createAssistantMessage("");
				error.content = [];
				error.stopReason = "error";
				error.errorMessage = googleErrorMessage;
				error.errorStatus = 429;
				stream.push({ type: "start", partial: error });
				stream.push({ type: "error", reason: "error", error });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-google-model",
			name: "Side Google Model",
			api,
			provider: "google",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const resolver = vi.fn(
			() => async (ctx: { error: unknown }) => (ctx.error === undefined ? "old-key" : "next-key"),
		);
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				getApiKey: vi.fn(async () => "old-key"),
				resolver,
			} as never,
		});
		sessions.push(session);
		const cacheSessionId = session.sessionId;

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Recovered");
		expect(keys).toEqual(["old-key", "next-key"]);
		expect(capturedOptions?.promptCacheKey).toBe(cacheSessionId);
		expect(capturedOptions?.sessionId).toStartWith(`${cacheSessionId}:side:`);
		expect(resolver).toHaveBeenCalledWith(model, cacheSessionId);
	});

	it("applies configured OpenRouter routing variant to ephemeral side-channel options", async () => {
		const api = "test-ephemeral-openrouter-variant";
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "anthropic/claude-sonnet-4",
			name: "OpenRouter Model",
			api,
			provider: "openrouter",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"providers.openrouterVariant": "nitro",
			}),
			modelRegistry: createModelRegistryStub() as never,
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Answer");
		expect(capturedOptions?.openrouterVariant).toBe("nitro");
	});

	it("obfuscates user messages on ephemeral side-channel requests", async () => {
		const api = "test-ephemeral-secret-redaction";
		const secret = "EPHEMERAL_SECRET_TOKEN_12345";
		let capturedContext: Context | undefined;
		registerCustomApi(api, (_model, context, _options) => {
			capturedContext = context;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-model-secrets",
			name: "Side Model Secrets",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			obfuscator: new SecretObfuscator([{ type: "plain", content: secret }]),
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: `question about ${secret}` });

		expect(result.replyText).toBe("Answer");
		expect(capturedContext).toBeDefined();
		// The secret entered only via the user prompt, which the opt-in obfuscator redacts.
		expect(JSON.stringify(capturedContext)).not.toContain(secret);
	});

	it("keeps obfuscated side-channel stable prefix byte-identical to the main turn", async () => {
		await withNativeDialectEnv(async () => {
			const api = "test-ephemeral-obfuscated-prefix-parity";
			const secret = "PREFIX_SECRET_TOKEN_12345";
			let callCount = 0;
			let mainContext: Context | undefined;
			let sideContext: Context | undefined;
			registerCustomApi(api, (_model, context, _options) => {
				if (callCount === 0) {
					mainContext = context;
				} else {
					sideContext = context;
				}
				callCount += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("Answer");
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			});

			const model = buildModel({
				id: "side-model-prefix-parity",
				name: "Side Model Prefix Parity",
				api,
				provider: "test-provider",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			} as ModelSpec<Api>) as Model<Api>;
			const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
			const tool: AgentTool = {
				name: "secret_probe",
				label: "Secret Probe",
				description: `Tool description ${secret}`,
				parameters: {
					type: "object",
					properties: {
						value: { type: "string", description: `Schema description ${secret}` },
					},
					required: ["value"],
				},
				execute: async () => ({ content: [], details: {} }),
			};
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: [`system prompt with ${secret}`],
					messages: [],
					tools: [tool],
				},
				transformProviderContext: context => obfuscateProviderContext(obfuscator, context),
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: createModelRegistryStub() as never,
				obfuscator,
			});
			sessions.push(session);

			await agent.prompt("Main Question?");
			await session.runEphemeralTurn({ promptText: `Side Question ${secret}?` });

			// The static prefix (system prompt + tools) is left untouched, so it stays byte-identical
			// between the main turn and the side turn and the prompt cache prefix survives.
			expect(JSON.stringify(mainContext?.systemPrompt)).toBe(JSON.stringify(sideContext?.systemPrompt));
			expect(JSON.stringify(mainContext?.tools)).toBe(JSON.stringify(sideContext?.tools));
			// The side turn's user prompt secret is redacted from the outbound messages.
			expect(JSON.stringify(sideContext?.messages)).not.toContain(secret);
		});
	});

	it("records raw SSE diagnostics into the session buffer before request hooks", async () => {
		const requestOnSseEvent = vi.fn();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onSseEvent: requestOnSseEvent,
		});
		sessions.push(session);

		const prepared = session.prepareSimpleStreamOptions({});
		prepared.onSseEvent?.({ event: "message", data: "{}", raw: ["event: message", "data: {}"] });

		expect(session.rawSseDebugBuffer.snapshot().totalEvents).toBe(1);
		expect(requestOnSseEvent).toHaveBeenCalledWith(
			{ event: "message", data: "{}", raw: ["event: message", "data: {}"] },
			undefined,
		);
	});

	it("emits message_update to session listeners before slow extension handlers finish", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const extensionEmit = vi.fn(async (event: { type: string }) => {
			if (event.type === "message_update") {
				await promise;
			}
		});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				hasHandlers: () => true,
				emit: extensionEmit,
			} as never,
		});
		sessions.push(session);

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});

		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "edit",
					arguments: {},
					partialJson: '{"file":"preview.txt","steps":[{"kbd":["ggdGi"],"insert":"rep',
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as const;

		session.agent.emitExternalEvent({
			type: "message_update",
			message: assistantMessage as never,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "rep",
			},
		} as never);

		await Bun.sleep(0);

		expect(events.some(event => event.type === "message_update")).toBe(true);
		expect(extensionEmit).toHaveBeenCalledTimes(1);

		resolve();
		await Bun.sleep(0);
	});

	it("keeps first-turn memory in the stable prompt on the next turn", async () => {
		const api = "test-injected-memory-append-only-cache";
		const contexts: Context[] = [];
		let remembered = false;
		const injected = "<memories>remember blue</memories>";
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return remembered ? `static memory instructions\n\n${injected}` : "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (remembered) return undefined;
				remembered = true;
				return injected;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-model",
			name: "Local Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base", "static memory instructions"],
				messages: [],
				tools: [],
			},
		});
		agent.setAppendOnlyContext(new AppendOnlyContextManager());
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "provider.appendOnlyContext": "on" }),
			modelRegistry: createModelRegistryStub() as never,
			rebuildSystemPrompt: async () => ({
				systemPrompt: remembered
					? ["base", `static memory instructions\n\n${injected}`]
					: ["base", "static memory instructions"],
			}),
		});
		sessions.push(session);

		await session.sendUserMessage("first");
		await session.sendUserMessage("second");

		expect(contexts).toHaveLength(2);
		const firstSystemPrompt = contexts[0]!.systemPrompt;
		expect(firstSystemPrompt).toBeDefined();
		expect(firstSystemPrompt!.join("\n")).toContain(injected);
		expect(contexts[1]!.systemPrompt).toEqual(firstSystemPrompt);
	});

	it("preserves append-only prefixes in subagent sessions when context handlers rewrite prior turns", async () => {
		using tempDir = TempDir.createSync("@pi-subagent-append-only-");
		const api = "test-subagent-append-only-cache";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(`ok-${contexts.length}`);
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-subagent-model",
			name: "Local Subagent Model",
			api,
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const rewritePriorAssistant: ExtensionFactory = pi => {
			pi.on("context", async event => {
				const hasSecondTurn = event.messages.some(message => {
					if (message.role !== "user") return false;
					const content = message.content;
					if (typeof content === "string") return content.includes("second");
					return content.some(part => part.type === "text" && part.text.includes("second"));
				});
				if (!hasSecondTurn) return undefined;
				return {
					messages: event.messages.map(message =>
						message.role === "assistant"
							? { ...message, content: [{ type: "text" as const, text: "rewritten assistant" }] }
							: message,
					),
				};
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"provider.appendOnlyContext": "auto",
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [rewritePriorAssistant],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		try {
			expect(session.agent.appendOnlyContext).toBeDefined();

			await session.sendUserMessage("first");
			await session.sendUserMessage("second");

			expect(contexts).toHaveLength(2);
			expect(contexts[0]!.messages).toHaveLength(1);
			expect(contexts[1]!.messages).toHaveLength(3);
			expect(contexts[1]!.messages[0]).toBe(contexts[0]!.messages[0]);
			expect((contexts[1]!.messages[1] as { content: unknown }).content).toEqual([
				{ type: "text", text: "rewritten assistant" },
			]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
	it("applies a tool_call input revision at arg-prep time across events, execution, and history", async () => {
		// End-to-end wiring for the loop-level tool_call emission (session
		// #beforeToolCall): the handler fires once per dispatch (the wrapper's
		// own emission is suppressed via the runner marker), the revision is what
		// tool_execution_start reports, what bash executes, and what the
		// assistant message persists.
		using tempDir = TempDir.createSync("@pi-tool-call-revision-");
		const api = "test-tool-call-revision";
		let requests = 0;
		registerCustomApi(api, () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const message = createAssistantMessage("");
					const toolCall = {
						type: "toolCall",
						id: "call-revise-1",
						name: "bash",
						arguments: { command: "echo original" },
					} as const;
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "local-revision-model",
			name: "Local Revision Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		let handlerCalls = 0;
		const reviseBash: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				if (event.toolName !== "bash") return undefined;
				handlerCalls++;
				return { input: { command: "echo revised" } };
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [reviseBash],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["bash"],
		});
		try {
			const startArgs: unknown[] = [];
			session.subscribe(event => {
				if (event.type === "tool_execution_start") startArgs.push(event.args);
			});

			await session.sendUserMessage("run it");

			expect(handlerCalls).toBe(1);
			expect(startArgs).toEqual([{ command: "echo revised" }]);
			const messages = session.agent.state.messages;
			const toolCallBlock = messages
				.filter(m => m.role === "assistant")
				.flatMap(m => (m as { content: Array<{ type: string }> }).content)
				.find(c => c.type === "toolCall") as { arguments?: unknown } | undefined;
			expect(toolCallBlock?.arguments).toEqual({ command: "echo revised" });
			const toolResult = messages.find(m => m.role === "toolResult") as
				| { content: Array<{ type: string; text?: string }> }
				| undefined;
			const text = toolResult?.content.find(block => block.type === "text")?.text ?? "";
			expect(text).toContain("revised");
			expect(text).not.toContain("original");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
	it("exposes ctx.invokeTool to a re-registered built-in so it can delegate to the native tool", async () => {
		// End-to-end for the extension path: a tool that re-registers `bash` receives ctx.invokeTool
		// (bound to its own name), delegates to the native bash, and the native output flows back.
		using tempDir = TempDir.createSync("@pi-invoke-tool-");
		const api = "test-invoke-tool";
		let requests = 0;
		registerCustomApi(api, () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const message = createAssistantMessage("");
					const toolCall = {
						type: "toolCall",
						id: "call-invoke-1",
						name: "bash",
						arguments: { command: "echo from-model" },
					} as const;
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "local-invoke-model",
			name: "Local Invoke Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		let invokeToolPresent = false;
		let delegatedText = "";
		// Re-register `bash`: the wrapper ignores the model's args, delegates to the native bash with
		// its own command via ctx.invokeTool, and returns the native result.
		const wrapBash: ExtensionFactory = pi => {
			pi.registerTool({
				name: "bash",
				label: "Bash",
				description: "wrapped bash",
				parameters: pi.arktype({ command: pi.arktype("string") }),
				async execute(
					_toolCallId: string,
					_params: unknown,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					invokeToolPresent = typeof ctx.invokeTool === "function";
					const native = await ctx.invokeTool?.({ command: "echo from-wrapper" });
					const textBlock = native?.content.find(b => b.type === "text");
					delegatedText = textBlock?.type === "text" ? textBlock.text : "";
					return native ?? { content: [{ type: "text" as const, text: "no invokeTool" }], details: {} };
				},
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"tools.xdev": false,
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [wrapBash],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["bash"],
		});
		try {
			await session.sendUserMessage("run it");

			expect(invokeToolPresent).toBe(true);
			// The native bash actually ran the wrapper's command, not the model's.
			expect(delegatedText).toContain("from-wrapper");
			expect(delegatedText).not.toContain("from-model");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("uses an extension web_search implementation when the built-in is enabled", async () => {
		using tempDir = TempDir.createSync("@pi-web-search-override-");
		const api: Api = "test-web-search-override";
		let requests = 0;
		registerCustomApi(api, () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const message = createAssistantMessage("");
					const toolCall: ToolCall = {
						type: "toolCall",
						id: "call-web-search-1",
						name: "web_search",
						arguments: {},
					};
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		});
		const modelSpec: ModelSpec<Api> = {
			id: "local-web-search-override-model",
			name: "Local Web Search Override Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		};
		const model = buildModel(modelSpec);
		let customInvoked = false;
		const customWebSearch: ExtensionFactory = pi => {
			pi.registerTool({
				name: "web_search",
				label: "Custom Web Search",
				description: "Custom extension web search",
				parameters: pi.arktype({}),
				async execute() {
					customInvoked = true;
					return {
						content: [{ type: "text", text: "custom-web-search-result" }],
						details: {},
					};
				},
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"tools.xdev": false,
				"web_search.enabled": true,
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [customWebSearch],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["web_search"],
		});
		try {
			await session.sendUserMessage("search");

			expect(customInvoked).toBe(true);
			const toolResult = session.agent.state.messages.find(message => message.role === "toolResult");
			const text = toolResult?.content.find(block => block.type === "text");
			expect(text?.type === "text" ? text.text : "").toBe("custom-web-search-result");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("clears promoted memory from the base prompt when switching sessions", async () => {
		using tempDir = TempDir.createSync("@pi-injected-memory-switch-");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const firstSessionFile = sessionManager.getSessionFile();
		expect(firstSessionFile).toBeString();
		await sessionManager.flush();
		const nextSessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const nextSessionFile = nextSessionManager.getSessionFile();
		expect(nextSessionFile).toBeString();
		await nextSessionManager.flush();

		const api = "test-injected-memory-switch-cache";
		const contexts: Context[] = [];
		let remembered = false;
		let recallAvailable = true;
		const injected = "<memories>session A only</memories>";
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return remembered ? `static memory instructions\n\n${injected}` : "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (remembered || !recallAvailable) return undefined;
				remembered = true;
				return injected;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-model",
			name: "Local Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base", "static memory instructions"],
				messages: [],
				tools: [],
			},
		});
		agent.setAppendOnlyContext(new AppendOnlyContextManager());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"memory.backend": "mnemopi",
				"provider.appendOnlyContext": "on",
			}),
			modelRegistry: createModelRegistryStub() as never,
			rebuildSystemPrompt: async () => ({
				systemPrompt: remembered
					? ["base", `static memory instructions\n\n${injected}`]
					: ["base", "static memory instructions"],
			}),
		});
		sessions.push(session);
		setMnemopiSessionState(session, {
			aliasOf: undefined,
			setSessionId(_sessionId: string) {},
			resetConversationTracking() {
				remembered = false;
			},
			async dispose() {},
		} as unknown as MnemopiSessionState);

		await session.sendUserMessage("first");
		expect(session.systemPrompt.join("\n")).toContain(injected);
		recallAvailable = false;

		await session.switchSession(nextSessionFile!);
		await session.sendUserMessage("second");

		expect(session.systemPrompt.join("\n")).not.toContain(injected);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.systemPrompt?.join("\n")).not.toContain(injected);
	});

	it("clears promoted memory from the base prompt when starting a new session", async () => {
		const api = "test-injected-memory-new-session-cache";
		const contexts: Context[] = [];
		let remembered = false;
		let recallAvailable = true;
		const injected = "<memories>previous session only</memories>";
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return remembered ? `static memory instructions\n\n${injected}` : "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (remembered || !recallAvailable) return undefined;
				remembered = true;
				return injected;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-model",
			name: "Local Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base", "static memory instructions"],
				messages: [],
				tools: [],
			},
		});
		agent.setAppendOnlyContext(new AppendOnlyContextManager());
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"memory.backend": "mnemopi",
				"provider.appendOnlyContext": "on",
			}),
			modelRegistry: createModelRegistryStub() as never,
			rebuildSystemPrompt: async () => ({
				systemPrompt: remembered
					? ["base", `static memory instructions\n\n${injected}`]
					: ["base", "static memory instructions"],
			}),
		});
		sessions.push(session);
		setMnemopiSessionState(session, {
			aliasOf: undefined,
			setSessionId(_sessionId: string) {},
			resetConversationTracking() {
				remembered = false;
			},
			async dispose() {},
		} as unknown as MnemopiSessionState);

		await session.sendUserMessage("first");
		expect(session.systemPrompt.join("\n")).toContain(injected);
		recallAvailable = false;

		await session.newSession();
		await session.sendUserMessage("second");

		expect(session.systemPrompt.join("\n")).not.toContain(injected);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.systemPrompt?.join("\n")).not.toContain(injected);
	});

	it("does not duplicate promoted memory in the base prompt when forking", async () => {
		using tempDir = TempDir.createSync("@pi-injected-memory-fork-");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		expect(sessionManager.getSessionFile()).toBeString();
		await sessionManager.flush();

		const api = "test-injected-memory-fork-cache";
		const contexts: Context[] = [];
		let remembered = false;
		const injected = "<memories>forked recall</memories>";
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return remembered ? `static memory instructions\n\n${injected}` : "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (remembered) return undefined;
				remembered = true;
				return injected;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-model",
			name: "Local Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base", "static memory instructions"],
				messages: [],
				tools: [],
			},
		});
		agent.setAppendOnlyContext(new AppendOnlyContextManager());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"memory.backend": "mnemopi",
				"provider.appendOnlyContext": "on",
			}),
			modelRegistry: createModelRegistryStub() as never,
			rebuildSystemPrompt: async () => ({
				systemPrompt: remembered
					? ["base", `static memory instructions\n\n${injected}`]
					: ["base", "static memory instructions"],
			}),
		});
		sessions.push(session);
		setMnemopiSessionState(session, {
			aliasOf: undefined,
			setSessionId(_sessionId: string) {},
			resetConversationTracking() {
				remembered = false;
			},
			async dispose() {},
		} as unknown as MnemopiSessionState);

		await session.sendUserMessage("first");
		expect(session.systemPrompt.join("\n")).toContain(injected);

		await session.fork();
		await session.sendUserMessage("second");

		const forkedPrompt = contexts[1]!.systemPrompt?.join("\n") ?? "";
		const occurrences = forkedPrompt.split(injected).length - 1;
		expect(occurrences).toBe(1);
	});

	it("ephemeral side-channel forwards native tools, injects developer reminder, leaves toolChoice auto", async () => {
		await withNativeDialectEnv(async () => {
			const api = "test-ephemeral-tools-warm-cache";
			let capturedContext: Context | undefined;
			let capturedOptions: SimpleStreamOptions | undefined;
			registerCustomApi(api, (_model, context, options) => {
				capturedContext = context;
				capturedOptions = options;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("Not using tools");
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Not using tools", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			});

			const model = buildModel({
				id: "side-model-with-tools",
				name: "Side Model with Tools",
				api,
				provider: "test-provider",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			} as ModelSpec<Api>) as Model<Api>;

			const tool: AgentTool = {
				name: "side_tool",
				label: "Side Tool",
				description: "A tool in side channel",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [], details: {} }),
			};

			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["system prompt"],
						messages: [],
						tools: [tool],
					},
				}),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: createModelRegistryStub() as never,
			});
			sessions.push(session);

			const result = await session.runEphemeralTurn({ promptText: "Side Question?" });

			expect(result.replyText).toBe("Not using tools");
			expect(capturedContext).toBeDefined();
			expect(capturedContext!.tools).toBeDefined();
			expect(capturedContext!.tools!.length).toBe(1);
			expect(capturedContext!.tools![0].name).toBe("side_tool");

			// Developer reminder injected immediately before user prompt
			const messages = capturedContext!.messages;
			expect(messages.length).toBeGreaterThanOrEqual(2);
			const lastMessage = messages.at(-1);
			const secondToLast = messages.at(-2);

			expect(lastMessage?.role).toBe("user");
			expect(getConvertedUserText(lastMessage)).toBe("Side Question?");

			expect(secondToLast?.role).toBe("developer");
			const textContent = secondToLast?.content as TextContent[];
			expect(textContent).toHaveLength(1);
			expect(textContent[0]?.type).toBe("text");
			expect(textContent[0]?.text).toMatch(/^<system-reminder>\n[\s\S]+\n<\/system-reminder>\n?$/);

			// Tool choice must be undefined (not "none") for cache hits
			expect(capturedOptions?.toolChoice).toBeUndefined();
		});
	});

	it("ephemeral side-channel discards any emitted tool calls", async () => {
		const api = "test-ephemeral-tools-discard";
		registerCustomApi(api, (_model, _context, _options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Here is text");
				message.content.push({
					type: "toolCall",
					id: "call_123",
					name: "side_tool",
					arguments: {},
				});
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Here is text", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-model-discard",
			name: "Side Model Discard",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;

		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: "Side Question?" });

		expect(result.replyText).toBe("Here is text");
		expect(result.assistantMessage.content.some(block => block.type === "toolCall")).toBe(false);
		expect(result.assistantMessage.content.every(block => block.type !== "toolCall")).toBe(true);
	});
});
