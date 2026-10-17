import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { ChatTranscriptPane } from "@oh-my-pi/pi-tui/chat/chat-transcript-pane";
import type { ExtensionPresentationSource } from "@oh-my-pi/pi-tui/chat/extension-types";
import { setTranscriptActions } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
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
	setTranscriptActions(undefined);
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
	overlay = false,
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
	if (overlay) h.tui.showOverlay(result, { width: "100%", margin: 0, fullscreen: true });
	else h.tui.addChild(result);
	h.tui.setFocus(result);
	return result;
}

describe("native shared transcript viewer", () => {
	it("keeps detached transcript commands out of Main and hides unsupported controls", async () => {
		const main: string[] = [];
		const child: string[] = [];
		setTranscriptActions({
			copy: text => {
				main.push(text);
			},
			retry: () => {
				main.push("retry");
			},
			switchModel: () => {
				main.push("switch-model");
			},
			rewind: () => {
				main.push("rewind");
			},
		});
		const failed: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: "503 Worker unavailable",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		harness = await TspHarness.start();
		const h = harness;
		const pane = new ChatTranscriptPane({
			builder: {
				ui: h.tui,
				cwd: process.cwd(),
				requestRender: () => h.tui.requestRender(),
				transcriptActions: {
					copy: text => {
						child.push(text);
					},
					retry: () => {
						child.push("retry");
					},
				},
			},
			expandKeys: [],
			getPlaceholder: () => "",
			onClose() {},
		});
		component = pane;
		pane.rebuild([{ role: "user", content: [{ type: "text", text: "Worker prompt" }], timestamp: 1 }, failed]);
		h.tui.addChild(pane);
		await h.render();
		const copy = h.find(node => node.p?.actions?.click === "copy-message")!;
		h.event({ ev: "action", sf: h.terminal.surface!, id: copy.id, act: "copy-message" });
		const retry = h.find(node => node.p?.actions?.click === "retry")!;
		h.event({ ev: "action", sf: h.terminal.surface!, id: retry.id, act: "retry" });
		expect(h.find(node => node.p?.actions?.click === "rewind")).toBeUndefined();
		expect(h.find(node => node.p?.actions?.click === "switch-model")).toBeUndefined();
		h.event({ ev: "action", sf: h.terminal.surface!, id: copy.id, act: "rewind" });
		h.event({ ev: "action", sf: h.terminal.surface!, id: retry.id, act: "switch-model" });
		expect(child).toEqual(["Worker prompt", "retry"]);
		expect(main).toEqual([]);

		h.tui.addChild(new UserMessageComponent("Main prompt"));
		h.tui.addChild(new AssistantMessageComponent(failed));
		await h.render();
		const rewind = h.find(node => node.p?.actions?.click === "rewind")!;
		const switchModel = h.find(node => node.p?.actions?.click === "switch-model")!;
		h.event({ ev: "action", sf: h.terminal.surface!, id: rewind.id, act: "rewind" });
		h.event({ ev: "action", sf: h.terminal.surface!, id: switchModel.id, act: "switch-model" });
		expect(main).toEqual(["rewind", "switch-model"]);
		expect(child).toEqual(["Worker prompt", "retry"]);

		h.tui.removeChild(pane);
		pane.dispose();
		let retryFails = false;
		viewer(
			h,
			agent({
				model: undefined,
				thinkingLevel: undefined,
				agent: { state: { messages: [], streamMessage: failed } },
				getSessionStats: () => ({
					tokens: { input: 0, output: 0, cacheWrite: 0 },
					assistantMessages: 1,
					toolCalls: 0,
					cost: 0,
				}),
				abort: async () => {},
			}),
			{
				lifecycle: () => ({ ensureLive: async () => ({ prompt: async () => {} }) }),
				transcriptActions: {
					retry: async () => {
						if (retryFails) throw new Error("Worker retry failed");
						child.push("viewer-retry");
					},
				},
			},
		);
		await h.render();
		const viewerRetry = h.findAll(node => node.p?.actions?.click === "retry").at(-1)!;
		h.event({ ev: "action", sf: h.terminal.surface!, id: viewerRetry.id, act: "retry" });
		await h.until(() => child.length === 3);
		h.terminal.send("\x1b[15~");
		await h.until(() => child.length === 4);
		expect(child.slice(2)).toEqual(["viewer-retry", "viewer-retry"]);
		retryFails = true;
		h.event({ ev: "action", sf: h.terminal.surface!, id: viewerRetry.id, act: "retry" });
		await h.until(() => JSON.stringify(h.doc()).includes("Worker retry failed"));
		expect(main).toEqual(["rewind", "switch-model"]);
		expect(h.errors).toEqual([]);
	});

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
		let closed = false;
		viewer(
			h,
			ref,
			{
				onClose: () => {
					closed = true;
				},
			},
			true,
		);
		await h.render();
		expect(h.find(node => node.k === "progress")?.p).toMatchObject({ value: 0.25 });
		expect(h.find(node => node.k === "badge")?.p).toMatchObject({ text: "running", tone: "success" });
		expect(JSON.stringify(h.doc())).toContain("$1.25");
		expect(h.find(node => node.p?.role === "omp.hub.transcript")).toBeDefined();

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
		const close = h.find(node => node.p?.actions?.click === "close")!;
		h.event({ ev: "action", sf: h.terminal.surface!, id: close.id, act: "close" });
		expect(closed).toBe(true);
	});

	it("restores a rejected image submission beside newer typing and preserves both drafts' attachment links", async () => {
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
		const editor = v.getPasteTarget()!;
		editor.setDraft("Inspect [Image #1]", [image]);
		editor.pendingImageLinks = ["file:///failed.png"];
		editor.imageLinks = editor.pendingImageLinks;
		await h.render();
		expect(textValue(h.find(node => node.k === "editor"))).toContain("Inspect");
		h.terminal.send("\r");
		await h.until(() => sent.length === 1);
		expect(sent).toEqual([{ text: "Inspect [Image #1]", images: [image], streamingBehavior: "steer" }]);
		expect(textValue(h.find(node => node.k === "editor"))).toBe("");
		const newerImage: ImageContent = { type: "image", data: "bmV3ZXI=", mimeType: "image/png" };
		editor.setDraft("New draft [Image #1]", [newerImage]);
		editor.pendingImageLinks = ["file:///newer.png"];
		editor.imageLinks = editor.pendingImageLinks;

		send.reject(new Error("Send\tfailed\nretry"));
		await send.promise.catch(() => {});
		await h.render();
		expect(editor.getExpandedText()).toBe("Inspect [Image #2]\n\nNew draft [Image #1]");
		expect(editor.pendingImages).toEqual([newerImage, image]);
		expect(editor.pendingImageLinks).toEqual(["file:///newer.png", "file:///failed.png"]);
		expect(editor.imageLinks).toEqual(editor.pendingImageLinks);
		h.terminal.send("!");
		await h.render();
		expect(editor.getExpandedText()).toContain("!");
		const error = h.find(node => node.k === "text" && node.p?.tone === "error");
		expect(textValue(error)).toMatch(/Send +failed retry/);
		expect(h.errors).toEqual([]);
	});

	it("restores a parked agent's image draft when synchronous revival fails", async () => {
		harness = await TspHarness.start();
		const h = harness;
		const ref = agent();
		ref.status = "parked";
		const v = viewer(h, ref, {
			lifecycle: () => ({
				ensureLive: () => {
					throw new Error("Revival failed");
				},
			}),
		});
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const editor = v.getPasteTarget()!;
		editor.setDraft("Retry [Image #1]", [image]);
		await h.render();
		h.terminal.send("\r");
		await h.until(() => editor.getExpandedText() === "Retry [Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		expect(textValue(h.find(node => node.k === "text" && node.p?.tone === "error"))).toBe("Revival failed");
		expect(h.errors).toEqual([]);
	});

	it("keeps native focus, Escape and automatic-close protection with the independent composer owner", async () => {
		harness = await TspHarness.start();
		const h = harness;
		let closed = 0;
		const v = viewer(h, agent(), {
			onClose: () => closed++,
			lifecycle: () => ({ ensureLive: async () => ({ prompt: async () => {} }) }),
		});
		v.focused = false;
		await h.render();
		const editor = h.find(node => node.k === "editor")!;
		h.event({ ev: "focus", sf: h.terminal.surface!, id: editor.id });
		await h.render();
		expect(v.autoCloseProtected).toBe(true);
		h.terminal.send("focused draft");
		await h.render();
		expect(textValue(h.find(node => node.k === "editor"))).toBe("focused draft");
		h.terminal.send("\x1b");
		await h.render();
		expect(textValue(h.find(node => node.k === "editor"))).toBe("");
		expect(closed).toBe(0);
		h.terminal.send("\x1b");
		await h.render();
		expect(closed).toBe(1);
		expect(h.errors).toEqual([]);
	});

	it("keeps the independent root transcript flowing and session widgets, draft and status in the dock", async () => {
		harness = await TspHarness.start();
		const h = harness;
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Worker response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const ref = agent({
			thinkingLevel: undefined,
			model: undefined,
			agent: { state: { messages: [], streamMessage: response } },
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheWrite: 0 },
				assistantMessages: 0,
				toolCalls: 2,
				cost: 1.25,
			}),
			abort: async () => {},
		});
		const presentation: ExtensionPresentationSource = {
			observePresentation(observer) {
				observer.setWidget("above", ["Worker above"], { placement: "aboveEditor" });
				observer.setWidget("below", ["Worker below"], { placement: "belowEditor" });
				return () => {};
			},
		};
		viewer(h, ref, {
			lifecycle: () => ({ ensureLive: async () => ({ prompt: async () => {} }) }),
			createStatusLine: () => ({
				getTopBorder: () => ({ content: "Worker status", width: 13, revision: 0 }),
				render: () => ["Worker owned status"],
				dispose: () => {},
			}),
			getExtensionPresentation: () => presentation,
		})
			.getPasteTarget()!
			.setText("Worker draft");
		await h.render();
		expect(JSON.stringify(h.region("main"))).toContain("Worker response");
		expect(JSON.stringify(h.region("dock"))).not.toContain("Worker response");
		expect(JSON.stringify(h.region("main"))).not.toContain("Worker draft");
		expect(JSON.stringify(h.region("dock"))).toContain("Worker draft");
		expect(JSON.stringify(h.region("dock"))).toContain("Worker above");
		expect(JSON.stringify(h.region("dock"))).toContain("Worker below");
		expect(JSON.stringify(h.region("dock"))).toContain("Worker owned status");
		expect(h.find(node => node.p?.role === "omp.hub.transcript")).toBeUndefined();
		expect(h.find(node => node.p?.role === "omp.overlay.hints")).toBeUndefined();
		expect(h.find(node => node.k === "progress")).toBeUndefined();
		expect(JSON.stringify(h.doc())).not.toContain("$1.25");
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
		expect(JSON.stringify(h.region("dock"))).toContain("read-only · advisor");
		expect(JSON.stringify(h.region("main"))).not.toContain("read-only · advisor");
		expect(h.errors).toEqual([]);
	});

	it("keeps transcript blocks independently virtualizable while switching drafts and scrolling the main region", async () => {
		harness = await TspHarness.start(undefined, { features: ["scroll"], nativeSurfaceMode: "screen" });
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
		expect(h.frames.at(-1)?.ops).toContainEqual(["scroll", "main", "end"]);
		pane.rebuild([{ role: "user", content: "Initial message", timestamp: 1 }]);
		pane.setEditorText("First draft");
		await h.render();
		expect(JSON.stringify(h.doc())).not.toContain("Waiting for transcript");
		expect(textValue(h.find(node => node.k === "md"))).toBe("Initial message");
		expect(textValue(h.find(node => node.k === "editor"))).toBe("First draft");
		const firstBlock = h.region("main")?.c?.find(node => node.p?.role === "omp.user");
		expect(firstBlock?.k).toBe("card");

		pane.append([{ role: "user", content: "Appended message", timestamp: 2 }]);
		pane.selectEditor("second", "Second draft");
		above.setText("Updated widget");
		await h.render();
		expect(h.findAll(node => node.k === "md").map(textValue)).toEqual(["Initial message", "Appended message"]);
		expect(textValue(h.find(node => node.k === "editor"))).toBe("Second draft");
		const blocks = h.region("main")?.c?.filter(node => node.p?.role === "omp.user") ?? [];
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.id).toBe(firstBlock!.id);
		expect(JSON.stringify(h.doc())).toContain("Updated widget");
		expect(JSON.stringify(h.doc())).toContain("After draft");
		pane.selectEditor(undefined, "ignored replacement");
		await h.render();
		expect(textValue(h.find(node => node.k === "editor"))).toBe("First draft");
		pane.setEditorText("");
		h.terminal.send("\x1b[5~");
		await h.render();
		expect(h.frames.at(-1)?.ops).toContainEqual(["scroll", "main", "page-up"]);
		h.terminal.send("\x1b[1;2A");
		await h.render();
		expect(h.frames.at(-1)?.ops.filter(op => op[0] === "scroll")).toEqual(
			Array.from({ length: 5 }, () => ["scroll", "main", "line-up"]),
		);
		pane.setEditorText("Updated draft");
		await h.render();
		expect(h.frames.at(-1)?.ops.some(op => op[0] === "scroll")).toBe(false);
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
