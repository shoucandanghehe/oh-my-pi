import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { BtwConversationPane } from "@oh-my-pi/pi-coding-agent/modes/components/btw-conversation-pane";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ManualScheduler, TspTestTerminal, tspEvent } from "../../tui/test/native/tsp-harness";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

async function harness(scroll = true, manualProbe = false) {
	await initTheme(false);
	resetSettingsForTest();
	const directory = TempDir.createSync("@pi-btw-native-");
	await Settings.init({ inMemory: true, cwd: directory.path() });
	const auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
	const registry = new ModelRegistry(auth);
	const model = registry.find("anthropic", "claude-sonnet-4-5")!;
	auth.keys.setRuntime(model.provider, "test-key");
	const requests: { context: Context; options: SimpleStreamOptions; stream: AssistantMessageEventStream }[] = [];
	const requestSignals = new Map<number, { promise: Promise<void>; resolve: () => void }>();
	async function requestStarted(index: number): Promise<void> {
		if (!requests[index]) {
			const signal = Promise.withResolvers<void>();
			requestSignals.set(index, signal);
			await signal.promise;
		}
		flush();
	}
	const sideStreamFn: StreamFn = (_model, context, options) => {
		const stream = new AssistantMessageEventStream();
		requests.push({
			context: { ...context, messages: structuredClone(context.messages) },
			options: options ?? {},
			stream,
		});
		requestSignals.get(requests.length - 1)?.resolve();
		return stream;
	};
	const manager = SessionManager.create(directory.path(), directory.path());
	const mainMessage = { role: "user" as const, content: "Main stays native", timestamp: 1 };
	manager.appendMessage(mainMessage);
	await manager.ensureOnDisk();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [mainMessage] } }),
		sessionManager: manager,
		settings: Settings.isolated({ "startup.quiet": true, "compaction.enabled": false }),
		modelRegistry: registry,
		sideStreamFn,
	});
	const terminal = new TspTestTerminal({ cols: 120, rows: 32, features: scroll ? ["scroll"] : [], manualProbe });
	const scheduler = new ManualScheduler();
	const previous = Bun.env.PI_TUI_RENDER_BACKEND;
	let composer: Composer;
	try {
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		composer = new Composer({ terminal, tuiOptions: { renderScheduler: scheduler } });
	} finally {
		if (previous === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
		else Bun.env.PI_TUI_RENDER_BACKEND = previous;
	}
	const mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	await mode.init({ suppressWelcomeIntro: true });
	mode.renderSessionContext({ messages: [mainMessage], models: {}, injectedTtsrRules: [], mode: "none" });
	cleanups.push(async () => {
		mode.stop();
		await mode.getPausedExitParticipants()[0]!.dispose();
		await session.dispose();
		auth.close();
		directory.removeSync();
	});
	function flush(advanceMs = 20) {
		scheduler.flush(
			advanceMs,
			() => (!manualProbe && terminal.answersProbe && terminal.answerProbe()) || terminal.deliver(),
		);
	}
	flush();
	function nodes(): TspNode[] {
		const all: TspNode[] = [];
		function visit(node: TspNode) {
			all.push(node);
			for (const child of node.c ?? []) visit(child);
		}
		visit(terminal.docs.get(terminal.surface!)!.snapshot());
		return all;
	}
	async function until(predicate: () => boolean) {
		for (let turn = 0; !predicate(); turn++) {
			if (turn === 10_000)
				throw new Error(
					`Native BTW transition did not settle: ${JSON.stringify(
						nodes()
							.filter(node => node.k === "text" || node.k === "item")
							.map(node => node.p),
					)}`,
				);
			await setImmediate();
			flush();
		}
	}
	function action(act: string) {
		const button = nodes().find(node => node.p?.actions?.click === act)!;
		expect(button).toBeDefined();
		terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: button.id, act }));
		flush();
	}
	function select(key: string) {
		const list = nodes().find(node => node.k === "list")!;
		const item = list.c!.find(node => node.id.endsWith(`/${key}`))!;
		expect(item).toBeDefined();
		terminal.send(tspEvent({ ev: "select", sf: terminal.surface!, id: list.id, item: item.id }));
		flush();
	}
	function pane(): BtwConversationPane {
		const focused = mode.ui.getFocused();
		expect(focused).toBeInstanceOf(BtwConversationPane);
		return focused as BtwConversationPane;
	}
	async function complete(index: number, text: string) {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: index + 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		requests[index]!.stream.push({ type: "done", reason: "stop", message });
		await until(
			() =>
				JSON.stringify(nodes()).includes(text) &&
				!nodes().some(node => node.k === "item" && JSON.stringify(node.p?.detail).includes("running")),
		);
		await mode.getPausedExitParticipants()[0]!.flush();
	}
	async function records() {
		await mode.getPausedExitParticipants()[0]!.flush();
		const store = await BtwHistoryStore.openThreads(manager.getLocalArtifactsDir()!);
		try {
			return [...store.getRecords()];
		} finally {
			await store.close();
		}
	}
	return { mode, terminal, requests, requestStarted, nodes, flush, until, action, select, pane, complete, records };
}

describe("durable BTW through the native terminal and production controller", () => {
	it("keeps running threads and separate drafts across sheet close/reopen, and follows up in the same lineage", async () => {
		const h = await harness();
		void h.mode.getUserInput();
		await h.mode.handleBtwCommand("first question");
		await h.requestStarted(0);
		expect(h.mode.workspaceEnabled).toBe(false);
		expect(h.nodes().some(node => node.k === "rows")).toBe(false);
		expect(JSON.stringify(h.nodes())).toContain("Main stays native");
		const firstKey = (await h.records())[0]!.id;
		h.pane().getPasteTarget()!.pasteText("first draft");
		h.action("close");
		expect(h.mode.ui.getFocused()).toBe(h.mode.editor);
		expect(h.requests[0]!.options.signal?.aborted).toBe(false);
		await h.mode.handleBtwCommand("");
		h.flush();
		expect(h.pane().getPasteTarget()!.getText()).toBe("first draft");
		h.action("new");
		const secondKey = (await h.records()).find(record => record.id !== firstKey)!.id;
		h.pane().getPasteTarget()!.pasteText("second draft");
		h.select(firstKey);
		expect(h.pane().getPasteTarget()!.getText()).toBe("first draft");
		h.terminal.send("\x1b");
		h.flush();
		await h.mode.handleBtwCommand("");
		h.flush();
		h.select(secondKey);
		expect(h.pane().getPasteTarget()!.getText()).toBe("second draft");
		h.select(firstKey);
		expect(h.pane().getPasteTarget()!.getText()).toBe("first draft");
		await h.complete(0, "first answer");
		h.pane().getPasteTarget()!.clearDraft();
		h.flush();
		const editor = h
			.nodes()
			.filter(node => node.k === "editor")
			.at(-1)!;
		h.terminal.send(tspEvent({ ev: "send", sf: h.terminal.surface!, id: editor.id, text: "follow up" }));
		h.flush();
		await h.requestStarted(1);
		expect(h.requests[1]!.options.sessionId).toBe(h.requests[0]!.options.sessionId);
		expect(JSON.stringify(h.requests[1]!.context.messages)).toContain("first answer");
		await h.complete(1, "follow-up answer");
		const stored = await h.records();
		expect(stored.find(record => record.id === firstKey)!.turns.map(turn => turn.input)).toEqual([
			"first question",
			"follow up",
		]);
		expect(stored.find(record => record.id === secondKey)!.draft).toBe("second draft");
		h.terminal.send("\x1b[5~");
		h.flush();
		expect(h.terminal.frames.flatMap(frame => frame.ops).some(op => op[0] === "scroll" && op[2] === "page-up")).toBe(
			true,
		);
		await h.mode.handleBtwCommand("background at stop");
		await h.requestStarted(2);
		const stoppedKey = (await h.records()).find(record => record.title === "background at stop")!.id;
		h.pane().getPasteTarget()!.pasteText("stopped draft");
		h.mode.stop();
		expect(h.mode.ui.hasOverlay()).toBe(false);
		expect(h.requests[2]!.options.signal?.aborted).toBe(false);
		expect((await h.records()).find(record => record.id === stoppedKey)!.draft).toBe("stopped draft");
		expect(h.terminal.errors).toEqual([]);
	});

	it("retires the ANSI pane on a late hello without hiding native focus or losing its durable draft", async () => {
		const h = await harness(true, true);
		void h.mode.getUserInput();
		h.flush(100);
		expect(h.mode.workspaceEnabled).toBe(true);
		await h.mode.handleBtwCommand("late native question");
		await h.requestStarted(0);
		await h.mode.handleBtwCommand("");
		const key = (await h.records())[0]!.id;
		h.pane().getPasteTarget()!.pasteText("late native draft");
		h.terminal.answerProbe();
		h.flush();
		expect(h.mode.workspaceEnabled).toBe(false);
		expect(h.mode.ui.getFocused()).toBe(h.mode.editor);
		expect(h.requests[0]!.options.signal?.aborted).toBe(false);
		await h.mode.handleBtwCommand("");
		h.flush();
		expect(h.pane().getPasteTarget()!.getText()).toBe("late native draft");
		expect(h.nodes().filter(node => node.k === "overlay")).toHaveLength(1);
		expect(h.nodes().some(node => node.k === "rows")).toBe(false);
		expect((await h.records())[0]!.id).toBe(key);
		h.action("close");
		expect(h.mode.ui.getFocused()).toBe(h.mode.editor);
		expect(h.terminal.errors).toEqual([]);
	});

	it("reports absent native scroll support instead of silently scrolling an invisible VT viewport", async () => {
		const h = await harness(false);
		void h.mode.getUserInput();
		await h.mode.handleBtwCommand("scroll question");
		await h.requestStarted(0);
		await h.complete(0, "scroll answer");
		h.terminal.send("\x1b[5~");
		h.flush();
		expect(JSON.stringify(h.nodes())).toContain("does not support keyboard transcript scrolling");
		expect(h.terminal.frames.flatMap(frame => frame.ops).some(op => op[0] === "scroll")).toBe(false);
	});

	it("routes native copy, delete and promotion to durable threads and keeps explicit history separate", async () => {
		const h = await harness();
		void h.mode.getUserInput();
		await h.mode.handleBtwCommand("");
		h.flush();
		const emptyRail = h.nodes().find(node => node.k === "list")!;
		expect(emptyRail.k).toBe("list");
		expect(emptyRail.c ?? []).toEqual([]);
		await h.mode.handleBtwCommand("promote question");
		await h.requestStarted(0);
		await h.complete(0, "promote answer");
		await h.mode.handleBtwCommand("");
		h.flush();
		expect(h.nodes().filter(node => node.k === "overlay")).toHaveLength(1);
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		h.action("copy-thread");
		await h.until(() => copy.mock.calls.length === 1);
		expect(copy.mock.calls[0]![0]).toContain("promote answer");
		const firstKey = (await h.records())[0]!.id;
		h.action("new");
		h.action("delete");
		await h.until(() => h.nodes().find(node => node.k === "list")?.c?.length === 1);
		expect((await h.records()).map(record => record.id)).toEqual([firstKey]);
		const previousSessionId = h.mode.sessionManager.getSessionId();
		h.action("promote");
		await h.until(() => h.mode.sessionManager.getSessionId() !== previousSessionId);
		await h.until(() => !h.mode.ui.hasOverlay());
		expect(JSON.stringify(h.mode.sessionManager.getBranch())).toContain("promote answer");
		expect(h.nodes().some(node => node.k === "rows")).toBe(false);
		await h.mode.handleBtwCommand("--history");
		h.flush();
		expect(h.nodes().find(node => node.k === "overlay")?.p?.role).toBe("omp.overlay.btwHistory");
		expect(h.terminal.errors).toEqual([]);
	});
});
