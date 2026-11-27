import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createSurface, jsx, type PresentedFrame, startHost } from "@oh-my-pi/pi-tui";
import { NativeSurfaces, TspConnection } from "@oh-my-pi/pi-tui/native/index";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { SgrState, tokens } from "@oh-my-pi/pi-tui/text/ansi";
import { sliceColumns } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { TspText } from "@oh-my-pi/pi-wire";
import { FakeTern, ManualClock } from "../../tui/test/native/fake-tern";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ExtensionPresentationSource } from "../src/extensibility/extensions/presentation";
import { AgentPaneDraft, type AgentWorkspaceSurface, mountAgentWorkspacePane } from "../src/modes/agent-workspace-pane";
import { NativeAgentPanes } from "../src/modes/controllers/native-agent-panes";
import type { NativeWorkspaceView } from "../src/modes/native-workspace/workspace";
import { type AgentRef, AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import type { AgentViewSession } from "../src/session/agent-session-handle";
import type { DequeuedMessage, PromptOptions, RestoredQueuedInput } from "../src/session/agent-session-types";
import type { SessionTreeNode } from "../src/session/session-entries";
import { SessionManager } from "../src/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { waitFor } from "./collab/helpers/throttled-host";

const PANE_PNG: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
};

async function display(mount: AgentWorkspaceSurface) {
	const tern = new FakeTern();
	const clock = new ManualClock();
	const connecting = TspConnection.connect(tern, { clock });
	tern.pump();
	const connection = (await connecting)!;
	const renderer = new NativeSurfaces(mount);
	renderer.start(connection);
	const doc = [...tern.docs.values()][0]!;
	const refresh = () => {
		tern.pump();
		clock.advance(0);
		tern.pump();
	};
	return {
		doc,
		refresh,
		type(text: string) {
			tern.event({ ev: "edit", sf: doc.root, id: doc.focus!, from: 0, to: 0, text, cursor: text.length, len: 0 });
			refresh();
		},
		press(id: string) {
			tern.input({ type: "key", key: { id, kind: "press", raw: id } });
			refresh();
		},
		act(act: string, index = 0) {
			const node = [...doc.nodes.values()].filter(
				({ p }) => p.actions && typeof p.actions === "object" && Reflect.get(p.actions, "click") === act,
			)[index];
			if (!node) throw new Error(`No native control for ${act} at index ${index}`);
			tern.event({ ev: "action", sf: doc.root, id: node.id, act });
			refresh();
		},
		resize(cols: number) {
			tern.event({ ev: "resize", cols });
			refresh();
		},
		close() {
			renderer.stop(false);
			connection.close();
			mount.surface.dispose();
			mount.dispose?.();
		},
	};
}

function workspaceAgent(
	id: string,
	options: {
		cwd?: string;
		assistant?: AssistantMessage;
		parkedFile?: string;
		showHub?: () => void;
		nativeScroll?: boolean;
	} = {},
) {
	const draft = new AgentPaneDraft();
	const prompts: { text: string; options?: PromptOptions }[] = [];
	const copied: string[] = [];
	const messages: AgentMessage[] = [{ role: "user", content: `transcript for ${id}`, timestamp: 0 }];
	if (options.assistant) messages.push(options.assistant);
	const steering: string[] = [];
	const claimed: string[] = [];
	const followUp: string[] = [];
	const statuses = new Map<string, string>();
	const presentationListeners = new Set<() => void>();
	const presentation: ExtensionPresentationSource = {
		getPresentation: () => ({ widgets: [], statuses }),
		subscribePresentation(listener) {
			presentationListeners.add(listener);
			return () => presentationListeners.delete(listener);
		},
	};
	const settings = Settings.isolated({});
	const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, name: `model-${id}`, contextWindow: 10_000 };
	let idleGate: Promise<void> | undefined;
	let retryCount = 0;
	let compacted: { instructions?: string; mode?: string } | undefined;
	let compactionGate: Promise<void> | undefined;
	const compactionStarted = Promise.withResolvers<void>();
	const prompted = Promise.withResolvers<void>();
	let navigated: string | undefined;
	const roots: SessionTreeNode[] = [
		{
			entry: { type: "message", id: "previous", parentId: null, timestamp: "", message: messages[0]! },
			children: [
				{
					entry: {
						type: "message",
						id: "leaf",
						parentId: "previous",
						timestamp: "",
						message: { role: "user", content: "latest agent prompt", timestamp: 1 },
					},
					children: [],
				},
			],
		},
	];
	const session = {
		instanceKey: `thread:${id}`,
		settings,
		model,
		presentation,
		state: { messages, model, thinkingLevel: "high" },
		modelRegistry: { isUsingSubscription: () => false },
		messages,
		agent: { state: { streamMessage: null, pendingToolCalls: new Set<string>() }, getPendingToolResults: () => [] },
		sessionManager: {
			getCwd: () => options.cwd ?? process.cwd(),
			getUsageStatistics: () => ({ input: 1_234, output: 766, cacheRead: 0, cacheWrite: 0, cost: 2.5 }),
			getSessionName: () => undefined,
			getSessionId: () => id,
			getLeafId: () => "leaf",
			getTree: () => roots,
			getBranch: () => roots[0]!.children.map(node => node.entry),
		},
		hasPausedAgents: () => false,
		get isStreaming() {
			return claimed.length > 0;
		},
		get hasInterruptibleInput() {
			return claimed.length + steering.length + followUp.length > 0;
		},
		get queuedMessageCount() {
			return steering.length + followUp.length;
		},
		getQueuedMessages: () => ({
			steering: [...claimed, ...steering],
			followUp: [...followUp],
			liveSteered: claimed.length,
		}),
		getQueuedMessageEditIds: () => ({
			steering: [...claimed.map(() => undefined), ...steering.map(text => `q:${text}`)],
			followUp: followUp.map(text => `q:${text}`),
		}),
		takeQueuedMessageAt(
			queue: "steering" | "followUp",
			index: number,
			text: string,
			id: string,
		): { text: string } | undefined {
			const messages = queue === "steering" ? steering : followUp;
			const pending = queue === "steering" ? index - claimed.length : index;
			if (messages[pending] !== text || `q:${text}` !== id) return undefined;
			messages.splice(pending, 1);
			return { text };
		},
		popLastQueuedMessage(): DequeuedMessage | undefined {
			const steer = steering.pop();
			if (steer !== undefined) return { text: steer, queue: "steering" };
			const follow = followUp.pop();
			if (follow !== undefined) return { text: follow, queue: "followUp" };
		},
		async interruptAndRestoreQueue(restore: (input: RestoredQueuedInput) => void) {
			restore({
				steering: [...claimed.splice(0), ...steering.splice(0)].map(text => ({ text })),
				followUp: followUp.splice(0).map(text => ({ text })),
			});
		},
		getAdvisorCost: () => 0,
		isFastModeActive: () => false,
		getPrewalkState: () => undefined,
		getAnthropicSlowModeLabel: () => undefined,
		getAsyncJobSnapshot: () => null,
		getContextUsage: () => ({ tokens: 2_500, contextWindow: 10_000, percent: 25 }),
		prewarmModelConnection: () => {},
		emitInteractiveInput: async () => undefined,
		subscribe: () => () => {},
		waitForIdle: async () => {
			await idleGate;
		},
		waitForAdmittedSubmissions: async () => {},
		waitForRunEnd: async () => {},
		buildTranscriptSessionContext: () => ({ messages }),
		activeToolExecutionUpdates: () => [],
		async prompt(text: string, options?: PromptOptions) {
			prompts.push({ text, options });
			options?.onPromptAdmitted?.();
			prompted.resolve();
			return true;
		},
		async retry() {
			retryCount++;
			return true;
		},
		async compact(instructions?: string, options?: { mode?: string }) {
			compacted = { instructions, mode: options?.mode };
			compactionStarted.resolve();
			await compactionGate;
		},
		async navigateTree(entryId: string) {
			navigated = entryId;
			return { cancelled: false, editorText: `restored ${id}` };
		},
	} as unknown as AgentViewSession;
	const registry = new AgentRegistry();
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		status: options.parkedFile ? "parked" : "running",
		sessionFile: options.parkedFile,
		session: options.parkedFile ? null : session,
	});
	return {
		prompts,
		copied,
		steering,
		claimed,
		followUp,
		setStatus(key: string, text: string) {
			statuses.set(key, text);
			for (const listener of presentationListeners) listener();
		},
		holdIdle(gate: Promise<void>) {
			idleGate = gate;
		},
		compactionStarted: compactionStarted.promise,
		prompted: prompted.promise,
		holdCompaction(gate: Promise<void>) {
			compactionGate = gate;
		},
		get retries() {
			return retryCount;
		},
		get compaction() {
			return compacted;
		},
		get treeJump() {
			return navigated;
		},
		async mount() {
			return await display(
				mountAgentWorkspacePane({
					agentId: id,
					close: () => {},
					rows: () => 32,
					columns: () => 100,
					registry,
					lifecycle: {
						async ensureLive(key) {
							if (key !== id) throw new Error(`Pane changed target to ${key}`);
							return session;
						},
					},
					settings,
					draft,
					isCurrent: () => true,
					knownCommand: text => text.startsWith("/settings"),
					copyText: async text => {
						copied.push(text);
					},
					showHub: options.showHub,
				}),
			);
		},
	};
}

function answer(text: string, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "parity",
		model: "agent-fixture",
		usage: {
			input: 22,
			output: 12,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 34,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: errorMessage ? "error" : "stop",
		errorMessage,
		timestamp: 1,
	};
}

// Wait for command dispatch microtasks (not prompt duration or a poll interval).
async function admit(): Promise<void> {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

test("native agent panes target their own transcript, draft and slash actions after resize and reopen", async () => {
	const first = workspaceAgent("first");
	const second = workspaceAgent("second");
	const left = await first.mount();
	let right = await second.mount();
	try {
		expect(JSON.stringify(left.doc.shape("main"))).toContain("transcript for first");
		expect(JSON.stringify(right.doc.shape("main"))).not.toContain("transcript for first");
		left.type("ask first");
		right.type("keep this draft");
		right.resize(47);
		left.press("enter");
		await admit();
		expect(first.prompts).toEqual([
			{ text: "ask first", options: expect.objectContaining({ streamingBehavior: "steer", runCommands: false }) },
		]);
		expect(second.prompts).toEqual([]);
		expect(right.doc.nodes.get(right.doc.focus!)?.p.text).toBe("keep this draft");
		right.close();
		right = await second.mount();
		expect(right.doc.nodes.get(right.doc.focus!)?.p.text).toBe("keep this draft");
		right.press("enter");
		await admit();
		expect(second.prompts.map(prompt => prompt.text)).toEqual(["keep this draft"]);
		right.type("/queue 1. first queued\n2. second queued");
		right.press("enter");
		await admit();
		expect(second.prompts[1]).toEqual({
			text: "first queued",
			options: expect.objectContaining({ streamingBehavior: "followUp", followUps: ["second queued"] }),
		});
		left.type("/retry");
		left.press("enter");
		await admit();
		expect(first.retries).toBe(1);
		expect(second.retries).toBe(0);
		right.type("/compact soft keep evidence");
		right.press("enter");
		await admit();
		expect(second.compaction).toEqual({ instructions: "keep evidence", mode: "soft" });
		expect(first.compaction).toBeUndefined();
		right.type("/tree");
		right.press("enter");
		await admit();
		right.refresh();
		right.press("up");
		right.press("enter");
		await admit();
		right.refresh();
		expect(second.treeJump).toBe("previous");
		expect(first.treeJump).toBeUndefined();
		expect(right.doc.nodes.get(right.doc.focus!)?.p.text).toBe("restored second");
		left.type("/settings");
		left.press("enter");
		await admit();
		left.refresh();
		expect(left.doc.nodes.get(left.doc.focus!)?.p.text).toBe("/settings");
		expect(first.prompts.map(prompt => prompt.text)).toEqual(["ask first"]);
	} finally {
		left.close();
		right.close();
	}
});

test("an agent pane sends later queued input only after its deferred compaction completes", async () => {
	const agent = workspaceAgent("queued compact");
	const gate = Promise.withResolvers<void>();
	agent.holdCompaction(gate.promise);
	const pane = await agent.mount();
	try {
		pane.type("/queue /compact keep the conclusion");
		pane.press("enter");
		await agent.compactionStarted;
		expect(agent.compaction?.instructions).toBe("keep the conclusion");
		pane.type("the next request");
		pane.press("enter");
		await admit();
		expect(agent.prompts).toEqual([]);
		gate.resolve();
		await agent.prompted;
		expect(agent.prompts.map(prompt => prompt.text)).toEqual(["the next request"]);
	} finally {
		gate.resolve();
		pane.close();
	}
});

test("native queue Edit and dequeue restore pending agent input, while Ctrl+C restores the claimed steering", async () => {
	const agent = workspaceAgent("queue ownership");
	const idle = Promise.withResolvers<void>();
	agent.holdIdle(idle.promise);
	agent.claimed.push("claimed steering");
	agent.steering.push("first pending", "selected pending", "newest pending");
	agent.followUp.push("older follow-up");
	const pane = await agent.mount();
	try {
		pane.type("/queue /compact keep the evidence");
		pane.press("enter");
		await admit();
		pane.type("held for compaction");
		pane.press("ctrl+q");
		await admit();
		pane.refresh();
		const dockText = JSON.stringify(pane.doc.shape("dock"));
		for (const text of [
			"claimed steering",
			"first pending",
			"selected pending",
			"newest pending",
			"older follow-up",
			"/compact keep the evidence",
			"held for compaction",
		]) {
			expect(dockText).toContain(text);
		}

		pane.act("queue.edit", 1);
		expect(pane.doc.nodes.get(pane.doc.focus!)?.p.text).toBe("selected pending");
		expect(agent.steering).toEqual(["first pending", "newest pending"]);
		pane.press("alt+up");
		expect(pane.doc.nodes.get(pane.doc.focus!)?.p.text).toBe("newest pending\n\nselected pending");
		pane.press("alt+up");
		expect(agent.steering).toEqual([]);
		pane.press("alt+up");
		expect(pane.doc.nodes.get(pane.doc.focus!)?.p.text).toBe(
			"=> held for compaction\n\nfirst pending\n\nnewest pending\n\nselected pending",
		);
		pane.press("alt+up");
		expect(pane.doc.nodes.get(pane.doc.focus!)?.p.text).toBe(
			"/queue /compact keep the evidence\n\n=> held for compaction\n\nfirst pending\n\nnewest pending\n\nselected pending",
		);
		expect(agent.claimed).toEqual(["claimed steering"]);
		expect(agent.followUp).toEqual(["older follow-up"]);
		expect(agent.compaction).toBeUndefined();

		pane.press("ctrl+c");
		await admit();
		pane.refresh();
		expect(pane.doc.nodes.get(pane.doc.focus!)?.p.text).toStartWith("claimed steering\n\nolder follow-up");
		expect(JSON.stringify(pane.doc.shape("dock"))).not.toContain('"role":"omp.queue"');
	} finally {
		idle.resolve();
		pane.close();
	}
});

test("a queued chip selects the second of identical texts and rejects a stale identity", async () => {
	const agent = new Agent({ initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")! } });
	const auth = createInMemoryAuthStorage();
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({}),
		modelRegistry: new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true }),
	});
	const secondImage: ImageContent = {
		...PANE_PNG,
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=",
	};
	const first: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "same caption" }, PANE_PNG],
		timestamp: 1,
	};
	const second: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "same caption" }, secondImage],
		timestamp: 2,
	};
	const companion: AgentMessage = {
		role: "custom",
		attribution: "user",
		customType: "image-attachment",
		content: "second source",
		display: false,
		timestamp: 2,
	};
	try {
		agent.replaceQueue("followUp", [first, companion, second]);
		const [firstId, secondId] = session.getQueuedMessageEditIds().followUp;
		expect(session.getQueuedMessages().followUp).toEqual(["same caption", "same caption"]);
		expect(session.takeQueuedMessageAt("followUp", 1, "same caption", firstId)).toBeUndefined();
		expect(session.takeQueuedMessageAt("followUp", 1, "same caption", secondId)?.images).toEqual([secondImage]);
		expect(agent.peekFollowUpQueue()).toEqual([first]);
		expect(session.takeQueuedMessageAt("followUp", 0, "same caption", secondId)).toBeUndefined();
		expect(session.takeQueuedMessageAt("followUp", 0, "same caption", firstId)?.images).toEqual([PANE_PNG]);
	} finally {
		await session.dispose();
		auth.close();
	}
});

test("native agent pane routes Hub shortcuts", async () => {
	let hubOpens = 0;
	const agent = workspaceAgent("native keys", { showHub: () => hubOpens++ });
	const pane = await agent.mount();
	try {
		pane.press("alt+a");
		pane.press("ctrl+s");
		expect(hubOpens).toBe(2);
	} finally {
		pane.close();
	}
});

test("agent transcript controls copy and retry only that pane, beside its own model and extension status", async () => {
	const first = workspaceAgent("CopyAgent", { assistant: answer("partial agent answer", "fixture failure") });
	const second = workspaceAgent("OtherAgent");
	second.setStatus("hook", "other agent hook");
	const left = await first.mount();
	const right = await second.mount();
	try {
		left.act("copy-message");
		left.act("copy-answer");
		left.act("retry");
		await admit();
		expect(first.copied).toEqual(["transcript for CopyAgent", "partial agent answer"]);
		expect(first.retries).toBe(1);
		expect(second.copied).toEqual([]);
		expect(second.retries).toBe(0);
		expect(JSON.stringify(left.doc.shape("main"))).not.toContain("switch-model");

		first.setStatus("hook", "copy agent hook");
		left.refresh();
		const status = JSON.stringify(left.doc.shape("dock"));
		expect(status).toContain("model-CopyAgent");
		expect(status).toContain("high");
		expect(status).toContain("25.0%");
		expect(status).toContain("copy agent hook");
		expect(status).not.toContain("other agent hook");
	} finally {
		left.close();
		right.close();
	}
});

test("a live worktree and a parked journal resolve the same relative reply link from different roots", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-links-"));
	const liveCwd = path.join(dir, "live");
	const parkedCwd = path.join(dir, "parked");
	const parkedFile = path.join(dir, "history.jsonl");
	const report = answer("Here is [the report](notes.md#L3).");
	await Bun.write(path.join(liveCwd, "notes.md"), "live report");
	await Bun.write(path.join(liveCwd, "agent-pane-cwd-only.md"), "only in the live agent's cwd");
	await Bun.write(path.join(parkedCwd, "notes.md"), "parked report");
	await Bun.write(
		parkedFile,
		`${[
			{ type: "session", id: "parked", cwd: parkedCwd, timestamp: "2026-11-26T00:00:00Z" },
			{ type: "message", id: "reply", parentId: null, timestamp: "2026-11-26T00:00:01Z", message: report },
		]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	const live = await workspaceAgent("live", { cwd: liveCwd, assistant: report }).mount();
	const parked = await workspaceAgent("parked", { parkedFile }).mount();
	const livePath = `${pathToFileURL(path.join(liveCwd, "notes.md")).pathname}#L3`;
	const parkedPath = `${pathToFileURL(path.join(parkedCwd, "notes.md")).pathname}#L3`;
	const suggestion = (pane: typeof live, label: string) =>
		[...pane.doc.nodes.values()].some(node => {
			if (node.k !== "item") return false;
			const text = node.p.label as TspText | undefined;
			return (typeof text === "string" ? text : text?.map(span => span.t).join(""))?.includes(label);
		});
	try {
		await waitFor(() => {
			live.refresh();
			parked.refresh();
			return (
				JSON.stringify(live.doc.shape("main")).includes(livePath) &&
				JSON.stringify(parked.doc.shape("main")).includes(parkedPath)
			);
		}, "resolved reply links did not reach their own agent panes");
		expect(JSON.stringify(live.doc.shape("main"))).not.toContain(parkedPath);
		expect(JSON.stringify(parked.doc.shape("main"))).not.toContain(livePath);
		expect(JSON.stringify(parked.doc.shape("dock"))).toContain("no live session");

		parked.type("/tr");
		await waitFor(() => {
			parked.refresh();
			return suggestion(parked, "tree");
		}, "parked pane command completion did not offer /tree");
		parked.press("tab");
		expect(parked.doc.nodes.get(parked.doc.focus!)?.p.text).toBe("/tree ");

		live.type("@agent-pane-cwd");
		await waitFor(() => {
			live.refresh();
			return suggestion(live, "agent-pane-cwd-only.md");
		}, "pane file completion did not find the file in its own worktree");
		live.press("tab");
		expect(live.doc.nodes.get(live.doc.focus!)?.p.text).toContain("agent-pane-cwd-only.md");
	} finally {
		live.close();
		parked.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("idle automatic agent panes close unless pinned, being used or still focused", async () => {
	const clock = new ManualClock();
	const panes = new Map<string, { view: NativeWorkspaceView; close: () => void }>();
	const running = new Set<string>();
	const drafts = new Set<string>();
	let focused = "main";
	const policy = new NativeAgentPanes({
		clock,
		workspace: {
			async open(key, _title, create, close, preserveFocus) {
				let pane = panes.get(key);
				if (!pane) {
					const driver = new FakeTern();
					const surface = create(
						() => {
							panes.delete(key);
						},
						() => false,
						driver,
					);
					pane = { view: { ...surface, driver, dispatch() {}, redescribe() {} }, close };
					panes.set(key, pane);
				}
				if (!preserveFocus) focused = key;
				return pane.view;
			},
			get(key) {
				return panes.get(key)?.view;
			},
			async isFocused(key) {
				return key === focused;
			},
			close(key) {
				const pane = panes.get(key);
				if (!pane) return;
				panes.delete(key);
				pane.view.surface.dispose();
				pane.close();
			},
		},
		create(id) {
			return { surface: createSurface(() => ({})), protectedFromAutoClose: () => drafts.has(id) };
		},
		isRunning: id => running.has(id),
		error: error => {
			throw error;
		},
	});
	const status = (id: string, active: boolean) => {
		if (active) running.add(id);
		else running.delete(id);
		const ref = { id, kind: "sub", status: active ? "running" : "idle" } as AgentRef;
		policy.handle({ type: "status_changed", ref });
	};
	try {
		for (const id of ["quiet", "pinned", "draft", "focused"]) status(id, true);
		await admit();
		expect(focused).toBe("main");
		expect([...panes.keys()]).toEqual(["agent:quiet", "agent:pinned", "agent:draft", "agent:focused"]);
		await policy.open("pinned");
		expect(focused).toBe("agent:pinned");
		drafts.add("draft");
		focused = "agent:focused";
		for (const id of running) status(id, false);
		await admit();
		clock.advance(3000);
		await admit();
		expect([...panes.keys()]).toEqual(["agent:pinned", "agent:draft", "agent:focused"]);
	} finally {
		policy.reset();
	}
});

test("ANSI background panes gray while closing, and focusing one restores its live colors", async () => {
	const clock = new ManualClock();
	const surface = createSurface(() => ({}));
	const memory = memoryTerminal({ columns: 120, rows: 12, env: { PI_TUI_RENDER_BACKEND: "app-viewport" } });
	const theme = loadThemeSync("dark", { depth: "truecolor" });
	const host = await startHost({ surface, driver: memory.options, theme: () => theme, native: false });
	const workspace = host.ansiWorkspace!;
	const running = new Set<string>();
	const policy = new NativeAgentPanes({
		clock,
		workspace,
		create: id => ({
			surface: createSurface(() => ({ main: jsx("text", { text: `transcript for ${id}`, tone: "success" }) })),
			protectedFromAutoClose: () => false,
		}),
		isRunning: id => running.has(id),
		error: error => {
			throw error;
		},
	});
	const status = (id: string, active: boolean) => {
		if (active) running.add(id);
		else running.delete(id);
		const ref = { id, kind: "sub", status: active ? "running" : "idle" } as AgentRef;
		policy.handle({ type: "status_changed", ref });
	};
	const nextFrame = (change: () => void) => {
		const { promise, resolve } = Promise.withResolvers<PresentedFrame>();
		const off = host.onFrame(frame => {
			off();
			resolve(frame);
		});
		change();
		return promise;
	};
	const transcriptRow = (frame: PresentedFrame) => {
		const label = "transcript for used";
		for (const row of frame.viewport) {
			const text = Bun.stripANSI(row);
			const at = text.indexOf(label);
			if (at === -1) continue;
			const start = Bun.stringWidth(text.slice(0, at));
			return sliceColumns(row, start, start + label.length);
		}
		return "";
	};
	const foreground = (row: string) => {
		const style = new SgrState();
		for (const token of tokens(row)) {
			if (!token.escape) break;
			style.feed(token.text);
		}
		return style.foreground;
	};
	try {
		const active = await nextFrame(() => {
			status("used", true);
			status("unattended", true);
			status("replacement", true);
		});
		expect(Bun.stripANSI(active.viewport.join("\n"))).not.toContain("transcript for replacement");
		const original = transcriptRow(active);
		expect(Bun.stripANSI(original)).toContain("transcript for used");
		const fading = await nextFrame(() => {
			status("used", false);
			status("unattended", false);
			clock.advance(1800);
		});
		expect(Bun.stripANSI(transcriptRow(fading))).toBe(Bun.stripANSI(original));
		expect(foreground(transcriptRow(fading))).not.toEqual(foreground(original));
		const focused = await nextFrame(() => {
			expect(workspace.focus("agent:used")).toBe(true);
			clock.advance(100);
		});
		expect(foreground(transcriptRow(focused))).toEqual(foreground(original));
		const remaining = await nextFrame(() => clock.advance(3100));
		expect(Bun.stripANSI(remaining.viewport.join("\n"))).toContain("transcript for used");
		expect(Bun.stripANSI(remaining.viewport.join("\n"))).not.toContain("transcript for unattended");
		expect(Bun.stripANSI(remaining.viewport.join("\n"))).toContain("transcript for replacement");
		expect(workspace.active()).toBe("agent:used");
	} finally {
		policy.reset();
		await host.stop();
		surface.dispose();
	}
});

test.each([
	["resize", ["first", "second"]],
	["redock", ["first"]],
] as const)("ANSI %s keeps only the automatic panes the user actually operated", async (action, keep) => {
	const clock = new ManualClock();
	const surface = createSurface(() => ({}));
	const memory = memoryTerminal({ columns: 200, rows: 25, env: { PI_TUI_RENDER_BACKEND: "app-viewport" } });
	const theme = loadThemeSync("dark", { depth: "truecolor" });
	const host = await startHost({ surface, driver: memory.options, theme: () => theme, native: false });
	const workspace = host.ansiWorkspace!;
	const ids = action === "resize" ? (["first", "second"] as const) : (["first", "second", "third"] as const);
	const running = new Set<string>(ids);
	const policy = new NativeAgentPanes({
		clock,
		workspace,
		create: id => ({
			surface: createSurface(() => ({ main: jsx("text", { text: `body for ${id}` }) })),
			protectedFromAutoClose: () => false,
		}),
		isRunning: id => running.has(id),
		error: error => {
			throw error;
		},
	});
	const status = (id: string, state: "running" | "idle") =>
		policy.handle({ type: "status_changed", ref: { id, kind: "sub", status: state } as AgentRef });
	const nextFrame = (change: () => void) => {
		const { promise, resolve } = Promise.withResolvers<PresentedFrame>();
		const off = host.onFrame(frame => {
			off();
			resolve(frame);
		});
		change();
		return promise;
	};
	try {
		const visible = await nextFrame(() => {
			for (const id of ids) status(id, "running");
		});
		for (const id of ids) expect(Bun.stripANSI(visible.viewport.join("\n"))).toContain(`body for ${id}`);
		const rows = visible.viewport.map(row => Bun.stripANSI(row));
		await nextFrame(() => {
			const drag = (x: number, y: number, toX: number, toY: number) =>
				memory.feed(`\x1b[<0;${x};${y}M\x1b[<32;${toX};${toY}M\x1b[<0;${toX};${toY}m`);
			const header = rows[0]!;
			if (action === "resize") {
				const sash = header.lastIndexOf("│") + 1;
				const row = Math.floor(rows.length / 2);
				drag(sash, row, sash - 3, row);
			} else {
				const source = header.indexOf("first") + 1;
				const target = Math.floor(header.indexOf("│") / 2);
				drag(source, 1, target, rows.length);
			}
		});
		expect(workspace.focus("main")).toBe(true);
		running.clear();
		for (const id of ids) status(id, "idle");
		clock.advance(3100);
		expect(ids.filter(id => workspace.focus(`agent:${id}`))).toEqual([...keep]);
	} finally {
		policy.reset();
		await host.stop();
		surface.dispose();
	}
});
