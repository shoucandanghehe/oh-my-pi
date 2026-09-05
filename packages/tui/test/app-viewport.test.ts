import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AppViewportInputOwner,
	type AppViewportScrollRegion,
	type Component,
	CURSOR_MARKER,
	type Focusable,
	type SgrMouseEvent,
	Text,
	TUI,
	WorkspaceLayout,
	WorkspaceModel,
} from "@oh-my-pi/pi-tui";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
	vi.restoreAllMocks();
});

class TranscriptComponent implements Component, AppViewportScrollRegion {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	append(line: string): void {
		this.#lines.push(line);
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {
		// No cached state.
	}

	getAppViewportScrollRegionStart(): number | undefined {
		return 0;
	}

	getAppViewportScrollRegionEnd(): number | undefined {
		return this.#lines.length;
	}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

class StaticLines implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {
		// No cached state.
	}

	render(_width: number): string[] {
		return [...this.lines];
	}
}

class WidthFill implements Component {
	invalidate(): void {
		// No cached state.
	}

	render(width: number): string[] {
		return ["A".repeat(width)];
	}
}

class CursorLine implements Component, Focusable {
	focused = false;

	invalidate(): void {
		// No cached state.
	}

	render(): string[] {
		return [`prompt>${this.focused ? CURSOR_MARKER : ""}`];
	}
}

class WorkspaceInputOwner implements Component, AppViewportInputOwner {
	readonly mouseEvents: SgrMouseEvent[] = [];
	hover = false;

	handleAppViewportMouse(event: SgrMouseEvent): boolean {
		this.mouseEvents.push(event);
		return true;
	}

	wantsAppViewportHover(): boolean {
		return this.hover;
	}

	render(): readonly string[] {
		return ["workspace"];
	}
}
function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

async function flushRender(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
	const previous = Bun.env[name];
	Bun.env[name] = value;
	try {
		await run();
	} finally {
		if (previous === undefined) {
			delete Bun.env[name];
		} else {
			Bun.env[name] = previous;
		}
	}
}

function viewportContent(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.replace(/[ \t]*[\u2800-\u28ff]?$/, "").trim());
}

function viewportScrollbarRows(term: VirtualTerminal): number[] {
	const rows: number[] = [];
	const viewport = term.getViewport();
	for (let row = 0; row < viewport.length; row++) {
		const code = viewport[row]?.trimEnd().codePointAt((viewport[row]?.trimEnd().length ?? 1) - 1) ?? 0;
		if (code >= 0x2800 && code <= 0x28ff) rows.push(row);
	}
	return rows;
}

class CountingTranscript implements Component, AppViewportScrollRegion {
	renders = 0;
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	append(line: string): void {
		this.#lines.push(line);
	}

	invalidate(): void {
		// No cached state.
	}

	getAppViewportScrollRegionStart(): number | undefined {
		return 0;
	}

	getAppViewportScrollRegionEnd(): number | undefined {
		return this.#lines.length;
	}

	render(_width: number): string[] {
		this.renders++;
		return [...this.#lines];
	}
}

describe("TUI app viewport backend", () => {
	it("uses a bounded app provider instead of native history or full-history resize frames", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const scheduler = new StressRenderScheduler();
			const term = new VirtualTerminal(20, 4);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const nativeFrame = vi.fn(() => ({ viewport: ["native"] }));
			const nativeResize = vi.fn(() => ["native-resize"]);
			const appViewports: Array<{ columns: number; rows: number }> = [];
			tui.setFrameProvider({
				renderFrame: nativeFrame,
				acknowledgeHistory() {},
				renderResizeFrame: nativeResize,
			});
			tui.setAppViewportFrameProvider({
				renderAppViewportFrame(viewport) {
					appViewports.push(viewport);
					return {
						viewport: ["app"],
						estimatedTotalRows: 1,
						offset: 0,
						stickyRows: 0,
						cursor: null,
						rowMap: [0],
					};
				},
			});

			try {
				tui.start();
				await scheduler.drain(term);
				expect(appViewports.at(-1)).toEqual({ columns: 19, rows: 4 });
				expect(nativeFrame).not.toHaveBeenCalled();
				expect(nativeResize).not.toHaveBeenCalled();
				expect(viewportContent(term)).toContain("app");
			} finally {
				tui.stop();
			}
		});
	});
	it("delegates normalized mouse events to a workspace input owner", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 8);
			const owner = new WorkspaceInputOwner();
			const tui = new TUI(term);
			tui.addChild(owner);
			try {
				tui.start();
				await flushRender(term);
				term.sendInput("\x1b[<0;5;3M");
				expect(owner.mouseEvents).toEqual([
					{
						button: 0,
						col: 4,
						row: 2,
						release: false,
						wheel: null,
						motion: false,
						leftClick: true,
						rightClick: false,
					},
				]);
			} finally {
				tui.stop();
			}
		});
	});

	it("enables any-motion tracking only while the app viewport owner needs hover", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 8);
			const writes = captureWrites(term);
			const owner = new WorkspaceInputOwner();
			const tui = new TUI(term);
			tui.addChild(owner);
			try {
				tui.start();
				await flushRender(term);
				expect(writes.join("")).toContain("\x1b[?1002h\x1b[?1006h");
				expect(writes.join("")).not.toContain("\x1b[?1003h");

				let writeIndex = writes.length;
				owner.hover = true;
				tui.requestRender(true);
				await flushRender(term);
				expect(writes.slice(writeIndex).join("")).toContain("\x1b[?1002l\x1b[?1003h");

				writeIndex = writes.length;
				owner.hover = false;
				tui.requestRender(true);
				await flushRender(term);
				expect(writes.slice(writeIndex).join("")).toContain("\x1b[?1003l\x1b[?1002h");
			} finally {
				tui.stop();
			}
		});
	});

	it("routes sash drags through app viewport into a workspace layout", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(20, 6);
			const model = WorkspaceModel.single("main");
			model.splitPane("main", "agent", "right");
			const tui = new TUI(term);
			const workspace = new WorkspaceLayout({
				model,
				height: () => term.rows,
				requestRender: () => tui.requestRender(true),
				panes: [
					{ paneId: "main", title: "Main", component: new WidthFill(), minWidth: 3 },
					{ paneId: "agent", title: "Agent", component: new WidthFill(), minWidth: 3 },
				],
			});
			tui.addChild(workspace);
			try {
				tui.start();
				await flushRender(term);
				expect(workspace.frame?.panes.get("main")?.width).toBe(9);
				expect(workspace.frame?.sashes[0]?.rect).toEqual({ x: 9, y: 0, width: 1, height: 6 });

				term.sendInput("\x1b[<0;10;3M");
				term.sendInput("\x1b[<32;13;3M");
				term.sendInput("\x1b[<0;13;3m");
				await flushRender(term);
				expect(workspace.frame?.panes.get("main")?.width).toBe(12);
				expect(workspace.frame?.panes.get("agent")?.width).toBe(6);
				expect(term.getViewport().some(line => line.includes("│"))).toBe(true);
			} finally {
				tui.stop();
			}
		});
	});
	it("preserves a recursive workspace across constrained Windows resizes", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const term = new VirtualTerminal(40, 8);
			const model = WorkspaceModel.single("main");
			model.splitPane("main", "agent", "right");
			model.splitPane("agent", "worker", "bottom");
			const tui = new TUI(term);
			const workspace = new WorkspaceLayout({
				model,
				height: () => term.rows,
				requestRender: () => tui.requestRender(true),
				panes: [
					{ paneId: "main", title: "Main", component: new WidthFill(), minWidth: 5, minHeight: 3 },
					{ paneId: "agent", title: "Agent", component: new WidthFill(), minWidth: 5, minHeight: 3 },
					{ paneId: "worker", title: "Worker", component: new WidthFill(), minWidth: 5, minHeight: 3 },
				],
			});
			tui.addChild(workspace);
			try {
				tui.start();
				await flushRender(term);
				expect(workspace.frame?.constrained).toBe(false);

				term.resize(12, 5);
				await flushRender(term);
				expect(workspace.frame?.constrained).toBe(true);
				expect([...workspace.frame!.panes.keys()]).toEqual(["main", "agent", "worker"]);

				term.resize(40, 8);
				await flushRender(term);
				expect(workspace.frame?.constrained).toBe(false);
				expect([...workspace.frame!.panes.keys()]).toEqual(["main", "agent", "worker"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("moves keyboard focus to the pane clicked inside a workspace", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(20, 6);
			const model = WorkspaceModel.single("main");
			model.splitPane("main", "agent", "right");
			const main = new CursorLine();
			const agent = new CursorLine();
			const tui = new TUI(term);
			const workspace = new WorkspaceLayout({
				model,
				height: () => term.rows,
				requestRender: () => tui.requestRender(true),
				focus: component => tui.setFocus(component),
				panes: [
					{ paneId: "main", title: "Main", component: main, minWidth: 3 },
					{ paneId: "agent", title: "Agent", component: agent, minWidth: 3 },
				],
			});
			tui.addChild(workspace);
			tui.setFocus(main);
			try {
				tui.start();
				await flushRender(term);
				term.sendInput("\x1b[<0;13;3M");
				await flushRender(term);
				expect(tui.getFocused()).toBe(agent);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps drag selection within its starting workspace pane", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(30, 6);
			const model = WorkspaceModel.single("main");
			model.splitPane("main", "agent", "right");
			const tui = new TUI(term);
			let copiedText = "";
			tui.onAppViewportSelectionCopy = text => {
				copiedText = text;
			};
			const workspace = new WorkspaceLayout({
				model,
				height: () => term.rows,
				requestRender: () => tui.requestRender(true),
				panes: [
					{
						paneId: "main",
						title: "Main",
						component: new StaticLines(["LEFT-ONE", "LEFT-TWO", "LEFT-THREE"]),
						minWidth: 3,
					},
					{
						paneId: "agent",
						title: "Agent",
						component: new StaticLines(["RIGHT-ONE", "RIGHT-TWO", "RIGHT-THREE"]),
						minWidth: 3,
					},
				],
			});
			tui.addChild(workspace);

			try {
				tui.start();
				await flushRender(term);
				const mainRect = workspace.frame?.panes.get("main");
				const agentRect = workspace.frame?.panes.get("agent");
				if (!mainRect || !agentRect) throw new Error("workspace frame unavailable");
				const startRow = mainRect.y + 1;
				const endRow = startRow + 2;

				term.sendInput(`\x1b[<0;${mainRect.x + 1};${startRow + 1}M`);
				term.sendInput(`\x1b[<32;${agentRect.x + agentRect.width};${endRow + 1}M`);
				term.sendInput(`\x1b[<0;${agentRect.x + agentRect.width};${endRow + 1}m`);
				await flushRender(term);

				for (let row = startRow; row <= endRow; row++) {
					const selectedColumns = term.getViewportRowBackgroundColumns(row);
					expect(selectedColumns.length).toBeGreaterThan(0);
					expect(selectedColumns.every(column => column < agentRect.x)).toBe(true);
				}
				term.sendInput("\x03");
				expect(copiedText).toBe("LEFT-ONE\nLEFT-TWO\nLEFT-THREE");
			} finally {
				tui.stop();
			}
		});
	});

	it("copies wrapped pane text without visual line breaks or its left gutter", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(20, 6);
			const model = WorkspaceModel.single("main");
			model.splitPane("main", "agent", "right");
			const tui = new TUI(term);
			let copiedText = "";
			tui.onAppViewportSelectionCopy = text => {
				copiedText = text;
			};
			const workspace = new WorkspaceLayout({
				model,
				height: () => term.rows,
				requestRender: () => tui.requestRender(true),
				panes: [
					{
						paneId: "main",
						title: "Main",
						component: new Text("alpha beta gamma", 1, 0),
						minWidth: 3,
					},
					{
						paneId: "agent",
						title: "Agent",
						component: new StaticLines(["RIGHT-ONE", "RIGHT-TWO", "RIGHT-THREE"]),
						minWidth: 3,
					},
				],
			});
			tui.addChild(workspace);

			try {
				tui.start();
				await flushRender(term);
				const mainRect = workspace.frame?.panes.get("main");
				const agentRect = workspace.frame?.panes.get("agent");
				if (!mainRect || !agentRect) throw new Error("workspace frame unavailable");
				const startRow = mainRect.y + 1;
				const endRow = startRow + 2;

				term.sendInput(`\x1b[<0;${mainRect.x + 1};${startRow + 1}M`);
				term.sendInput(`\x1b[<32;${agentRect.x + agentRect.width};${endRow + 1}M`);
				term.sendInput(`\x1b[<0;${agentRect.x + agentRect.width};${endRow + 1}m`);
				await flushRender(term);
				term.sendInput("\x03");
				expect(copiedText).toBe("alpha beta gamma");

				for (let row = startRow; row <= endRow; row++) {
					const selectedColumns = term.getViewportRowBackgroundColumns(row);
					expect(selectedColumns.length).toBeGreaterThan(0);
					expect(selectedColumns.every(column => column > mainRect.x && column < agentRect.x)).toBe(true);
				}
			} finally {
				tui.stop();
			}
		});
	});

	it("scrolls without re-rendering transcript components", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const transcript = new CountingTranscript(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
			const tui = new TUI(term);
			tui.addChild(transcript);
			tui.addChild(new StaticLines(["status", "editor"]));

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-7", "row-8", "row-9", "status", "editor"]);
				expect(transcript.renders).toBeGreaterThan(0);

				// Pure scroll frames reuse the composed frame: re-walking thousands
				// of transcript blocks per wheel tick is what made scrolling lag.
				transcript.renders = 0;
				term.sendInput("\x1b[<64;1;1M");
				term.sendInput("\x1b[<64;1;1M");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-1", "row-2", "row-3", "status", "editor"]);
				expect(transcript.renders).toBe(0);

				term.sendInput("\x1b[5~");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-0", "row-1", "row-2", "status", "editor"]);
				expect(transcript.renders).toBe(0);

				// A content change must still recompose, and the scrolled viewport
				// keeps its anchor (follow stays off while scrolled up).
				transcript.append("row-10");
				tui.requestRender(true);
				await flushRender(term);
				expect(transcript.renders).toBeGreaterThan(0);
				expect(viewportContent(term)).toEqual(["row-0", "row-1", "row-2", "status", "editor"]);

				transcript.renders = 0;
				term.sendInput("\x1b[<65;1;1M");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-3", "row-4", "row-5", "status", "editor"]);
				expect(transcript.renders).toBe(0);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps transcript app-scrolled and sticky chrome fixed without ED3 frames", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const transcript = new TranscriptComponent(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
			const tui = new TUI(term);
			tui.addChild(transcript);
			tui.addChild(new StaticLines(["status", "editor"]));

			let stopped = false;
			try {
				tui.start();
				await flushRender(term);

				expect(writes.join("")).toContain("\x1b[?1049h");
				expect(writes.join("")).not.toContain("\x1b[3J");
				expect(viewportContent(term)).toEqual(["row-7", "row-8", "row-9", "status", "editor"]);
				expect(viewportScrollbarRows(term)).toEqual([2]);
				// A full thumb row fills both Braille dot columns: four vertical
				// subrows of scroll precision without the visual thinness of one column.
				expect(
					Bun.stripANSI(term.getViewport()[2] ?? "")
						.trimEnd()
						.at(-1),
				).toBe("\u28ff");

				expect(writes.join("")).toContain("\x1b[?1002h\x1b[?1006h");
				term.sendInput("\x1b[<64;1;1M");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-4", "row-5", "row-6", "status", "editor"]);
				expect(viewportScrollbarRows(term)).toEqual([1, 2]);

				term.sendInput("\x1b[<65;1;1M");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-7", "row-8", "row-9", "status", "editor"]);
				expect(viewportScrollbarRows(term)).toEqual([2]);

				term.sendInput("\x1b[5~");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-4", "row-5", "row-6", "status", "editor"]);

				transcript.append("row-10");
				transcript.append("row-11");
				tui.requestRender(true);
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-4", "row-5", "row-6", "status", "editor"]);

				term.sendInput("\x1b[6~");
				term.sendInput("\x1b[6~");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-9", "row-10", "row-11", "status", "editor"]);

				transcript.append("row-12");
				tui.requestRender(true);
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-10", "row-11", "row-12", "status", "editor"]);

				expect(writes.join("")).not.toContain("\x1b[3J");

				tui.stop();
				stopped = true;
				expect(writes.join("")).toContain("\x1b[?1049l");
			} finally {
				if (!stopped) tui.stop();
			}
		});
	});

	it("keeps large Windows history scrollable without ConPTY truncation marker", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const term = new VirtualTerminal(80, 8, 12_000);
			const writes = captureWrites(term);
			const transcript = new TranscriptComponent(
				Array.from(
					{ length: 9000 },
					(_value, index) => `第${index.toString().padStart(5, "0")}行：${"界".repeat(80)}`,
				),
			);
			const tui = new TUI(term);
			tui.addChild(transcript);

			try {
				tui.start({ clearScrollback: true });
				await flushRender(term);

				const paint = writes.join("");
				expect(paint).toContain("\x1b[?1049h");
				expect(paint).not.toContain("older lines hidden");
				expect(term.getScrollBuffer().some(line => line.includes("older lines hidden"))).toBe(false);
				expect(viewportContent(term).some(line => line.includes("第08999行"))).toBe(true);

				term.sendInput("\x1b[1;3H");
				await flushRender(term);

				expect(viewportContent(term)[0]).toContain("第00000行");
			} finally {
				tui.stop();
			}
		});
	});

	it("drags the scrollbar thumb", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(Array.from({ length: 10 }, (_value, index) => `row-${index}`)));
			tui.addChild(new StaticLines(["status", "editor"]));

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-7", "row-8", "row-9", "status", "editor"]);

				term.sendInput("\x1b[<0;40;3M");
				term.sendInput("\x1b[<32;40;1M");
				term.sendInput("\x1b[<0;40;1m");
				await flushRender(term);

				expect(viewportContent(term)).toEqual(["row-0", "row-1", "row-2", "status", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("uses pixel mouse reports for finer scrollbar drags when the terminal supports them", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(Array.from({ length: 1000 }, (_value, index) => `row-${index}`)));
			tui.addChild(new StaticLines(["status", "editor"]));

			try {
				tui.start();
				term.reportPrivateMode(1016, true);
				term.sendInput("\x1b[6;10;10t");
				await flushRender(term);
				expect(viewportContent(term).at(0)).toBe("row-992");

				term.sendInput("\x1b[<0;396;76M");
				term.sendInput("\x1b[<32;396;66M");
				term.sendInput("\x1b[<0;396;66m");
				await flushRender(term);

				expect(viewportContent(term).at(0)).toBe("row-921");
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
			}
		});
	});

	it("selects pixel-reported wide Unicode text without corrupting the rendered row", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const originalCellDimensions = getCellDimensions();
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			const term = new VirtualTerminal(40, 4);
			const tui = new TUI(term);
			const line = "A界Z";
			let copiedText = "";
			tui.onAppViewportSelectionCopy = text => {
				copiedText = text;
			};
			tui.addChild(new TranscriptComponent([line, line]));

			try {
				tui.start();
				term.reportPrivateMode(1016, true);
				term.sendInput("\x1b[6;10;10t");
				await flushRender(term);

				// Pixel coordinates x=10 and x=20 map to display columns 0 and 1.
				// Column 1 is the first of the two cells occupied by 界; rendering
				// this intermediate drag frame must retain the complete grapheme.
				term.sendInput("\x1b[<0;10;1M");
				term.sendInput("\x1b[<32;20;1M");
				await flushRender(term);

				expect(Bun.stripANSI(term.getViewport()[0] ?? "").trimEnd()).toBe(line);
				expect(term.getViewportRowBackgroundColumns(0)).toEqual([0, 1, 2]);

				term.sendInput("\x1b[<32;30;1M");
				term.sendInput("\x1b[<0;30;1m");
				await flushRender(term);

				expect(Bun.stripANSI(term.getViewport()[0] ?? "").trimEnd()).toBe(line);
				expect(term.getViewportRowBackgroundColumns(0)).toEqual([0, 1, 2]);
				term.sendInput("\x03");
				expect(copiedText).toBe("A界");

				// Starting in the second cell of a wide grapheme must align the
				// selection start to that grapheme's first display column.
				term.sendInput("\x1b[<0;30;11M");
				term.sendInput("\x1b[<32;40;11M");
				term.sendInput("\x1b[<0;40;11m");
				await flushRender(term);

				expect(Bun.stripANSI(term.getViewport()[1] ?? "").trimEnd()).toBe(line);
				expect(term.getViewportRowBackgroundColumns(1)).toEqual([1, 2, 3]);
				term.sendInput("\x03");
				expect(copiedText).toBe("界Z");

				tui.requestRender(true);
				await flushRender(term);
				expect(Bun.stripANSI(term.getViewport()[0] ?? "").trimEnd()).toBe(line);
			} finally {
				tui.stop();
				setCellDimensions(originalCellDimensions);
			}
		});
	});
	it("selects visible transcript text without repainting untouched rows", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 4);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(["alpha beta gamma"]));

			try {
				tui.start();
				await flushRender(term);
				writes.length = 0;

				term.sendInput("\x1b[<0;7;1M");
				term.sendInput("\x1b[<32;10;1M");
				term.sendInput("\x1b[<0;10;1m");
				await flushRender(term);
				const selectionPaint = writes.join("");
				expect(selectionPaint).toContain("\x1b[1;1H");
				expect(selectionPaint).not.toContain("\x1b[2;1H");
				expect(selectionPaint).not.toContain("\x1b[3;1H");
				expect(selectionPaint).not.toContain("\x1b[4;1H");

				expect(term.getViewportRowBackgroundColumns(0)).toEqual([6, 7, 8, 9]);
				term.sendInput("\x03");
				expect(writes.join("")).toContain(`\x1b]52;c;${Buffer.from("beta").toString("base64")}\x07`);

				term.sendInput("\x1b[<0;1;1M");
				term.sendInput("\x1b[<0;1;1m");
				await flushRender(term);

				expect(term.getViewportRowBackgroundColumns(0)).toEqual([]);
			} finally {
				tui.stop();
			}
		});
	});

	it("reconciles topology changes with a differential repaint", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 4);
			const writes = captureWrites(term);
			const transcript = new TranscriptComponent(["alpha", "removed", "stable"]);
			const tui = new TUI(term);
			tui.addChild(transcript);

			try {
				tui.start();
				await flushRender(term);
				writes.length = 0;

				transcript.setLines(["changed", "stable"]);
				tui.reconcileRenderTopology();
				await flushRender(term);

				const topologyPaint = writes.join("");
				expect(viewportContent(term)).toEqual(["changed", "stable", "", ""]);
				expect(topologyPaint).toContain("\x1b[1;1H");
				expect(topologyPaint).toContain("\x1b[2;1H");
				expect(topologyPaint).toContain("\x1b[3;1H");
				expect(topologyPaint).not.toContain("\x1b[4;1H");
			} finally {
				tui.stop();
			}
		});
	});

	it("right-clicks to paste without a selection and copy with one", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 4);
			const tui = new TUI(term);
			let pasteRequests = 0;
			let copiedText = "";
			tui.onAppViewportPasteRequest = () => {
				pasteRequests++;
			};
			tui.onAppViewportSelectionCopy = text => {
				copiedText = text;
			};
			tui.addChild(new TranscriptComponent(["alpha beta gamma"]));

			try {
				tui.start();
				await flushRender(term);

				term.sendInput("\x1b[<2;1;1M");
				expect(pasteRequests).toBe(1);
				expect(copiedText).toBe("");

				term.sendInput("\x1b[<0;7;1M");
				term.sendInput("\x1b[<32;10;1M");
				term.sendInput("\x1b[<0;10;1m");
				await flushRender(term);
				term.sendInput("\x1b[<2;1;1M");

				expect(pasteRequests).toBe(1);
				expect(copiedText).toBe("beta");
				await flushRender(term);
				expect(term.getViewportRowBackgroundColumns(0)).toEqual([]);

				term.sendInput("\x1b[<2;1;1M");
				expect(pasteRequests).toBe(2);
			} finally {
				tui.stop();
			}
		});
	});

	it("clears selected source rows when the transcript shrinks", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 4);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			const transcript = new TranscriptComponent(["zero", "alpha beta gamma"]);
			tui.addChild(transcript);

			try {
				tui.start();
				await flushRender(term);

				term.sendInput("\x1b[<0;7;2M");
				term.sendInput("\x1b[<32;10;2M");
				term.sendInput("\x1b[<0;10;2m");
				await flushRender(term);
				expect(term.getViewportRowBackgroundColumns(1)).toEqual([6, 7, 8, 9]);

				transcript.setLines(["replacement"]);
				tui.requestRender(true);
				await flushRender(term);

				expect(term.getViewportRowBackgroundColumns(0)).toEqual([]);
				term.sendInput("\x03");
				expect(writes.join("")).not.toContain(`\x1b]52;c;${Buffer.from("beta").toString("base64")}\x07`);
			} finally {
				tui.stop();
			}
		});
	});

	it("copies reverse multi-line selections", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(["zero alpha", "one beta", "two gamma"]));

			try {
				tui.start();
				await flushRender(term);

				term.sendInput("\x1b[<0;8;2M");
				term.sendInput("\x1b[<32;6;1M");
				term.sendInput("\x1b[<0;6;1m");
				await flushRender(term);

				expect(term.getViewportRowBackgroundColumns(0)).toEqual([5, 6, 7, 8, 9]);
				expect(term.getViewportRowBackgroundColumns(1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
				term.sendInput("\x03");
				expect(writes.join("")).toContain(`\x1b]52;c;${Buffer.from("alpha\none beta").toString("base64")}\x07`);
			} finally {
				tui.stop();
			}
		});
	});

	it("trims right-padded line ends when copying multi-line selections", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			// Components (and sticky chrome) often right-pad to content width.
			// Copying a full multi-line selection must not paste those spaces.
			tui.addChild(
				new TranscriptComponent(["alpha".padEnd(39, " "), "beta".padEnd(39, " "), "gamma".padEnd(39, " ")]),
			);

			try {
				tui.start();
				await flushRender(term);

				term.sendInput("\x1b[<0;1;1M");
				term.sendInput("\x1b[<32;39;3M");
				term.sendInput("\x1b[<0;39;3m");
				await flushRender(term);

				term.sendInput("\x03");
				expect(writes.join("")).toContain(`\x1b]52;c;${Buffer.from("alpha\nbeta\ngamma").toString("base64")}\x07`);
			} finally {
				tui.stop();
			}
		});
	});

	it("copies styled wide-character selections as plain text", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 4);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(["\x1b[31m你好\x1b[0m beta"]));

			try {
				tui.start();
				await flushRender(term);

				term.sendInput("\x1b[<0;1;1M");
				term.sendInput("\x1b[<32;4;1M");
				term.sendInput("\x1b[<0;4;1m");
				await flushRender(term);

				expect(term.getViewportRowBackgroundColumns(0)).toEqual([0, 1, 2, 3]);
				term.sendInput("\x03");
				expect(writes.join("")).toContain(`\x1b]52;c;${Buffer.from("你好").toString("base64")}\x07`);
			} finally {
				tui.stop();
			}
		});
	});

	it("auto-scrolls while dragging selection past the viewport edge", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(Array.from({ length: 20 }, (_value, index) => `row-${index}`)));

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-15", "row-16", "row-17", "row-18", "row-19"]);

				term.sendInput("\x1b[<0;7;4M");
				for (let i = 0; i < 3; i++) term.sendInput("\x1b[<32;1;1M");
				term.sendInput("\x1b[<0;1;1m");
				await flushRender(term);

				expect(viewportContent(term)).toEqual(["row-12", "row-13", "row-14", "row-15", "row-16"]);
				term.sendInput("\x03");
				expect(writes.join("")).toContain(
					`\x1b]52;c;${Buffer.from(["row-12", "row-13", "row-14", "row-15", "row-16", "row-17", "row-18"].join("\n")).toString("base64")}\x07`,
				);
			} finally {
				tui.stop();
			}
		});
	});

	it("extends selection with the wheel while dragging", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(Array.from({ length: 20 }, (_value, index) => `row-${index}`)));
			tui.addChild(new StaticLines(["status", "editor"]));

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-17", "row-18", "row-19", "status", "editor"]);

				// Drag on the last transcript row, then wheel up without releasing.
				// Do not send a follow-up motion on the bottom scroll edge: that edge
				// is the auto-scroll zone and would step the viewport back down.
				term.sendInput("\x1b[<0;1;3M");
				term.sendInput("\x1b[<32;5;3M");
				term.sendInput("\x1b[<64;5;3M");
				term.sendInput("\x1b[<0;5;3m");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-14", "row-15", "row-16", "status", "editor"]);
				// Anchor stayed on row-19; focus remapped under the pointer to
				// row-16 after the wheel. Partial line ends are intentional.
				term.sendInput("\x03");
				expect(writes.join("")).toContain(
					`\x1b]52;c;${Buffer.from("16\nrow-17\nrow-18\nr").toString("base64")}\x07`,
				);
			} finally {
				tui.stop();
			}
		});
	});

	it("selects sticky powerline and editor chrome", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(Array.from({ length: 10 }, (_value, index) => `row-${index}`)));
			const powerline = "\x1b[48;2;30;30;30m\x1b[38;5;81m model \x1b[0m\x1b[48;2;50;50;50m path \x1b[0m";
			tui.addChild(new StaticLines([powerline, "hello world input"]));

			try {
				tui.start();
				await flushRender(term);

				// Select the powerline status strip (sticky chrome row).
				term.sendInput("\x1b[<0;2;4M");
				term.sendInput("\x1b[<32;8;4M");
				term.sendInput("\x1b[<0;8;4m");
				await flushRender(term);

				// Selection fill must be present even when segment styles are
				// coalesced into a multi-parameter SGR around the selected text.
				expect(writes.join("")).toMatch(/\x1b\[[0-9;:]*48;2;80;80;80m/);
				term.sendInput("\x03");
				expect(writes.join("")).toContain(`\x1b]52;c;${Buffer.from("model  ").toString("base64")}\x07`);

				// Select editor text without auto-scroll stealing the sticky rows.
				writes.length = 0;
				term.sendInput("\x1b[<0;1;5M");
				term.sendInput("\x1b[<32;11;5M");
				term.sendInput("\x1b[<0;11;5m");
				await flushRender(term);

				expect(term.getViewportRowBackgroundColumns(4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
				term.sendInput("\x03");
				expect(writes.join("")).toContain(`\x1b]52;c;${Buffer.from("hello world").toString("base64")}\x07`);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps sticky chrome selection put while the transcript streams", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const transcript = new TranscriptComponent(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
			const tui = new TUI(term);
			tui.addChild(transcript);
			tui.addChild(new StaticLines(["status strip", "hello world input"]));

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-7", "row-8", "row-9", "status strip", "hello world input"]);

				// Held drag on the sticky editor while follow is pinned to the tail.
				term.sendInput("\x1b[<0;1;5M");
				term.sendInput("\x1b[<32;11;5M");
				await flushRender(term);
				expect(term.getViewportRowBackgroundColumns(4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

				// Streamed transcript rows shift sticky absolute indices; the
				// highlight must stay on the editor row, not jump into history.
				transcript.append("row-10");
				transcript.append("row-11");
				tui.requestRender(true);
				await flushRender(term);

				expect(viewportContent(term)).toEqual(["row-9", "row-10", "row-11", "status strip", "hello world input"]);
				expect(term.getViewportRowBackgroundColumns(3)).toEqual([]);
				expect(term.getViewportRowBackgroundColumns(4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

				// Continue the drag after the remap and copy the same editor text.
				term.sendInput("\x1b[<32;14;5M");
				term.sendInput("\x1b[<0;14;5m");
				await flushRender(term);
				expect(term.getViewportRowBackgroundColumns(4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

				term.sendInput("\x03");
				expect(writes.join("")).toContain(`\x1b]52;c;${Buffer.from("hello world in").toString("base64")}\x07`);
			} finally {
				tui.stop();
			}
		});
	});

	it("selects a word on double click", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 4);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(["alpha beta gamma"]));

			try {
				tui.start();
				await flushRender(term);

				term.sendInput("\x1b[<0;8;1M");
				term.sendInput("\x1b[<0;8;1m");
				term.sendInput("\x1b[<0;8;1M");
				term.sendInput("\x1b[<0;8;1m");
				await flushRender(term);

				expect(term.getViewportRowBackgroundColumns(0)).toEqual([6, 7, 8, 9]);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps URLs and paths together on double click", async () => {
		const cases = [
			["visit https://example.com/a-b?x=1#top now", "example", "https://example.com/a-b?x=1#top"],
			["open /tmp/foo-bar_baz.ts:42 now", "foo", "/tmp/foo-bar_baz.ts:42"],
		] as const;
		for (const [line, clickText, expected] of cases) {
			await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
				const term = new VirtualTerminal(80, 4);
				const tui = new TUI(term);
				let copiedText = "";
				tui.onAppViewportSelectionCopy = text => {
					copiedText = text;
				};
				tui.addChild(new TranscriptComponent([line]));

				try {
					tui.start();
					await flushRender(term);

					const col = line.indexOf(clickText) + 1;
					for (let i = 0; i < 2; i++) {
						term.sendInput(`\x1b[<0;${col};1M`);
						term.sendInput(`\x1b[<0;${col};1m`);
					}
					await flushRender(term);
					term.sendInput("\x03");

					expect(copiedText).toBe(expected);
				} finally {
					tui.stop();
				}
			});
		}
	});

	it("selects a line on triple click", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 4);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(["alpha beta gamma"]));

			try {
				tui.start();
				await flushRender(term);

				for (let i = 0; i < 3; i++) {
					term.sendInput("\x1b[<0;8;1M");
					term.sendInput("\x1b[<0;8;1m");
				}
				await flushRender(term);

				expect(term.getViewportRowBackgroundColumns(0)).toEqual(
					Array.from({ length: 16 }, (_value, index) => index),
				);
				term.sendInput("\x03");
				expect(writes.join("")).toContain(`\x1b]52;c;${Buffer.from("alpha beta gamma").toString("base64")}\x07`);
			} finally {
				tui.stop();
			}
		});
	});

	it("replays visible SIXEL atomically when another viewport row changes", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const previousProtocol = TERMINAL.imageProtocol;
			const scheduler = new StressRenderScheduler();
			const term = new VirtualTerminal(20, 4);
			const writes = captureWrites(term);
			const wideSixel = "\x1bPqWIDE~\x1b\\";
			const narrowSixel = "\x1bPqNARROW~\x1b\\";
			const transcript = new TranscriptComponent(["\x1b[0m", wideSixel, "status-0"]);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(transcript);

			try {
				setTerminalImageProtocol(ImageProtocol.Sixel);
				tui.start();
				await scheduler.drain(term);
				writes.length = 0;

				transcript.setLines(["\x1b[0m", narrowSixel, "status-1"]);
				tui.requestComponentRender(transcript);
				await scheduler.drain(term);

				const repaint = writes.join("");
				expect(repaint).toContain(narrowSixel);
				expect(repaint.indexOf("\x1b[?2J")).toBeLessThan(repaint.indexOf(narrowSixel));
				expect(repaint).toContain("\x1b[2J\x1b[?2J\x1b[H");
				for (let row = 1; row <= term.rows; row++) expect(repaint).toContain(`\x1b[${row};1H`);

				writes.length = 0;
				transcript.setLines(["\x1b[0m", narrowSixel, "status-stream"]);
				tui.requestComponentRender(transcript);
				await scheduler.drain(term);
				expect(writes.join("")).not.toContain("\x1b[2J");
				expect(writes.join("")).not.toContain(narrowSixel);

				expect(writes.join("")).not.toContain("\x1b[?2J");

				writes.length = 0;
				transcript.setLines(["", "", "status-2"]);
				tui.requestComponentRender(transcript);
				await scheduler.drain(term);
				expect(writes.join("")).toContain("\x1b[2J\x1b[?2J\x1b[H");
			} finally {
				tui.stop();
				setTerminalImageProtocol(previousProtocol);
			}
		});
	});

	it("clears the old SIXEL footprint when only a workspace split width changes", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const previousProtocol = TERMINAL.imageProtocol;
			const scheduler = new StressRenderScheduler();
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const widths: number[] = [];
			const imagePane: Component = {
				render(width: number): readonly string[] {
					widths.push(width);
					return ["\x1b[0m", `\x1bPqwidth-${width}~\x1b\\`];
				},
			};
			const model = WorkspaceModel.single("image");
			expect(model.splitPane("image", "text", "right")).toBe(true);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const workspace = new WorkspaceLayout({
				model,
				height: () => term.rows,
				requestRender: () => tui.requestRender(),
				panes: [
					{ paneId: "image", title: "Image", component: imagePane },
					{ paneId: "text", title: "Text", component: new StaticLines(["right-pane"]) },
				],
			});
			tui.addChild(workspace);

			try {
				setTerminalImageProtocol(ImageProtocol.Sixel);
				tui.start();
				await scheduler.drain(term);
				const oldWidth = widths.at(-1)!;
				const split = model.root;
				if (split.kind !== "split") throw new Error("Expected split workspace");
				writes.length = 0;

				expect(model.resizeSplit(split.splitId, 0, 8, 32)).toBe(true);
				tui.requestRender();
				await scheduler.drain(term);

				const newWidth = widths.at(-1)!;
				const repaint = writes.join("");
				const newSixel = `\x1bPqwidth-${newWidth}~\x1b\\`;
				expect(newWidth).toBeLessThan(oldWidth);
				expect(repaint.indexOf("\x1b[?2J")).toBeLessThan(repaint.indexOf(newSixel));
				expect(repaint).toContain("right-pane");
			} finally {
				tui.stop();
				setTerminalImageProtocol(previousProtocol);
			}
		});
	});

	it("clips an embedded workspace Kitty placement to the pane body", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const previousProtocol = TERMINAL.imageProtocol;
			const scheduler = new StressRenderScheduler();
			const term = new VirtualTerminal(120, 4);
			const writes = captureWrites(term);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const imageId = tui.imageBudget.acquireId("workspace-direct-clip");
			tui.imageBudget.registerPlacementGeometry(imageId, 40, 60);
			const placement = `\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=${imageId},p=${imageId},c=4,r=4\x1b\\\x1b8\x1b[0m│`;
			const model = WorkspaceModel.single("left");
			expect(model.splitPane("left", "image", "right")).toBe(true);
			const split = model.root;
			if (split.kind !== "split") throw new Error("Expected split workspace");
			expect(model.resizeSplit(split.splitId, 0, 80, 39)).toBe(true);
			const workspace = new WorkspaceLayout({
				model,
				height: () => term.rows,
				requestRender: () => tui.requestRender(),
				panes: [
					{ paneId: "left", title: "Left", component: new StaticLines(["left-pane"]) },
					{
						paneId: "image",
						title: "Image",
						component: new TranscriptComponent(["", "", "", placement]),
						overflow: "tail",
					},
				],
			});
			tui.addChild(workspace);

			try {
				setTerminalImageProtocol(ImageProtocol.Kitty);
				tui.start();
				await scheduler.drain(term);
				const output = writes.join("");
				expect(output).toContain(`i=${imageId},p=1,c=4,r=3,y=15,h=45`);
				expect(output).toContain(`\x1b7\x1b[2A\x1b_Ga=p`);
				expect(output).not.toContain("\x1b_pi:kp:");
			} finally {
				tui.stop();
				setTerminalImageProtocol(previousProtocol);
			}
		});
	});

	it("flushes retired Kitty ids on an unchanged frame after a protocol switch", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const previousProtocol = TERMINAL.imageProtocol;
			const scheduler = new StressRenderScheduler();
			const term = new VirtualTerminal(20, 4);
			const writes = captureWrites(term);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const imageId = tui.imageBudget.acquireId("protocol-switch-retire");
			let active = true;
			tui.addChild({
				render(): readonly string[] {
					if (active) tui.imageBudget.observe(imageId);
					return ["unchanged"];
				},
			});

			try {
				setTerminalImageProtocol(ImageProtocol.Kitty);
				tui.start();
				await scheduler.drain(term);
				writes.length = 0;

				active = false;
				setTerminalImageProtocol(ImageProtocol.Sixel);
				tui.requestRender();
				await scheduler.drain(term);
				expect(writes.join("")).toContain(`a=d,d=I,i=${imageId},q=2`);
			} finally {
				tui.stop();
				setTerminalImageProtocol(previousProtocol);
			}
		});
	});

	it("retires a Kitty image removed from the app viewport frame", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const previousProtocol = TERMINAL.imageProtocol;
			const scheduler = new StressRenderScheduler();
			const term = new VirtualTerminal(20, 6);
			const writes = captureWrites(term);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const imageId = tui.imageBudget.acquireId("removed-app-image");
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: text => text },
				{ budget: tui.imageBudget, imageKey: "removed-app-image", maxWidthCells: 4, maxHeightCells: 4 },
				{ widthPx: 40, heightPx: 40 },
			);
			tui.addChild(image);

			try {
				setTerminalImageProtocol(ImageProtocol.Kitty);
				tui.start();
				await scheduler.drain(term);
				writes.length = 0;

				tui.removeChild(image);
				tui.requestRender();
				await scheduler.drain(term);
				expect(writes.join("")).toContain(`a=d,d=I,i=${imageId},q=2`);
			} finally {
				tui.stop();
				setTerminalImageProtocol(previousProtocol);
			}
		});
	});

	it("emits a virtual placement when a workspace first shows a placeholder block mid-slice", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const previousProtocol = TERMINAL.imageProtocol;
			const previousGraphics = { ...getKittyGraphics() };
			const scheduler = new StressRenderScheduler();
			const term = new VirtualTerminal(30, 4);
			const writes = captureWrites(term);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const imageId = tui.imageBudget.acquireId("sliced-placeholder");
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: text => text },
				{ budget: tui.imageBudget, imageKey: "sliced-placeholder", maxWidthCells: 4, maxHeightCells: 4 },
				{ widthPx: 40, heightPx: 40 },
			);
			const workspace = new WorkspaceLayout({
				model: WorkspaceModel.single("image"),
				height: () => term.rows,
				requestRender: () => tui.requestRender(),
				panes: [{ paneId: "image", title: "Image", component: image, overflow: "tail" }],
			});
			tui.addChild(workspace);

			try {
				setKittyGraphics({ unicodePlaceholders: true });
				setTerminalImageProtocol(ImageProtocol.Kitty);
				tui.start();
				await scheduler.drain(term);
				expect(writes.join("")).toContain(`a=p,U=1,q=2,i=${imageId}`);
			} finally {
				tui.stop();
				setKittyGraphics(previousGraphics);
				setTerminalImageProtocol(previousProtocol);
			}
		});
	});

	it("clips direct Kitty placements that straddle the app viewport top", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const previousProtocol = TERMINAL.imageProtocol;
			const scheduler = new StressRenderScheduler();
			const term = new VirtualTerminal(20, 4);
			const writes = captureWrites(term);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const imageId = tui.imageBudget.acquireId("app-viewport-direct-clip");
			tui.imageBudget.registerPlacementGeometry(imageId, 40, 60);
			const placement = `\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=${imageId},p=${imageId},c=4,r=6\x1b\\\x1b8`;
			tui.addChild(new TranscriptComponent(["", "", placement]));

			try {
				setTerminalImageProtocol(ImageProtocol.Kitty);
				tui.start();
				await scheduler.drain(term);

				expect(writes.join("")).toContain(`i=${imageId},p=1,c=4,r=3,y=30,h=30`);
			} finally {
				tui.stop();
				setTerminalImageProtocol(previousProtocol);
			}
		});
	});

	it("repaints short frames after a Windows resize without duplicating sticky chrome", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const term = new VirtualTerminal(40, 8);
			const transcript = new TranscriptComponent(["short"]);
			const tui = new TUI(term);
			tui.addChild(transcript);
			tui.addChild(new StaticLines(["status", "editor"]));

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["short", "", "", "", "", "", "status", "editor"]);

				term.resize(40, 5);
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["short", "", "", "status", "editor"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("reserves one content column for the scrollbar", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(8, 3);
			const tui = new TUI(term);
			tui.addChild(new TranscriptComponent(["row-0", "row-1", "row-2", "row-3", "row-4"]));
			tui.addChild(new WidthFill());

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-3", "row-4", "AAAAAAA"]);
			} finally {
				tui.stop();
			}
		});
	});
	it("positions the hardware cursor in sticky chrome", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "app-viewport", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term, true);
			const cursor = new CursorLine();
			tui.addChild(new TranscriptComponent(Array.from({ length: 10 }, (_value, index) => `row-${index}`)));
			tui.addChild(cursor);
			tui.setFocus(cursor);

			try {
				tui.start();
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-6", "row-7", "row-8", "row-9", "prompt>"]);
				expect(term.getCursor()).toEqual({ row: 4, col: 7 });

				term.sendInput("\x1b[<64;1;1M");
				await flushRender(term);
				expect(viewportContent(term)).toEqual(["row-3", "row-4", "row-5", "row-6", "prompt>"]);
				expect(term.getCursor()).toEqual({ row: 4, col: 7 });
				expect(writes.join("")).toContain("\x1b[?25h");
			} finally {
				tui.stop();
			}
		});
	});

	it("stays on the native renderer unless the app viewport backend is requested", async () => {
		await withEnv("PI_TUI_RENDER_BACKEND", "", async () => {
			const term = new VirtualTerminal(40, 5);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new StaticLines(["one", "two"]));

			try {
				tui.start();
				await flushRender(term);
				expect(writes.join("")).not.toContain("\x1b[?1049h");
			} finally {
				tui.stop();
			}
		});
	});
});
