import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { readAgentsPaused, SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function pauseTurnMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		stopDetails: { type: "pause_turn" },
		timestamp: Date.now(),
	};
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate() && Date.now() < deadline) {
		await Bun.sleep(5);
	}
	if (!predicate()) throw new Error(message);
}

describe("AgentSession barrier pause resume", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		agentPauseGate.resume();
		tempDir = TempDir.createSync("@pi-agent-pause-resume-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		agentPauseGate.resume();
		await Promise.allSettled(sessions.splice(0).map(session => session.dispose()));
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(agent: Agent, sessionManager: SessionManager): AgentSession {
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);
		return session;
	}

	it("discovers and resumes a persisted subagent directly after cold session resume", async () => {
		const mainMock = createMockModel({ responses: [{ content: ["idle"] }] });
		const mainAgent = new Agent({
			initialState: { model: mainMock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mainMock.stream,
		});
		await mainAgent.prompt("finish main turn");
		const mainManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const mainSession = createSession(mainAgent, mainManager);
		const mainFile = mainManager.getSessionFile();
		if (!mainFile) throw new Error("Expected persistent main session file");

		const subMock = createMockModel({ responses: [{ content: ["sub resumed"] }] });
		const subAgent = new Agent({
			initialState: {
				model: subMock.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [{ role: "user", content: "continue sub", timestamp: Date.now() }],
			},
			convertToLlm,
			streamFn: subMock.stream,
		});
		const subSession = createSession(subAgent, SessionManager.inMemory(tempDir.path()));
		const subFile = path.join(mainFile.slice(0, -".jsonl".length), "Sub.jsonl");
		await Bun.write(
			subFile,
			`${[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "sub",
					timestamp: new Date().toISOString(),
					cwd: tempDir.path(),
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "continue sub", timestamp: Date.now() },
				}),
			].join("\n")}\n`,
		);
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async ref => (ref.id === "Sub" ? async () => subSession : undefined),
			0,
		);
		mainSession.recordAgentsPaused(["Sub"]);

		const result = await mainSession.continuePausedAgents();

		expect(result.continued).toBe(1);
		expect(result.skipped).toEqual([]);
		expect(subMock.calls).toHaveLength(1);
		expect(mainSession.hasPausedAgents()).toBe(false);
	});

	it("resumes a persisted pause_turn continuation instead of treating it as idle", async () => {
		const mock = createMockModel({ responses: [{ content: ["finished"] }] });
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [{ role: "user", content: "work", timestamp: Date.now() - 10 }, pauseTurnMessage("progress")],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = createSession(agent, SessionManager.inMemory(tempDir.path()));
		session.recordAgentsPaused([MAIN_AGENT_ID]);

		const result = await session.continuePausedAgents();

		expect(result.continued).toBe(1);
		expect(result.skipped).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		expect(session.hasPausedAgents()).toBe(false);
	});

	it("continues the parked model turn while its goal remains paused", async () => {
		const mock = createMockModel({ responses: [{ content: ["model turn resumed"] }] });
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [
					{ role: "user", content: "work on goal", timestamp: Date.now() - 10 },
					pauseTurnMessage("progress"),
				],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = createSession(agent, SessionManager.inMemory(tempDir.path()));
		const now = Date.now();
		session.setGoalModeState({
			enabled: false,
			mode: "active",
			goal: {
				id: "goal-1",
				objective: "Ship the release",
				status: "paused",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.recordAgentsPaused([MAIN_AGENT_ID]);

		const result = await session.continuePausedAgents();

		expect(result.continued).toBe(1);
		expect(result.skipped).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		expect(session.getGoalModeState()).toMatchObject({ enabled: false, goal: { status: "paused" } });
		expect(session.hasPausedAgents()).toBe(false);
	});

	it("starts every paused agent before awaiting any run completion", async () => {
		const releaseFirst = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const firstMock = createMockModel({
			handler: async () => {
				await releaseFirst.promise;
				return { content: ["first finished"] };
			},
		});
		const secondMock = createMockModel({
			handler: async () => {
				await releaseSecond.promise;
				return { content: ["second finished"] };
			},
		});
		const makePausedSubagent = (id: string, mock: typeof firstMock): AgentSession => {
			const agent = new Agent({
				initialState: {
					model: mock.model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [{ role: "user", content: `continue ${id}`, timestamp: Date.now() }],
				},
				convertToLlm,
				streamFn: mock.stream,
			});
			const session = createSession(agent, SessionManager.inMemory(tempDir.path()));
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session,
				status: "idle",
			});
			return session;
		};
		makePausedSubagent("First", firstMock);
		makePausedSubagent("Second", secondMock);
		const mainAgent = new Agent();
		const mainSession = createSession(mainAgent, SessionManager.inMemory(tempDir.path()));
		mainSession.recordAgentsPaused(["First", "Second"]);

		const continuing = mainSession.continuePausedAgents();
		try {
			await waitFor(
				() => firstMock.calls.length === 1 && secondMock.calls.length === 1,
				"Paused agents did not start concurrently",
			);
		} catch (error) {
			releaseFirst.resolve();
			releaseSecond.resolve();
			await continuing;
			throw error;
		}
		releaseFirst.resolve();
		releaseSecond.resolve();
		const result = await continuing;

		expect(result.continued).toBe(2);
		expect(result.skipped).toEqual([]);
		expect(mainSession.hasPausedAgents()).toBe(false);
	});

	it("clears the pause marker when every recorded agent is already idle", async () => {
		const mock = createMockModel({ responses: [{ content: ["idle"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		await agent.prompt("finish");
		const session = createSession(agent, SessionManager.inMemory(tempDir.path()));
		session.recordAgentsPaused([MAIN_AGENT_ID]);

		const result = await session.continuePausedAgents();

		expect(result.continued).toBe(0);
		expect(result.skipped).toEqual([`${MAIN_AGENT_ID}: already idle`]);
		expect(session.hasPausedAgents()).toBe(false);
	});

	it("keeps a partial resume marker retryable when one agent cannot revive", async () => {
		const mock = createMockModel({ responses: [{ content: ["good finished"] }] });
		const goodAgent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [{ role: "user", content: "continue good", timestamp: Date.now() }],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const goodSession = createSession(goodAgent, SessionManager.inMemory(tempDir.path()));
		AgentRegistry.global().register({
			id: "Good",
			displayName: "Good",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: goodSession,
			status: "idle",
		});
		const mainSession = createSession(new Agent(), SessionManager.inMemory(tempDir.path()));
		mainSession.recordAgentsPaused(["Good", "Missing"]);

		const result = await mainSession.continuePausedAgents();

		expect(result.continued).toBe(1);
		expect(result.complete).toBe(false);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toContain('Unknown agent "Missing"');
		expect(mainSession.hasPausedAgents()).toBe(true);
	});

	it("records only active loops when preparing a durable paused exit", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const sessionDir = path.join(tempDir.path(), "sessions");
		const manager = SessionManager.create(tempDir.path(), sessionDir, undefined, { suppressBreadcrumb: true });
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent main session file");
		const session = createSession(agent, manager);
		const idleSession = createSession(new Agent(), SessionManager.inMemory(tempDir.path()));
		AgentRegistry.global().register({
			id: "Idle",
			displayName: "Idle",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: idleSession,
			status: "idle",
		});

		agentPauseGate.pause();
		const prompt = agent.prompt("work");
		await waitFor(
			() => agentPauseGate.activeLoopCount === 1 && agentPauseGate.modelWaiterCount === 1,
			"Main agent did not park at the model boundary",
		);
		await session.disposeForPausedExit();
		await prompt;

		const reopened = await SessionManager.open(sessionFile, sessionDir, undefined, { suppressBreadcrumb: true });
		try {
			expect(readAgentsPaused(reopened.getBranch())?.agentIds).toEqual([MAIN_AGENT_ID]);
			const exitEntry = reopened
				.getEntries()
				.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
			if (exitEntry?.type !== "custom") throw new Error("Expected paused session exit marker");
			expect(exitEntry.data).toMatchObject({ kind: "paused", reason: "agents_paused" });
			expect(mock.calls).toHaveLength(0);
		} finally {
			await reopened.close();
		}
	});

	it("prepares side-loop participants before a durable paused exit", async () => {
		const session = createSession(new Agent(), SessionManager.inMemory(tempDir.path()));
		let prepared = 0;
		agentPauseGate.pause();

		await session.disposeForPausedExit([
			{
				label: "BTW",
				prepareForPausedExit: () => {
					prepared++;
				},
				continuePaused: async () => ({ continued: 0, skipped: [], complete: true }),
			},
		]);

		expect(prepared).toBe(1);
	});

	it("keeps the durable pause marker until side-loop continuation succeeds", async () => {
		const session = createSession(new Agent(), SessionManager.inMemory(tempDir.path()));
		session.recordAgentsPaused([]);
		let attempts = 0;
		const participant = {
			label: "BTW",
			prepareForPausedExit: () => {},
			continuePaused: async () => {
				attempts++;
				return attempts === 1
					? { continued: 0, skipped: ["thread: provider unavailable"], complete: false }
					: { continued: 1, skipped: [], complete: true };
			},
		};

		const first = await session.continuePausedAgents([participant]);

		expect(first).toEqual({
			continued: 0,
			skipped: ["BTW: thread: provider unavailable"],
			complete: false,
		});
		expect(session.hasPausedAgents()).toBe(true);

		const second = await session.continuePausedAgents([participant]);

		expect(second).toEqual({ continued: 1, skipped: [], complete: true });
		expect(session.hasPausedAgents()).toBe(false);
	});
});
