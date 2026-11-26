import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createSurface, jsx, type PresentedFrame, startHost } from "@oh-my-pi/pi-tui";
import { NativeSurfaces, TspConnection } from "@oh-my-pi/pi-tui/native/index";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { SgrState, tokens } from "@oh-my-pi/pi-tui/text/ansi";
import { sliceColumns } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { FakeTern, ManualClock } from "../../tui/test/native/fake-tern";
import { Settings } from "../src/config/settings";
import { AgentPaneDraft, type AgentWorkspaceSurface, mountAgentWorkspacePane } from "../src/modes/agent-workspace-pane";
import { NativeAgentPanes } from "../src/modes/controllers/native-agent-panes";
import type { NativeWorkspaceView } from "../src/modes/native-workspace/workspace";
import { type AgentRef, AgentRegistry } from "../src/registry/agent-registry";
import type { AgentViewSession } from "../src/session/agent-session-handle";
import type { PromptOptions } from "../src/session/agent-session-types";
import type { SessionTreeNode } from "../src/session/session-entries";

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

function workspaceAgent(id: string) {
	const draft = new AgentPaneDraft();
	const prompts: { text: string; options?: PromptOptions }[] = [];
	const messages: AgentMessage[] = [{ role: "user", content: `transcript for ${id}`, timestamp: 0 }];
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
		messages,
		agent: { state: { streamMessage: null, pendingToolCalls: new Set<string>() }, getPendingToolResults: () => [] },
		sessionManager: {
			getSessionId: () => id,
			getLeafId: () => "leaf",
			getTree: () => roots,
			getBranch: () => roots[0]!.children.map(node => node.entry),
		},
		hasPausedAgents: () => false,
		queuedMessageCount: 0,
		subscribe: () => () => {},
		waitForIdle: async () => {},
		waitForAdmittedSubmissions: async () => {},
		waitForRunEnd: async () => {},
		buildTranscriptSessionContext: () => ({ messages }),
		activeToolExecutionUpdates: () => [],
		async prompt(text: string, options?: PromptOptions) {
			prompts.push({ text, options });
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
	registry.register({ id, displayName: id, kind: "sub", status: "running", session });
	return {
		prompts,
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
					registry,
					lifecycle: {
						async ensureLive(key) {
							if (key !== id) throw new Error(`Pane changed target to ${key}`);
							return session;
						},
					},
					settings: Settings.isolated({}),
					draft,
					isCurrent: () => true,
					knownCommand: text => text.startsWith("/settings"),
				}),
			);
		},
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
					const surface = create(
						() => {
							panes.delete(key);
						},
						() => false,
					);
					pane = { view: { ...surface, driver: new FakeTern(), dispatch() {}, redescribe() {} }, close };
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
	const memory = memoryTerminal({ columns: 120, rows: 20, env: { PI_TUI_RENDER_BACKEND: "app-viewport" } });
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
		});
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
	} finally {
		policy.reset();
		await host.stop();
		surface.dispose();
	}
});
