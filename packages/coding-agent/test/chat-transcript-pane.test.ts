import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ChatTranscriptPane,
	type ChatTranscriptPaneEditorOptions,
} from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-pane";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, ProcessTerminal, type SgrMouseEvent, TUI } from "@oh-my-pi/pi-tui";

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

function createPane(editor: ChatTranscriptPaneEditorOptions): ChatTranscriptPane {
	const pane = new ChatTranscriptPane({
		builder: {
			ui: new TUI(new ProcessTerminal()),
			cwd: process.cwd(),
			requestRender: () => {},
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
});
