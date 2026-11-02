import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptPane, type ChatTranscriptPaneEditorOptions } from "@oh-my-pi/pi-tui/chat/chat-transcript-pane";
import type { ChatTranscriptBuilderDeps } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import type { AssistantTextRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { PaneToolUpdate } from "@oh-my-pi/pi-tui/chat/session-controls";
import type { XdevMountedRenderer, XdevMountedState } from "@oh-my-pi/pi-tui/tools/xdev";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme/theme";
import {
	type Component,
	ProcessTerminal,
	type SgrMouseEvent,
	setTerminalHyperlinks,
	TERMINAL,
	Text,
	TUI,
} from "@oh-my-pi/pi-tui";
import { createAssistantMessage } from "./helpers/agent-session-setup";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

class CountingRows implements Component {
	renders = 0;

	constructor(private readonly text: string) {}

	render(): readonly string[] {
		this.renders++;
		return [this.text];
	}

	measureRows(): number {
		return 1;
	}
}

function mouse(overrides: Partial<SgrMouseEvent>): SgrMouseEvent {
	return {
		button: 0,
		col: 0,
		row: 0,
		release: false,
		wheel: null,
		motion: false,
		leftClick: false,
		rightClick: false,
		...overrides,
	};
}

function createPane(
	editor: ChatTranscriptPaneEditorOptions,
	builder: Partial<ChatTranscriptBuilderDeps> = {},
): ChatTranscriptPane {
	const pane = new ChatTranscriptPane({
		builder: {
			ui: new TUI(new ProcessTerminal()),
			cwd: process.cwd(),
			requestRender: () => {},
			...builder,
		},
		editor,
		expandKeys: ["ctrl+o"],
		getEditorTopBorder: () => ({ content: theme.bg("statusLineBg", " STATUS "), width: 8 }),
		getPlaceholder: () => "No messages yet.",
		onClose: () => {},
	});
	pane.setViewportHeight(8);
	pane.focused = true;
	return pane;
}

function renderedText(pane: ChatTranscriptPane): string {
	return Bun.stripANSI(pane.render(40).join("\n"));
}

describe("ChatTranscriptPane", () => {
	it("uses one responsive transcript and composer shell with a dynamic top border", () => {
		const pane = createPane({ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true });
		try {
			const lines = pane.render(40);
			expect(lines).toHaveLength(8);
			expect(lines.filter(line => Bun.stripANSI(line).includes("╭"))).toHaveLength(1);
			expect(renderedText(pane)).toContain("STATUS");
			const statusLine = lines.find(line => Bun.stripANSI(line).includes("STATUS"));
			expect(statusLine).toContain(theme.getBgAnsi("statusLineBg"));
			expect(renderedText(pane)).not.toContain("Message Agent…");

			pane.handleInput("x");
			expect(renderedText(pane)).toContain("x");
		} finally {
			pane.dispose();
		}
	});
	it("keeps an unfocused editable composer visibly muted", () => {
		const pane = createPane({ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true });
		pane.focused = false;
		try {
			const rendered = pane.render(40);
			expect(Bun.stripANSI(rendered.join("\n"))).toContain("Message Agent…");
			expect(rendered.join("\n")).toContain(theme.fg("muted", "╭──"));
		} finally {
			pane.dispose();
		}
	});
	it("keeps read-only input inert while hiding its hint on focus", () => {
		const pane = createPane({ label: "read-only", placeholder: "read-only · advisor", readOnly: true });
		try {
			const before = pane.render(40);
			expect(before).toHaveLength(8);
			expect(renderedText(pane)).not.toContain("read-only · advisor");
			pane.handleInput("x");
			expect(pane.render(40)).toEqual(before);

			pane.focused = false;
			expect(renderedText(pane)).toContain("read-only · advisor");
		} finally {
			pane.dispose();
		}
	});

	it("returns to the live tail from the control below the scrollbar", () => {
		const pane = createPane({ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true });
		try {
			pane.rebuild([
				{
					role: "user",
					content: Array.from({ length: 12 }, (_value, index) => `row-${index}`).join("\n"),
					timestamp: 0,
				},
			]);
			pane.render(40);
			pane.setScrollOffset(0);
			const detached = pane.render(40).map(line => Bun.stripANSI(line));
			const controlRow = detached.findIndex(line => line.includes("▽"));
			const controlCol = detached[controlRow]?.indexOf("▽") ?? -1;

			expect(controlRow).toBeGreaterThan(0);
			expect(controlCol).toBe(39);
			expect(pane.wantsAppViewportHover()).toBe(true);
			expect(
				pane.routeMouse(mouse({ row: controlRow, col: controlCol, leftClick: true }), controlRow, controlCol),
			).toBe(true);

			const returned = pane.render(40).map(line => Bun.stripANSI(line));
			expect(returned.some(line => line.includes("▽"))).toBe(false);
			expect(returned.some(line => line.includes("row-11"))).toBe(true);
		} finally {
			pane.dispose();
		}
	});

	it("resumes following when a selection releases at the live tail", () => {
		const pane = createPane({ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true });
		try {
			pane.rebuild([
				{
					role: "user",
					content: Array.from({ length: 12 }, (_value, index) => `row-${index}`).join("\n"),
					timestamp: 0,
				},
			]);
			pane.render(40);
			pane.setTextSelectionActive(true);
			pane.setTextSelectionActive(false);
			pane.append([{ role: "user", content: "new-tail-marker", timestamp: 1 }]);

			expect(Bun.stripANSI(pane.render(40).join("\n"))).toContain("new-tail-marker");
		} finally {
			pane.dispose();
		}
	});
	it("recovers transcript rows that scroll beyond the viewport", () => {
		const pane = new ChatTranscriptPane({
			builder: {
				ui: new TUI(new ProcessTerminal()),
				cwd: process.cwd(),
				requestRender: () => {},
			},
			expandKeys: ["ctrl+o"],
			getPlaceholder: () => "No messages yet.",
			onClose: () => {},
		});
		try {
			pane.setViewportHeight(4);
			pane.rebuild([
				{
					role: "user",
					content: Array.from({ length: 8 }, (_value, index) => `row-${index}`).join("\n"),
					timestamp: 0,
				},
			]);
			pane.render(20);
			pane.setScrollOffset(2);
			pane.render(20);

			expect(
				pane.getTextSelection({
					start: { row: 0, col: 0 },
					end: { row: 4, col: 19 },
				}),
			).toBe("row-1\nrow-2\nrow-3\nrow-4\nrow-5");
		} finally {
			pane.dispose();
		}
	});

	it("reflows only visible transcript blocks when pane width changes", () => {
		const blocks: CountingRows[] = [];
		const pane = new ChatTranscriptPane({
			builder: {
				ui: new TUI(new ProcessTerminal()),
				cwd: process.cwd(),
				requestRender: () => {},
				getMessageRenderer: () => message => {
					const block = new CountingRows(String(message.content));
					blocks.push(block);
					return block;
				},
			},
			expandKeys: ["ctrl+o"],
			getPlaceholder: () => "No messages yet.",
			onClose: () => {},
		});
		try {
			pane.setViewportHeight(20);
			pane.rebuild(
				Array.from(
					{ length: 1_000 },
					(_value, index) =>
						({
							role: "custom",
							customType: "counting",
							content: `row-${index}`,
							display: true,
							timestamp: index,
						}) as AgentMessage,
				),
			);

			pane.render(100);
			const firstWidthRenders = blocks.reduce((total, block) => total + block.renders, 0);
			pane.render(70);
			const secondWidthRenders = blocks.reduce((total, block) => total + block.renders, 0) - firstWidthRenders;

			expect(firstWidthRenders).toBeLessThan(100);
			expect(secondWidthRenders).toBeLessThan(100);
			expect(Bun.stripANSI(pane.render(70).join("\n"))).toContain("row-999");
		} finally {
			pane.dispose();
		}
	});
	it("resolves a model link added when a streamed assistant finalizes", async () => {
		const originalHyperlinks = TERMINAL.hyperlinks;
		setTerminalHyperlinks(true);
		const resolved = Promise.withResolvers<void>();
		const pane = new ChatTranscriptPane({
			builder: {
				ui: new TUI(new ProcessTerminal()),
				cwd: process.cwd(),
				resolveLinks: async texts => {
					if (!texts.some(text => text.includes("note.md"))) return new Map();
					resolved.resolve();
					return new Map([["note.md", "file:///current/note.md"]]);
				},
				requestRender: () => {},
			},
			expandKeys: [],
			getPlaceholder: () => "No messages yet.",
			onClose: () => {},
		});
		pane.setViewportHeight(12);
		try {
			const partial = createAssistantMessage("Draft");
			pane.rebuild([partial]);
			expect(
				pane.finalizeStreamingAssistant({
					...partial,
					content: [{ type: "text", text: "Final [note](note.md)" }],
				}),
			).toBe(true);
			await resolved.promise;
			await Promise.resolve();
			expect(pane.render(80).join("\n")).toContain("file:///current/note.md");
		} finally {
			pane.dispose();
			setTerminalHyperlinks(originalHyperlinks);
		}
	});

	it("shows changing execution progress before completion, but never replaces a final result with an old snapshot", () => {
		const pane = createPane(
			{ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true },
			{ isBuiltInTool: () => false },
		);
		pane.setViewportHeight(30);
		const call = {
			...createAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "long-call", name: "long_work", arguments: {} }],
		};
		const progress = (text: string): PaneToolUpdate => ({
			type: "tool_execution_update",
			toolCallId: "long-call",
			toolName: "long_work",
			args: {},
			partialResult: { content: [{ type: "text", text }] },
		});
		const final: AgentMessage = {
			role: "toolResult",
			toolCallId: "long-call",
			toolName: "long_work",
			content: [{ type: "text", text: "completed-output" }],
			isError: false,
			timestamp: 2,
		};
		try {
			// A snapshot can arrive before its transcript call is read on a cold open.
			pane.updateToolUpdates([progress("first-progress")]);
			pane.rebuild([call]);
			expect(renderedText(pane)).toContain("first-progress");
			pane.updateToolUpdates([progress("second-progress")]);
			expect(renderedText(pane)).toContain("second-progress");
			expect(renderedText(pane)).not.toContain("first-progress");

			pane.rebuild([call]);
			expect(renderedText(pane)).toContain("second-progress");
			pane.append([final]);
			pane.updateToolUpdates([progress("stale-progress")]);
			expect(renderedText(pane)).toContain("completed-output");
			expect(renderedText(pane)).not.toContain("stale-progress");
			pane.rebuild([call, final]);
			expect(renderedText(pane)).toContain("completed-output");
			expect(renderedText(pane)).not.toContain("stale-progress");
		} finally {
			pane.dispose();
		}
	});

	it("keeps renderer-owned stream previews live and reconstructs them without letting them beat the final diff", () => {
		const editTool: AgentTool & { mode: "replace" } = {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [] }),
			mode: "replace",
		};
		const pane = createPane(
			{ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true },
			{ getTool: () => editTool },
		);
		pane.setViewportHeight(30);
		const call = {
			...createAssistantMessage(""),
			content: [
				{
					type: "toolCall" as const,
					id: "edit-call",
					name: "edit",
					arguments: { path: "/tmp/mod.ts", old_string: "old", new_string: "new" },
				},
			],
		};
		const preview = (text: string): PaneToolUpdate => ({
			type: "tool_stream_update",
			toolCallId: "edit-call",
			toolName: "edit",
			update: {
				streaming: true,
				files: [{ path: "/tmp/mod.ts", diff: `@@ -1 +1 @@\n-old\n+${text}`, firstChangedLine: 1 }],
			},
		});
		const final: AgentMessage = {
			role: "toolResult",
			toolCallId: "edit-call",
			toolName: "edit",
			content: [{ type: "text", text: "ok" }],
			details: { diff: "@@ -1 +1 @@\n-old\n+final-diff", firstChangedLine: 1 },
			isError: false,
			timestamp: 2,
		};
		try {
			pane.rebuild([call]);
			pane.updateToolUpdates([preview("first-preview")]);
			expect(renderedText(pane)).toContain("first-preview");
			pane.updateToolUpdates([preview("latest-preview")]);
			expect(renderedText(pane)).toContain("latest-preview");
			expect(renderedText(pane)).not.toContain("first-preview");
			pane.rebuild([call]);
			expect(renderedText(pane)).toContain("latest-preview");
			pane.append([final]);
			pane.updateToolUpdates([preview("late-preview")]);
			expect(renderedText(pane)).toContain("final-diff");
			expect(renderedText(pane)).not.toContain("late-preview");
			pane.rebuild([call, final]);
			expect(renderedText(pane)).toContain("final-diff");
			expect(renderedText(pane)).not.toContain("late-preview");

			// A successful result without its own diff still uses the renderer's computed preview.
			pane.updateToolUpdates([preview("computed-preview")]);
			pane.rebuild([call, { ...final, details: undefined }]);
			expect(renderedText(pane)).toContain("computed-preview");
		} finally {
			pane.dispose();
		}
	});

	it("keeps a detached task card attached to late background progress and its terminal snapshot after reopening", () => {
		const makePane = () => {
			const pane = createPane(
				{ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true },
				{ isBuiltInTool: () => false },
			);
			pane.setViewportHeight(30);
			return pane;
		};
		const call = {
			...createAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "task-call", name: "task", arguments: {} }],
		};
		const returned: AgentMessage = {
			role: "toolResult",
			toolCallId: "task-call",
			toolName: "task",
			content: [{ type: "text", text: "background-started" }],
			details: { async: { state: "running" } },
			isError: false,
			timestamp: 2,
		};
		const update = (text: string, state: string): PaneToolUpdate => ({
			type: "tool_execution_update",
			toolCallId: "task-call",
			toolName: "task",
			args: {},
			partialResult: { content: [{ type: "text", text }], details: { async: { state } } },
		});
		const pane = makePane();
		let reopened: ChatTranscriptPane | undefined;
		try {
			pane.rebuild([call, returned]);
			pane.append([{ role: "user", content: "Another question", timestamp: 3 }]);
			pane.updateToolUpdates([update("background-progress", "running")]);
			expect(renderedText(pane)).toContain("background-progress");
			expect(renderedText(pane)).not.toContain("background-started");
			const terminal = update("background-finished", "completed");
			pane.updateToolUpdates([terminal]);
			expect(renderedText(pane)).toContain("background-finished");
			pane.updateToolUpdates([update("too-late", "running")]);
			expect(renderedText(pane)).toContain("background-finished");
			expect(renderedText(pane)).not.toContain("too-late");

			reopened = makePane();
			reopened.updateToolUpdates([terminal]);
			reopened.rebuild([call, returned]);
			expect(renderedText(reopened)).toContain("background-finished");
			expect(renderedText(reopened)).not.toContain("background-started");
		} finally {
			pane.dispose();
			reopened?.dispose();
		}
	});

	it("passes xdev progress details through the existing mounted renderer instead of drawing a generic frame", () => {
		const device: XdevMountedRenderer = {
			renderResult: (result, options) => {
				const details = result.details;
				const stage =
					details !== null && typeof details === "object" && "stage" in details ? String(details.stage) : "lost";
				return new Text(`device-${options.isPartial ? "partial" : "final"}:${stage}`, 0, 0);
			},
		};
		const xdev: XdevMountedState = {
			mountedNames: new Set(["work"]),
			tools: new Map([["work", device]]),
			resolve: name => (name === "work" ? device : undefined),
		};
		const writeTool: AgentTool & { session: { xdev: XdevMountedState } } = {
			name: "write",
			label: "Write",
			description: "Dispatch a device",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [] }),
			session: { xdev },
		};
		const pane = createPane(
			{ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true },
			{ getTool: () => writeTool },
		);
		pane.setViewportHeight(30);
		const call = {
			...createAssistantMessage(""),
			content: [
				{
					type: "toolCall" as const,
					id: "xdev-call",
					name: "write",
					arguments: { path: "xd://work", content: "{}" },
				},
			],
		};
		try {
			pane.rebuild([call]);
			pane.updateToolUpdates([
				{
					type: "tool_execution_update",
					toolCallId: "xdev-call",
					toolName: "write",
					args: {},
					partialResult: {
						content: [{ type: "text", text: "generic-output" }],
						details: { xdev: { tool: "work", mode: "invoke", args: {}, inner: { stage: "working" } } },
					},
				},
			]);
			expect(renderedText(pane)).toContain("device-partial:working");
			pane.rebuild([call]);
			expect(renderedText(pane)).toContain("device-partial:working");
		} finally {
			pane.dispose();
		}
	});

	it("transforms live and rebuilt multi-tool prose at its full-message indices without changing the source", () => {
		const transform: AssistantTextRenderer = ({ message, text, contentIndex, streaming }) => {
			message.usage.cost.input = 999;
			message.content.length = 0;
			return `${text}#${contentIndex}:${streaming ? "live" : "sealed"}`;
		};
		let renderers: readonly AssistantTextRenderer[] = [];
		const pane = createPane(
			{ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true },
			{ getAssistantTextRenderers: () => renderers, isBuiltInTool: () => false },
		);
		pane.setViewportHeight(50);
		const message = {
			...createAssistantMessage(""),
			content: [
				{ type: "text" as const, text: "before" },
				{ type: "toolCall" as const, id: "first", name: "lookup", arguments: {} },
				{ type: "text" as const, text: "between" },
				{ type: "toolCall" as const, id: "second", name: "lookup", arguments: {} },
				{ type: "thinking" as const, thinking: "considering" },
				{ type: "text" as const, text: "after" },
			],
		};
		const source = structuredClone(message);
		try {
			pane.rebuild([message], { transientTail: true });
			renderers = [transform];
			pane.invalidate();
			expect(renderedText(pane)).toContain("before#0:sealed");
			expect(renderedText(pane)).toContain("between#2:sealed");
			expect(renderedText(pane)).toContain("after#5:live");
			expect(message).toEqual(source);

			const growing = {
				...message,
				content: [...message.content.slice(0, -1), { type: "text" as const, text: "after grows" }],
			};
			expect(pane.updateStreamingAssistant(growing)).toBe(true);
			expect(renderedText(pane)).toContain("after grows#5:live");
			expect(pane.finalizeStreamingAssistant(growing)).toBe(true);
			expect(renderedText(pane)).toContain("after grows#5:sealed");
			pane.rebuild([growing]);
			expect(renderedText(pane)).toContain("after grows#5:sealed");

			renderers = [];
			pane.invalidate();
			expect(renderedText(pane)).not.toContain("#5");
			renderers = [({ text, contentIndex }) => `${text}@${contentIndex}`];
			pane.invalidate();
			expect(renderedText(pane)).toContain("before@0");
			expect(renderedText(pane)).toContain("between@2");
			expect(renderedText(pane)).toContain("after grows@5");
			expect(message).toEqual(source);

			const shifted = {
				...growing,
				content: [{ type: "thinking" as const, thinking: "new leading block" }, ...growing.content],
			};
			expect(pane.updateStreamingAssistant(shifted)).toBe(false);
			pane.rebuild([shifted]);
			expect(renderedText(pane)).toContain("before@1");
			expect(renderedText(pane)).toContain("between@3");
			expect(renderedText(pane)).toContain("after grows@6");
		} finally {
			pane.dispose();
		}
	});

	it("keeps text transforms on the live subagent tail across rebuild and persisted adoption", () => {
		const pane = createPane(
			{ label: "Message Agent", placeholder: "Message Agent…", onSubmit: () => true },
			{ getAssistantTextRenderers: () => [({ text, contentIndex }) => `${text}@${contentIndex}`] },
		);
		pane.setViewportHeight(40);
		const message = {
			...createAssistantMessage(""),
			content: [
				{ type: "text" as const, text: "before" },
				{ type: "toolCall" as const, id: "call", name: "lookup", arguments: {} },
				{ type: "text" as const, text: "after" },
			],
		};
		const source = structuredClone(message);
		try {
			pane.setLiveAssistant(message);
			expect(renderedText(pane)).toContain("before@0");
			expect(renderedText(pane)).toContain("after@2");
			pane.rebuild([{ role: "user", content: "Question", timestamp: 0 }]);
			expect(renderedText(pane)).toContain("after@2");
			pane.append([message]);
			expect(renderedText(pane).match(/before@0/g)).toHaveLength(1);
			expect(renderedText(pane).match(/after@2/g)).toHaveLength(1);
			expect(message).toEqual(source);
		} finally {
			pane.dispose();
		}
	});

	it("configures each thread editor once after its ordinary submit callback is installed", () => {
		const configured: (string | undefined)[] = [];
		const intercepted: string[] = [];
		const submitted: string[] = [];
		const pane = new ChatTranscriptPane({
			builder: { ui: new TUI(new ProcessTerminal()), cwd: process.cwd(), requestRender() {} },
			editor: {
				label: "Message",
				placeholder: "Message…",
				onSubmit: text => {
					submitted.push(text);
					return true;
				},
			},
			configureEditor: (editor, key) => {
				configured.push(key);
				const submit = editor.onSubmit;
				editor.onSubmit = text => {
					intercepted.push(`${key ?? "initial"}:${text}`);
					submit?.(text);
				};
			},
			expandKeys: [],
			getPlaceholder: () => "No messages",
			onClose() {},
		});
		pane.focused = true;
		try {
			pane.handleInput("o");
			pane.handleInput("n");
			pane.handleInput("e");
			pane.handleInput("\r");
			pane.selectEditor("thread", "two");
			pane.handleInput("\r");
			pane.selectEditor(undefined, "");
			pane.selectEditor("thread", "");
			expect(configured).toEqual([undefined, "thread"]);
			expect(intercepted).toEqual(["initial:one", "thread:two"]);
			expect(submitted).toEqual(["one", "two"]);
		} finally {
			pane.dispose();
		}
	});
});
