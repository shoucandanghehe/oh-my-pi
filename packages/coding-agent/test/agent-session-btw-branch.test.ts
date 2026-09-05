import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { loadAdvisorTranscriptCosts } from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { EphemeralConversationTurn } from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

function createBtwAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Check the failure mode first.", thinkingSignature: "sig" },
			{ type: "redactedThinking", data: "encrypted-side-channel-thinking" },
			{ type: "text", text: "The fix is to branch the side answer." },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		providerPayload: { type: "openaiResponsesHistory", items: [{ id: "side-channel" }] },
	};
}
function createBtwTurn(input: string, assistantMessage = createBtwAssistant()): EphemeralConversationTurn {
	return {
		input,
		assistantMessage,
		replyText: "The fix is to branch the side answer.",
		timestamp: assistantMessage.timestamp,
	};
}

function expectSanitizedBtwAssistant(message: AssistantMessage): void {
	expect(message.providerPayload).toBeUndefined();
	expect(message.content).toEqual([
		{ type: "thinking", thinking: "Check the failure mode first." },
		{ type: "text", text: "The fix is to branch the side answer." },
	]);
}

function requiredLeafId(session: AgentSession): string {
	const leafId = session.sessionManager.getLeafId();
	if (!leafId) throw new Error("Expected session leaf");
	return leafId;
}

describe("AgentSession.branchFromBtw", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-btw-branch-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await fs.promises
			.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
			.catch(() => undefined);
		vi.restoreAllMocks();
	});

	async function createSession(options?: {
		persisted?: boolean;
		extensionRunner?: ExtensionRunner;
		handler?: MockHandler;
	}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: options?.handler ?? (() => ({ content: ["unused"] })) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager =
			options?.persisted === false ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated({ "compaction.enabled": false });
		authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: options?.extensionRunner,
		});
		return session;
	}

	it("creates a persisted branch with every completed /btw turn", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() - 2 });
		activeSession.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1,
		});
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		expect(originalFile).toBeDefined();
		const originalRaw = fs.readFileSync(originalFile!, "utf8");
		const assistantMessage = createBtwAssistant();

		const result = await activeSession.branchFromBtw({
			anchorLeafId: requiredLeafId(activeSession),
			sessionId: activeSession.sessionManager.getSessionId(),
			turns: [createBtwTurn("why did this fail?", assistantMessage), createBtwTurn("what should happen next?")],
		});

		expect(result.cancelled).toBe(false);
		expect(result.sessionFile).toBe(activeSession.sessionFile);
		expect(result.sessionFile).toBeDefined();
		expect(result.sessionFile).not.toBe(originalFile);
		expect(fs.readFileSync(originalFile!, "utf8")).toBe(originalRaw);
		const messages = activeSession.messages;
		expect(messages.at(-4)).toMatchObject({ role: "user", content: [{ type: "text", text: "why did this fail?" }] });
		expect(messages.at(-3)?.role).toBe("assistant");
		expect(messages.at(-2)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "what should happen next?" }],
		});
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
	});
	it("does not record a late advisor turn into a /btw branch", async () => {
		const activeSession = await createSession();
		activeSession.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		activeSession.toggleAdvisorEnabled();
		const advisor = activeSession.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const createBranchedSession = activeSession.sessionManager.createBranchedSession.bind(
			activeSession.sessionManager,
		);
		vi.spyOn(activeSession.sessionManager, "createBranchedSession").mockImplementation(parentId => {
			const result = createBranchedSession(parentId);
			const lateMessage = createBtwAssistant();
			lateMessage.usage.cost.total = 9;
			advisor.emitExternalEvent({ type: "message_end", message: lateMessage });
			return result;
		});

		const result = await activeSession.branchFromBtw({
			anchorLeafId: requiredLeafId(activeSession),
			sessionId: activeSession.sessionManager.getSessionId(),
			turns: [createBtwTurn("question", createBtwAssistant())],
		});
		expect(result.cancelled).toBe(false);
		const replacementSessionFile = activeSession.sessionFile;
		if (!replacementSessionFile) throw new Error("Expected the replacement session to be persisted");
		await activeSession.dispose();
		session = undefined;

		expect((await loadAdvisorTranscriptCosts(replacementSessionFile)).get("")).toBeUndefined();
	});

	it("promotes from the frozen BTW anchor after Main has advanced", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "anchor question", timestamp: 1 });
		const anchorLeafId = activeSession.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "anchor answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		activeSession.sessionManager.appendMessage({ role: "user", content: "late main turn", timestamp: 3 });
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);

		const result = await activeSession.branchFromBtw({
			anchorLeafId,
			sessionId: activeSession.sessionManager.getSessionId(),
			turns: [createBtwTurn("side question")],
		});

		expect(result.cancelled).toBe(false);
		const serialized = JSON.stringify(activeSession.messages);
		expect(serialized).toContain("anchor question");
		expect(serialized).toContain("side question");
		expect(serialized).not.toContain("late main turn");
	});

	it("honors session_before_branch cancellation without creating a branch", async () => {
		const emit = vi.fn(async () => ({ cancel: true }));
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit,
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const result = await activeSession.branchFromBtw({
			anchorLeafId: requiredLeafId(activeSession),
			sessionId: activeSession.sessionManager.getSessionId(),
			turns: [createBtwTurn("question", createBtwAssistant())],
		});

		expect(result).toEqual({ cancelled: true, sessionFile: originalFile });
		expect(activeSession.sessionFile).toBe(originalFile);
		expect(emit).toHaveBeenCalledWith({
			type: "session_before_branch",
			entryId: activeSession.sessionManager.getLeafId(),
		});
	});

	it("refuses when the authorized session changes while a branch hook is pending", async () => {
		const hookStarted = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => {
				hookStarted.resolve();
				await hookRelease.promise;
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		const authorizedSessionId = activeSession.sessionManager.getSessionId();
		let currentSessionId = authorizedSessionId;
		vi.spyOn(activeSession.sessionManager, "getSessionId").mockImplementation(() => currentSessionId);

		const branchPromise = activeSession.branchFromBtw({
			anchorLeafId: requiredLeafId(activeSession),
			sessionId: authorizedSessionId,
			turns: [createBtwTurn("question", createBtwAssistant())],
		});
		await hookStarted.promise;
		currentSessionId = "different-session";
		hookRelease.resolve();

		await expect(branchPromise).rejects.toThrow("Cannot promote BTW: session or frozen anchor changed");
		expect(activeSession.sessionFile).toBe(originalFile);
	});

	it("refuses when the authorized session id no longer matches the loaded session", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		const leafId = requiredLeafId(activeSession);

		// A resumed/branched session preserves the entry id, so the leaf still matches
		// while the loaded session is different.
		await expect(
			activeSession.branchFromBtw({
				anchorLeafId: leafId,
				sessionId: "some-other-session",
				turns: [createBtwTurn("question", createBtwAssistant())],
			}),
		).rejects.toThrow("Cannot promote BTW: session changed since BTW started");
		expect(activeSession.sessionFile).toBe(originalFile);
	});

	it("syncs promoted /btw messages into live context even when hooks skip conversation restore", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => ({ skipConversationRestore: true })),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.flush();
		const assistantMessage = createBtwAssistant();

		const result = await activeSession.branchFromBtw({
			anchorLeafId: requiredLeafId(activeSession),
			sessionId: activeSession.sessionManager.getSessionId(),
			turns: [createBtwTurn("question", assistantMessage)],
		});

		expect(result.cancelled).toBe(false);
		const messages = activeSession.messages;
		expect(messages.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: "question" }] });
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
	});

	it("refuses to defer a /btw branch while the main turn is streaming", async () => {
		const providerStarted = Promise.withResolvers<void>();
		const activeSession = await createSession({
			handler: () => {
				providerStarted.resolve();
				return { content: ["main response"], delayMs: 60_000 };
			},
		});
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const promptPromise = activeSession.prompt("main prompt");
		await providerStarted.promise;
		expect(activeSession.isStreaming).toBe(true);

		await expect(
			activeSession.branchFromBtw({
				anchorLeafId: requiredLeafId(activeSession),
				sessionId: activeSession.sessionManager.getSessionId(),
				turns: [createBtwTurn("question", createBtwAssistant())],
			}),
		).rejects.toThrow("Cannot promote BTW while session maintenance or user work is still running");
		expect(activeSession.isStreaming).toBe(true);
		expect(activeSession.sessionFile).toBe(originalFile);

		await activeSession.abort({ goalReason: "internal", reason: "test cleanup" });
		await promptPromise;
	});

	it("refuses to branch /btw while user bash work is still running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();

		const bashPromise = activeSession.executeBash('bun -e "await Bun.sleep(60_000)"', () => undefined, {
			useUserShell: false,
		});
		expect(activeSession.isBashRunning).toBe(true);

		await expect(
			activeSession.branchFromBtw({
				anchorLeafId: requiredLeafId(activeSession),
				sessionId: activeSession.sessionManager.getSessionId(),
				turns: [createBtwTurn("question", createBtwAssistant())],
			}),
		).rejects.toThrow("Cannot promote BTW while session maintenance or user work is still running");

		activeSession.abortBash();
		await bashPromise.catch(() => undefined);
	});

	it("refuses to branch /btw while user Python work is still running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const abortController = new AbortController();
		const execution = Promise.withResolvers<void>().promise;
		activeSession.trackEvalExecution(execution, abortController).catch(() => undefined);
		expect(activeSession.isEvalRunning).toBe(true);

		await expect(
			activeSession.branchFromBtw({
				anchorLeafId: requiredLeafId(activeSession),
				sessionId: activeSession.sessionManager.getSessionId(),
				turns: [createBtwTurn("question", createBtwAssistant())],
			}),
		).rejects.toThrow("Cannot promote BTW while session maintenance or user work is still running");

		abortController.abort();
	});

	it("refuses to branch /btw while context maintenance is running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const sessionWithMaintenance = activeSession as AgentSession & { _maintenanceForTest?: boolean };
		Object.defineProperty(sessionWithMaintenance, "isCompacting", {
			get: () => sessionWithMaintenance._maintenanceForTest === true,
		});
		sessionWithMaintenance._maintenanceForTest = true;

		await expect(
			activeSession.branchFromBtw({
				anchorLeafId: requiredLeafId(activeSession),
				sessionId: activeSession.sessionManager.getSessionId(),
				turns: [createBtwTurn("question", createBtwAssistant())],
			}),
		).rejects.toThrow("Cannot promote BTW while session maintenance or user work is still running");
	});

	it("refuses when post-prompt work starts a turn while a branch hook is pending", async () => {
		const hookRelease = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => {
				await hookRelease.promise;
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		activeSession.queueDeferredMessage({
			role: "custom",
			customType: "test-hidden-message",
			content: "hidden",
			display: false,
			timestamp: Date.now(),
		});
		expect(activeSession.hasPostPromptWork).toBe(true);

		const branchPromise = activeSession.branchFromBtw({
			anchorLeafId: requiredLeafId(activeSession),
			sessionId: activeSession.sessionManager.getSessionId(),
			turns: [createBtwTurn("question", createBtwAssistant())],
		});
		await Promise.resolve();
		hookRelease.resolve();

		await expect(branchPromise).rejects.toThrow(
			"Cannot promote BTW while session maintenance or user work is still running",
		);
		expect(activeSession.sessionFile).toBe(originalFile);
	});

	it("throws for in-memory sessions", async () => {
		const activeSession = await createSession({ persisted: false });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });

		await expect(
			activeSession.branchFromBtw({
				anchorLeafId: requiredLeafId(activeSession),
				sessionId: activeSession.sessionManager.getSessionId(),
				turns: [createBtwTurn("question", createBtwAssistant())],
			}),
		).rejects.toThrow("Cannot promote BTW: session is not persisted");
	});
});
