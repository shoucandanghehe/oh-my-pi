/** Queue Edit runs the real session and controllers; only the provider and UI output are external seams. */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { QueuedMessagesBand } from "@oh-my-pi/pi-tui/prompt/queued-messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(() => initTheme());

const queuedImage: ImageContent = { type: "image", data: "queued-image", mimeType: "image/png" };
const draftImage: ImageContent = { type: "image", data: "draft-image", mimeType: "image/png" };

describe("queued message Edit", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-queue-edit-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function createSession(streamFn: StreamFn) {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn,
			steeringMode: "all",
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		return session;
	}

	function createQueueUi(target: AgentSession, draft = "draft [Image #1]") {
		let editorText = draft;
		const ctx = createInteractiveModeContext({
			session: target,
			sessionManager: target.sessionManager,
			settings: target.settings,
			compactionQueuedMessages: [],
			cancelPendingSubmission: () => false,
			editor: {
				getText: () => editorText,
				setCollapsedText: value => {
					editorText = value;
				},
				pendingImages: [draftImage],
				pendingImageLinks: ["draft-link"],
			},
		});
		const input = new InputController(ctx);
		const helpers = new UiHelpers(ctx);
		const events = new EventController(ctx);
		let editing: Promise<void> | undefined;
		ctx.updatePendingMessagesDisplay = () => helpers.updatePendingMessagesDisplay();
		ctx.handleQueuedMessageEdit = edit => {
			editing = input.handleQueuedMessageEdit(edit);
			return editing;
		};
		target.subscribe(event => {
			if (event.type === "queue_update") void events.handleEvent(event);
		});
		helpers.updatePendingMessagesDisplay();
		return {
			ctx,
			input,
			getText: () => editorText,
			band: () =>
				ctx.pendingMessagesContainer.children.find(child => child instanceof QueuedMessagesBand) as
					| QueuedMessagesBand
					| undefined,
			click: async (band: QueuedMessagesBand, key: string) => {
				editing = undefined;
				band.handleNativeEvent({ type: "action", key, act: "queue.edit", mods: [] });
				if (!editing) throw new Error("queue edit did not dispatch");
				await editing;
			},
		};
	}

	it("stops a live-claimed response, restores only the clicked input, and leaves other input pending", async () => {
		const streaming = Promise.withResolvers<void>();
		const allowClaim = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<void>();
		let providerCalls = 0;
		let aborted = false;
		const target = createSession(async (_model, _context, options) => {
			providerCalls++;
			const live = options?.liveSteering;
			const signal = options?.signal;
			if (!live || !signal) throw new Error("live steering was not offered");
			const stream = new AssistantMessageEventStream();
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
					stream.fail(new Error("aborted"));
				},
				{ once: true },
			);
			streaming.resolve();
			await live.wait(signal);
			await allowClaim.promise;
			const claim = await live.claim(signal);
			if (!claim) throw new Error("steering was not claimed");
			claim.accept();
			claimed.resolve();
			return stream;
		});
		target.setSlashCommands([{ name: "review", description: "Review", content: "Expanded $1", source: "(test)" }]);
		const running = target.prompt("start");
		await streaming.promise;
		await target.prompt("/review chosen", { streamingBehavior: "steer" });
		await target.steer("other live");
		allowClaim.resolve();
		await claimed.promise;
		await target.steer("other pending");
		await target.followUp("after yield");
		const ui = createQueueUi(target);
		expect(target.getQueuedMessages().liveSteered).toBe(2);
		expect(target.getQueuedMessages().steering[0]).toBe("Expanded chosen");
		await ui.click(ui.band()!, "Steering/0/edit");
		await running;
		await setImmediate();

		expect(aborted).toBe(true);
		expect(target.isStreaming).toBe(false);
		expect(providerCalls).toBe(1);
		expect(ui.getText()).toBe("/review chosen\n\ndraft [Image #1]");
		expect(ui.ctx.editor.pendingImages).toEqual([draftImage]);
		expect(ui.ctx.editor.pendingImageLinks).toEqual(["draft-link"]);
		expect(target.getQueuedMessages()).toEqual({
			steering: ["other live", "other pending"],
			followUp: ["after yield"],
			liveSteered: 0,
		});
		expect(
			target.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("chosen")),
		).toBe(false);
		expect(ui.band()).toBeDefined();
	});

	it("lets Alt+Up stop and restore live input when no ordinary pending message remains", async () => {
		const streaming = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<void>();
		let aborted = false;
		const target = createSession(async (_model, _context, options) => {
			const live = options?.liveSteering;
			const signal = options?.signal;
			if (!live || !signal) throw new Error("live steering was not offered");
			const stream = new AssistantMessageEventStream();
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
					stream.fail(new Error("aborted"));
				},
				{ once: true },
			);
			streaming.resolve();
			await live.wait(signal);
			const claim = await live.claim(signal);
			if (!claim) throw new Error("steering was not claimed");
			claim.accept();
			claimed.resolve();
			return stream;
		});
		const running = target.prompt("start");
		await streaming.promise;
		await target.steer("live input");
		await claimed.promise;
		const ui = createQueueUi(target);
		ui.input.handleDequeue();
		await running;
		await setImmediate();
		expect(aborted).toBe(true);
		expect(ui.getText()).toBe("live input\n\ndraft [Image #1]");
		expect(target.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
		expect(ui.band()).toBeUndefined();
	});

	it("edits the clicked pending duplicate without stopping the response or taking the last message", async () => {
		const streaming = Promise.withResolvers<void>();
		let aborted = false;
		const target = createSession(async (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			options?.signal?.addEventListener(
				"abort",
				() => {
					aborted = true;
					stream.fail(new Error("aborted"));
				},
				{ once: true },
			);
			streaming.resolve();
			return stream;
		});
		const running = target.prompt("start");
		await streaming.promise;
		await target.followUp("same [Image #1]", [queuedImage]);
		await target.followUp("same [Image #1]", [draftImage]);
		await target.steer("keep steering");
		const ui = createQueueUi(target);
		const staleBand = ui.band()!;
		await ui.click(staleBand, "After yield/0/edit");
		await ui.click(staleBand, "After yield/0/edit");

		expect(aborted).toBe(false);
		expect(target.isStreaming).toBe(true);
		expect(ui.getText()).toBe("same [Image #2]\n\ndraft [Image #1]");
		expect(ui.ctx.editor.pendingImages).toEqual([draftImage, queuedImage]);
		expect(target.getQueuedMessages()).toEqual({
			steering: ["keep steering"],
			followUp: ["same [Image #1]"],
			liveSteered: 0,
		});
		expect(target.agent.peekFollowUpQueue()[0]).toMatchObject({
			content: [{ type: "text", text: "same [Image #1]" }, draftImage],
		});
		target.clearQueue({ forInterrupt: true });
		await target.abort();
		await running;
	});

	it("edits the selected compaction entry without draining the other mode or changing the existing draft images", async () => {
		const target = createSession(createMockModel({ responses: [] }).stream);
		const ui = createQueueUi(target);
		ui.ctx.compactionQueuedMessages = [
			{ text: "chosen [Image #1]", mode: "followUp", images: [queuedImage] },
			{ text: "keep compaction", mode: "steer" },
		];
		ui.ctx.updatePendingMessagesDisplay();
		await ui.click(ui.band()!, "After yield/0/edit");
		expect(ui.getText()).toBe("chosen [Image #2]\n\ndraft [Image #1]");
		expect(ui.ctx.editor.pendingImages).toEqual([draftImage, queuedImage]);
		expect(ui.ctx.compactionQueuedMessages).toEqual([{ text: "keep compaction", mode: "steer" }]);
		expect(target.isStreaming).toBe(false);
	});

	it("refreshes delivered chips on queue_update and refuses a stale Edit without modifying the draft", async () => {
		const target = createSession(
			createMockModel({ responses: [{ content: ["first"] }, { content: ["second"] }] }).stream,
		);
		const ui = createQueueUi(target);
		let staleBand: QueuedMessagesBand | undefined;
		target.agent.setOnBeforeYield(async () => {
			if (staleBand) return;
			await target.followUp("delivered");
			staleBand = ui.band();
		});
		await target.prompt("start");
		expect(
			target.messages.some(
				message => message.role === "user" && JSON.stringify(message.content).includes("delivered"),
			),
		).toBe(true);
		expect(ui.band()).toBeUndefined();
		await ui.click(staleBand!, "After yield/0/edit");
		expect(ui.getText()).toBe("draft [Image #1]");
		expect(ui.ctx.editor.pendingImages).toEqual([draftImage]);
		expect(target.isStreaming).toBe(false);
		expect(ui.band()).toBeUndefined();
	});
});
