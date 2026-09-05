import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("issue #4806 command output during streaming", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let streaming = true;
	let tempDir: TempDir;
	let terminal: VirtualTerminal;
	let previousBackend: string | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-4806-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		terminal = new VirtualTerminal(100, 80);
		const composer = new Composer({ terminal });
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, undefined, composer);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.close();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
		else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
		resetSettingsForTest();
	});

	async function submitCommand(command: string): Promise<void> {
		void mode.getUserInput();
		const submit = mode.editor.onSubmit;
		if (!submit) throw new Error("Expected editor submit handler");
		const settled = Promise.withResolvers<void>();
		mode.editor.onSubmit = async value => {
			try {
				await submit(value);
				settled.resolve();
			} catch (error) {
				settled.reject(error);
			}
		};
		mode.editor.setText(command);
		terminal.sendInput("\r");
		await settled.promise;
		await terminal.waitForRender();
	}

	it("mounts slash-command output once after the active turn ends", async () => {
		const streamedReply = new Text("agent is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);

		mode.handleToolsCommand();

		expect(mode.chatContainer.children).toEqual([streamedReply]);

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.chatContainer.children).toHaveLength(2);
		const transcript = mode.chatContainer.render(80).join("\n");
		expect(transcript.match(/Available Tools/g)).toHaveLength(1);
	});

	it("drops deferred slash-command output when the session changes before agent_end", async () => {
		const streamedReply = new Text("old session is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);
		const previousSessionId = session.sessionManager.getSessionId();

		mode.handleToolsCommand();
		await session.newSession();

		expect(session.sessionManager.getSessionId()).not.toBe(previousSessionId);
		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.chatContainer.children).toEqual([streamedReply]);
	});

	it("renders /context immediately without another user prompt", async () => {
		streaming = false;
		await submitCommand("/context");

		const viewport = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(viewport).toContain("Context Usage");
	});

	it("renders /session info immediately without another user prompt", async () => {
		streaming = false;
		await submitCommand("/session info");

		const viewport = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(viewport).toContain("Session Info");
	});
});
