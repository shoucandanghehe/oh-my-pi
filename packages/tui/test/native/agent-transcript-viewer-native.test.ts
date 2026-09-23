import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ChatTranscriptPane } from "@oh-my-pi/pi-tui/chat/chat-transcript-pane";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import type { AgentHubRemoteTranscript } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentHubSession, AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import {
	AgentTranscriptViewer,
	type AgentTranscriptViewerDeps,
} from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
let component: AgentTranscriptViewer | ChatTranscriptPane | undefined;
afterEach(() => {
	component?.dispose();
	component = undefined;
	harness?.stop();
	harness = undefined;
	setNativeRendering(false);
});

function textValue(node: TspNode | undefined): string | undefined {
	if (node?.k === "md" || node?.k === "editor" || node?.k === "text") return node.p?.text;
	return undefined;
}

function agent(session: AgentHubSession | null = null): AgentRecordLike {
	return {
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		parentId: "Main",
		status: "running",
		session,
		sessionFile: null,
		createdAt: 0,
		lastActivity: 0,
	};
}

function viewer(
	h: TspHarness,
	ref: AgentRecordLike,
	deps: Partial<AgentTranscriptViewerDeps> = {},
): AgentTranscriptViewer {
	const result = new AgentTranscriptViewer({
		agentId: ref.id,
		transcript: { fs, parseEntries: () => [], visitEntries: async () => {} },
		registry: { get: () => ref, list: () => [ref], onChange: () => () => {} },
		ui: h.tui,
		cwd: "/tmp",
		expandKeys: ["ctrl+o"],
		hubKeys: [],
		createStatusLine: () => undefined,
		requestRender: () => h.tui.requestRender(),
		onClose: () => {},
		onHubToggle: () => {},
		...deps,
	});
	component = result;
	h.tui.addChild(result);
	h.tui.setFocus(result);
	return result;
}

describe("native shared transcript viewer", () => {
	it("updates session usage and lifecycle metadata without retaining stats after the session detaches", async () => {
		let tokens = 25;
		let cost = 1.25;
		const ref = agent({
			model: undefined,
			thinkingLevel: undefined,
			getSessionStats: () => ({
				tokens: { input: 5, output: 2, cacheWrite: 0 },
				assistantMessages: 1,
				toolCalls: 3,
				cost,
				contextUsage: { tokens, contextWindow: 100 },
			}),
			abort: async () => {},
		});
		harness = await TspHarness.start();
		const h = harness;
		viewer(h, ref);
		await h.render();
		expect(h.find(node => node.k === "progress")?.p).toMatchObject({ value: 0.25 });
		expect(h.find(node => node.k === "badge")?.p).toMatchObject({ text: "running", tone: "success" });
		expect(JSON.stringify(h.doc())).toContain("$1.25");

		tokens = 50;
		cost = 2.5;
		ref.status = "idle";
		await h.render();
		expect(h.find(node => node.k === "progress")?.p).toMatchObject({ value: 0.5 });
		expect(h.find(node => node.k === "badge")?.p).toMatchObject({ text: "idle", tone: "accent" });
		expect(JSON.stringify(h.doc())).toContain("$2.50");
		expect(JSON.stringify(h.doc())).not.toContain("$1.25");

		ref.session = null;
		ref.status = "parked";
		await h.render();
		expect(h.find(node => node.k === "progress")).toBeUndefined();
		expect(JSON.stringify(h.doc())).not.toContain("$2.50");
		expect(h.find(node => node.k === "badge")?.p).toMatchObject({ text: "parked", tone: "muted" });
		expect(h.errors).toEqual([]);
	});

	it("submits the described image draft through the viewer and replaces cleared input with its send error", async () => {
		harness = await TspHarness.start();
		const h = harness;
		const sent: { text: string; images?: ImageContent[]; streamingBehavior: string }[] = [];
		const send = Promise.withResolvers<void>();
		const v = viewer(h, agent(), {
			lifecycle: () => ({
				ensureLive: async () => ({
					prompt: (text, options) => {
						sent.push({ text, ...options });
						return send.promise;
					},
				}),
			}),
		});
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		v.getPasteTarget()!.setDraft("Inspect [Image #1]", [image]);
		await h.render();
		expect(textValue(h.find(node => node.k === "editor"))).toContain("Inspect");
		v.handleInput("\r");
		await h.render();
		expect(sent).toEqual([{ text: "Inspect [Image #1]", images: [image], streamingBehavior: "steer" }]);
		expect(textValue(h.find(node => node.k === "editor"))).toBe("");

		send.reject(new Error("Send\tfailed\nretry"));
		await send.promise.catch(() => {});
		await h.render();
		const error = h.find(node => node.k === "text" && node.p?.tone === "error");
		expect(textValue(error)).toMatch(/Send +failed retry/);
		expect(h.errors).toEqual([]);
	});

	it("replaces a cached remote loading placeholder with a sanitized host error", async () => {
		harness = await TspHarness.start();
		const h = harness;
		const read = Promise.withResolvers<AgentHubRemoteTranscript>();
		viewer(h, agent(), {
			remote: {
				chat() {},
				kill() {},
				revive() {},
				readTranscript: () => read.promise,
			},
		});
		await h.render();
		expect(JSON.stringify(h.doc())).toContain("Loading transcript from host");
		read.resolve({ text: "", newSize: 0, error: "Host\tread\nfailed" });
		await read.promise;
		await h.render();
		expect(JSON.stringify(h.doc())).toContain("Host read failed");
		expect(JSON.stringify(h.doc())).not.toContain("Loading transcript from host");
		expect(h.errors).toEqual([]);
	});

	it("does not advertise or mount an editable native composer for a read-only advisor", async () => {
		harness = await TspHarness.start();
		const h = harness;
		const ref = agent();
		ref.kind = "advisor";
		const v = viewer(h, ref);
		await h.render();
		v.handleInput("cannot send");
		v.handleInput("\r");
		await h.render();
		expect(h.find(node => node.k === "editor")).toBeUndefined();
		expect(JSON.stringify(h.doc())).toContain("read-only · advisor");
		expect(JSON.stringify(h.find(node => node.p?.role === "omp.overlay.hints"))).not.toContain('"send"');
		expect(h.errors).toEqual([]);
	});

	it("replaces placeholders, appends transcript blocks and switches draft owners while preserving widgets", async () => {
		harness = await TspHarness.start();
		const h = harness;
		const above = new Text("Before draft");
		const below = new Text("After draft");
		const pane = new ChatTranscriptPane({
			builder: { ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() },
			editor: { label: "Message", placeholder: "Message…", onSubmit: () => true },
			aboveEditor: above,
			belowEditor: below,
			expandKeys: ["ctrl+o"],
			getPlaceholder: () => "Waiting for transcript",
			onClose: () => {},
		});
		component = pane;
		h.tui.addChild(pane);
		h.tui.setFocus(pane);
		await h.render();
		expect(JSON.stringify(h.doc())).toContain("Waiting for transcript");
		pane.rebuild([{ role: "user", content: "Initial message", timestamp: 1 }]);
		pane.setEditorText("First draft");
		await h.render();
		expect(JSON.stringify(h.doc())).not.toContain("Waiting for transcript");
		expect(textValue(h.find(node => node.k === "md"))).toBe("Initial message");
		expect(textValue(h.find(node => node.k === "editor"))).toBe("First draft");

		pane.append([{ role: "user", content: "Appended message", timestamp: 2 }]);
		pane.selectEditor("second", "Second draft");
		above.setText("Updated widget");
		await h.render();
		expect(h.findAll(node => node.k === "md").map(textValue)).toEqual(["Initial message", "Appended message"]);
		expect(textValue(h.find(node => node.k === "editor"))).toBe("Second draft");
		expect(JSON.stringify(h.doc())).toContain("Updated widget");
		expect(JSON.stringify(h.doc())).toContain("After draft");
		pane.selectEditor(undefined, "ignored replacement");
		await h.render();
		expect(textValue(h.find(node => node.k === "editor"))).toBe("First draft");
		expect(h.errors).toEqual([]);
	});

	it("expands synthetic transcript bodies without depending on a VT viewport render", async () => {
		harness = await TspHarness.start();
		const h = harness;
		const pane = new ChatTranscriptPane({
			builder: { ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() },
			expandKeys: ["ctrl+o"],
			getPlaceholder: () => "Waiting",
			onClose: () => {},
		});
		component = pane;
		pane.rebuild([{ role: "user", synthetic: true, content: "Replay body", timestamp: 1 }]);
		h.tui.addChild(pane);
		await h.render();
		expect(h.find(node => node.k === "md")).toBeUndefined();
		pane.handleInput("\x0f");
		await h.render();
		expect(textValue(h.find(node => node.k === "md"))).toBe("Replay body");
		pane.handleInput("\x0f");
		await h.render();
		expect(h.find(node => node.k === "md")).toBeUndefined();
		expect(h.errors).toEqual([]);
	});
});
