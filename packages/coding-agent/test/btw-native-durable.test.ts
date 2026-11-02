import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, ImageContent, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { BtwConversationPane } from "@oh-my-pi/pi-coding-agent/modes/components/btw-conversation-pane";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BtwSessionStore } from "@oh-my-pi/pi-coding-agent/session/btw-session-store";
import type { EphemeralConversation } from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sessionCommandQueue } from "@oh-my-pi/pi-coding-agent/session/session-command-queue";
import { cfgRetryEnabled } from "@oh-my-pi/pi-coding-agent/session/settings";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Text } from "@oh-my-pi/pi-tui";
import { text } from "@oh-my-pi/pi-tui/native/describe";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { TSP_KINDS, type TspNode } from "@oh-my-pi/pi-wire";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ManualScheduler, TspTestTerminal, tspEvent } from "../../tui/test/native/tsp-harness";
import { NativePaneHarness } from "./helpers/native-pane-harness";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { createMainWriteTool, sendToMainSessionCall } from "./helpers/btw-send-to-main";
import { AgentRegistry } from "../src/registry/agent-registry";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

async function harness(scroll = true, manualProbe = false, native?: NativePaneHarness, nativeMenu = true) {
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
		options?.signal?.addEventListener(
			"abort",
			() => {
				const error = createAssistantMessage("");
				error.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error });
			},
			{ once: true },
		);
		return stream;
	};
	const manager = SessionManager.create(directory.path(), directory.path());
	const mainMessage = { role: "user" as const, content: "Main stays native", timestamp: 1 };
	manager.appendMessage(mainMessage);
	await manager.ensureOnDisk();
	const write = createMainWriteTool();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [write], messages: [mainMessage] } }),
		toolRegistry: new Map([["write", write]]),
		builtInToolNames: new Set(["write"]),
		sessionManager: manager,
		settings: Settings.isolated({
			"startup.quiet": true,
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
		}),
		modelRegistry: registry,
		sideStreamFn,
	});
	vi.spyOn(session, "generateTitle").mockResolvedValue(null);
	const conversations: EphemeralConversation[] = [];
	const createConversation = session.createEphemeralConversation.bind(session);
	vi.spyOn(session, "createEphemeralConversation").mockImplementation((...args) => {
		const conversation = createConversation(...args);
		conversations.push(conversation);
		return conversation;
	});
	const terminal = new TspTestTerminal({
		cols: 120,
		rows: 32,
		features: scroll ? ["scroll"] : [],
		manualProbe,
		kinds: TSP_KINDS.filter(kind => nativeMenu || kind !== "menu"),
	});
	const scheduler = new ManualScheduler();
	const previous = Bun.env.PI_TUI_RENDER_BACKEND;
	let mode: InteractiveMode;
	try {
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		const composer = new Composer({ terminal, tuiOptions: { renderScheduler: scheduler } });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, composer);
	} finally {
		if (previous === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
		else Bun.env.PI_TUI_RENDER_BACKEND = previous;
	}
	mode.nativeWorkspace = native?.workspace;
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
		const targetNow = scheduler.now() + advanceMs;
		scheduler.flush(
			advanceMs,
			() => (!manualProbe && terminal.answersProbe && terminal.answerProbe()) || terminal.deliver(),
		);
		scheduler.advance(targetNow - scheduler.now());
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
	function pick(item: string) {
		const picker = nodes().find(node => node.k === "picker")!;
		expect(picker.p?.items?.some(candidate => candidate.id === item)).toBe(true);
		terminal.send(tspEvent({ ev: "activate", sf: terminal.surface!, id: picker.id, item }));
		flush();
	}
	function select(key: string) {
		action("threads");
		pick(key);
	}
	function threadAction(act: string) {
		const menu = nodes().find(node => node.k === "menu");
		if (menu) {
			expect(menu.p?.items?.some(item => typeof item === "object" && "id" in item && item.id === act)).toBe(true);
			terminal.send(tspEvent({ ev: "toggle", sf: terminal.surface!, id: menu.id, open: true }));
			flush();
			terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: menu.id, act }));
			flush();
			return;
		}
		action("more");
		const list = nodes().find(node => node.k === "list")!;
		const item = list.c!.find(node => node.id.endsWith(`/${act}`))!;
		expect(item).toBeDefined();
		terminal.send(tspEvent({ ev: "select", sf: terminal.surface!, id: list.id, item: item.id }));
		flush();
	}
	function pane(): BtwConversationPane {
		const focused = mode.nativeWorkspace?.get("btw")?.component ?? mode.ui.getFocused();
		expect(focused).toBeInstanceOf(BtwConversationPane);
		return focused as BtwConversationPane;
	}
	async function complete(index: number, text: string, replyText?: string) {
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
		if (native) {
			await native.until(async () => {
				for (const record of await records()) {
					if (replyText !== undefined && !record.turns.some(turn => turn.replyText === replyText)) continue;
					const snapshot = await journal(record.key);
					if (
						snapshot.entries.some(
							entry =>
								entry.type === "message" &&
								entry.message.role === "assistant" &&
								entry.message.timestamp === message.timestamp,
						)
					)
						return true;
				}
				return false;
			});
		} else {
			await until(
				() =>
					JSON.stringify(nodes()).includes(text) &&
					!nodes().some(node => node.k === "item" && JSON.stringify(node.p?.detail).includes("running")),
			);
		}
		await mode.getPausedExitParticipants()[0]!.flush();
	}
	async function records() {
		await mode.getPausedExitParticipants()[0]!.flush();
		return [...(await BtwSessionStore.readRecords(manager.getLocalArtifactsDir()!, directory.path()))];
	}
	async function journal(key: string) {
		const record = (await records()).find(record => record.key === key);
		const file = conversations
			.find(conversation => conversation.checkpoint().sideSessionId === record?.sideSessionId)
			?.sessionManager.getSessionFile();
		if (!file) throw new Error(`Missing standard BTW journal: ${key}`);
		const directoryPath = path.dirname(file);
		const side = await SessionManager.open(file, directoryPath, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		try {
			return {
				entries: structuredClone(side.getEntries()),
				branch: structuredClone(side.getBranch()),
				leafId: side.getLeafId(),
			};
		} finally {
			await side.close();
		}
	}
	async function createChildSession(tools: AgentTool[] = [], factory?: ExtensionFactory) {
		const sessionManager = SessionManager.create(directory.path(), directory.path());
		const childSettings = Settings.isolated({
			"startup.quiet": true,
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
			"extensionRenderers.assistantText": true,
		});
		let extensionRunner: ExtensionRunner | undefined;
		if (factory) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				factory,
				directory.path(),
				new EventBus(),
				runtime,
				"pane-test",
			);
			extensionRunner = new ExtensionRunner(
				[extension],
				runtime,
				directory.path(),
				sessionManager,
				registry,
				undefined,
				childSettings,
			);
		}
		const child = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test child"], tools, messages: [] },
				streamFn: sideStreamFn,
			}),
			sessionManager,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: [],
			extensionRunner,
			settings: childSettings,
			modelRegistry: registry,
		});
		await sessionManager.ensureOnDisk();
		cleanups.push(async () => {
			await child.abort();
			await child.dispose();
			await sessionManager.close();
		});
		return child;
	}
	return {
		mode,
		terminal,
		requests,
		requestStarted,
		nodes,
		flush,
		until,
		action,
		select,
		threadAction,
		pane,
		complete,
		records,
		journal,
		createChildSession,
		conversations,
	};
}

describe("durable BTW through the native terminal and production controller", () => {
	it("keeps native BTW message actions from falling back to Main controls", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		cfgRetryEnabled.set(h.mode.session.settings, false);
		await h.mode.handleBtwCommand("BTW action ownership");
		await h.requestStarted(0);
		await h.mode.handleBtwCommand("");
		await native.until(() => native.workspace.has("btw"));
		const block = native.focused;
		const terminal = native.terminals.get(block)!;
		const failure = createAssistantMessage("");
		failure.stopReason = "error";
		failure.errorMessage = "BTW action failure";
		h.requests[0]!.stream.push({ type: "error", reason: "error", error: failure });
		await native.until(() => JSON.stringify(native.nodes(block)).includes("BTW action failure"));

		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const copyMessage = native.nodes(block).find(node => node.p?.actions?.click === "copy-message");
		expect(copyMessage).toBeDefined();
		terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: copyMessage!.id, act: "copy-message" }));
		await native.until(() => copy.mock.calls.length === 1);
		expect(copy.mock.calls[0]![0]).toBe("BTW action ownership");
		const actions = native.nodes(block).flatMap(node => node.p?.actions?.click ?? []);
		expect(actions).not.toContain("rewind");
		expect(actions).not.toContain("switch-model");
		const retry = native.nodes(block).find(node => node.p?.actions?.click === "retry")!;
		const child = h.conversations[0]!.session;
		terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: retry.id, act: "retry" }));
		await h.requestStarted(1);
		expect(JSON.stringify(h.requests[1]!.context.messages)).toContain("BTW action ownership");
		await h.complete(1, "BTW action retried locally");
		expect(h.conversations[0]!.session).toBe(child);
		expect(h.mode.sessionManager.buildSessionContext().messages).toEqual([
			{ role: "user", content: "Main stays native", timestamp: 1 },
		]);
	});

	it.each([false, true])(
		"keeps summary argument updates stable with post-tool text=%s and approves in BTW",
		async postToolText => {
			const native = new NativePaneHarness();
			cleanups.push(() => native.dispose());
			const h = await harness(true, false, native);
			await h.mode.handleBtwCommand("share context");
			await h.requestStarted(0);
			await h.mode.handleBtwOpenThreadKey();
			const block = native.focused;
			await native.until(() => native.nodes(block).some(node => node.k === "editor"));
			const partial = createAssistantMessage("");
			partial.content = [
				{ type: "text", text: "I can share this context." },
				sendToMainSessionCall("share", "First"),
			];
			if (postToolText) partial.content.push({ type: "text", text: "Waiting for your approval." });
			partial.stopReason = "toolUse";
			h.requests[0]!.stream.push({ type: "start", partial: structuredClone(partial) });
			h.requests[0]!.stream.push({ type: "toolcall_start", contentIndex: 1, partial: structuredClone(partial) });
			await native.until(() => JSON.stringify(native.nodes(block)).includes("First"));
			const user = native.nodes(block).find(node => node.k === "card" && node.p?.role === "omp.user")!;
			const terminal = native.terminals.get(block)!;
			const before = terminal.frames.length;
			partial.content[1] = sendToMainSessionCall("share", "First and second");
			h.requests[0]!.stream.push({
				type: "toolcall_delta",
				contentIndex: 1,
				delta: " and second",
				partial: structuredClone(partial),
			});
			await native.until(() => JSON.stringify(native.nodes(block)).includes("First and second"));
			expect(native.nodes(block).find(node => node.id === user.id)?.p?.role).toBe("omp.user");
			expect(
				terminal.frames
					.slice(before)
					.flatMap(frame => frame.ops)
					.some(op => op[0] === "del" && (op[1] === user.id || user.id.startsWith(`${op[1]}.`))),
			).toBe(false);
			if (postToolText) {
				const nodes = native.nodes(block);
				const toolIndex = nodes.findIndex(node => node.k === "tool");
				const textIndex = nodes.findIndex(node => node.k === "md" && node.p?.text === "Waiting for your approval.");
				expect(toolIndex).toBeGreaterThanOrEqual(0);
				expect(textIndex).toBeGreaterThan(toolIndex);
				partial.content.push(sendToMainSessionCall("another-share", "Another note"));
				h.requests[0]!.stream.push({ type: "toolcall_start", contentIndex: 3, partial: structuredClone(partial) });
				await native.until(() => JSON.stringify(native.nodes(block)).includes("Another note"));
				const rebuiltNodes = native.nodes(block);
				const toolIndices = rebuiltNodes.flatMap((node, index) => (node.k === "tool" ? [index] : []));
				const betweenTools = rebuiltNodes.findIndex(
					node => node.k === "md" && node.p?.text === "Waiting for your approval.",
				);
				expect(toolIndices).toHaveLength(2);
				expect(betweenTools).toBeGreaterThan(toolIndices[0]!);
				expect(betweenTools).toBeLessThan(toolIndices[1]!);
			}
			h.requests[0]!.stream.push({ type: "done", reason: "toolUse", message: partial });
			await native.until(() => native.nodes(block).some(node => node.p?.role === "omp.btw.summary-approval"));
			const pendingCard = native.nodes(block).find(node => node.k === "tool")!;
			expect(pendingCard.c).toMatchObject([
				{ k: "col", p: { role: "omp.assistant" }, c: [{ k: "md", p: { text: "First and second" } }] },
			]);
			expect(
				native.nodes(block).filter(node => node.k === "md" && node.p?.text === "First and second"),
			).toHaveLength(1);
			expect(h.mode.ui.hasOverlay()).toBe(false);
			expect(
				h.mode.session.messages.some(message => message.role === "custom" && message.customType === "btw:summary"),
			).toBe(false);
			if (postToolText) native.action(block, "approve");
			else terminal.send("\r");
			if (postToolText) {
				await native.until(
					() =>
						native.nodes(block).some(node => node.p?.role === "omp.btw.summary-approval") &&
						native.nodes(block).some(node => node.k === "tool" && node.p?.status === "done"),
				);
				native.action(block, "approve");
			}
			await h.requestStarted(1);
			const sentCard = native.nodes(block).find(node => node.k === "tool")!;
			expect(sentCard.c).toMatchObject([
				{ k: "col", p: { role: "omp.assistant" }, c: [{ k: "md", p: { text: "First and second" } }] },
			]);
			expect(JSON.stringify(sentCard)).not.toContain("Summary sent to the main session.");
			expect(
				h.mode.session.messages.filter(
					message => message.role === "custom" && message.customType === "btw:summary",
				),
			).toMatchObject([
				{ details: { summaries: [{ threadTitle: "share context", summary: "First and second" }] } },
				...(postToolText
					? [{ details: { summaries: [{ threadTitle: "share context", summary: "Another note" }] } }]
					: []),
			]);
			await h.complete(
				1,
				"Shared.",
				`I can share this context.${postToolText ? "Waiting for your approval." : ""}Shared.`,
			);
			expect(terminal.errors).toEqual([]);
		},
	);

	it.each(["cancelled", "closed"])(
		"does not publish a summary when its side-pane confirmation is %s",
		async reason => {
			const native = new NativePaneHarness();
			cleanups.push(() => native.dispose());
			const h = await harness(true, false, native);
			await h.mode.handleBtwCommand("private context");
			await h.requestStarted(0);
			const message = createAssistantMessage("");
			message.content = [sendToMainSessionCall("private-share", "Do not send this")];
			message.stopReason = "toolUse";
			h.requests[0]!.stream.push({ type: "done", reason: "toolUse", message });
			await native.until(() => native.workspace.has("btw"));
			const block = native.focused;
			await native.until(() => native.nodes(block).some(node => node.p?.role === "omp.btw.summary-approval"));
			expect(h.mode.ui.hasOverlay()).toBe(false);
			if (reason === "cancelled") native.terminals.get(block)!.send("\x1b");
			else native.terminals.get(block)!.closeInput();
			await h.requestStarted(1);
			const result = h.requests[1]!.context.messages.find(
				message => message.role === "toolResult" && message.toolCallId === "private-share",
			);
			expect(result).toMatchObject({ role: "toolResult", isError: true });
			expect(
				h.mode.session.messages.some(message => message.role === "custom" && message.customType === "btw:summary"),
			).toBe(false);
			await h.complete(1, "Not shared.");
		},
	);

	it("keeps running threads and separate drafts across sheet close/reopen, and follows up in the same lineage", async () => {
		const h = await harness();
		void h.mode.getUserInput();
		await h.mode.handleBtwCommand("first question");
		await h.requestStarted(0);
		expect(h.mode.hasActiveBtw()).toBe(true);
		expect(h.mode.ui.hasOverlay()).toBe(false);
		expect(h.mode.ui.getFocused()).toBe(h.mode.editor);
		h.action("open");
		await h.until(() => h.mode.ui.hasOverlay());
		expect(h.mode.workspaceEnabled).toBe(false);
		expect(h.nodes().some(node => node.k === "rows")).toBe(false);
		const btwComposer = h
			.nodes()
			.filter(node => node.p?.role === "omp.editor")
			.at(-1)!;
		expect(JSON.stringify(btwComposer)).toContain("Read-only");
		expect(JSON.stringify(btwComposer)).not.toContain("status.model");
		expect(JSON.stringify(h.nodes())).toContain("Main stays native");
		const firstKey = (await h.records())[0]!.key;
		h.pane().getPasteTarget()!.pasteText("first draft");
		h.pane().handleInput("\x1b");
		h.flush();
		expect(h.mode.ui.getFocused()).toBe(h.mode.editor);
		expect(h.requests[0]!.options.signal?.aborted).toBe(false);
		await h.mode.handleBtwCommand("");
		h.flush();
		expect(h.pane().getPasteTarget()!.getText()).toBe("first draft");
		h.action("threads");
		h.terminal.send("\x1b");
		h.flush();
		expect(h.mode.ui.getFocused()).toBe(h.pane());
		expect(h.pane().getPasteTarget()!.getText()).toBe("first draft");
		h.action("new");
		const secondKey = (await h.records()).find(record => record.key !== firstKey)!.key;
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
		expect(stored.find(record => record.key === firstKey)!.turns.map(turn => turn.input)).toEqual([
			"first question",
			"follow up",
		]);
		expect(stored.find(record => record.key === secondKey)!.draft).toBe("second draft");
		h.terminal.send("\x1b[5~");
		h.flush();
		expect(h.terminal.frames.flatMap(frame => frame.ops).some(op => op[0] === "scroll" && op[2] === "page-up")).toBe(
			true,
		);
		await h.mode.handleBtwCommand("background at stop");
		await h.requestStarted(2);
		await h.mode.handleBtwOpenThreadKey();
		const stoppedKey = (await h.records()).find(record => record.title === "background at stop")!.key;
		h.pane().getPasteTarget()!.pasteText("stopped draft");
		h.mode.stop();
		expect(h.mode.ui.hasOverlay()).toBe(false);
		expect(h.requests[2]!.options.signal?.aborted).toBe(false);
		expect((await h.records()).find(record => record.key === stoppedKey)!.draft).toBe("stopped draft");
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
		const key = (await h.records())[0]!.key;
		h.pane().getPasteTarget()!.pasteText("late native draft");
		h.terminal.answerProbe();
		h.flush();
		expect(h.mode.workspaceEnabled).toBe(false);
		expect(h.mode.ui.getFocused()).toBe(h.mode.editor);
		expect(h.requests[0]!.options.signal?.aborted).toBe(false);
		await h.mode.handleBtwCommand("");
		await h.until(() => h.nodes().some(node => node.k === "overlay"));
		expect(h.pane().getPasteTarget()!.getText()).toBe("late native draft");
		expect(h.nodes().filter(node => node.k === "overlay")).toHaveLength(1);
		expect(h.nodes().some(node => node.k === "rows")).toBe(false);
		expect((await h.records())[0]!.key).toBe(key);
		h.pane().handleInput("\x1b");
		h.flush();
		expect(h.mode.ui.getFocused()).toBe(h.mode.editor);
		expect(h.terminal.errors).toEqual([]);
	});

	it("reports absent native scroll support instead of silently scrolling an invisible VT viewport", async () => {
		const h = await harness(false);
		void h.mode.getUserInput();
		await h.mode.handleBtwCommand("scroll question");
		await h.requestStarted(0);
		await h.complete(0, "scroll answer");
		await h.mode.handleBtwOpenThreadKey();
		h.terminal.send("\x1b[5~");
		h.flush();
		expect(JSON.stringify(h.nodes())).toContain("does not support keyboard transcript scrolling");
		expect(h.terminal.frames.flatMap(frame => frame.ops).some(op => op[0] === "scroll")).toBe(false);
	});

	it.each([true, false])("routes thread actions with native menu support %s to durable threads", async nativeMenu => {
		const h = await harness(true, false, undefined, nativeMenu);
		void h.mode.getUserInput();
		await h.mode.handleBtwCommand("");
		h.flush();
		expect(h.nodes().some(node => node.k === "list" || node.k === "picker")).toBe(false);
		await h.mode.handleBtwCommand("promote question");
		await h.requestStarted(0);
		await h.complete(0, "promote answer");
		await h.mode.handleBtwCommand("");
		h.flush();
		expect(h.nodes().filter(node => node.k === "overlay")).toHaveLength(1);
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		if (nativeMenu) {
			const menu = h.nodes().find(node => node.k === "menu")!;
			h.pane().getPasteTarget()!.setText("Keep this draft");
			h.terminal.send(tspEvent({ ev: "toggle", sf: h.terminal.surface!, id: menu.id, open: true }));
			h.flush();
			expect(h.nodes().find(node => node.k === "menu")?.p?.open).toBe(true);
			h.terminal.send("\x1b[B");
			h.flush();
			expect(h.nodes().find(node => node.k === "menu")?.p?.active).toBe("promote");
			h.terminal.send("x");
			h.terminal.send("\x1b");
			h.flush();
			expect(h.nodes().find(node => node.k === "menu")?.p?.open).toBe(false);
			expect(h.mode.ui.hasOverlay()).toBe(true);
			expect(h.pane().getPasteTarget()!.getText()).toBe("Keep this draft");
			h.terminal.send(tspEvent({ ev: "toggle", sf: h.terminal.surface!, id: menu.id, open: true }));
			h.flush();
			h.terminal.send("\r");
			h.flush();
			await h.until(() => copy.mock.calls.length === 1);
			expect(copy.mock.calls[0]![0]).toContain("promote answer");
			copy.mockClear();
		}
		h.threadAction("copy-thread");
		await h.until(() => copy.mock.calls.length === 1);
		expect(copy.mock.calls[0]![0]).toContain("promote answer");
		const firstKey = (await h.records())[0]!.key;
		h.action("new");
		h.threadAction("delete");
		await h.until(() => JSON.stringify(h.nodes()).includes("promote answer"));
		expect((await h.records()).map(record => record.key)).toEqual([firstKey]);
		const previousSessionId = h.mode.sessionManager.getSessionId();
		h.threadAction("promote");
		await h.until(() => h.mode.sessionManager.getSessionId() !== previousSessionId);
		await h.until(() => !h.mode.ui.hasOverlay());
		expect(JSON.stringify(h.mode.sessionManager.getBranch())).toContain("promote answer");
		expect(h.nodes().some(node => node.k === "rows")).toBe(false);
		await h.mode.handleBtwCommand("--history");
		h.flush();
		expect(h.nodes().find(node => node.k === "overlay")?.p?.role).toBe("omp.overlay.btwHistory");
		expect(h.terminal.errors).toEqual([]);
	});

	it("steers a running native side session and queues follow-up without changing Main or losing the newer draft", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		const errors = vi.spyOn(h.mode, "showError");
		void h.mode.getUserInput();
		h.mode.editor.setText("Main draft");
		await h.mode.handleBtwCommand("");
		const block = native.focused;
		await native.until(() => native.nodes(block).some(node => node.k === "editor"));
		const terminal = native.terminals.get(block)!;
		const editor = native.nodes(block).find(node => node.k === "editor")!;
		expect(native.nodes(block).some(node => node.k === "list" || node.k === "picker")).toBe(false);
		terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text: "first side question" }));
		await h.requestStarted(0);
		const runningEditor = h.pane().getPasteTarget()!;
		const image: ImageContent = {
			type: "image",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDP8AAAAASUVORK5CYII=",
			mimeType: "image/png",
		};
		runningEditor.setDraft("steered input [Image #1]", [image]);
		terminal.send("\r");
		await native
			.until(() => native.nodes(block).some(node => node.p?.role === "omp.queue.item"))
			.catch(error => {
				throw new Error(
					JSON.stringify({
						errors: errors.mock.calls,
						editors: native
							.nodes(block)
							.filter(node => node.k === "editor")
							.map(node => ({ id: node.id, props: node.p })),
						queues: h.conversations.map(conversation => conversation.session?.getQueuedMessages()),
					}),
					{ cause: error },
				);
			});
		terminal.send("new draft");
		await native.until(() => runningEditor.getText() === "new draft");
		expect(h.requests).toHaveLength(1);
		expect(h.mode.editor.getText()).toBe("Main draft");
		await h.complete(0, "first side answer");
		await h.requestStarted(1);
		expect(h.requests[1]!.context.messages).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: expect.arrayContaining([expect.objectContaining({ type: "image" })]),
			}),
		);
		runningEditor.clearDraft();
		terminal.send("queued follow-up");
		await native.until(() => runningEditor.getText() === "queued follow-up");
		terminal.send("\x11");
		await native.until(() => JSON.stringify(native.nodes(block)).includes("After yield"));
		expect(h.requests).toHaveLength(2);
		terminal.send("newer side draft");
		await h.complete(1, "steered answer");
		await h.requestStarted(2);
		expect(JSON.stringify(h.requests[2]!.context.messages)).toContain("queued follow-up");
		await h.complete(2, "follow-up answer");
		expect((await h.records())[0]!.turns.map(turn => turn.input)).toEqual([
			"first side question",
			"steered input [Image #1]",
			"queued follow-up",
		]);
		expect(runningEditor.getText()).toBe("newer side draft");
		expect(h.mode.editor.getText()).toBe("Main draft");
		expect(terminal.errors).toEqual([]);
	});

	it("executes queued compact on the BTW journal instead of sending the slash command to the model", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		const summarize = vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
			summary: "BTW compacted context",
			shortSummary: "BTW summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
		}));
		await h.mode.handleBtwCommand("first question to compact");
		await h.requestStarted(0);
		await h.mode.handleBtwOpenThreadKey();
		const block = native.focused;
		await native.until(() => native.nodes(block).some(node => node.k === "editor"));
		const terminal = native.terminals.get(block)!;
		const editor = native.nodes(block).find(node => node.k === "editor")!;
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text: "/queue /compact soft" }));
		await native.until(() => JSON.stringify(native.nodes(block)).includes("/compact soft"));
		expect(summarize).not.toHaveBeenCalled();
		await h.complete(0, "answer before compaction");
		const key = (await h.records())[0]!.key;
		await native.until(async () => (await h.journal(key)).entries.some(entry => entry.type === "compaction"));
		expect((await h.journal(key)).entries).toContainEqual(
			expect.objectContaining({
				type: "compaction",
				summary: "BTW compacted context",
			}),
		);
		expect(summarize).toHaveBeenCalled();
		expect(h.requests).toHaveLength(1);
		expect(JSON.stringify(h.requests[0]!.context.messages)).not.toContain("/compact");
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
		expect(JSON.stringify(native.nodes(block))).toContain("BTW compacted context");
		expect(terminal.errors).toEqual([]);
	});

	it("stops only the selected BTW run, keeps its draft, and retries in the same thread", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		await h.mode.handleBtwCommand("A question to stop");
		await h.requestStarted(0);
		await h.mode.handleBtwOpenThreadKey();
		const block = native.focused;
		const terminal = native.terminals.get(block)!;
		await native.until(() => native.nodes(block).some(node => node.p?.actions?.click === "interrupt"));
		const child = h.conversations[0]!.session!;
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		terminal.send("Keep this draft");
		await native.until(() => h.pane().getPasteTarget()!.getText() === "Keep this draft");
		const stop = native.nodes(block).find(node => node.p?.actions?.click === "interrupt")!;
		terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: stop.id, act: "interrupt" }));
		await native.until(() => !child.isStreaming && !h.conversations[0]!.isRunning);
		expect(h.requests[0]!.options.signal?.aborted).toBe(true);
		expect(h.pane().getPasteTarget()!.getText()).toBe("Keep this draft");
		expect(h.conversations[0]!.session).toBe(child);
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
		const editor = native.nodes(block).find(node => node.k === "editor")!;
		terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text: "/retry" }));
		await h.requestStarted(1);
		expect(JSON.stringify(h.requests[1]!.context.messages)).toContain("A question to stop");
		await h.complete(1, "Retried BTW answer");
		expect(h.conversations).toHaveLength(1);
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
	});

	it("rejects clear in BTW without erasing its context or sending the command to the model", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		await h.mode.handleBtwCommand("Keep this BTW question");
		await h.requestStarted(0);
		await h.complete(0, "Keep this BTW answer");
		await h.mode.handleBtwOpenThreadKey();
		const block = native.focused;
		await native.until(() => native.nodes(block).some(node => node.k === "editor"));
		const terminal = native.terminals.get(block)!;
		const child = h.conversations[0]!.session!;
		const messagesBefore = structuredClone(child.messages);
		const contextBefore = structuredClone(child.sessionManager.buildSessionContext().messages);
		const boundariesBefore = child.sessionManager.getEntries().filter(entry => entry.type === "reset_boundary");
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		const errors = vi.spyOn(h.mode, "showError");
		for (const input of ["/clear", "/clear extra", "/queue /clear"]) {
			const errorCount = errors.mock.calls.length;
			const editor = native.nodes(block).find(node => node.k === "editor")!;
			terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text: input }));
			await native.until(
				() =>
					errors.mock.calls.length > errorCount ||
					h.requests.length > 1 ||
					child.messages.length !== messagesBefore.length,
			);
			expect(errors.mock.calls[errorCount]?.[0]).toMatch(/not available.*clear/);
			expect(structuredClone(child.messages)).toEqual(messagesBefore);
			expect(structuredClone(child.sessionManager.buildSessionContext().messages)).toEqual(contextBefore);
			expect(child.sessionManager.getEntries().filter(entry => entry.type === "reset_boundary")).toEqual(
				boundariesBefore,
			);
			expect(h.requests).toHaveLength(1);
		}
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
		expect(terminal.errors).toEqual([]);
	});

	it("navigates the standard BTW tree without moving Main or replacing a newer side draft", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		await h.mode.handleBtwCommand("first branch question");
		await h.requestStarted(0);
		await h.complete(0, "first branch answer");
		await h.mode.handleBtwOpenThreadKey();
		const block = native.focused;
		await native.until(() => native.nodes(block).some(node => node.k === "editor"));
		const terminal = native.terminals.get(block)!;
		const send = (text: string) => {
			const editor = native.nodes(block).find(node => node.k === "editor")!;
			terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text }));
		};
		send("second branch question");
		await h.requestStarted(1);
		await h.complete(1, "second branch answer");
		const key = (await h.records())[0]!.key;
		const before = await h.journal(key);
		const firstReply = before.entries.find(entry => entry.type === "message" && entry.message.role === "assistant")!;
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		const mainLeaf = h.mode.sessionManager.getLeafId();
		const pane = h.pane();
		send("/tree");
		await native.until(() => native.nodes(block).some(node => node.k === "picker"));
		pane.getPasteTarget()!.setDraft("newer side draft");
		const picker = native.nodes(block).find(node => node.k === "picker")!;
		terminal.send(tspEvent({ ev: "activate", sf: terminal.surface!, id: picker.id, item: firstReply.id }));
		await native.until(
			async () =>
				!(await h.journal(key)).branch.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes("second branch question"),
				),
		);
		expect((await h.journal(key)).branch.some(entry => entry.id === firstReply.id)).toBe(true);
		expect(h.mode.sessionManager.getLeafId()).toBe(mainLeaf);
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
		expect(pane.getPasteTarget()!.getText()).toBe("newer side draft");
		expect(JSON.stringify(native.nodes(block))).toContain("first branch answer");
		expect(JSON.stringify(native.nodes(block))).not.toContain("second branch answer");
		expect(terminal.errors).toEqual([]);
	});

	it("opens the same inline thread on Enter through a side transport without resending, then preserves drafts and promotes it", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		void h.mode.getUserInput();
		const sessionId = h.mode.sessionManager.getSessionId();
		h.mode.editor.setText("Main draft");
		h.flush();
		const image: ImageContent = {
			type: "image",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDP8AAAAASUVORK5CYII=",
			mimeType: "image/png",
		};
		expect(await h.mode.handleBtwCommand("native split question", [image], "/sitrep")).toBe(true);
		await h.requestStarted(0);
		const sentContent = h.requests[0]!.context.messages.at(-1)?.content;
		const sentImage = Array.isArray(sentContent) ? sentContent.find(block => block.type === "image") : undefined;
		if (!sentImage) throw new Error("Expected the submitted BTW image");
		expect(sentImage).toMatchObject({ type: "image", mimeType: "image/webp" });
		expect(native.workspace.has("btw")).toBe(false);
		expect(h.mode.hasActiveBtw()).toBe(true);
		expect(h.mode.ui.getFocused()).toBe(h.mode.editor);
		h.mode.editor.clearDraft();
		h.terminal.send("\r");
		h.flush();
		await native.until(() => native.workspace.has("btw"));
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]!.options.signal?.aborted).toBe(false);
		h.mode.editor.setText("Main draft");
		const firstBlock = native.focused;
		await native.until(() => native.nodes(firstBlock).some(node => node.k === "editor"));
		const regions = native.terminals
			.get(firstBlock)!
			.docs.get(native.terminals.get(firstBlock)!.surface!)!
			.snapshot();
		const dock = regions.c!.find(node => node.id === "dock")!;
		const main = regions.c!.find(node => node.id === "main")!;
		expect(JSON.stringify(dock)).toContain('"k":"editor"');
		expect(JSON.stringify(main)).not.toContain('"k":"editor"');
		expect(h.mode.ui.hasOverlay()).toBe(false);
		expect(JSON.stringify(h.nodes())).toContain("Main stays native");
		expect(JSON.stringify(native.nodes(firstBlock))).toContain("native split question");
		native.terminals.get(firstBlock)!.send("Side draft");
		await native.until(() => h.pane().getPasteTarget()?.getText() === "Side draft");
		native.terminals.get(firstBlock)!.send("\x1b");
		await native.until(() => !native.workspace.has("btw"));
		expect(h.mode.editor.getText()).toBe("Main draft");
		expect(h.requests[0]!.options.signal?.aborted).toBe(false);
		await h.complete(0, "native split answer");
		const saved = (await h.records())[0]!;
		expect(saved.title).toBe("/sitrep");
		expect(saved.turns[0]?.images).toEqual([sentImage]);
		await h.mode.handleBtwCommand("");
		const secondBlock = native.focused;
		await native.until(() =>
			native.nodes(secondBlock).some(node => node.k === "editor" && node.p?.text === "Side draft"),
		);
		h.pane().getPasteTarget()!.clearDraft();
		native.workspace.get("btw")!.ui.requestRender();
		await native.until(() => native.nodes(secondBlock).some(node => node.k === "editor" && node.p?.text === ""));
		const editor = native.nodes(secondBlock).find(node => node.k === "editor")!;
		const terminal = native.terminals.get(secondBlock)!;
		terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text: "native follow up" }));
		await h.requestStarted(1);
		expect(h.requests[1]!.options.sessionId).toBe(h.requests[0]!.options.sessionId);
		expect(JSON.stringify(h.requests[1]!.context.messages)).toContain("native split answer");
		expect(
			h.requests[1]!.context.messages.flatMap(message =>
				message.role === "user" && Array.isArray(message.content) ? message.content : [],
			),
		).toContainEqual(sentImage);
		await h.complete(1, "native follow-up answer");
		const menu = native.nodes(secondBlock).find(node => node.k === "menu")!;
		expect(menu.p?.items?.some(item => typeof item === "object" && "id" in item && item.id === "promote")).toBe(true);
		terminal.send(tspEvent({ ev: "toggle", sf: terminal.surface!, id: menu.id, open: true }));
		terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: menu.id, act: "promote" }));
		await h.until(() => h.mode.sessionManager.getSessionId() !== sessionId);
		await native.until(() => !native.workspace.has("btw"));
		expect(JSON.stringify(h.mode.sessionManager.getBranch())).toContain("native follow-up answer");
		expect(h.mode.ui.nativeRendering).toBe(true);
		expect(h.mode.ui.hasOverlay()).toBe(false);
	});

	it("pastes into an automatic native child pane without redirecting to Main", async () => {
		vi.spyOn(clipboard, "readImageFromClipboard").mockResolvedValue(null);
		vi.spyOn(clipboard, "readTextFromClipboard").mockResolvedValue("Paste into the child");
		vi.spyOn(clipboard, "readClipboardContent").mockResolvedValue({
			image: null,
			text: "Paste into the child",
			fileUrls: [],
		});
		vi.spyOn(clipboard, "readMacFileUrlsFromClipboard").mockResolvedValue([]);
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		const child = await h.createChildSession();
		void child.prompt("Keep the automatic pane running").catch(() => {});
		await h.requestStarted(0);
		const registry = AgentRegistry.global();
		const id = `Native-paste-${crypto.randomUUID()}`;
		registry.register({ id, displayName: id, kind: "sub", parentId: "Main", status: "running", session: child });
		cleanups.push(async () => {
			registry.unregister(id);
		});
		await native.until(() => native.workspace.get(`agent:${id}`)?.ui.nativeRendering === true);
		const view = native.workspace.get(`agent:${id}`)!;
		expect(view.component).toBeInstanceOf(AgentTranscriptViewer);
		const editor = (view.component as AgentTranscriptViewer).getPasteTarget()!;
		await view.ui.onAppViewportPasteRequest!();
		expect(editor.getText()).toBe("Paste into the child");
		expect(h.mode.editor.getText()).toBe("");
		expect(native.focused).toBe(1);
	});

	it("opens automatic native agent panes without stealing focus and keeps a manually pinned pane after completion", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		const registry = AgentRegistry.global();
		const id = `Native-${crypto.randomUUID()}`;
		cleanups.push(async () => {
			registry.unregister(id);
		});
		registry.register({ id, displayName: id, kind: "sub", parentId: "Main", status: "running", session: null });
		await native.until(() => native.workspace.get(`agent:${id}`)?.ui.nativeRendering === true);
		expect(native.focused).toBe(1);
		const block = [...native.terminals.keys()][0]!;
		await native.until(() => JSON.stringify(native.nodes(block)).includes(id));
		await h.mode.openAgentWorkspacePane(id);
		expect(native.focused).toBe(block);
		registry.setStatus(id, "parked");
		native.terminals.get(block)!.send("pinned after completion");
		await native.until(() =>
			native.nodes(block).some(node => node.k === "editor" && node.p?.text === "pinned after completion"),
		);
		expect(native.workspace.has(`agent:${id}`)).toBe(true);
		native.terminals.get(block)!.send("\x1b");
		await native.until(() => native.nodes(block).some(node => node.k === "editor" && node.p?.text === ""));
		native.terminals.get(block)!.send("\x1b");
		await native.until(() => !native.workspace.has(`agent:${id}`));
		expect(h.mode.ui.nativeRendering).toBe(true);
	});

	it("retires an unvisited completed native agent pane without stopping Main", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		const registry = AgentRegistry.global();
		const id = `Native-auto-${crypto.randomUUID()}`;
		cleanups.push(async () => {
			registry.unregister(id);
		});
		registry.register({ id, displayName: id, kind: "sub", parentId: "Main", status: "running", session: null });
		await native.until(() => native.workspace.get(`agent:${id}`)?.ui.nativeRendering === true);
		registry.setStatus(id, "parked");
		await native.until(() => !native.workspace.has(`agent:${id}`));
		expect(h.mode.ui.nativeRendering).toBe(true);
		expect(native.focused).toBe(1);
	});
});

describe("standard session controls in a native subagent pane", () => {
	async function childHarness(tools: AgentTool[] = [], factory?: ExtensionFactory) {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		const child = await h.createChildSession(tools, factory);
		const registry = AgentRegistry.global();
		const id = `Pane-controls-${crypto.randomUUID()}`;
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: child,
			sessionFile: child.sessionManager.getSessionFile() ?? undefined,
		});
		cleanups.push(async () => {
			registry.unregister(id);
		});
		await h.mode.openAgentWorkspacePane(id);
		const block = native.focused;
		await native.until(() => native.nodes(block).some(node => node.k === "editor"));
		const terminal = native.terminals.get(block)!;
		const send = (text: string) => {
			const editor = native.nodes(block).find(node => node.k === "editor")!;
			terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text }));
		};
		const respond = (index: number, text: string) => {
			h.requests[index]!.stream.push({ type: "done", reason: "stop", message: createAssistantMessage(text) });
		};
		return { h, native, child, registry, id, block, terminal, send, respond };
	}

	it("stops and retries the child run without closing the pane or changing Main", async () => {
		const { h, native, child, block, terminal, send, respond } = await childHarness();
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		send("A child task to stop");
		await h.requestStarted(0);
		await native.until(() => native.nodes(block).some(node => node.p?.actions?.click === "interrupt"));
		terminal.send("Keep the child draft");
		await native.until(() =>
			native.nodes(block).some(node => node.k === "editor" && node.p?.text === "Keep the child draft"),
		);
		const stop = native.nodes(block).find(node => node.p?.actions?.click === "interrupt")!;
		terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: stop.id, act: "interrupt" }));
		await child.waitForIdle();
		expect(h.requests[0]!.options.signal?.aborted).toBe(true);
		expect(native.nodes(block).some(node => node.k === "editor" && node.p?.text === "Keep the child draft")).toBe(
			true,
		);
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
		send("/retry");
		await h.requestStarted(1);
		expect(JSON.stringify(h.requests[1]!.context.messages)).toContain("A child task to stop");
		respond(1, "Retried child answer");
		await child.waitForIdle();
		await native.until(() => JSON.stringify(native.nodes(block)).includes("Retried child answer"));
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
	});

	it("shows a running tool's partial output across pane reopen and lets the final result replace it", async () => {
		const release = Promise.withResolvers<void>();
		cleanups.push(async () => release.resolve());
		const tool: AgentTool = {
			...createMainWriteTool(),
			name: "pane_progress",
			execute: async (_id, _args, signal, update) => {
				signal?.addEventListener("abort", () => release.resolve(), { once: true });
				update?.({ content: [{ type: "text", text: "Partial child tool output" }] });
				await release.promise;
				signal?.throwIfAborted();
				return { content: [{ type: "text", text: "Final child tool output" }] };
			},
			renderResult: result =>
				new Text(result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n")),
		};
		const { h, native, child, id, block, terminal, send, respond } = await childHarness([tool]);
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		send("Run the child tool");
		await h.requestStarted(0);
		const call = createAssistantMessage("");
		call.content = [
			{ type: "toolCall", id: "progress-call", name: tool.name, arguments: { path: "probe", content: "" } },
		];
		call.stopReason = "toolUse";
		h.requests[0]!.stream.push({ type: "done", reason: "toolUse", message: call });
		await native.until(() => JSON.stringify(native.nodes(block)).includes("Partial child tool output"));
		terminal.send("\x1b");
		await native.until(() => !native.workspace.has(`agent:${id}`));
		expect(h.requests[0]!.options.signal?.aborted).toBe(false);
		await h.mode.openAgentWorkspacePane(id);
		const reopenedBlock = native.focused;
		await native.until(() => JSON.stringify(native.nodes(reopenedBlock)).includes("Partial child tool output"));
		release.resolve();
		await h.requestStarted(1);
		respond(1, "Tool completed");
		await child.waitForIdle();
		await native.until(() => JSON.stringify(native.nodes(reopenedBlock)).includes("Final child tool output"));
		expect(JSON.stringify(native.nodes(reopenedBlock))).not.toContain("Partial child tool output");
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
	});

	it("renders a subagent's tools, custom messages and thinking with its own registrations", async () => {
		const childTool = {
			...createMainWriteTool(),
			name: "pane_probe",
			describeCall: () => ({ body: [text("Child tool renderer")] }),
		};
		const { h, native, child, block } = await childHarness([childTool], api => {
			api.registerMessageRenderer("pane:note", () => new Text("Child message renderer"));
			api.registerAssistantThinkingRenderer(() => ({
				type: "replace",
				component: new Text("Child thinking renderer"),
			}));
			api.registerAssistantTextRenderer(({ text }) => text.replace("Child answer", "Child displayed answer"));
		});
		const mainTool = {
			...childTool,
			describeCall: () => ({ body: [text("Main tool renderer")] }),
		};
		vi.spyOn(h.mode.session, "getToolByName").mockImplementation(name =>
			name === childTool.name ? mainTool : undefined,
		);
		const call = createAssistantMessage("");
		call.content = [{ type: "toolCall", id: "pane-call", name: childTool.name, arguments: {} }];
		call.stopReason = "toolUse";
		child.sessionManager.appendMessage({ role: "user", content: "Render child facts", timestamp: 1 });
		child.sessionManager.appendMessage(call);
		child.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "pane-call",
			toolName: childTool.name,
			content: [{ type: "text", text: "Tool result" }],
			isError: false,
			timestamp: 2,
		});
		child.sessionManager.appendCustomMessageEntry("pane:note", "Raw child note", true);
		const answer = createAssistantMessage("Child answer");
		answer.content.unshift({ type: "thinking", thinking: "Raw child thinking" });
		child.sessionManager.appendMessage(answer);
		await child.sessionManager.flush();
		await native.until(() => JSON.stringify(native.nodes(block)).includes("Child displayed answer"));
		const rendered = JSON.stringify(native.nodes(block));
		expect(rendered).toContain("Child tool renderer");
		expect(rendered).toContain("Child message renderer");
		expect(rendered).toContain("Child thinking renderer");
		expect(rendered).not.toContain("Main tool renderer");
		expect(JSON.stringify(child.sessionManager.buildSessionContext().messages)).toContain("Child answer");
		expect(JSON.stringify(child.sessionManager.buildSessionContext().messages)).not.toContain(
			"Child displayed answer",
		);
	});

	it("uses one child runtime for follow-up, compact and tree without moving Main, and rejects clear", async () => {
		const { h, native, child, registry, id, block, terminal, send, respond } = await childHarness();
		vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
			summary: "Child compacted context",
			shortSummary: "Child summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
		}));
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		send("first child question");
		await h.requestStarted(0);
		terminal.send("child follow-up");
		await native.until(() =>
			native.nodes(block).some(node => node.k === "editor" && node.p?.text === "child follow-up"),
		);
		terminal.send("\x11");
		await native.until(() => JSON.stringify(native.nodes(block)).includes("After yield"));
		terminal.send("\x1b[1;3A");
		await native.until(() =>
			native.nodes(block).some(node => node.k === "editor" && node.p?.text === "child follow-up"),
		);
		terminal.send("\x11");
		await native.until(() => JSON.stringify(native.nodes(block)).includes("After yield"));
		send("/queue /compact soft");
		await native.until(() => JSON.stringify(native.nodes(block)).includes("/compact soft"));
		expect(h.requests).toHaveLength(1);
		respond(0, "first child answer");
		await h.requestStarted(1);
		expect(JSON.stringify(h.requests[1]!.context.messages)).toContain("child follow-up");
		respond(1, "child follow-up answer");
		await native.until(() => child.sessionManager.getEntries().some(entry => entry.type === "compaction"));
		await native.until(() => JSON.stringify(native.nodes(block)).includes("Child compacted context"));
		send("after child compact");
		await h.requestStarted(2);
		respond(2, "after child compact answer");
		await child.waitForIdle();
		await native.until(() => JSON.stringify(native.nodes(block)).includes("after child compact answer"));
		const firstReply = child.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "assistant")!;
		send("/tree");
		await native.until(() => native.nodes(block).some(node => node.k === "picker"));
		const picker = native.nodes(block).find(node => node.k === "picker")!;
		terminal.send(tspEvent({ ev: "activate", sf: terminal.surface!, id: picker.id, item: firstReply.id }));
		await native.until(() => !JSON.stringify(native.nodes(block)).includes("after child compact answer"));
		send("on child rewound branch");
		await h.requestStarted(3);
		expect(JSON.stringify(h.requests[3]!.context.messages)).toContain("first child answer");
		expect(JSON.stringify(h.requests[3]!.context.messages)).not.toContain("after child compact answer");
		respond(3, "rewound child answer");
		await child.waitForIdle();
		await native.until(() => JSON.stringify(native.nodes(block)).includes("rewound child answer"));
		const childMessages = structuredClone(child.messages);
		const childEntries = structuredClone(child.sessionManager.getEntries());
		send("/clear");
		await native.until(
			() => JSON.stringify(native.nodes(block)).includes("not available") || child.messages.length === 0,
		);
		expect(JSON.stringify(native.nodes(block))).toMatch(/not available[^"]*clear/);
		expect(structuredClone(child.messages)).toEqual(childMessages);
		expect(structuredClone(child.sessionManager.getEntries())).toEqual(childEntries);
		expect(JSON.stringify(native.nodes(block))).toContain("rewound child answer");
		expect(registry.get(id)?.session).toBe(child);
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
		expect(h.requests).toHaveLength(4);
		expect(terminal.errors).toEqual([]);
	});

	it("edits the selected follow-up rather than the compact barrier when both are pending", async () => {
		const { h, native, child, block, terminal, send, respond } = await childHarness();
		vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
			summary: "Child compacted context",
			shortSummary: "Child summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
		}));
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		send("first child question");
		await h.requestStarted(0);
		terminal.send("queued child follow-up");
		await native.until(() =>
			native.nodes(block).some(node => node.k === "editor" && node.p?.text === "queued child follow-up"),
		);
		terminal.send("\x11");
		await native.until(() => child.getQueuedMessages().followUp.length === 1);
		send("/queue /compact soft");
		await native.until(() => JSON.stringify(native.nodes(block)).includes("/compact soft"));
		const followUp = native
			.nodes(block)
			.find(
				node =>
					node.p?.role === "omp.queue.item" &&
					node.c?.some(part => part.k === "text" && part.p?.text === "queued child follow-up"),
			)!;
		const edit = followUp.c!.find(node => node.p?.role === "omp.queue.edit")!;
		terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: edit.id, act: "queue.edit" }));
		await native.until(() => native.nodes(block).some(node => node.k === "editor" && Boolean(node.p?.text)));
		expect(native.nodes(block).find(node => node.k === "editor")?.p?.text).toBe("queued child follow-up");
		expect(child.getQueuedMessages().followUp).toEqual([]);
		expect(sessionCommandQueue(child).request?.text).toBe("/compact soft");
		respond(0, "first child answer");
		await native.until(() => child.sessionManager.getEntries().some(entry => entry.type === "compaction"));
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
	});

	it("runs direct compact through the standard abort-and-compact path while a child turn streams", async () => {
		const { h, native, child, block, terminal, send, respond } = await childHarness();
		vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
			summary: "Direct child compact",
			shortSummary: "Direct summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
		}));
		const mainBefore = structuredClone(h.mode.sessionManager.getEntries());
		send("completed child context");
		await h.requestStarted(0);
		respond(0, "completed child answer");
		await child.waitForIdle();
		send("streaming child context");
		await h.requestStarted(1);
		send("/compact soft");
		await native.until(() => h.requests[1]!.options.signal?.aborted === true);
		await native.until(() =>
			child.sessionManager
				.getEntries()
				.some(entry => entry.type === "compaction" && entry.summary === "Direct child compact"),
		);
		expect(h.mode.sessionManager.getEntries()).toEqual(mainBefore);
		expect(JSON.stringify(native.nodes(block))).not.toContain("already in progress");
		expect(terminal.errors).toEqual([]);
	});
});

describe("standard BTW context consumers", () => {
	it("hands off consecutive users in order and promotes the complete user/tool message history", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		await h.mode.handleBtwCommand("baseline question");
		await h.requestStarted(0);
		await h.complete(0, "baseline answer");
		await h.mode.handleBtwOpenThreadKey();
		const side = h.conversations.at(-1)?.session;
		if (!side) throw new Error("Expected the standard BTW session");
		const timestamp = Date.now();
		side.sessionManager.appendMessage({ role: "user", content: "Earlier unmatched request", timestamp });
		side.sessionManager.appendMessage({
			role: "user",
			content: "Correction to that request",
			timestamp: timestamp + 1,
		});
		const call = createAssistantMessage("");
		call.content = [{ type: "toolCall", id: "context-read", name: "read", arguments: { path: "source.txt" } }];
		call.stopReason = "toolUse";
		call.timestamp = timestamp + 2;
		side.sessionManager.appendMessage(call);
		side.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "context-read",
			toolName: "read",
			content: [{ type: "text", text: "Canonical tool source" }],
			isError: false,
			timestamp: timestamp + 3,
		});
		const answer = createAssistantMessage("Canonical follow-up answer");
		answer.timestamp = timestamp + 4;
		side.sessionManager.appendMessage(answer);
		side.agent.replaceMessages(side.sessionManager.buildSessionContext().messages);
		const block = native.focused;
		await native.until(() => native.nodes(block).some(node => node.k === "editor"));
		const terminal = native.terminals.get(block)!;
		const send = (text: string) => {
			const editor = native.nodes(block).find(node => node.k === "editor")!;
			terminal.send(tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text }));
		};
		const handoff = vi.spyOn(h.mode.session, "sendUserMessage").mockResolvedValue(undefined);
		send("/handoff Keep the correction");
		await native.until(() => handoff.mock.calls.length === 1);
		const body = handoff.mock.calls[0]![0];
		if (typeof body !== "string") throw new Error("Expected a text handoff");
		expect(body).toContain("[User]: Earlier unmatched request");
		expect(body).toContain("[User]: Correction to that request");
		expect(body).toContain("[Assistant]: Canonical follow-up answer");
		expect(body.indexOf("Earlier unmatched request")).toBeLessThan(body.indexOf("Correction to that request"));
		expect(body.indexOf("Correction to that request")).toBeLessThan(body.indexOf("Canonical follow-up answer"));
		expect(body).toContain("User direction: Keep the correction");
		const promote = vi.spyOn(h.mode, "handleBtwBranch").mockResolvedValue(false);
		send("/promote");
		await native.until(() => promote.mock.calls.length === 1);
		expect(promote.mock.calls[0]![0]).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({ role: "user", content: "Earlier unmatched request" }),
				expect.objectContaining({ role: "user", content: "Correction to that request" }),
				expect.objectContaining({ role: "assistant", content: call.content }),
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "context-read",
					content: [{ type: "text", text: "Canonical tool source" }],
				}),
				expect.objectContaining({ role: "assistant", content: answer.content }),
			]),
		});
		expect(terminal.errors).toEqual([]);
	});
});

describe("BTW startup admission", () => {
	it("admits the original request before a native queue submitted during its durable flush", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const h = await harness(true, false, native);
		const flushing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = BtwSessionStore.prototype.flush;
		vi.spyOn(BtwSessionStore.prototype, "flush").mockImplementation(async function (this: BtwSessionStore) {
			flushing.resolve();
			await release.promise;
			await original.call(this);
		});
		const starting = h.mode.handleBtwCommand("Startup first question");
		try {
			await flushing.promise;
			await h.mode.handleBtwOpenThreadKey();
			const block = native.focused;
			await native.until(() => native.nodes(block).some(node => node.k === "editor"));
			await native.until(() => h.conversations.at(-1)?.session !== undefined);
			h.pane().getPasteTarget()!.setDraft("/queue Startup correction");
			const terminal = native.terminals.get(block)!;
			const editor = native.nodes(block).find(node => node.k === "editor")!;
			terminal.send(
				tspEvent({ ev: "send", sf: terminal.surface!, id: editor.id, text: "/queue Startup correction" }),
			);
			await native.until(() => h.pane().getPasteTarget()!.getText() === "");
		} finally {
			release.resolve();
		}
		await starting;
		await h.requestStarted(0);
		const firstContext = JSON.stringify(h.requests[0]!.context.messages);
		expect(firstContext).toContain("Startup first question");
		if (firstContext.includes("Startup correction"))
			expect(firstContext.indexOf("Startup first question")).toBeLessThan(
				firstContext.indexOf("Startup correction"),
			);
		await h.complete(0, "Startup first answer");
		if (!firstContext.includes("Startup correction")) {
			await h.requestStarted(1);
			expect(JSON.stringify(h.requests[1]!.context.messages)).toContain("Startup correction");
			await h.complete(1, "Startup corrected answer");
		}
		expect(h.terminal.errors).toEqual([]);
	});
});
