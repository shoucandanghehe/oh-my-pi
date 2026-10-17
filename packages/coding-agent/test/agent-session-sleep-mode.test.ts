/**
 * Contract: in sleep mode a dialog that would wait for the user's answer (`ask`, a tool approval, an extension
 * prompt) is refused without being shown, and the refusal reaches the model as the tool's error; entering sleep
 * mode mid-turn tells the running turn at once. Ending sleep mode shows dialogs again.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession sleep mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-sleep-mode-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Dialogs actually shown to the user. */
	let shown = 0;
	let stepEntered = Promise.withResolvers<void>();
	let stepRelease = Promise.withResolvers<void>();
	const stepSchema = type({});
	/** A foreground step that holds the turn until the test releases it. */
	const stepTool: AgentTool<typeof stepSchema, undefined> = {
		name: "step",
		label: "Step",
		description: "Step",
		parameters: stepSchema,
		async execute() {
			stepEntered.resolve();
			await stepRelease.promise;
			return { content: [{ type: "text", text: "stepped" }], details: undefined };
		},
	};
	const questionSchema = type({});
	/** A tool that waits for the user's answer, as `ask` and approvals do. */
	const questionTool: AgentTool<typeof questionSchema, undefined> = {
		name: "question",
		label: "Question",
		description: "Question",
		parameters: questionSchema,
		async execute() {
			const answer = await session!.waitForUser(async () => {
				shown++;
				return "yes";
			});
			return { content: [{ type: "text", text: `answer: ${answer}` }], details: undefined };
		},
	};
	/** The serialized messages of every model request, in order. */
	const requests: string[] = [];

	function createSession(responses: MockResponse[]): AgentSession {
		shown = 0;
		requests.length = 0;
		stepEntered = Promise.withResolvers<void>();
		stepRelease = Promise.withResolvers<void>();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [stepTool as AgentTool, questionTool as AgentTool],
				messages: [],
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requests.push(JSON.stringify(context.messages));
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([
				[stepTool.name, stepTool as AgentTool],
				[questionTool.name, questionTool as AgentTool],
			]),
		});
		return session;
	}

	const call = (name: string): MockResponse => ({
		content: [{ type: "toolCall", name, arguments: {} }],
		stopReason: "toolUse",
	});
	const questionResults = (messages: AgentMessage[]) =>
		messages.flatMap(message =>
			message.role === "toolResult" && message.toolName === "question"
				? [{ isError: message.isError, text: message.content.map(c => (c.type === "text" ? c.text : "")).join("") }]
				: [],
		);

	it("tells a running turn at once, refuses dialogs while asleep, and shows them again after waking", async () => {
		const target = createSession([
			call("step"),
			call("question"),
			{ content: ["done"] },
			call("question"),
			{ content: ["done again"] },
		]);

		const running = target.prompt("go");
		await stepEntered.promise;
		await target.setSleepModeState({ authorization: "may restart the training job" });
		stepRelease.resolve();
		await running;

		expect(requests[0]).not.toContain("Sleep mode ON");
		expect(requests[1]).toContain("Sleep mode ON");
		expect(requests[1]).toContain("may restart the training job");
		expect(shown).toBe(0);
		const [refused] = questionResults(target.agent.state.messages);
		expect(refused?.isError).toBe(true);
		expect(refused?.text).toContain("The user is asleep (sleep mode)");

		await target.setSleepModeState(undefined);
		await target.prompt("again");

		expect(requests[3]).toContain("Sleep mode OFF");
		expect(shown).toBe(1);
		expect(questionResults(target.agent.state.messages)[1]).toEqual({ isError: false, text: "answer: yes" });
	});
});
