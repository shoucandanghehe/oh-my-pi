import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { WorkspaceLayout } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ManualScheduler, TspTestTerminal, tspEvent, type TspHarnessOptions } from "../../tui/test/native/tsp-harness";

describe("interactive app-viewport with native TSP rendering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: TspTestTerminal;
	let scheduler: ManualScheduler;

	beforeEach(async () => {
		await initTheme(false);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-native-workspace-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function flush(advanceMs = 0): void {
		scheduler.flush(advanceMs, () => (terminal.answersProbe && terminal.answerProbe()) || terminal.deliver());
	}

	async function start(options: TspHarnessOptions, prepaint = false): Promise<void> {
		terminal = new TspTestTerminal({ cols: 120, rows: 32, ...options });
		scheduler = new ManualScheduler();
		const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
		let composer: Composer;
		try {
			Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
			composer = new Composer({ terminal, tuiOptions: { renderScheduler: scheduler } });
			if (prepaint) {
				composer.start({ playWelcomeIntro: false });
				flush();
			}
			mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		} finally {
			if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
			else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
		}
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		flush();
	}

	function documentNodes(document: TspNode = terminal.docs.get(terminal.surface!)!.snapshot()): TspNode[] {
		const nodes: TspNode[] = [];
		function visit(node: TspNode): void {
			nodes.push(node);
			for (const child of node.c ?? []) visit(child);
		}
		visit(document);
		return nodes;
	}

	it("keeps transcript, tool cards and an addressable editor through optimistic startup and confirmation", async () => {
		await start({ expected: true, manualProbe: true });
		const firstFrame = new TspDocument(terminal.frames[0]!.sf);
		expect(firstFrame.applyFrame(terminal.frames[0]!)).toEqual([]);
		expect(documentNodes(firstFrame.snapshot()).some(node => node.k === "editor")).toBe(true);
		const pending = mode.getUserInput();
		const toolCall: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "native-call", name: "lookup", arguments: { query: "native" } }],
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
			stopReason: "toolUse",
			timestamp: 2,
		};
		mode.renderSessionContext({
			messages: [
				{ role: "user", content: "native transcript marker", timestamp: 1 },
				toolCall,
				{
					role: "toolResult",
					toolCallId: "native-call",
					toolName: "lookup",
					content: [{ type: "text", text: "native tool result" }],
					isError: false,
					timestamp: 3,
				},
			],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});
		mode.editor.setText("preserved draft");
		mode.ui.requestRender();
		flush();
		const optimistic = documentNodes();
		expect(mode.workspaceEnabled).toBe(false);
		expect(optimistic.find(node => node.k === "editor")?.p).toMatchObject({
			text: "preserved draft",
			sendable: true,
		});
		expect(optimistic.find(node => node.k === "tool" && node.p?.key === "native-call")?.p).toMatchObject({
			name: "lookup",
			status: "done",
		});
		expect(JSON.stringify(optimistic)).toContain("native transcript marker");
		expect(JSON.stringify(optimistic)).toContain("native tool result");
		expect(mode.ui.children.some(child => child instanceof WorkspaceLayout)).toBe(false);

		terminal.answerProbe();
		flush();
		const editor = documentNodes().find(node => node.k === "editor")!;
		terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text: "native submitted prompt" }));
		flush();
		expect((await pending).text).toBe("native submitted prompt");
		expect(terminal.errors).toEqual([]);
	});

	it("adopts a prepaint native surface without wrapping its editor in workspace rows", async () => {
		await start({ expected: true }, true);
		void mode.getUserInput();
		terminal.send("draft after adoption");
		flush();
		expect(documentNodes().find(node => node.k === "editor")?.p).toMatchObject({ text: "draft after adoption" });
		expect(mode.ui.children.some(child => child instanceof WorkspaceLayout)).toBe(false);
		expect(terminal.log.filter(message => message.verb === "o")).toHaveLength(1);
		expect(terminal.errors).toEqual([]);
	});

	it("restores the app workspace on timeout and keeps its draft on a late hello and stop/start", async () => {
		await start({ expected: true, manualProbe: true });
		void mode.getUserInput();
		terminal.send("draft across backends");
		flush();
		flush(1000);
		expect(mode.workspaceEnabled).toBe(true);
		expect(mode.ui.children.some(child => child instanceof WorkspaceLayout)).toBe(true);
		expect(terminal.rowBytes).toContain("draft across backends");

		terminal.answerProbe();
		flush();
		expect(mode.workspaceEnabled).toBe(false);
		expect(documentNodes().find(node => node.k === "editor")?.p).toMatchObject({ text: "draft across backends" });
		mode.ui.stop();
		mode.ui.start();
		flush();
		expect(documentNodes().find(node => node.k === "editor")?.p).toMatchObject({ text: "draft across backends" });
		expect(terminal.errors).toEqual([]);
	});

	it("moves hidden pane focus and overlay restoration back to the native editor on a late handshake", async () => {
		await start({ manualProbe: true });
		void mode.getUserInput();
		flush(100);
		const pane = new Text("auxiliary pane");
		expect(mode.openBtwWorkspacePane(pane)).toBe(true);
		mode.ui.requestRender();
		flush();
		expect(mode.ui.getFocused()).toBe(pane);
		const overlay = new Text("blocking overlay");
		const handle = mode.ui.showOverlay(overlay);
		terminal.answerProbe();
		flush();
		expect(mode.ui.getFocused()).toBe(overlay);
		handle.hide();
		terminal.send("main after handshake");
		flush();
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.editor.getText()).toBe("main after handshake");
		expect(mode.openBtwWorkspacePane(new Text("must not become a hidden pane"))).toBe(false);
		expect(terminal.errors).toEqual([]);
	});
});
