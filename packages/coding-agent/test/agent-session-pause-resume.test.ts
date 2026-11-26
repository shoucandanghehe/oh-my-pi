import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, agentPauseGate, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	collectPendingToolCalls,
	readAgentsPaused,
	SESSION_EXIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("durable paused exit", () => {
	let tempDir: TempDir;
	let auth: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-pause-recovery-");
		auth = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		auth.keys.setRuntime("mock", "test-key");
		modelRegistry = new ModelRegistry(auth);
	});

	afterEach(async () => {
		agentPauseGate.resume();
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		auth.close();
		tempDir.removeSync();
	});

	function createSession(mock: MockModel, manager: SessionManager, tools: AgentTool[] = []): AgentSession {
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools,
				messages: manager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);
		return session;
	}

	async function reopen(manager: SessionManager, mock: MockModel, tools: AgentTool[] = []): Promise<AgentSession> {
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing session journal");
		return createSession(
			mock,
			await SessionManager.open(file, manager.getSessionDir(), undefined, { suppressBreadcrumb: true }),
			tools,
		);
	}

	function observeParkedLoop() {
		const parked = Promise.withResolvers<void>();
		const stop = agentPauseGate.onWaitersChange(() => {
			if (!agentPauseGate.ready || agentPauseGate.modelWaiterCount === 0) return;
			stop();
			parked.resolve();
		});
		return { parked: parked.promise, stop };
	}

	it("commits the entire tool batch and does not execute it again after a cold continue", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const executed: string[] = [];
		const parameters = type({ value: "string" });
		const tool: AgentTool<typeof parameters> = {
			name: "record",
			label: "Record",
			description: "Record a value",
			parameters,
			concurrency: "exclusive",
			intent: "omit",
			async execute(_id, args) {
				if (args.value === "first") {
					started.resolve();
					await release.promise;
				}
				executed.push(args.value);
				return { content: [{ type: "text", text: `recorded ${args.value}` }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "first-call", name: "record", arguments: { value: "first" } },
						{ type: "toolCall", id: "second-call", name: "record", arguments: { value: "second" } },
					],
				},
			],
		});
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const live = createSession(mock, manager, [tool]);
		const { parked, stop } = observeParkedLoop();
		const prompt = live.prompt("record both values");
		try {
			await Promise.race([
				started.promise,
				prompt.then(() => {
					throw new Error("Tool did not start");
				}),
			]);
			agentPauseGate.pause();
			expect(agentPauseGate.ready).toBe(false);
			release.resolve();
			await parked;
			expect(executed).toEqual(["first", "second"]);
			expect(mock.calls).toHaveLength(1);
			await live.disposeForPausedExit();
			await prompt;
		} finally {
			stop();
			release.resolve();
			agentPauseGate.resume();
		}

		const coldMock = createMockModel({ responses: [{ content: ["both recorded"] }] });
		const cold = await reopen(manager, coldMock, [tool]);
		const branch = cold.sessionManager.getBranch();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		expect(readAgentsPaused(branch)).toMatchObject({ agentIds: [MAIN_AGENT_ID] });
		const exit = branch.findLast(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		expect(exit).toMatchObject({ data: { reason: "agents_paused", kind: "paused" } });
		expect(await restoreSession(cold)).toEqual({ turn: false, subagents: [] });
		expect(coldMock.calls).toHaveLength(0);

		expect(await cold.continuePausedAgents()).toEqual({ continued: 1, skipped: [], complete: true });
		expect(coldMock.calls).toHaveLength(1);
		const results = coldMock.calls[0].context.messages.filter(message => message.role === "toolResult");
		expect(results.map(result => result.toolCallId)).toEqual(["first-call", "second-call"]);
		expect(executed).toEqual(["first", "second"]);
		expect(cold.hasPausedAgents()).toBe(false);
	});

	it("consumes a parked prompt once even if continuing it fails and the session opens cold again", async () => {
		const original = createMockModel({ responses: [{ content: ["must not start"] }] });
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const live = createSession(original, manager);
		agentPauseGate.pause();
		const { parked, stop } = observeParkedLoop();
		const prompt = live.prompt("/literal pending input", { expandPromptTemplates: false, runCommands: false });
		try {
			await Promise.race([
				parked,
				prompt.then(() => {
					throw new Error("Prompt did not park");
				}),
			]);
			await live.disposeForPausedExit();
			await prompt;
		} finally {
			stop();
			agentPauseGate.resume();
		}
		expect(original.calls).toHaveLength(0);

		const coldMock = createMockModel({
			responses: [{ content: [], stopReason: "error", errorMessage: "Provider refused" }],
		});
		const cold = await reopen(manager, coldMock);
		expect(cold.sessionManager.buildSessionContext().messages).toEqual([]);
		expect(readAgentsPaused(cold.sessionManager.getBranch())).toMatchObject({
			agentIds: [MAIN_AGENT_ID],
			pendingPrompt: { text: "/literal pending input", attribution: "user" },
		});
		expect(await cold.continuePausedAgents()).toMatchObject({ continued: 0, complete: false });
		expect(readAgentsPaused(cold.sessionManager.getBranch())?.pendingPrompt).toBeUndefined();
		expect(cold.hasPausedAgents()).toBe(true);
		expect(coldMock.calls).toHaveLength(1);
		expect(coldMock.calls[0].context.messages.filter(message => message.role === "user")).toMatchObject([
			{ content: [{ type: "text", text: "/literal pending input" }] },
		]);
		await cold.dispose();
		const retryMock = createMockModel({ responses: [{ content: ["received once"] }] });
		const reopened = await reopen(manager, retryMock);
		expect(await reopened.continuePausedAgents()).toEqual({ continued: 1, skipped: [], complete: true });
		expect(reopened.hasPausedAgents()).toBe(false);
		expect(retryMock.calls).toHaveLength(1);
		expect(retryMock.calls[0].context.messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(
			reopened.sessionManager.buildSessionContext().messages.filter(message => message.role === "user"),
		).toHaveLength(1);
	});

	it("re-samples a cold pause_turn tail without sending a new prompt", async () => {
		const original = createMockModel({
			responses: [
				() => {
					agentPauseGate.pause();
					return { content: ["progress"], stopReason: "stop", stopDetails: { type: "pause_turn" } };
				},
			],
		});
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const live = createSession(original, manager);
		const { parked, stop } = observeParkedLoop();
		const prompt = live.prompt("continue this turn");
		try {
			await Promise.race([
				parked,
				prompt.then(() => {
					throw new Error("Nonterminal reply did not park");
				}),
			]);
			await live.disposeForPausedExit();
			await prompt;
		} finally {
			stop();
			agentPauseGate.resume();
		}
		const coldMock = createMockModel({ responses: [{ content: ["finished"] }] });
		const cold = await reopen(manager, coldMock);
		expect(await cold.continuePausedAgents()).toEqual({ continued: 1, skipped: [], complete: true });
		expect(coldMock.calls[0].context.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(coldMock.calls[0].context.messages[1]).toMatchObject({ content: [{ text: "progress" }] });
	});
});
