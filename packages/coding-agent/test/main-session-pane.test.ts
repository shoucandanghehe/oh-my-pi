import { describe, expect, it } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { MainSessionPane } from "@oh-my-pi/pi-coding-agent/modes/components/main-session-pane";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type Component,
	Container,
	Markdown,
	type SgrMouseEvent,
	Text,
	TUI,
	type ViewportTailProvider,
	WorkspaceLayout,
	WorkspaceModel,
} from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { defaultMarkdownTheme } from "../../tui/test/test-themes.js";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class StaticRows implements Component {
	constructor(private readonly rows: readonly string[]) {}

	render(): readonly string[] {
		return this.rows;
	}
}

class WidthRows implements Component {
	readonly widths: number[] = [];

	constructor(private readonly rows: readonly string[]) {}

	render(width: number): readonly string[] {
		this.widths.push(width);
		return this.rows;
	}
}

class TailRows implements Component, ViewportTailProvider {
	fullRenders = 0;
	tailRenders = 0;

	constructor(private readonly rows: readonly string[]) {}

	render(): readonly string[] {
		this.fullRenders++;
		return this.rows;
	}

	renderViewportTail(_width: number, maxRows: number): readonly string[] {
		this.tailRenders++;
		return this.rows.slice(-maxRows);
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

describe("MainSessionPane", () => {
	it("recovers selected history from its logical text providers", () => {
		const history = new Container();
		history.addChild(new Text("alpha beta gamma", 1, 0));
		const pane = new MainSessionPane({
			scrollRoot: history,
			stickyRoot: new StaticRows([]),
			requestRender: () => {},
		});
		pane.setViewportHeight(5);
		pane.render(9);
		const selectable = pane as Component;

		expect(
			selectable.getTextSelection?.({
				start: { row: 0, col: 0 },
				end: { row: 2, col: 8 },
			}),
		).toBe("alpha beta gamma");
		expect(selectable.getTextSelectionInset?.(0)).toBe(1);
	});

	it("keeps tool-row column zero selectable while excluding a Text gutter", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new StaticRows(["TOOL"]));
		transcript.addChild(new Text("body", 1, 0));
		const history = new Container();
		history.addChild(transcript);
		const main = new MainSessionPane({
			scrollRoot: history,
			stickyRoot: new StaticRows([]),
			requestRender: () => {},
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => 5,
			requestRender: () => {},
			panes: [{ paneId: "main", title: "Main", component: main, scroll: "component" }],
		});
		workspace.render(20);

		expect(workspace.getAppViewportTextSelectionRect(1, 0)?.col).toBe(0);
		expect(
			workspace.getAppViewportTextSelection({
				start: { row: 1, col: 0 },
				end: { row: 1, col: 3 },
			}),
		).toBe("TOOL");
		expect(workspace.getAppViewportTextSelectionRect(3, 0)?.col).toBe(1);
	});

	it("keeps column-zero fenced code inside a selection region started on padded prose", () => {
		const markdown = new Markdown(
			"Used --force-with-lease:\n\n```text\nfork/demo/app-viewport-backend\n0d47db29f → f2af9bda9\n```",
			1,
			0,
			defaultMarkdownTheme,
			undefined,
			0,
		);
		const transcript = new TranscriptContainer();
		transcript.addChild(markdown);
		const main = new MainSessionPane({
			scrollRoot: transcript,
			stickyRoot: new StaticRows([]),
			requestRender: () => {},
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => 10,
			requestRender: () => {},
			panes: [{ paneId: "main", title: "Main", component: main, scroll: "component" }],
		});
		const rendered = workspace.render(50).map(line => Bun.stripANSI(line));
		const proseRow = rendered.findIndex(line => line.includes("Used --force-with-lease:"));
		const codeRow = rendered.findIndex(line => line.startsWith("fork/demo/app-viewport-backend"));
		expect(proseRow).toBeGreaterThan(0);
		expect(codeRow).toBeGreaterThan(proseRow);

		expect(workspace.getAppViewportTextSelectionRect(codeRow, 0)?.col).toBe(0);
		expect(workspace.getAppViewportTextSelectionRect(proseRow, 1)?.col).toBe(0);
		expect(
			workspace.getAppViewportTextSelection({
				start: { row: codeRow, col: 0 },
				end: { row: codeRow, col: "fork/demo/app-viewport-backend".length - 1 },
			}),
		).toBe("fork/demo/app-viewport-backend");
	});

	it("omits pane scrollbar and sticky rows when copying scroll content", async () => {
		const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		const term = new VirtualTerminal(20, 6);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let copiedText = "";
		tui.onAppViewportSelectionCopy = text => {
			copiedText = text;
		};
		const main = new MainSessionPane({
			scrollRoot: new StaticRows(["zero", "one", "two", "three", "TOOL"]),
			stickyRoot: new StaticRows(["STATUS"]),
			requestRender: () => tui.requestRender(),
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => term.rows,
			requestRender: () => tui.requestRender(),
			panes: [{ paneId: "main", title: "Main", component: main, scroll: "component" }],
		});
		tui.addChild(workspace);

		try {
			tui.start();
			await scheduler.drain(term);
			const rect = workspace.frame?.panes.get("main");
			if (!rect) throw new Error("workspace frame unavailable");
			const startRow = rect.y + 1;
			const endRow = rect.y + rect.height - 1;
			term.sendInput(`\x1b[<0;${rect.x + 1};${startRow + 1}M`);
			term.sendInput(`\x1b[<32;${rect.x + rect.width};${endRow + 1}M`);
			term.sendInput(`\x1b[<0;${rect.x + rect.width};${endRow + 1}m`);
			await scheduler.drain(term);
			expect(term.getViewportRowBackgroundColumns(endRow)).toEqual([]);
			term.sendInput("\x03");
			expect(copiedText).toBe("one\ntwo\nthree\nTOOL");
		} finally {
			tui.stop();
			if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
			else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
		}
	});

	it("copies history that scrolls beyond the pane while selection is held", async () => {
		const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		const term = new VirtualTerminal(20, 6);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let copiedText = "";
		tui.onAppViewportSelectionCopy = text => {
			copiedText = text;
		};
		const main = new MainSessionPane({
			scrollRoot: new StaticRows(Array.from({ length: 10 }, (_value, index) => `row-${index}`)),
			stickyRoot: new StaticRows([]),
			requestRender: () => tui.requestRender(),
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => term.rows,
			requestRender: () => tui.requestRender(),
			panes: [{ paneId: "main", title: "Main", component: main, scroll: "component" }],
		});
		tui.addChild(workspace);

		try {
			tui.start();
			await scheduler.drain(term);
			const rect = workspace.frame?.panes.get("main");
			if (!rect) throw new Error("workspace frame unavailable");
			const bottomRow = rect.y + rect.height - 1;

			term.sendInput(`\x1b[<0;${rect.x + 5};${bottomRow + 1}M`);
			term.sendInput(`\x1b[<32;${rect.x + 4};${bottomRow + 1}M`);
			term.sendInput(`\x1b[<64;${rect.x + 1};${bottomRow + 1}M`);
			term.sendInput(`\x1b[<0;${rect.x + 1};${bottomRow + 1}m`);
			await scheduler.drain(term);
			term.sendInput("\x03");

			expect(copiedText).toBe("row-6\nrow-7\nrow-8\nrow-9");
		} finally {
			tui.stop();
			if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
			else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
		}
	});

	it("right-click copies prompt text recalled from history", async () => {
		const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		await initTheme();
		const term = new VirtualTerminal(40, 8);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let copiedText = "";
		let pasteRequests = 0;
		tui.onAppViewportSelectionCopy = text => {
			copiedText = text;
		};
		tui.onAppViewportPasteRequest = () => {
			pasteRequests++;
		};
		const editor = new CustomEditor(getEditorTheme());
		editor.addToHistory("hello input");
		const stickyRoot = new Container();
		stickyRoot.addChild(editor);
		const main = new MainSessionPane({
			scrollRoot: new StaticRows(["history"]),
			stickyRoot,
			requestRender: () => tui.requestRender(),
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => term.rows,
			requestRender: () => tui.requestRender(),
			focus: component => tui.setFocus(component),
			panes: [
				{
					paneId: "main",
					title: "Main",
					component: main,
					focusTarget: editor,
					scroll: "component",
				},
			],
		});
		tui.addChild(workspace);

		try {
			tui.setFocus(editor);
			tui.start();
			await scheduler.drain(term);
			term.sendInput("\x1b[A");
			await scheduler.drain(term);
			const viewport = term.getViewport().map(line => Bun.stripANSI(line));
			const inputRow = viewport.findIndex(line => line.includes("hello input"));
			if (inputRow < 0) throw new Error("recalled prompt row unavailable");
			const startCol = viewport[inputRow]!.indexOf("hello");
			term.sendInput(`\x1b[<0;${startCol + 1};${inputRow + 1}M`);
			term.sendInput(`\x1b[<32;${startCol + 5};${inputRow + 1}M`);
			term.sendInput(`\x1b[<0;${startCol + 5};${inputRow + 1}m`);
			await scheduler.drain(term);
			term.sendInput(`\x1b[<2;${startCol + 1};${inputRow + 1}M`);

			expect({ copiedText, pasteRequests }).toEqual({ copiedText: "hello", pasteRequests: 0 });
		} finally {
			tui.stop();
			if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
			else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
		}
	});

	it("moves an active selection with its pane content while scrolling", async () => {
		const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		const term = new VirtualTerminal(20, 6);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let copiedText = "";
		tui.onAppViewportSelectionCopy = text => {
			copiedText = text;
		};
		const main = new MainSessionPane({
			scrollRoot: new StaticRows(["zero", "one", "two", "three", "four", "five", "six"]),
			stickyRoot: new StaticRows(["STATUS"]),
			requestRender: () => tui.requestRender(),
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => term.rows,
			requestRender: () => tui.requestRender(),
			panes: [{ paneId: "main", title: "Main", component: main, scroll: "component" }],
		});
		tui.addChild(workspace);

		try {
			tui.start();
			await scheduler.drain(term);
			const rect = workspace.frame?.panes.get("main");
			if (!rect) throw new Error("workspace frame unavailable");
			const selectedRow = rect.y + 1;
			term.sendInput(`\x1b[<0;${rect.x + 1};${selectedRow + 1}M`);
			term.sendInput(`\x1b[<32;${rect.x + 5};${selectedRow + 1}M`);
			term.sendInput(`\x1b[<0;${rect.x + 5};${selectedRow + 1}m`);
			await scheduler.drain(term);
			expect(term.getViewportRowBackgroundColumns(selectedRow)).toEqual([0, 1, 2, 3, 4]);

			term.sendInput(`\x1b[<64;${rect.x + 1};${selectedRow + 1}M`);
			await scheduler.drain(term);
			const movedRow = selectedRow + 3;
			expect(Bun.stripANSI(term.getViewport()[movedRow] ?? "").trimEnd()).toStartWith("three");
			expect(term.getViewportRowBackgroundColumns(selectedRow)).toEqual([]);
			expect(term.getViewportRowBackgroundColumns(movedRow)).toEqual([0, 1, 2, 3, 4]);
			term.sendInput("\x03");
			expect(copiedText).toBe("three");
		} finally {
			tui.stop();
			if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
			else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
		}
	});

	it("keeps an active drag when its anchor scrolls above the pane without selecting sticky input", async () => {
		const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		const term = new VirtualTerminal(20, 6);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let copiedText = "";
		tui.onAppViewportSelectionCopy = text => {
			copiedText = text;
		};
		const main = new MainSessionPane({
			scrollRoot: new StaticRows(["zero", "one", "two", "three", "four", "five", "six"]),
			stickyRoot: new StaticRows(["STATUS"]),
			requestRender: () => tui.requestRender(),
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => term.rows,
			requestRender: () => tui.requestRender(),
			panes: [{ paneId: "main", title: "Main", component: main, scroll: "component" }],
		});
		tui.addChild(workspace);

		try {
			tui.start();
			await scheduler.drain(term);
			const rect = workspace.frame?.panes.get("main");
			if (!rect) throw new Error("workspace frame unavailable");
			const firstContentRow = rect.y + 1;
			const lastScrollRow = firstContentRow + 3;
			const stickyRow = lastScrollRow + 1;

			term.sendInput(`\x1b[<64;${rect.x + 1};${firstContentRow + 1}M`);
			await scheduler.drain(term);
			expect(Bun.stripANSI(term.getViewport()[firstContentRow] ?? "").trimEnd()).toStartWith("zero");

			term.sendInput(`\x1b[<0;${rect.x + 1};${firstContentRow + 1}M`);
			term.sendInput(`\x1b[<32;${rect.x + 5};${lastScrollRow + 1}M`);
			term.sendInput(`\x1b[<65;${rect.x + 5};${lastScrollRow + 1}M`);
			await scheduler.drain(term);

			expect(Bun.stripANSI(term.getViewport()[firstContentRow] ?? "").trimEnd()).toStartWith("three");
			expect(term.getViewportRowBackgroundColumns(firstContentRow).length).toBeGreaterThan(0);
			expect(term.getViewportRowBackgroundColumns(lastScrollRow).length).toBeGreaterThan(0);
			expect(term.getViewportRowBackgroundColumns(stickyRow)).toEqual([]);

			term.sendInput(`\x1b[<0;${rect.x + 5};${lastScrollRow + 1}m`);
			term.sendInput("\x03");
			expect(copiedText).toBe("zero\none\ntwo\nthree\nfour\nfive\nsix");
		} finally {
			tui.stop();
			if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
			else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
		}
	});

	it("scrolls session history while keeping status and editor rows pinned", () => {
		let renders = 0;
		const pane = new MainSessionPane({
			scrollRoot: new StaticRows(Array.from({ length: 10 }, (_value, index) => `row-${index}`)),
			stickyRoot: new StaticRows(["status", "editor"]),
			requestRender: () => renders++,
		});
		pane.setViewportHeight(6);

		const bottomRows = pane.render(40).slice(0, 4);
		for (const [index, expected] of ["row-6", "row-7", "row-8", "row-9"].entries()) {
			expect(Bun.stripANSI(bottomRows[index] ?? "")).toStartWith(expected);
		}
		pane.handleInput("\x1b[<64;1;1M");
		const scrolledRows = pane.render(40).slice(0, 4);
		for (const [index, expected] of ["row-3", "row-4", "row-5", "row-6"].entries()) {
			expect(Bun.stripANSI(scrolledRows[index] ?? "")).toStartWith(expected);
		}
		expect(renders).toBe(1);
	});

	it("shows a virtual scrollbar when Main history exceeds its pane viewport", () => {
		const history = new WidthRows(Array.from({ length: 20 }, (_value, index) => `row-${index}`));
		const main = new MainSessionPane({
			scrollRoot: history,
			stickyRoot: new StaticRows(["status", "editor"]),
			requestRender: () => {},
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => 7,
			requestRender: () => {},
			panes: [{ paneId: "main", title: "Main", component: main, scroll: "component" }],
		});

		const bottomBar = workspace
			.render(20)
			.slice(1, 5)
			.map(line => Bun.stripANSI(line).at(-1));
		main.handleInput("\x1b[<64;1;1M");
		const raisedBar = workspace
			.render(20)
			.slice(1, 5)
			.map(line => Bun.stripANSI(line).at(-1));

		expect(history.widths.at(-1)).toBe(19);
		expect(
			bottomBar.some(glyph => {
				const codePoint = glyph?.codePointAt(0) ?? 0;
				return codePoint >= 0x2800 && codePoint <= 0x28ff;
			}),
		).toBe(true);
		expect(bottomBar).not.toContain("█");
		expect(raisedBar).not.toEqual(bottomBar);
	});

	it("drags the Main scrollbar thumb through workspace mouse routing", () => {
		const main = new MainSessionPane({
			scrollRoot: new StaticRows(Array.from({ length: 20 }, (_value, index) => `row-${index}`)),
			stickyRoot: new StaticRows(["status", "editor"]),
			requestRender: () => {},
		});
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => 7,
			requestRender: () => {},
			panes: [{ paneId: "main", title: "Main", component: main, scroll: "component" }],
		});
		const initial = workspace.render(20);
		const thumbRow = initial.findIndex((line, row) => {
			const codePoint = Bun.stripANSI(line).at(-1)?.codePointAt(0) ?? 0;
			return row > 0 && row < 5 && codePoint >= 0x2800 && codePoint <= 0x28ff;
		});
		expect(thumbRow).toBeGreaterThan(0);

		workspace.handleAppViewportMouse(mouse({ col: 19, row: thumbRow, leftClick: true }));
		workspace.handleAppViewportMouse(mouse({ button: 32, col: 19, row: 1, motion: true, leftClick: false }));
		const dragged = workspace.render(20);
		workspace.handleAppViewportMouse(mouse({ col: 19, row: 1, release: true }));

		expect(Bun.stripANSI(dragged[1] ?? "")).toStartWith("row-0");
	});
	it("keeps sticky rows at the bottom when history is shorter than the viewport", () => {
		const pane = new MainSessionPane({
			scrollRoot: new StaticRows(["hello"]),
			stickyRoot: new StaticRows(["status", "editor"]),
			requestRender: () => {},
		});
		pane.setViewportHeight(5);

		expect(pane.render(40)).toEqual(["hello", "", "", "status", "editor"]);
	});

	it("composes only the visible history tail while a workspace sash is moving", () => {
		const history = new TailRows(Array.from({ length: 10_000 }, (_value, index) => `row-${index}`));
		const scrollRoot = new Container();
		scrollRoot.addChild(new StaticRows(["welcome"]));
		scrollRoot.addChild(history);
		scrollRoot.addChild(new StaticRows(["hud"]));
		const main = new MainSessionPane({
			scrollRoot,
			stickyRoot: new StaticRows(["status", "editor"]),
			requestRender: () => {},
		});
		const model = WorkspaceModel.single("main");
		model.splitPane("main", "agent", "right");
		const workspace = new WorkspaceLayout({
			model,
			height: () => 10,
			requestRender: () => {},
			panes: [
				{ paneId: "main", title: "Main", component: main, scroll: "component", minWidth: 10 },
				{ paneId: "agent", title: "Agent", component: new StaticRows(["agent"]), minWidth: 10 },
			],
		});
		workspace.render(80);
		const sash = workspace.frame!.sashes[0]!.rect;
		workspace.handleAppViewportMouse(mouse({ col: sash.x, row: sash.y, leftClick: true }));
		workspace.handleAppViewportMouse(mouse({ col: sash.x + 1, row: sash.y, motion: true, leftClick: true }));
		history.fullRenders = 0;
		history.tailRenders = 0;

		workspace.render(80);

		expect(history.fullRenders).toBe(0);
		expect(history.tailRenders).toBeGreaterThan(0);
	});
});
