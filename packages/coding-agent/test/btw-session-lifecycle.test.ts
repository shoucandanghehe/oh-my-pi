import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import type { EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

interface SideTurn {
	signal?: AbortSignal;
	finished: Promise<EphemeralTurnResult>;
}

describe("BTW session boundaries", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let manager: SessionManager;
	let btw: BtwController;
	let sourceFile: string;
	let sourceId: string;
	let sourceThreadKey: string;
	let turns: SideTurn[];
	let responses: Array<(text: string) => void>;
	let providerStarted: PromiseWithResolvers<void>;
	let extensionRunner: ExtensionRunner;

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		directory = TempDir.createSync("@omp-btw-session-lifecycle-");
		await Settings.init({ inMemory: true, cwd: directory.path() });
		auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		vi.spyOn(registry, "resolver").mockReturnValue(async () => "test-api-key");
		manager = SessionManager.create(directory.path(), directory.path());
		const sourceMessage = { role: "user" as const, content: "Source session", timestamp: Date.now() };
		manager.appendMessage(sourceMessage);
		await manager.ensureOnDisk();
		extensionRunner = new ExtensionRunner([], new ExtensionRuntime(), directory.path(), manager, registry);
		turns = [];
		responses = [];
		providerStarted = Promise.withResolvers<void>();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [sourceMessage] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: registry,
			extensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
			sideStreamFn: () => {
				const stream = new AssistantMessageEventStream();
				responses.push(text => {
					const message = answer(text);
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				providerStarted.resolve();
				return stream;
			},
		});
		const createConversation = session.createEphemeralConversation.bind(session);
		vi.spyOn(session, "createEphemeralConversation").mockImplementation((...args) => {
			const conversation = createConversation(...args);
			const prompt = conversation.prompt.bind(conversation);
			vi.spyOn(conversation, "prompt").mockImplementation((input, options) => {
				const finished = prompt(input, options);
				turns.push({ signal: options?.signal, finished });
				return finished;
			});
			return conversation;
		});
		mode = new InteractiveMode(session, "test");
		Object.defineProperty(mode, "workspaceEnabled", { value: false });
		mode.ui.requestRender = vi.fn();
		mode.ui.requestComponentRender = vi.fn();
		mode.ui.setFocus = vi.fn();
		vi.spyOn(mode.ui, "showOverlay").mockImplementation(() => ({
			hide: vi.fn(),
			setHidden: vi.fn(),
			isHidden: () => false,
		}));
		vi.spyOn(mode, "renderInitialMessages").mockResolvedValue(undefined);
		vi.spyOn(mode, "reloadTodos").mockResolvedValue(undefined);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		vi.spyOn(mode, "showError").mockImplementation(() => {});
		const start = BtwController.prototype.start;
		vi.spyOn(BtwController.prototype, "start").mockImplementation(function (this: BtwController, question) {
			btw = this;
			return start.call(this, question);
		});
		await mode.handleBtwCommand("Slow side question");
		await providerStarted.promise;
		sourceFile = manager.getSessionFile()!;
		sourceId = manager.getSessionId();
		const thread = (await savedThreads(sourceFile))[0];
		if (!thread) throw new Error("Expected a durable inline thread with workspace disabled");
		sourceThreadKey = thread.key;
	});

	afterEach(async () => {
		for (const complete of responses) complete("Cleanup");
		await Promise.allSettled(turns.map(turn => turn.finished));
		await btw?.dispose();
		mode.stop();
		vi.restoreAllMocks();
		await session.dispose();
		auth.close();
		directory.removeSync();
		resetSettingsForTest();
	});

	async function savedThreads(file: string) {
		const store = await BtwHistoryStore.open(file.slice(0, -".jsonl".length));
		return store.getRecords().map(record => ({ ...record, key: record.id }));
	}

	async function targetSession(): Promise<string> {
		const target = SessionManager.create(directory.path(), directory.path());
		target.appendMessage({ role: "user", content: "Target session", timestamp: Date.now() });
		await target.ensureOnDisk();
		const file = target.getSessionFile()!;
		await target.close();
		return file;
	}

	async function picker(file: string): Promise<SessionSelectorComponent> {
		const list = await SessionManager.list(directory.path(), directory.path());
		const selected = list.find(item => item.path === file);
		if (!selected) throw new Error("Expected saved picker target");
		vi.spyOn(SessionManager, "listForPicker").mockResolvedValue([selected]);
		await new SelectorController(mode).showSessionSelector();
		const component = vi.spyOn(mode.ui, "showOverlay").mock.calls.at(-1)?.[0];
		if (!(component instanceof SessionSelectorComponent)) throw new Error("Expected session selector");
		return component;
	}

	async function startTransition(action: "delete command" | "picker delete" | "picker resume") {
		if (action === "delete command") {
			vi.spyOn(SelectorController.prototype, "showSessionSelector").mockResolvedValue(undefined);
			return { finished: mode.handleSessionDeleteCommand() };
		}
		const panel = await picker(action === "picker delete" ? sourceFile : await targetSession());
		const done = Promise.withResolvers<void>();
		if (action === "picker delete") {
			const remove = FileSessionStorage.prototype.deleteSessionWithArtifacts;
			vi.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts").mockImplementation(
				async function (this: FileSessionStorage, file) {
					try {
						await remove.call(this, file);
						done.resolve();
					} catch (error) {
						done.reject(error);
						throw error;
					}
				},
			);
			panel.handleInput("\x1b[3~");
		} else {
			const resume = SelectorController.prototype.handleResumeSession;
			vi.spyOn(SelectorController.prototype, "handleResumeSession").mockImplementation(async function (
				this: SelectorController,
				...args
			) {
				try {
					const result = await resume.apply(this, args);
					done.resolve();
					return result;
				} catch (error) {
					done.reject(error);
					throw error;
				}
			});
		}
		panel.handleInput("\n");
		return { finished: done.promise };
	}

	async function completeDestinationQuestion() {
		manager.appendMessage({ role: "user", content: "Destination context", timestamp: Date.now() });
		await manager.ensureOnDisk();
		providerStarted = Promise.withResolvers<void>();
		await mode.handleBtwCommand("Destination side question");
		await providerStarted.promise;
		responses.at(-1)!("Destination answer");
		await turns.at(-1)!.finished;
		await btw.dispose();
		await manager.flush();
		const destination = await savedThreads(manager.getSessionFile()!);
		expect(destination.find(thread => thread.title === "Destination side question")?.turns.at(-1)?.replyText).toBe(
			"Destination answer",
		);
		expect(destination.some(thread => thread.key === sourceThreadKey)).toBe(false);
	}

	it.each(["delete command", "picker delete", "picker resume"] as const)(
		"%s aborts BTW before the journal write barrier and ignores late provider output",
		async action => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const flush = manager.flush.bind(manager);
			vi.spyOn(manager, "flush").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				await flush();
			});
			try {
				const { finished } = await startTransition(action);
				await entered.promise;
				expect(turns[0]!.signal?.aborted).toBe(true);
				expect(manager.getSessionId()).toBe(sourceId);
				expect(await Bun.file(sourceFile).exists()).toBe(true);
				release.resolve();
				await finished;
				expect(manager.getSessionId()).not.toBe(sourceId);
				responses[0]!("Late answer from the source");
				await Promise.allSettled([turns[0]!.finished]);
				if (action === "picker resume") {
					const source = await savedThreads(sourceFile);
					expect(source.map(thread => thread.key)).toEqual([sourceThreadKey]);
					expect(source[0]!.turns).toEqual([]);
				} else {
					expect(await Bun.file(sourceFile).exists()).toBe(false);
				}
				await completeDestinationQuestion();
			} finally {
				release.resolve();
			}
		},
	);

	it.each(["delete", "resume"] as const)("keeps the source journal when persistence blocks %s", async action => {
		const target = action === "resume" ? await targetSession() : undefined;
		const failure = new Error("session journal unavailable");
		vi.spyOn(manager, "flush").mockRejectedValueOnce(failure);
		const operation = action === "delete" ? mode.handleSessionDeleteCommand() : mode.handleResumeSession(target!);
		await expect(operation).rejects.toThrow(failure.message);
		expect(manager.getSessionId()).toBe(sourceId);
		expect(await Bun.file(sourceFile).exists()).toBe(true);
		expect((await savedThreads(sourceFile)).map(thread => thread.key)).toEqual([sourceThreadKey]);
	});

	it("leaves BTW running when the delete confirmation is declined", async () => {
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(false);
		await mode.handleSessionDeleteCommand();
		expect(manager.getSessionId()).toBe(sourceId);
		expect(turns[0]!.signal?.aborted).toBe(false);
		expect((await savedThreads(sourceFile)).map(thread => thread.key)).toEqual([sourceThreadKey]);
	});

	it("deletes an inactive picker entry without interrupting the current BTW", async () => {
		const target = await targetSession();
		const panel = await picker(target);
		const removed = Promise.withResolvers<void>();
		const remove = FileSessionStorage.prototype.deleteSessionWithArtifacts;
		vi.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts").mockImplementation(
			async function (this: FileSessionStorage, file) {
				await remove.call(this, file);
				removed.resolve();
			},
		);
		panel.handleInput("\x1b[3~");
		panel.handleInput("\n");
		await removed.promise;
		expect(await Bun.file(target).exists()).toBe(false);
		expect(manager.getSessionId()).toBe(sourceId);
		expect(turns[0]!.signal?.aborted).toBe(false);
	});

	describe.each(["initial", "reinitialized"] as const)("%s extension command context", binding => {
		it.each(["newSession", "switchSession", "branch"] as const)(
			"%s preserves the source thread and cannot append its late reply to the destination",
			async action => {
				const controller = new ExtensionUiController(mode);
				await controller.initHooksAndCustomTools();
				if (binding === "reinitialized") controller.initializeHookRunner(extensionRunner.getUIContext(), true);
				const context = extensionRunner.createCommandContext();
				const target =
					action === "switchSession" ? await targetSession() : (await savedThreads(sourceFile))[0]!.anchorLeafId;
				const result =
					action === "newSession"
						? await context.newSession()
						: action === "switchSession"
							? await context.switchSession(target)
							: await context.branch(target);
				expect(result).toEqual({ cancelled: false });
				expect(manager.getSessionId()).not.toBe(sourceId);
				expect(turns[0]!.signal?.aborted).toBe(true);
				const saved = await Bun.file(sourceFile).text();
				responses[0]!("Late answer from the source");
				await Promise.allSettled([turns[0]!.finished]);
				expect(await Bun.file(sourceFile).text()).toBe(saved);
				const source = await savedThreads(sourceFile);
				expect(source.map(thread => thread.key)).toEqual([sourceThreadKey]);
				expect(source[0]!.turns).toEqual([]);
				await completeDestinationQuestion();
			},
		);
	});
});
