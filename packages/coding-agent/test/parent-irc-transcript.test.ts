import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBridge } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ChatTranscriptPane } from "@oh-my-pi/pi-tui/chat/chat-transcript-pane";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { prompt, TempDir } from "@oh-my-pi/pi-utils";
import { TspHarness } from "../../tui/test/native/tsp-harness";
import parentIrcTemplate from "../src/prompts/steering/parent-irc.md" with { type: "text" };

let harness: TspHarness | undefined;
let pane: ChatTranscriptPane | undefined;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	pane?.dispose();
	pane = undefined;
	harness?.stop();
	harness = undefined;
});

async function startPane(): Promise<TspHarness> {
	harness = await TspHarness.start(undefined, { nativeSurfaceMode: "screen" });
	const h = harness;
	pane = new ChatTranscriptPane({
		builder: { ui: h.tui, cwd: import.meta.dir, requestRender: () => h.tui.requestRender() },
		expandKeys: ["ctrl+o"],
		getPlaceholder: () => "Waiting for transcript",
		onClose: () => {},
	});
	h.tui.addChild(pane);
	return h;
}

function expectIrcBody(h: TspHarness, body: string): void {
	expect(h.find(node => node.p?.role === "omp.irc.incoming")?.k).toBe("card");
	expect(h.findAll(node => node.k === "md").map(node => (node.k === "md" ? node.p?.text : undefined))).toEqual([body]);
	expect(h.find(node => node.p?.role === "omp.user")).toBeUndefined();
	expect(h.findAll(node => node.k === "rows")).toEqual([]);
	expect(h.errors).toEqual([]);
}

describe("parent IRC in agent transcript panes", () => {
	it("shows a delivered parent steer as IRC on live append and after reopening the journal", async () => {
		using temp = TempDir.createSync("@omp-parent-irc-pane-");
		const manager = SessionManager.create(temp.path(), temp.path(), undefined, { suppressBreadcrumb: true });
		const agent = new Agent();
		const registry = AgentRegistry.global();
		const child = registry.register({
			id: "ParentIrcPaneChild",
			displayName: "ParentIrcPaneChild",
			kind: "sub",
			parentId: "Main",
			session: null,
		});
		const body = "**Inspect only**\n\nKeep `<irc>` in this code sample.";
		const bridge = new IrcBridge({
			agent,
			sessionManager: manager,
			isDisposed: () => false,
			isStreaming: () => true,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: () => {
				throw new Error("A streaming parent message must steer, not start a wake turn");
			},
		});
		try {
			await bridge.deliver({ id: "parent-note", from: "Main", to: child.id, body, ts: 1, replyTo: "child-note" });
			const message = agent.popLastSteer();
			if (message?.role !== "user") throw new Error("Expected a parent steering message");
			expect(message.attribution).toBe("agent");
			expect(message.steering).toBe(true);
			const modelContent = prompt.render(parentIrcTemplate, {
				from: "Main",
				message: "**Inspect only**\n\nKeep `&lt;irc>` in this code sample.",
			});
			manager.appendMessage(message);
			await manager.ensureOnDisk();
			await manager.flush();
			const h = await startPane();
			pane!.appendEntries(manager.getEntries().filter(entry => entry.type === "message"));
			await h.render();
			expectIrcBody(h, body);
			expect(JSON.stringify(h.find(node => node.p?.role === "omp.irc.incoming")?.p)).toContain("Main");
			expect(message.content).toBe(modelContent);

			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected a persisted journal");
			await manager.close();
			const reopened = await SessionManager.open(file, temp.path());
			try {
				pane!.rebuildEntries(reopened.getEntries().filter(entry => entry.type === "message"));
				await h.render();
				expectIrcBody(h, body);
			} finally {
				await reopened.close();
			}
		} finally {
			registry.unregister(child.id);
			await manager.close();
		}
	});

	it("renders parent steering envelopes from existing journals as IRC", async () => {
		const body = "Use the existing verification path.";
		const content = prompt.render(parentIrcTemplate, { from: "Main", message: body });
		const h = await startPane();
		pane!.rebuild([{ role: "user", content, attribution: "agent", steering: true, timestamp: 1 }]);
		await h.render();
		expectIrcBody(h, body);
	});

	it("keeps a user-authored copy of the parent IRC envelope as an ordinary user message", async () => {
		const content = prompt.render(parentIrcTemplate, { from: "Main", message: "This is pasted text, not IRC." });
		const h = await startPane();
		pane!.rebuild([{ role: "user", content, attribution: "user", steering: true, timestamp: 1 }]);
		await h.render();
		expect(h.find(node => node.p?.role === "omp.irc.incoming")).toBeUndefined();
		expect(h.find(node => node.p?.role === "omp.user")?.k).toBe("card");
		expect(h.find(node => node.k === "md" && node.p?.text === content)?.k).toBe("md");
	});
});
