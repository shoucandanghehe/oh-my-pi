import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { PaneRestorableMessage } from "@oh-my-pi/pi-tui/chat/session-controls";
import { SessionPaneControls } from "@oh-my-pi/pi-coding-agent/modes/utils/pane-session-controls";
import { conversationPosition } from "@oh-my-pi/pi-coding-agent/modes/utils/conversation-position";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { BtwManager } from "@oh-my-pi/pi-coding-agent/session/btw-manager";
import type { BtwThreadEvent } from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import { sessionCommandQueue } from "@oh-my-pi/pi-coding-agent/session/session-command-queue";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { TestEphemeralConversation, disposeTestEphemeralConversations } from "./helpers/ephemeral-conversation";

const activeControls = new Set<SessionPaneControls>();

afterEach(async () => {
	for (const controls of activeControls) controls.dispose();
	activeControls.clear();
	await disposeTestEphemeralConversations();
});

function answer(text: string): EphemeralTurnResult {
	return { replyText: text, assistantMessage: createAssistantMessage(text) };
}

function userText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
}

async function makeSession(
	runTurn: (messages: AgentMessage[]) => Promise<EphemeralTurnResult> = async () => answer("Done"),
): Promise<AgentSession> {
	const conversation = new TestEphemeralConversation({
		snapshotBaseMessages: () => [],
		sideSessionId: `pane-controls-${crypto.randomUUID()}`,
		runTurn,
	});
	await conversation.initializeExtensionRuntime();
	return conversation.session!;
}

function controlsFor(
	session: AgentSession | undefined,
	options: Partial<ConstructorParameters<typeof SessionPaneControls<AgentSession>>[0]> = {},
) {
	const restored: PaneRestorableMessage[] = [];
	const errors: string[] = [];
	const controls = new SessionPaneControls<AgentSession>({
		currentSession: () => session,
		ensureSession: async () => {
			if (!session) throw new Error("A parked runtime must not be initialized by Stop");
			return session;
		},
		restore: input => restored.push(input),
		changed: () => {},
		error: message => errors.push(message),
		showTree: () => {},
		knownCommand: () => false,
		...options,
	});
	activeControls.add(controls);
	return { controls, restored, errors };
}

describe("SessionPaneControls runtime ownership", () => {
	it("does not revive a parked runtime for Stop or running-state reads", async () => {
		let initialized = 0;
		const { controls } = controlsFor(undefined, {
			ensureSession: async () => {
				initialized++;
				throw new Error("Unexpected runtime creation");
			},
		});
		expect(controls.isRunning()).toBe(false);
		expect(controls.getToolUpdates()).toEqual([]);
		await controls.submit("/stop");
		expect(initialized).toBe(0);
	});

	it("orders async preparation and binds each input to its originating session", async () => {
		const firstSession = await makeSession();
		const secondSession = await makeSession();
		let current = firstSession;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prepared: Array<{ session: AgentSession; text: string }> = [];
		const { controls } = controlsFor(firstSession, {
			currentSession: () => current,
			ensureSession: async () => current,
			prepareInput: async (session, input) => {
				prepared.push({ session, text: input.text });
				if (input.text === "First") {
					entered.resolve();
					await release.promise;
				}
				return { ...input, text: `Prepared ${input.text}` };
			},
		});
		const first = controls.submit("First");
		await entered.promise;
		current = secondSession;
		const second = controls.submit("Second");
		expect(prepared).toEqual([{ session: firstSession, text: "First" }]);
		release.resolve();
		await Promise.all([first, second]);
		expect(prepared).toEqual([
			{ session: firstSession, text: "First" },
			{ session: secondSession, text: "Second" },
		]);
		expect(firstSession.messages.filter(message => message.role === "user").map(userText)).toEqual([
			"Prepared First",
		]);
		expect(secondSession.messages.filter(message => message.role === "user").map(userText)).toEqual([
			"Prepared Second",
		]);
	});

	it("does not dispatch prepared or waiting input after Stop interrupts the submission lane", async () => {
		const session = await makeSession();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { controls, restored } = controlsFor(session, {
			prepareInput: async (_session, input) => {
				if (input.text === "Preparing") {
					entered.resolve();
					await release.promise;
				}
				return input;
			},
		});
		const preparing = controls.submit("Preparing");
		await entered.promise;
		const preparingIsRunning = controls.isRunning();
		const waiting = controls.submit("Waiting");
		const outcomes = Promise.allSettled([preparing, waiting]);
		await controls.abort();
		release.resolve();
		expect((await outcomes).map(result => result.status)).toEqual(["rejected", "rejected"]);
		expect(preparingIsRunning).toBe(true);
		expect(session.messages.filter(message => message.role === "user")).toEqual([]);
		expect(restored).toEqual([]);
		await controls.submit("New input");
		expect(session.messages.filter(message => message.role === "user").map(userText)).toEqual(["New input"]);
	});

	it("prepares nested queued input once and retains image and link facts for editing", async () => {
		const session = await makeSession();
		const prepared: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { controls } = controlsFor(session, {
			prepareInput: async (_session, input) => {
				prepared.push(input.text);
				entered.resolve();
				await release.promise;
				return input;
			},
		});
		sessionCommandQueue(session).request = { ...conversationPosition(session.sessionManager), text: "/compact" };
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
		const imageLinks = ["local://attachment.png"];
		const submitted = controls.submit("/queue /queue Held [Image #1]", images, "steer", imageLinks);
		await entered.promise;
		images.length = 0;
		imageLinks.length = 0;
		release.resolve();
		await submitted;
		expect(prepared).toEqual(["/queue /queue Held [Image #1]"]);
		const pending = controls.getPending().find(group => group.label === "After compaction")!;
		expect(pending.messages).toEqual(["Held [Image #1]"]);
		expect(await pending.edits[0]!()).toMatchObject({
			text: "Held [Image #1]",
			images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
			imageLinks: ["local://attachment.png"],
		});
		await controls.abort();
	});

	it("stops the current turn without draining held commands, then retries in the same session", async () => {
		const started = Promise.withResolvers<void>();
		const retried = Promise.withResolvers<void>();
		const release = Promise.withResolvers<EphemeralTurnResult>();
		let samples = 0;
		const session = await makeSession(async () => {
			if (samples++ === 0) {
				started.resolve();
				return release.promise;
			}
			retried.resolve();
			return answer("Retried locally");
		});
		const { controls, restored, errors } = controlsFor(session);
		const first = controls.submit("Run").catch(() => undefined);
		try {
			await started.promise;
			expect(controls.isRunning()).toBe(true);
			await controls.submit("/queue /compact");
			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "aGVsZA==" }];
			await controls.submit("Held [Image #1]", images, "followUp", ["local://held.png"]);
			await controls.submit("/stop");
			await first;
			expect(controls.isRunning()).toBe(false);
			expect(restored).toMatchObject([
				{ text: "/queue /compact" },
				{ text: "Held [Image #1]", images, imageLinks: ["local://held.png"] },
			]);
			expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
			expect(samples).toBe(1);
			await controls.submit("/retry");
			await retried.promise;
			await session.waitForIdle();
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Retried locally" }],
			});
			expect(samples).toBe(2);
			expect(errors).toEqual([]);
		} finally {
			release.resolve(answer("Late answer"));
			await first;
		}
	});

	it("keeps failure restoration with the editor owner and admits later input after a consumed or failed hook", async () => {
		const session = await makeSession();
		const { controls, restored } = controlsFor(session, {
			prepareInput: async (_session, input) => {
				if (input.text === "Consumed") return undefined;
				if (input.text === "Failed") throw new Error("Attachment unavailable");
				return input;
			},
		});
		await controls.submit("Consumed");
		await expect(controls.submit("Failed")).rejects.toThrow("Attachment unavailable");
		await expect(controls.submit("/clear")).rejects.toThrow("not available in this pane");
		await expect(controls.submit("/queue /stop")).rejects.toThrow("cannot be queued");
		await controls.submit("Accepted");
		expect(session.messages.filter(message => message.role === "user").map(userText)).toEqual(["Accepted"]);
		expect(restored).toEqual([]);
	});

	it("uses the thread prompt owner for both queued admission and ordinary turns", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<EphemeralTurnResult>();
		const events: BtwThreadEvent[] = [];
		let samples = 0;
		const manager = new BtwManager({
			restoredThreads: [],
			appendEvent: event => events.push(event),
			createConversation: () =>
				new TestEphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "pane-prompt-owner",
					runTurn: async () => {
						if (samples++ === 0) {
							started.resolve();
							return release.promise;
						}
						return answer("Second answer");
					},
				}),
			nextKey: () => "pane-prompt-owner",
			now: () => 100,
		});
		const key = manager.createChild("First", "main-leaf", { provider: "anthropic", id: "claude-sonnet-4-5" });
		const session = await manager.session(key);
		const { controls } = controlsFor(session, {
			prompt: async (_session, input, mode, onPromptAdmitted) => {
				await manager.prompt(key, input.text, undefined, undefined, input.images, mode, onPromptAdmitted);
			},
			abort: () => manager.abort(key),
		});
		try {
			await controls.submit("/queue First");
			await started.promise;
			expect(manager.thread(key)?.phase).toBe("running");
			const settled = manager.thread(key)!.request!.settled.promise;
			release.resolve(answer("First answer"));
			await settled;
			await controls.submit("Second");
			expect(events.filter(event => event.op === "request").map(event => event.input)).toEqual(["First", "Second"]);
			expect(manager.thread(key)?.turns.map(turn => turn.input)).toEqual(["First", "Second"]);
		} finally {
			release.resolve(answer("First answer"));
			await manager.dispose();
		}
	});

	it("replays current partial and stream snapshots without a view subscription and omits finished previews", async () => {
		const session = await makeSession();
		const partial = {
			type: "tool_execution_update" as const,
			toolCallId: "task-1",
			toolName: "task",
			args: {},
			partialResult: { content: [{ type: "text", text: "Child working" }] },
		};
		const preview = {
			type: "tool_stream_update" as const,
			toolCallId: "edit-1",
			toolName: "edit",
			update: { text: "Writing an edit" },
		};
		session.agent.emitExternalEvent(partial);
		session.agent.emitExternalEvent(preview);
		expect(controlsFor(session).controls.getToolUpdates()).toEqual([partial, preview]);
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			result: { content: [{ type: "text", text: "Saved" }] },
		});
		expect(controlsFor(session).controls.getToolUpdates()).toEqual([partial]);
	});
});
