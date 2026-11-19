import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SUPERSEDED_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const OLD_RESULT = "old file contents\n".repeat(100);
const NEW_RESULT = "new file contents\n".repeat(100);

function createPrefixBindingModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

function createModel(id: string): Model<"openai-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(model: Model, content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: usage(),
		timestamp,
	};
}

function toolResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function newSession(model: Model, now = Date.now()): AgentSession {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({ role: "user", content: "Read the file twice.", timestamp: now - 500 });
	sessionManager.appendMessage(
		assistant(
			model,
			[{ type: "toolCall", id: "read-old", name: "read", arguments: { path: "src/foo.ts" } }],
			now - 400,
		),
	);
	sessionManager.appendMessage(toolResult("read-old", OLD_RESULT, now - 350));
	sessionManager.appendMessage(
		assistant(
			model,
			[{ type: "toolCall", id: "read-new", name: "read", arguments: { path: "src/foo.ts" } }],
			now - 300,
		),
	);
	sessionManager.appendMessage(toolResult("read-new", NEW_RESULT, now - 250));
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: [{ content: ["Done."] }] }).stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"compaction.dropUseless": false,
			"compaction.supersedeReads": true,
		}),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
	});
	session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	return session;
}

async function runMaintenance(session: AgentSession): Promise<void> {
	const model = session.model;
	if (!model) throw new Error("Expected an active model");
	const finalAssistant = assistant(model, [{ type: "text", text: "Done." }], Date.now());
	session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
	await session.waitForIdle();
}

function oldResultText(session: AgentSession): string {
	const message = session.agent.state.messages.find(
		(candidate): candidate is ToolResultMessage =>
			candidate.role === "toolResult" && candidate.toolCallId === "read-old",
	);
	if (!message) throw new Error("Expected the old read result");
	const text = message.content.find(block => block.type === "text");
	if (text?.type !== "text") throw new Error("Expected text in the old read result");
	return text.text;
}

describe("prefix-bound stale-result pruning", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("keeps warm superseded reads for prefix-bound Claude and GPT models", async () => {
		const claudeSession = newSession(createPrefixBindingModel());
		const gpt62Session = newSession(createModel("gpt-6.2-sol"));
		const controlSession = newSession(createModel("gpt-6.1-sol"));
		sessions.push(claudeSession, gpt62Session, controlSession);

		await runMaintenance(claudeSession);
		await runMaintenance(gpt62Session);
		await runMaintenance(controlSession);

		expect(oldResultText(claudeSession)).toBe(OLD_RESULT);
		expect(oldResultText(gpt62Session)).toBe(OLD_RESULT);
		expect(oldResultText(controlSession)).toBe(SUPERSEDED_NOTICE);
	});

	it("keeps a superseded read when an idle GPT-6.2 session resumes after an error", async () => {
		const now = Date.now() - 2 * 60 * 60 * 1000;
		const model = createModel("gpt-6.2-sol");
		const session = newSession(model, now);
		sessions.push(session);
		const failure: AssistantMessage = {
			...assistant(model, [], now),
			stopReason: "error",
			errorMessage: "Interrupted",
		};
		session.sessionManager.appendMessage(failure);
		session.agent.appendMessage(failure);
		await session.prompt("Continue");
		expect(oldResultText(session)).toBe(OLD_RESULT);
	});
});
