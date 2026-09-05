import { afterEach, describe, expect, it } from "bun:test";
import { AnchoredLiveContainer } from "@oh-my-pi/pi-coding-agent/modes/components/anchored-live-container";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { type Component, Text, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;

afterEach(() => {
	if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
	else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
});

function viewport(term: VirtualTerminal): string[] {
	return term.getViewport().map(line =>
		Bun.stripANSI(line)
			.replace(/[ \t]*[\u2800-\u28ff]?$/, "")
			.trim(),
	);
}

class CountingBlock implements Component {
	renders = 0;
	#text: string;

	constructor(
		text: string,
		readonly finalized = true,
	) {
		this.#text = text;
	}

	setText(text: string): void {
		this.#text = text;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renders++;
		return [this.#text];
	}

	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
}

describe("AnchoredLiveContainer app viewport scrolling", () => {
	it("keeps the editor visible and scrolls through long Todo and BTW panels", async () => {
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		const term = new VirtualTerminal(40, 5);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text("history-0\nhistory-1", 1, 0));
		const todo = new AnchoredLiveContainer();
		todo.addChild(new Text(Array.from({ length: 6 }, (_, index) => `todo-${index}`).join("\n"), 1, 0));
		const btw = new AnchoredLiveContainer();
		btw.addChild(new Text(Array.from({ length: 6 }, (_, index) => `btw-${index}`).join("\n"), 1, 0));
		tui.addChild(transcript);
		tui.addChild(todo);
		tui.addChild(btw);
		tui.addChild(new Text("editor", 1, 0));

		try {
			tui.start();
			await scheduler.drain(term);
			expect(viewport(term)).toEqual(["btw-2", "btw-3", "btw-4", "btw-5", "editor"]);

			term.sendInput("\x1b[<64;1;1M");
			await scheduler.drain(term);
			expect(viewport(term)).toEqual(["todo-5", "btw-0", "btw-1", "btw-2", "editor"]);

			term.sendInput("\x1b[<64;1;1M");
			await scheduler.drain(term);
			expect(viewport(term)).toEqual(["todo-2", "todo-3", "todo-4", "todo-5", "editor"]);
		} finally {
			tui.stop();
		}
	});

	it("limits component-scoped frames to the requested root and transcript block", async () => {
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		const term = new VirtualTerminal(40, 5);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		const history = Array.from({ length: 200 }, (_, index) => new CountingBlock(`history-${index}`));
		for (const block of history) transcript.addChild(block);
		const live = new CountingBlock("live-0", false);
		transcript.addChild(live);
		const editor = new CountingBlock("editor-0");
		tui.addChild(transcript);
		tui.addChild(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			const historyRenders = history.reduce((total, block) => total + block.renders, 0);

			editor.setText("editor-1");
			tui.requestComponentRender(editor);
			await scheduler.drain(term);
			expect(history.reduce((total, block) => total + block.renders, 0)).toBe(historyRenders);

			live.setText("live-1");
			tui.requestComponentRender(live);
			await scheduler.drain(term);
			expect(history.reduce((total, block) => total + block.renders, 0)).toBe(historyRenders);
			expect(viewport(term)).toContain("live-1");
			expect(viewport(term)).toContain("editor-1");
		} finally {
			tui.stop();
		}
	});
});
