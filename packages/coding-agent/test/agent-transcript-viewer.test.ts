import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { agentTranscriptSource, resolveAgentTranscriptLinks } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentTranscriptViewer, type AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { type Component, ProcessTerminal, setTerminalHyperlinks, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { TspHarness } from "../../tui/test/native/tsp-harness";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";

let widgetAuth: AuthStorage;
let widgetModels: ModelRegistry;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	widgetAuth = await AuthStorage.create(":memory:");
	widgetModels = new ModelRegistry(widgetAuth);
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(() => {
	widgetAuth.close();
	resetSettingsForTest();
});

function createRunningViewer(ui: TUI = new TUI(new ProcessTerminal()), statusContent?: string): AgentTranscriptViewer {
	const registry = new AgentRegistry();
	registry.register({
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		parentId: "Main",
		status: "running",
		session: statusContent ? ({} as never) : null,
	});
	const viewer = new AgentTranscriptViewer({
		transcript: agentTranscriptSource,
		agentId: "Worker",
		registry,
		ui,
		cwd: process.cwd(),
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+a"],
		createStatusLine: () => ({
			getTopBorder: () => ({
				content: statusContent ?? " STATUS ",
				width: Bun.stringWidth(Bun.stripANSI(statusContent ?? " STATUS ")),
				revision: 0,
			}),
			dispose: () => {},
		}),
		requestRender: () => {},
		onClose: () => {},
		onHubToggle: () => {},
	});
	viewer.setViewportHeight(8);
	return viewer;
}

function createNativeViewer(
	h: TspHarness,
	registry: AgentRegistry,
	cwd: string,
	transcript: AgentTranscriptSource = agentTranscriptSource,
): AgentTranscriptViewer {
	const viewer = new AgentTranscriptViewer({
		transcript,
		agentId: "Worker",
		registry,
		ui: h.tui,
		cwd,
		expandKeys: ["ctrl+o"],
		hubKeys: [],
		createStatusLine: () => undefined,
		requestRender: () => h.tui.requestRender(),
		onClose: () => {},
		onHubToggle: () => {},
	});
	h.tui.addChild(viewer);
	return viewer;
}

describe("AgentTranscriptViewer", () => {
	it("replays session widgets into their own pane, follows targeted updates, and disposes on close", () => {
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			widgetModels,
		);
		const ctx = runner.createContext();
		const registry = new AgentRegistry();
		const ui = new TUI(new ProcessTerminal());
		let value = 10;
		let disposed = 0;
		let live!: Component;
		ctx.ui.setWidget(
			"rate",
			() => {
				let closed = false;
				live = {
					render: () => [closed ? "disposed widget" : `Rate ${value * 2}`],
					dispose: () => {
						closed = true;
						disposed++;
					},
				};
				return live;
			},
			{ placement: "belowEditor" },
		);
		ctx.ui.setWidget("above", ["Before editor"]);
		registry.register({
			id: "Widgets",
			displayName: "Widgets",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: { extensionRunner: runner } as AgentSession,
		});
		const open = () => {
			const viewer = new AgentTranscriptViewer({
				transcript: agentTranscriptSource,
				getExtensionPresentation: agentId => registry.get(agentId)?.session?.extensionRunner,
				agentId: "Widgets",
				registry,
				ui,
				cwd: process.cwd(),
				expandKeys: [],
				hubKeys: [],
				createStatusLine: () => ({
					getTopBorder: () => ({ content: " COMPOSER ", width: 10, revision: 0 }),
					dispose() {},
				}),
				requestRender() {},
				onClose() {},
				onHubToggle() {},
			});
			viewer.setViewportHeight(14);
			return viewer;
		};
		const viewer = open();
		let reopened: AgentTranscriptViewer | undefined;
		try {
			const initial = Bun.stripANSI(viewer.render(80).join("\n"));
			expect(initial).toContain("Before editor");
			expect(initial.indexOf("Before editor")).toBeLessThan(initial.indexOf("COMPOSER"));
			expect(initial.indexOf("COMPOSER")).toBeLessThan(initial.indexOf("Rate 20"));
			expect(viewer.containsComponent(live)).toBe(true);
			value = 21;
			expect(Bun.stripANSI(viewer.renderTargeted(80, [live]).join("\n"))).toContain("Rate 42");
			expect(ctx.hasUI).toBe(false);
			viewer.dispose();
			viewer.dispose();
			expect(disposed).toBe(1);
			value = 22;
			reopened = open();
			expect(Bun.stripANSI(reopened.render(80).join("\n"))).toContain("Rate 44");
			ctx.ui.setWidget("rate", ["Ended at 42"], { placement: "belowEditor" });
			expect(disposed).toBe(2);
			const restored = Bun.stripANSI(reopened.render(80).join("\n"));
			expect(restored).toContain("Ended at 42");
			expect(restored).not.toContain("Rate 44");
			ctx.ui.setWidget("rate", undefined);
			expect(Bun.stripANSI(reopened.render(80).join("\n"))).not.toContain("Ended at 42");
		} finally {
			viewer.dispose();
			reopened?.dispose();
			runner.clearManagedTimers();
		}
	});

	it("detaches the old runner on session revival without leaking its widgets into the new session", () => {
		const makeRunner = () =>
			new ExtensionRunner([], new ExtensionRuntime(), process.cwd(), SessionManager.inMemory(), widgetModels);
		const oldRunner = makeRunner();
		const newRunner = makeRunner();
		const registry = new AgentRegistry();
		const oldWidget = { render: () => ["Old run"], dispose: vi.fn() };
		oldRunner.getUIContext().setWidget("activity", () => oldWidget);
		newRunner.getUIContext().setWidget("activity", ["Revived run"]);
		registry.register({
			id: "Revive",
			displayName: "Revive",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: { extensionRunner: oldRunner } as AgentSession,
		});
		const viewer = new AgentTranscriptViewer({
			transcript: agentTranscriptSource,
			getExtensionPresentation: agentId => registry.get(agentId)?.session?.extensionRunner,
			agentId: "Revive",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: process.cwd(),
			expandKeys: [],
			hubKeys: [],
			createStatusLine: () => ({ getTopBorder: () => ({ content: "", width: 0, revision: 0 }), dispose() {} }),
			requestRender() {},
			onClose() {},
			onHubToggle() {},
		});
		viewer.setViewportHeight(12);
		try {
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("Old run");
			registry.attachSession("Revive", { extensionRunner: newRunner } as AgentSession);
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("Revived run");
			expect(oldWidget.dispose).toHaveBeenCalledTimes(1);
			oldRunner.getUIContext().setWidget("late", ["Late old update"]);
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).not.toContain("Late old update");
		} finally {
			viewer.dispose();
			oldRunner.clearManagedTimers();
			newRunner.clearManagedTimers();
		}
	});

	it("keeps an advisor on the unified shell with a read-only composer", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Reviewer",
			displayName: "Reviewer",
			kind: "advisor",
			parentId: "Main",
			status: "idle",
			session: {} as never,
		});
		const peerStatusLine = {
			getTopBorder: vi.fn(() => ({ content: " MAIN STATUS ", width: 13, revision: 0 })),
			dispose: vi.fn(),
		};
		const viewer = new AgentTranscriptViewer({
			transcript: agentTranscriptSource,
			agentId: "Reviewer",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: process.cwd(),
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+a"],
			createStatusLine: () => peerStatusLine,
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(8);
		viewer.focused = true;
		try {
			const header = Bun.stripANSI(viewer.renderWorkspaceHeader(40, true));
			expect(header).toContain("Reviewer");
			expect(header).toContain("idle");
			expect(header).toContain("Esc");
			expect(header).not.toContain("Enter send");
			expect(viewer.renderWorkspaceHeader(40, true)).toContain(theme.fg("accent", theme.bold("Reviewer")));
			expect(Bun.stripANSI(viewer.renderWorkspaceHeader(40, false))).toStartWith("○ Reviewer");

			const before = viewer.render(40);
			expect(before).toHaveLength(8);
			const transcript = Bun.stripANSI(before.join("\n"));
			expect(transcript).toContain("MAIN STATUS");
			expect(transcript).not.toContain("advisor");
			expect(transcript).not.toContain("read-only");
			expect(peerStatusLine.getTopBorder).toHaveBeenCalled();
			viewer.handleInput("x");
			expect(viewer.render(40)).toEqual(before);
		} finally {
			viewer.dispose();
		}
		expect(peerStatusLine.dispose).toHaveBeenCalledTimes(1);
	});

	it("shows a status-line error without blocking the transcript, then recovers in place", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
		});
		const disposeStatusLine = vi.fn();
		const createStatusLine = vi.fn(() => ({
			getTopBorder: () => ({ content: " LIVE STATUS ", width: 13, revision: 0 }),
			dispose: disposeStatusLine,
		}));
		const viewer = new AgentTranscriptViewer({
			transcript: agentTranscriptSource,
			agentId: "Parked",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: process.cwd(),
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+a"],
			createStatusLine,
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(8);
		try {
			const unavailable = Bun.stripANSI(viewer.render(60).join("\n"));
			expect(unavailable).toContain("Status unavailable (parked)");
			expect(unavailable).not.toContain("LIVE STATUS");
			expect(createStatusLine).not.toHaveBeenCalled();

			const session = {} as never;
			expect(registry.attachSession("Parked", session)).toBe(true);
			expect(Bun.stripANSI(viewer.render(60).join("\n"))).toContain("LIVE STATUS");
		} finally {
			viewer.dispose();
		}
		expect(disposeStatusLine).toHaveBeenCalledTimes(1);
	});

	it("plays the completed-agent petrification before closing", () => {
		vi.useFakeTimers();
		const viewer = createRunningViewer();
		const close = vi.fn();
		try {
			const normal = viewer.render(40);
			const normalHeader = viewer.renderWorkspaceHeader(40, false);
			viewer.startAutoClose(close);
			vi.advanceTimersByTime(64);
			const petrifyingHeader = viewer.renderWorkspaceHeader(40, false);
			expect(petrifyingHeader).not.toBe(normalHeader);
			viewer.cancelAutoClose();
			expect(viewer.render(40)).toEqual(normal);
			expect(viewer.renderWorkspaceHeader(40, false)).toBe(normalHeader);

			viewer.startAutoClose(close);
			vi.advanceTimersByTime(2_999);
			expect(close).not.toHaveBeenCalled();
			vi.advanceTimersByTime(16);
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			viewer.dispose();
		}
	});

	it("petrifies diagonally from the top-left without moving glyphs", () => {
		vi.useFakeTimers();
		const viewer = createRunningViewer();
		try {
			const normal = viewer.render(40);
			viewer.startAutoClose(() => {});
			vi.advanceTimersByTime(1_200);
			const petrifying = viewer.render(40);

			expect(petrifying[0]).not.toBe(normal[0]);
			expect(Bun.stripANSI(petrifying[0] ?? "").trimEnd()).toBe(Bun.stripANSI(normal[0] ?? "").trimEnd());
			expect(petrifying.at(-1)).toBe(normal.at(-1));
		} finally {
			viewer.dispose();
		}
	});

	it("preserves styled backgrounds while petrifying foreground glyphs", () => {
		vi.useFakeTimers();
		const background = theme.bg("statusLineBg", " STONE STATUS ");
		const viewer = createRunningViewer(new TUI(new ProcessTerminal()), background);
		try {
			const normal = viewer.render(40);
			const normalStatus = normal.find(line => Bun.stripANSI(line).includes("STONE STATUS"));
			expect(normalStatus).toContain(theme.getBgAnsi("statusLineBg"));

			viewer.startAutoClose(() => {});
			vi.advanceTimersByTime(2_600);
			const petrifiedStatus = viewer.render(40).find(line => Bun.stripANSI(line).includes("STONE STATUS"));

			expect(Bun.stripANSI(petrifiedStatus ?? "")).toBe(Bun.stripANSI(normalStatus ?? ""));
			expect(petrifiedStatus).toContain(theme.getBgAnsi("statusLineBg"));
		} finally {
			viewer.dispose();
		}
	});

	it("restores the pane and permanently abandons auto-close after interaction", () => {
		vi.useFakeTimers();
		const viewer = createRunningViewer();
		const close = vi.fn();
		try {
			const normal = viewer.render(40);
			viewer.startAutoClose(close);
			vi.advanceTimersByTime(2_999);
			viewer.handleInput("\x1b[5~");
			expect(viewer.render(40)).toEqual(normal);

			viewer.startAutoClose(close);
			vi.advanceTimersByTime(3_100);
			expect(close).not.toHaveBeenCalled();
		} finally {
			viewer.dispose();
		}
	});

	it("repaints the dissolve at display-frame cadence", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const viewer = createRunningViewer(ui);
		try {
			viewer.startAutoClose(() => {});
			requestComponentRender.mockClear();

			vi.advanceTimersByTime(1_000);
			const viewerPaints = requestComponentRender.mock.calls.filter(([component]) => component === viewer);
			expect(viewerPaints.length).toBeGreaterThanOrEqual(60);
		} finally {
			viewer.dispose();
		}
	});

	it("replaces subagent thinking in the pane and paints an asynchronous translation", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-thinking-"));
		const file = path.join(dir, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		const assistant = {
			...createAssistantMessage("Answer"),
			content: [
				{ type: "thinking" as const, thinking: "Inspect project" },
				{ type: "text" as const, text: "Answer" },
			],
		};
		fs.writeFileSync(
			file,
			`${[
				{ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: dir },
				{ type: "message", id: "m0", parentId: null, timestamp, message: assistant },
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
		});
		let translated = "翻译中…";
		let requestRender: (() => void) | undefined;
		const viewer = new AgentTranscriptViewer({
			transcript: agentTranscriptSource,
			agentId: "Worker",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: dir,
			getAssistantThinkingRenderers: () => [
				context => {
					requestRender = context.requestRender;
					return { type: "replace", component: { render: () => [translated] } };
				},
			],
			expandKeys: [],
			hubKeys: [],
			createStatusLine: () => undefined,
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(12);
		try {
			const before = Bun.stripANSI(viewer.render(80).join("\n"));
			expect(before).toContain("翻译中");
			expect(before).not.toContain("Inspect project");
			translated = "检查项目";
			requestRender?.();
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("检查项目");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves parked subagent links against its own persisted cwd", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-link-"));
		const childCwd = path.join(root, "child");
		const mainCwd = path.join(root, "main");
		fs.mkdirSync(childCwd);
		fs.mkdirSync(mainCwd);
		fs.writeFileSync(path.join(childCwd, "note.md"), "child");
		fs.writeFileSync(path.join(mainCwd, "note.md"), "main");
		const file = path.join(root, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		fs.writeFileSync(
			file,
			`${[
				{ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: childCwd },
				{
					type: "message",
					id: "m0",
					parentId: null,
					timestamp,
					message: createAssistantMessage("[note](note.md)"),
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
		});
		const originalHyperlinks = TERMINAL.hyperlinks;
		setTerminalHyperlinks(true);
		const resolved = Promise.withResolvers<void>();
		const viewer = new AgentTranscriptViewer({
			transcript: agentTranscriptSource,
			agentId: "Worker",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: mainCwd,
			resolveLinks: async (texts, cwd) => {
				const targets = await resolveAgentTranscriptLinks(registry, "Worker", texts, cwd);
				resolved.resolve();
				return targets;
			},
			expandKeys: [],
			hubKeys: [],
			createStatusLine: () => undefined,
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(12);
		try {
			await resolved.promise;
			await Promise.resolve();
			const displayed = viewer.render(80).join("\n");
			expect(displayed).toContain(fileUriForTerminal(path.join(childCwd, "note.md"), undefined, TERMINAL.id));
			expect(displayed).not.toContain(fileUriForTerminal(path.join(mainCwd, "note.md"), undefined, TERMINAL.id));
		} finally {
			viewer.dispose();
			setTerminalHyperlinks(originalHyperlinks);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("discards a previous subagent session's late link result after revival", async () => {
		vi.useFakeTimers();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-link-revive-"));
		const file = path.join(root, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		fs.writeFileSync(
			file,
			`${[
				{ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: root },
				{
					type: "message",
					id: "m0",
					parentId: null,
					timestamp,
					message: createAssistantMessage("[note](note.md)"),
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
		});
		const old = Promise.withResolvers<ReadonlyMap<string, string>>();
		const current = Promise.withResolvers<ReadonlyMap<string, string>>();
		const currentRequested = Promise.withResolvers<void>();
		let requests = 0;
		const originalHyperlinks = TERMINAL.hyperlinks;
		setTerminalHyperlinks(true);
		const viewer = new AgentTranscriptViewer({
			transcript: agentTranscriptSource,
			agentId: "Worker",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: root,
			resolveLinks: () => {
				if (++requests === 1) return old.promise;
				currentRequested.resolve();
				return current.promise;
			},
			expandKeys: [],
			hubKeys: [],
			createStatusLine: () => undefined,
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(12);
		try {
			expect(requests).toBe(1);
			registry.attachSession("Worker", {} as unknown as AgentSession, file);
			viewer.render(80);
			vi.advanceTimersByTime(250);
			await currentRequested.promise;
			expect(requests).toBe(2);
			current.resolve(new Map([["note.md", "file:///current/note.md"]]));
			await current.promise;
			await Promise.resolve();
			expect(viewer.render(80).join("\n")).toContain("file:///current/note.md");
			old.resolve(new Map([["note.md", "file:///old/note.md"]]));
			await old.promise;
			await Promise.resolve();
			expect(viewer.render(80).join("\n")).not.toContain("file:///old/note.md");
		} finally {
			viewer.dispose();
			setTerminalHyperlinks(originalHyperlinks);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("translates live subagent thinking and hands it to the persisted turn without duplication", () => {
		vi.useFakeTimers();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-live-thinking-"));
		const file = path.join(dir, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: dir })}\n`,
		);
		const state: { messages: AgentMessage[]; streamMessage: AgentMessage | null } = {
			messages: [],
			streamMessage: null,
		};
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: { agent: { state } } as AgentSession,
			sessionFile: file,
		});
		const assistant = {
			...createAssistantMessage("Answer"),
			timestamp: 42,
			content: [
				{ type: "thinking" as const, thinking: "Inspect first" },
				{ type: "text" as const, text: "Answer" },
			],
		};
		const viewer = new AgentTranscriptViewer({
			transcript: agentTranscriptSource,
			agentId: "Worker",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: dir,
			getAssistantThinkingRenderers: () => [
				context => ({
					type: "replace",
					component: {
						render: () => [
							context.text === "Inspect first"
								? "先检查"
								: context.text === "Inspect second"
									? "继续检查"
									: "检查完成",
						],
					},
				}),
			],
			expandKeys: [],
			hubKeys: [],
			createStatusLine: () => undefined,
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(12);
		try {
			state.streamMessage = assistant;
			vi.advanceTimersByTime(250);
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("先检查");

			state.streamMessage = {
				...assistant,
				content: [
					{ type: "thinking", thinking: "Inspect second" },
					{ type: "text", text: "Answer" },
				],
			};
			vi.advanceTimersByTime(250);
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("继续检查");

			const finalMessage = {
				...assistant,
				content: [
					{ type: "thinking" as const, thinking: "Inspect final" },
					{ type: "text" as const, text: "Answer" },
				],
			};
			state.messages.push(finalMessage);
			state.streamMessage = null;
			vi.advanceTimersByTime(250);
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("检查完成");
			const persistedLine = JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp,
				message: finalMessage,
			});
			const split = Math.floor(persistedLine.length / 2);
			fs.appendFileSync(file, persistedLine.slice(0, split));
			vi.advanceTimersByTime(250);
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("检查完成");
			fs.appendFileSync(file, `${persistedLine.slice(split)}\n`);
			vi.advanceTimersByTime(250);
			const completed = Bun.stripANSI(viewer.render(80).join("\n"));
			expect(completed).toContain("检查完成");
			expect(completed.match(/检查完成/g)).toHaveLength(1);
			expect(completed).not.toContain("继续检查");

			state.streamMessage = {
				...assistant,
				timestamp: 43,
				content: [
					{ type: "thinking", thinking: "Inspect second" },
					{ type: "text", text: "Next" },
				],
			};
			vi.advanceTimersByTime(250);
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("继续检查");
			registry.attachSession(
				"Worker",
				{ agent: { state: { messages: [], streamMessage: null } } } as unknown as AgentSession,
				file,
			);
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).not.toContain("继续检查");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists a live assistant without replacing its native markdown identity", async () => {
		vi.useFakeTimers();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-native-live-"));
		const file = path.join(dir, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		const header = { type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: dir };
		fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
		const assistant = { ...createAssistantMessage("Stable answer"), timestamp: 42 };
		const state: { messages: AgentMessage[]; streamMessage: AgentMessage | null } = {
			messages: [],
			streamMessage: assistant,
		};
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: { agent: { state } } as AgentSession,
			sessionFile: file,
		});
		const h = await TspHarness.start();
		const viewer = createNativeViewer(h, registry, dir);
		try {
			await h.render();
			const md = h.find(node => node.k === "md" && node.p?.text === "Stable answer")!;
			expect(md.p).toMatchObject({ stream: true });
			const frames = h.frames.length;
			state.messages.push(assistant);
			state.streamMessage = null;
			const entry = { type: "message", id: "m0", parentId: null, timestamp, message: assistant };
			const line = JSON.stringify(entry);
			const split = Math.floor(line.length / 2);
			fs.appendFileSync(file, line.slice(0, split));
			vi.advanceTimersByTime(250);
			await h.render();
			expect(h.byId(md.id)).toMatchObject({ k: "md", p: { text: "Stable answer" } });
			fs.appendFileSync(file, `${line.slice(split)}\n`);
			vi.advanceTimersByTime(250);
			await h.render();
			expect(h.byId(md.id)).toMatchObject({ k: "md", p: { text: "Stable answer" } });
			expect(h.byId(md.id)?.p).not.toHaveProperty("stream");
			expect(h.findAll(node => node.k === "md" && node.p?.text === "Stable answer")).toHaveLength(1);
			const ops = h.frames.slice(frames).flatMap(frame => frame.ops);
			expect(ops.some(op => op[0] === "del" && (op[1] === md.id || md.id.startsWith(`${op[1]}.`)))).toBe(false);
			expect(ops.some(op => op[0] === "add" && JSON.stringify(op).includes(`"id":"${md.id}"`))).toBe(false);
			// The old response remaining in agent.state must not appear as a new live tail.
			vi.advanceTimersByTime(250);
			await h.render();
			expect(h.findAll(node => node.k === "md" && node.p?.text === "Stable answer")).toHaveLength(1);
			expect(h.errors).toEqual([]);
		} finally {
			viewer.dispose();
			h.stop();
			setNativeRendering(false);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps valid native content until a complete reload publishes and cancels a rotated late load", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-native-reload-"));
		const file = path.join(dir, "Worker.jsonl");
		const rotated = path.join(dir, "Rotated.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		const write = (target: string, prefix: string, count = 1) => {
			const entries = [
				{ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: dir },
				...Array.from({ length: count }, (_, index) => ({
					type: "message",
					id: `${prefix}-${index}`,
					parentId: null,
					timestamp,
					message: { role: "user", content: `${prefix}-${index}`, timestamp: index },
				})),
			];
			fs.writeFileSync(target, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		};
		write(file, "old");
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
		});
		const gates = Array.from({ length: 4 }, () => ({
			read: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
		}));
		let nextRead = 0;
		const source: AgentTranscriptSource = {
			...agentTranscriptSource,
			async visitEntries(target, visit, options) {
				const gate = gates[nextRead++]!;
				await agentTranscriptSource.visitEntries(target, visit, options);
				gate.read.resolve();
				await gate.release.promise;
			},
		};
		const h = await TspHarness.start();
		const viewer = createNativeViewer(h, registry, dir, source);
		try {
			await h.render();
			const old = h.find(node => node.k === "md" && node.p?.text === "old-0")!;
			write(file, "replacement", 140);
			await gates[0]!.read.promise;
			await h.render();
			expect(h.byId(old.id)).toMatchObject({ k: "md", p: { text: "old-0" } });
			expect(h.find(node => node.k === "md" && node.p?.text === "replacement-139")).toBeUndefined();
			gates[0]!.release.resolve();
			await h.until(() => h.find(node => node.k === "md" && node.p?.text === "replacement-139") !== undefined);
			expect(h.byId(old.id)).toBeUndefined();

			write(file, "cancelled", 140);
			await gates[1]!.read.promise;
			write(rotated, "current");
			registry.get("Worker")!.sessionFile = rotated;
			await gates[2]!.read.promise;
			gates[2]!.release.resolve();
			await h.until(() => h.find(node => node.k === "md" && node.p?.text === "current-0") !== undefined);
			gates[1]!.release.resolve();
			await gates[1]!.release.promise;
			// Let the viewer's continuation consume the now-completed source read.
			await Promise.resolve();
			await h.render();
			expect(h.findAll(node => node.k === "md").map(node => (node.k === "md" ? node.p?.text : undefined))).toEqual([
				"current-0",
			]);

			write(rotated, "failed", 140);
			await gates[3]!.read.promise;
			gates[3]!.release.reject(new Error("snapshot read failed"));
			await gates[3]!.release.promise.catch(() => {});
			await h.until(() => h.find(node => node.k === "text" && node.p?.tone === "error") !== undefined);
			expect(h.findAll(node => node.k === "md").map(node => (node.k === "md" ? node.p?.text : undefined))).toEqual([
				"current-0",
			]);
			expect(h.find(node => node.k === "text" && node.p?.tone === "error")).toMatchObject({
				k: "text",
				p: { text: expect.stringContaining("snapshot read failed") },
			});
			expect(h.errors).toEqual([]);
		} finally {
			for (const gate of gates) gate.release.resolve();
			viewer.dispose();
			h.stop();
			setNativeRendering(false);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("publishes initial large-transcript batches before the source read completes", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-load-"));
		const file = path.join(dir, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		const entries: unknown[] = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: dir },
			{ type: "custom", id: "padding", timestamp, data: "x".repeat(2 * 1024 * 1024) },
			...Array.from({ length: 300 }, (_value, index) => ({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp,
				message: { role: "user", content: `row-${index}`, timestamp: index },
			})),
		];
		fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
		});
		// oxlint-disable-next-line prefer-const -- requestRender may run during construction before assignment
		let viewer: AgentTranscriptViewer | undefined;
		const loaded = Promise.withResolvers<void>();
		const read = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		viewer = new AgentTranscriptViewer({
			transcript: {
				...agentTranscriptSource,
				async visitEntries(target, visit, options) {
					await agentTranscriptSource.visitEntries(target, visit, options);
					read.resolve();
					await release.promise;
				},
			},
			agentId: "Worker",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: dir,
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+a"],
			createStatusLine: () => ({
				getTopBorder: () => ({ content: " STATUS ", width: 8, revision: 0 }),
				dispose: () => {},
			}),
			requestRender: () => {
				if (viewer && Bun.stripANSI(viewer.render(60).join("\n")).includes("row-299")) loaded.resolve();
			},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(12);
		try {
			const immediate = Bun.stripANSI(viewer.render(60).join("\n"));
			expect(immediate).toContain("Loading transcript");
			expect(immediate).not.toContain("row-299");

			await read.promise;
			expect(Bun.stripANSI(viewer.render(60).join("\n"))).toMatch(/\brow-\d+\b/);
			release.resolve();
			await loaded.promise;
			expect(Bun.stripANSI(viewer.render(60).join("\n"))).toContain("row-299");
		} finally {
			release.resolve();
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("opens a persisted activity entry inside the virtualized transcript", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-deep-link-"));
		const file = path.join(dir, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		const entries = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: dir },
			...Array.from({ length: 30 }, (_value, index) => ({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp,
				message: { role: "user", content: `activity-row-${index}`, timestamp: index },
			})),
		];
		fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
		});
		const viewer = new AgentTranscriptViewer({
			transcript: agentTranscriptSource,
			agentId: "Worker",
			initialEntryId: "m20",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: dir,
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+a"],
			createStatusLine: () => ({
				getTopBorder: () => ({ content: " STATUS ", width: 8, revision: 0 }),
				dispose: () => {},
			}),
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(8);
		try {
			const rendered = Bun.stripANSI(viewer.render(60).join("\n"));
			expect(rendered).toContain("activity-row-20");
			expect(rendered).not.toContain("activity-row-0");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
