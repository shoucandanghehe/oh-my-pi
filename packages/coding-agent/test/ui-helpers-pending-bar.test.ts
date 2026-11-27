import { afterEach, describe, expect, it, mock } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentViewSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import type { RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSurface, jsx } from "@oh-my-pi/pi-tui";
import { NativeSurfaces, TspConnection } from "@oh-my-pi/pi-tui/native/index";
import { TempDir } from "@oh-my-pi/pi-utils";
import { FakeTern, ManualClock } from "../../tui/test/native/fake-tern";
import { emptyMirrorState, RemoteAgentSession, type SessionHostClient } from "../src/thread/remote-agent-session";
import { Composer } from "../src/ui/composer/composer";
import { QueuedMessages, QueueModel } from "../src/ui/dock/queue";

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createRealSession(): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@pi-pending-bar-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return { tempDir, authStorage, session };
}

function queueCustomSteer(session: AgentSession, chip: string): void {
	session.agent.steer({
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: "skill body",
		display: true,
		attribution: "user",
		details: {
			name: "foo",
			path: "/s.md",
			args: "bar",
			lineCount: 1,
			__queueChipText: chip,
		} satisfies SkillPromptDetails,
		timestamp: Date.now(),
	});
}

function contextFor(session: AgentSession, compactionQueuedMessages: CompactionQueuedMessage[] = []) {
	const queue = new QueueModel();
	const composer = new Composer();
	let viewed: AgentViewSession = session;
	const ctx = {
		session,
		get viewSession() {
			return viewed;
		},
		get focusedAgentId() {
			return viewed === session ? undefined : "Worker";
		},
		compactionQueuedMessages,
		composer,
		locallySubmittedUserSignatures: new Set<string>(),
		keybindings: { keysFor: () => ["alt+up"] },
		hud: { queue },
		restoreCompactionQueueToEditor: (status?: string) => input.restoreCompactionQueueToEditor(status),
		restoreEditedQueueMessage: (message: RestoredQueuedMessage | undefined) =>
			input.restoreEditedQueueMessage(message),
		updatePendingMessagesDisplay: () => helpers.updatePendingMessagesDisplay(),
		showStatus: () => {},
	} as unknown as InteractiveModeContext;
	const input = new InputController(ctx);
	const helpers = new UiHelpers(ctx);
	return {
		ctx,
		queue,
		focus(target: AgentViewSession) {
			viewed = target;
		},
	};
}

/** Press the Edit control in the rendered pill (not the model callback). */
async function mountBand(queue: QueueModel) {
	const surface = createSurface(() => ({ dock: jsx(QueuedMessages, { model: queue }) }));
	const clock = new ManualClock();
	const tern = new FakeTern();
	const connecting = TspConnection.connect(tern, { clock });
	tern.pump();
	const connection = (await connecting)!;
	const backend = new NativeSurfaces({ surface });
	backend.start(connection);
	const doc = [...tern.docs.values()][0]!;
	const refresh = () => {
		tern.pump();
		clock.advance(0);
		tern.pump();
	};
	const pills = () => {
		refresh();
		const group = [...doc.nodes.values()].find(n => n.p.role === "omp.queue");
		return group?.c.map(id => doc.nodes.get(id)!) ?? [];
	};
	return {
		rows: () => pills().map(row => row.c.map(id => doc.nodes.get(id)!).find(n => n.k === "text")!.p.text),
		edit(row: number) {
			const pill = pills()[row];
			const button = pill?.c.map(id => doc.nodes.get(id)!).find(n => n.p.role === "omp.queue.edit");
			if (!button) return undefined;
			return () => {
				tern.event({ ev: "action", sf: doc.root, id: button.id, act: "queue.edit" });
				refresh();
			};
		},
		[Symbol.dispose]() {
			backend.stop(false);
			connection.close();
			surface.dispose();
		},
	};
}

describe("UiHelpers.updatePendingMessagesDisplay", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		if (!fixture) return;
		await fixture.session.dispose();
		fixture.authStorage.close();
		fixture.tempDir.removeSync();
		fixture = undefined;
	});

	it("lists a queued skill by its compact slash form under Steering", async () => {
		fixture = await createRealSession();
		queueCustomSteer(fixture.session, "/skill:test-skill arg1 arg2");
		const { ctx, queue } = contextFor(fixture.session);
		new UiHelpers(ctx).updatePendingMessagesDisplay();
		expect(queue.groups.peek()).toMatchObject([{ label: "Steering", messages: ["/skill:test-skill arg1 arg2"] }]);
		expect(queue.dequeueKey.peek()).toBe("alt+up");
	});

	it("Edit takes the selected follow-up, not the newest steer, and rejects a stale duplicate", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		const { ctx, queue } = contextFor(session);
		queueCustomSteer(session, "other queue");
		for (const text of ["duplicate", "duplicate", "last"]) {
			session.agent.followUp({ role: "user", content: text, timestamp: 1 });
		}
		ctx.updatePendingMessagesDisplay();
		using band = await mountBand(queue);
		expect(band.rows()).toEqual(["other queue", "duplicate", "duplicate", "last"]);
		const edit = band.edit(1)!;
		ctx.composer.setText("new draft");
		edit();
		expect(ctx.composer.text()).toBe("duplicate\n\nnew draft");
		expect(session.getQueuedMessages()).toMatchObject({
			steering: ["other queue"],
			followUp: ["duplicate", "last"],
		});
		edit();
		expect(session.getQueuedMessages().followUp).toEqual(["duplicate", "last"]);
		expect(ctx.composer.text()).toBe("duplicate\n\nnew draft");
		const stale = band.edit(1)!;
		session.clearQueue();
		session.agent.followUp({ role: "user", content: "duplicate", timestamp: 2 });
		stale();
		expect(session.getQueuedMessages().followUp).toEqual(["duplicate"]);
		session.clearQueue();
		ctx.updatePendingMessagesDisplay();
		expect(band.rows()).toEqual([]);
	});

	it("edits one held row, but returns the whole held batch when its compaction barrier is withdrawn", async () => {
		fixture = await createRealSession();
		const image: ImageContent = { type: "image", data: "YQ==", mimeType: "image/png" };
		const draftImage: ImageContent = { ...image, data: "Yg==" };
		const { ctx, queue } = contextFor(fixture.session, [
			{ text: "keep for later", mode: "steer" },
			{ text: "selected [Image #1]", mode: "steer", images: [image], imageLinks: ["/held.png"] },
			{ text: "after compact", mode: "followUp" },
		]);
		ctx.yieldCompaction = { sessionId: "main", leafId: null, text: "/compact preserve notes" };
		ctx.updatePendingMessagesDisplay();
		using band = await mountBand(queue);
		const editHeld = band.edit(1)!;
		ctx.composer.pendingImages.push(draftImage);
		ctx.composer.pendingImageLinks.push("/draft.png");
		ctx.composer.setCollapsedText("newer [Image #1]");
		editHeld();
		expect(ctx.composer.expandedText()).toBe("selected [Image #2]\n\nnewer [Image #1]");
		expect(ctx.composer.pendingImages).toEqual([draftImage, image]);
		expect(ctx.composer.pendingImageLinks).toEqual(["/draft.png", "/held.png"]);
		expect(band.rows()).toEqual(["keep for later", "Compaction queued · /compact preserve notes", "after compact"]);
		const requestEdit = band.edit(1)!;
		ctx.yieldCompaction = { ...ctx.yieldCompaction!, text: "/compact replacement" };
		requestEdit();
		expect(ctx.compactionQueuedMessages.map(m => m.text)).toEqual(["keep for later", "after compact"]);
		ctx.updatePendingMessagesDisplay();
		band.edit(1)!();
		expect(ctx.composer.expandedText()).toBe(
			"/compact replacement\n\nkeep for later\n\nafter compact\n\nselected [Image #2]\n\nnewer [Image #1]",
		);
		expect(ctx.yieldCompaction).toBeUndefined();
		expect(ctx.compactionQueuedMessages).toEqual([]);
		expect(band.rows()).toEqual([]);
	});

	it("Edit in a focused worker takes only that mirror's pending row, not a live steer or Main input", async () => {
		fixture = await createRealSession();
		const main = fixture.session;
		queueCustomSteer(main, "main steer");
		const { ctx, queue, focus } = contextFor(main, [{ text: "main held", mode: "steer" }]);
		const call = mock(async () => {});
		const worker = new RemoteAgentSession({
			agentId: "Worker",
			key: "worker",
			home: "w1",
			host: { remote: { call } } as unknown as SessionHostClient,
			state: emptyMirrorState(),
			messages: [],
		});
		worker.applyViewPatch({
			queuedMessages: { steering: ["live steer", "worker target", "worker last"], followUp: [], liveSteered: 1 },
			restorableQueue: {
				steering: ["worker target", "worker last"].map((text, i) => ({
					id: `remote${i}`,
					message: { text },
					claimed: false,
				})),
				followUp: [],
			},
		});
		focus(worker);
		ctx.updatePendingMessagesDisplay();
		using band = await mountBand(queue);
		expect(band.rows()).toEqual(["live steer", "worker target", "worker last"]);
		expect(band.edit(0)).toBeUndefined();
		const target = band.edit(1)!;
		focus(main);
		target();
		expect(call).not.toHaveBeenCalled();
		expect(ctx.composer.text()).toBe("");
		focus(worker);
		ctx.updatePendingMessagesDisplay();
		band.edit(1)!();
		expect(ctx.composer.text()).toBe("worker target");
		expect(call).toHaveBeenCalledWith("popQueuedMessage", "remote0");
		expect(worker.getQueuedMessages().steering).toEqual(["live steer", "worker last"]);
		const beforeClaim = band.edit(1)!;
		worker.applyViewPatch({
			queuedMessages: { steering: ["live steer", "worker last"], followUp: [], liveSteered: 2 },
			restorableQueue: { steering: [], followUp: [] },
		});
		beforeClaim();
		expect(call).toHaveBeenCalledTimes(1);
		expect(ctx.composer.text()).toBe("worker target");
		expect(main.getQueuedMessages().steering).toEqual(["main steer"]);
		expect(ctx.compactionQueuedMessages.map(m => m.text)).toEqual(["main held"]);
	});

	it("groups yield follow-ups under one heading, in order", async () => {
		fixture = await createRealSession();
		for (const text of ["inspect types", "run tests", "summarize"]) {
			fixture.session.agent.followUp({ role: "user", content: text, attribution: "user", timestamp: Date.now() });
		}
		const { ctx, queue } = contextFor(fixture.session);
		new UiHelpers(ctx).updatePendingMessagesDisplay();
		expect(queue.groups.peek()).toMatchObject([
			{ label: "After yield", messages: ["inspect types", "run tests", "summarize"] },
		]);
	});
});
