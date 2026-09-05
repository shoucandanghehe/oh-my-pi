import { beforeAll, describe, expect, it } from "bun:test";
import {
	ChatTranscriptPane,
	type ChatTranscriptPaneEditorOptions,
} from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-pane";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false);
});

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
});
