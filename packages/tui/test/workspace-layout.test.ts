import { describe, expect, it } from "bun:test";
import {
	type AppViewportHoverProvider,
	type Component,
	layoutWorkspace,
	type ViewportTailProvider,
	WorkspaceLayout,
	WorkspaceModel,
} from "@oh-my-pi/pi-tui";
import { TERMINAL_STATE_TERMINATOR } from "@oh-my-pi/pi-tui/utils";

class FillPane implements Component {
	constructor(private readonly fill: string) {}

	render(width: number): readonly string[] {
		return Array.from({ length: 20 }, () => this.fill.repeat(width));
	}
}

class HoverPane extends FillPane implements AppViewportHoverProvider {
	hover = false;
	clears = 0;

	wantsAppViewportHover(): boolean {
		return this.hover;
	}

	clearAppViewportHover(): void {
		this.clears++;
	}
}

class RawPane implements Component {
	line: string;

	constructor(line: string) {
		this.line = line;
	}

	render(): readonly string[] {
		return [this.line];
	}
}

class NumberedPane implements Component {
	render(): readonly string[] {
		return Array.from({ length: 10 }, (_value, index) => `line-${index}`);
	}
}

class TailPane implements Component, ViewportTailProvider {
	fullRenders = 0;
	tailRenders = 0;

	render(width: number): readonly string[] {
		this.fullRenders++;
		return Array.from({ length: 100 }, (_value, index) => `${index}`.padEnd(width));
	}

	renderViewportTail(width: number, maxRows: number): readonly string[] {
		this.tailRenders++;
		return Array.from({ length: maxRows }, (_value, index) => `tail-${index}`.padEnd(width));
	}
}

describe("WorkspaceModel", () => {
	it("rejects invalid initial trees before they can produce ambiguous pane ownership", () => {
		expect(
			() =>
				new WorkspaceModel({
					kind: "split",
					splitId: "root",
					axis: "x",
					children: [
						{ node: { kind: "pane", paneId: "duplicate" }, weight: 1 },
						{ node: { kind: "pane", paneId: "duplicate" }, weight: 1 },
					],
				}),
		).toThrow("Duplicate workspace pane");
	});

	it("lays out recursively split panes without gaps or overlap", () => {
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "agent-a", "right")).toBe(true);
		expect(model.splitPane("agent-a", "agent-b", "bottom")).toBe(true);

		const frame = layoutWorkspace(model.root, { x: 0, y: 0, width: 120, height: 40 }, () => ({
			minWidth: 10,
			minHeight: 5,
		}));

		expect(frame.constrained).toBe(false);
		expect(frame.panes.get("main")).toEqual({ x: 0, y: 0, width: 60, height: 40 });
		expect(frame.panes.get("agent-a")).toEqual({ x: 61, y: 0, width: 59, height: 20 });
		expect(frame.panes.get("agent-b")).toEqual({ x: 61, y: 21, width: 59, height: 19 });
		expect(frame.sashes).toEqual([
			{
				splitId: expect.any(String),
				boundary: 0,
				axis: "x",
				rect: { x: 60, y: 0, width: 1, height: 40 },
				beforeSize: 60,
				beforeMin: 10,
				afterMin: 10,
				afterSize: 59,
			},
			{
				splitId: expect.any(String),
				boundary: 0,
				axis: "y",
				rect: { x: 61, y: 20, width: 59, height: 1 },
				beforeSize: 20,
				afterSize: 19,
				beforeMin: 5,
				afterMin: 5,
			},
		]);
	});

	it("returns a closed pane's share to its adjacent sibling and collapses redundant splits", () => {
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "agent-a", "right")).toBe(true);
		expect(model.splitPane("main", "agent-b", "right")).toBe(true);
		expect(model.closePane("agent-b")).toBe(true);

		const frame = layoutWorkspace(model.root, { x: 0, y: 0, width: 120, height: 20 }, () => ({
			minWidth: 10,
			minHeight: 5,
		}));

		expect(model.root).toMatchObject({
			kind: "split",
			axis: "x",
			children: [{ node: { paneId: "main" } }, { node: { paneId: "agent-a" } }],
		});
		expect(frame.panes.get("main")).toEqual({ x: 0, y: 0, width: 60, height: 20 });
		expect(frame.panes.get("agent-a")).toEqual({ x: 61, y: 0, width: 59, height: 20 });
	});

	it("composes bounded panes and resizes adjacent panes by dragging their sash", () => {
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "agent", "right")).toBe(true);
		let renders = 0;
		const workspace = new WorkspaceLayout({
			model,
			height: () => 4,
			requestRender: () => renders++,
			panes: [
				{ paneId: "main", title: "Main", component: new FillPane("M"), minWidth: 3, minHeight: 2 },
				{ paneId: "agent", title: "A", component: new FillPane("A"), minWidth: 3, minHeight: 2 },
			],
		});

		expect(workspace.render(11)).toEqual([">Main│ A   ", "MMMMM│AAAAA", "MMMMM│AAAAA", "MMMMM│AAAAA"]);

		workspace.handleAppViewportMouse({
			button: 0,
			col: 5,
			row: 2,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			rightClick: false,
		});
		workspace.handleAppViewportMouse({
			button: 32,
			col: 7,
			row: 2,
			release: false,
			wheel: null,
			motion: true,
			leftClick: false,
			rightClick: false,
		});
		workspace.handleAppViewportMouse({
			button: 0,
			col: 7,
			row: 2,
			release: true,
			wheel: null,
			motion: false,
			leftClick: false,
			rightClick: false,
		});
		workspace.render(11);

		expect(workspace.frame?.panes.get("main")).toEqual({ x: 0, y: 0, width: 7, height: 4 });
		expect(workspace.frame?.panes.get("agent")).toEqual({ x: 8, y: 0, width: 3, height: 4 });
		expect(renders).toBeGreaterThan(0);
	});
	it("closes truncated OSC 8 hyperlinks before composing a horizontal sibling", () => {
		const open = "\x1b]8;;https://example.test\x07";
		const close = "\x1b]8;;\x07";
		const model = WorkspaceModel.single("linked");
		expect(model.splitPane("linked", "plain", "right")).toBe(true);
		const workspace = new WorkspaceLayout({
			model,
			height: () => 3,
			requestRender: () => {},
			panes: [
				{ paneId: "linked", title: "Linked", component: new RawPane(`${open}${"L".repeat(30)}${close}`) },
				{ paneId: "plain", title: "Plain", component: new RawPane("RIGHT") },
			],
		});

		const content = workspace.render(21)[1]!;
		const siblingStart = content.indexOf("RIGHT");
		expect(siblingStart).toBeGreaterThan(0);
		expect(content.lastIndexOf(close, siblingStart)).toBeGreaterThan(content.lastIndexOf(open, siblingStart));
	});

	it("moves a pane through a header drag and normalizes the resulting layout", () => {
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "agent", "right")).toBe(true);
		expect(model.splitPane("agent", "worker", "bottom")).toBe(true);
		const workspace = new WorkspaceLayout({
			model,
			height: () => 10,
			requestRender: () => {},
			panes: [
				{ paneId: "main", title: "Main", component: new FillPane("M"), minWidth: 3, minHeight: 3 },
				{ paneId: "agent", title: "Agent", component: new FillPane("A"), minWidth: 3, minHeight: 3 },
				{ paneId: "worker", title: "Worker", component: new FillPane("W"), minWidth: 3, minHeight: 3 },
			],
		});
		workspace.render(30);
		const worker = workspace.frame?.panes.get("worker");
		expect(worker).toBeDefined();

		workspace.handleAppViewportMouse({
			button: 0,
			col: worker!.x + 1,
			row: worker!.y,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			rightClick: false,
		});
		workspace.handleAppViewportMouse({
			button: 32,
			col: 0,
			row: 1,
			release: false,
			wheel: null,
			motion: true,
			leftClick: false,
			rightClick: false,
		});
		expect(workspace.render(30).some(line => Bun.stripANSI(line).startsWith("┏"))).toBe(true);
		workspace.handleAppViewportMouse({
			button: 0,
			col: 0,
			row: 1,
			release: true,
			wheel: null,
			motion: false,
			leftClick: false,
			rightClick: false,
		});
		workspace.render(30);

		expect(workspace.frame?.panes.get("worker")).toEqual({ x: 0, y: 0, width: 7, height: 10 });
		expect(workspace.frame?.panes.get("main")).toEqual({ x: 8, y: 0, width: 7, height: 10 });
		expect(workspace.frame?.panes.get("agent")).toEqual({ x: 16, y: 0, width: 14, height: 10 });
	});

	it("renders an ANSI-isolated live ghost of the dragged pane inside the drop frame", () => {
		const model = WorkspaceModel.single("target");
		expect(model.splitPane("target", "agent", "right")).toBe(true);
		expect(model.splitPane("agent", "source", "bottom")).toBe(true);
		const sourcePane = new RawPane("\x1b[31m GHOST");
		const workspace = new WorkspaceLayout({
			model,
			height: () => 10,
			requestRender: () => {},
			renderDropPreview: (text: string) => `\x1b[35m${text}\x1b[39m`,
			renderDropPreviewGhost: (text: string) => `\x1b[36m${text}\x1b[39m`,
			panes: [
				{ paneId: "target", title: "Target", component: new RawPane("\x1b[31mTARGET"), minWidth: 3, minHeight: 3 },
				{ paneId: "agent", title: "Agent", component: new FillPane("A"), minWidth: 3, minHeight: 3 },
				{ paneId: "source", title: "Source", component: sourcePane, minWidth: 3, minHeight: 3 },
			],
		});
		workspace.render(30);
		const source = workspace.frame?.panes.get("source");
		expect(source).toBeDefined();

		workspace.handleAppViewportMouse({
			button: 0,
			col: source!.x + 1,
			row: source!.y,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			rightClick: false,
		});
		workspace.handleAppViewportMouse({
			button: 32,
			col: 0,
			row: 1,
			release: false,
			wheel: null,
			motion: true,
			leftClick: false,
			rightClick: false,
		});

		const preview = workspace.render(30);
		const stripped = preview.map(line => Bun.stripANSI(line));
		expect(stripped.some(line => line.startsWith("┏━━━━━┓"))).toBe(true);
		const ghostLine = preview.find(line => Bun.stripANSI(line).startsWith("┃GHOST┃"));
		expect(ghostLine).toBeDefined();
		expect(ghostLine).toContain(`${TERMINAL_STATE_TERMINATOR}\x1b[35m┃`);
		expect(ghostLine).toContain(`${TERMINAL_STATE_TERMINATOR}\x1b[36mGHOST\x1b[39m${TERMINAL_STATE_TERMINATOR}`);
		sourcePane.line = "CHANGED";
		expect(workspace.render(30).some(line => Bun.stripANSI(line).startsWith("┃GHOST┃"))).toBe(true);

		workspace.handleAppViewportMouse({
			button: 0,
			col: 0,
			row: 1,
			release: true,
			wheel: null,
			motion: false,
			leftClick: false,
			rightClick: false,
		});
		expect(workspace.render(30).some(line => /[┏┓┗┛━┃█]/u.test(Bun.stripANSI(line)))).toBe(false);
	});

	it("preserves the layout tree while terminal geometry is temporarily constrained", () => {
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "agent", "right")).toBe(true);
		const root = model.root;
		const constraints = () => ({ minWidth: 8, minHeight: 3 });

		const narrow = layoutWorkspace(model.root, { x: 0, y: 0, width: 10, height: 5 }, constraints);
		expect(narrow.constrained).toBe(true);
		expect(narrow.panes.get("main")).toEqual({ x: 0, y: 0, width: 5, height: 5 });
		expect(narrow.panes.get("agent")).toEqual({ x: 6, y: 0, width: 4, height: 5 });
		expect(model.root).toBe(root);

		const restored = layoutWorkspace(model.root, { x: 0, y: 0, width: 21, height: 5 }, constraints);
		expect(restored.constrained).toBe(false);
		expect(restored.panes.get("main")).toEqual({ x: 0, y: 0, width: 10, height: 5 });
		expect(restored.panes.get("agent")).toEqual({ x: 11, y: 0, width: 10, height: 5 });
	});

	it("keeps scroll state local to each workspace pane", () => {
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "agent", "right")).toBe(true);
		const workspace = new WorkspaceLayout({
			model,
			height: () => 4,
			requestRender: () => {},
			panes: [
				{ paneId: "main", title: "Main", component: new NumberedPane(), overflow: "tail", minWidth: 3 },
				{ paneId: "agent", title: "Agent", component: new NumberedPane(), overflow: "tail", minWidth: 3 },
			],
		});

		expect(workspace.render(21).join("\n")).toContain("line-9");
		workspace.handleAppViewportMouse({
			button: 64,
			col: 2,
			row: 2,
			release: false,
			wheel: -1,
			motion: false,
			leftClick: false,
			rightClick: false,
		});
		const rendered = workspace.render(21);

		expect(rendered.slice(1).map(line => line.slice(0, 10).trim())).toEqual(["line-4", "line-5", "line-6"]);
		expect(rendered.slice(1).map(line => line.slice(11).trim())).toEqual(["line-7", "line-8", "line-9"]);
	});

	it("prefers a pane header renderer over the workspace fallback", () => {
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "agent", "right")).toBe(true);
		const workspace = new WorkspaceLayout({
			model,
			height: () => 3,
			requestRender: () => {},
			renderHeader: pane => `f:${pane.paneId}`,
			panes: [
				{ paneId: "main", title: "Main", component: new FillPane("m"), minWidth: 3 },
				{
					paneId: "agent",
					title: "Agent",
					component: new FillPane("a"),
					minWidth: 3,
					renderHeader: (_width, focused) => `agent:${focused ? "focused" : "idle"}`,
				},
			],
		});

		const rendered = workspace.render(21);
		expect(rendered[0]?.slice(0, 10).trim()).toBe("f:main");
		expect(rendered[0]?.slice(11).trim()).toBe("agent:idle");
	});

	it("aggregates hover tracking requests from pane components", () => {
		const pane = new HoverPane("h");
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => 3,
			requestRender: () => {},
			panes: [{ paneId: "main", title: "Main", component: pane, minWidth: 3 }],
		});

		expect(workspace.wantsAppViewportHover()).toBe(false);
		pane.hover = true;
		expect(workspace.wantsAppViewportHover()).toBe(true);
	});

	it("clears transient hover state when the pointer leaves a pane body", () => {
		const main = new HoverPane("m");
		const side = new HoverPane("s");
		main.hover = true;
		side.hover = true;
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "side", "right")).toBe(true);
		const workspace = new WorkspaceLayout({
			model,
			height: () => 4,
			requestRender: () => {},
			panes: [
				{ paneId: "main", title: "Main", component: main, minWidth: 3 },
				{ paneId: "side", title: "Side", component: side, minWidth: 3 },
			],
		});
		workspace.render(21);

		workspace.handleAppViewportMouse({
			button: 32,
			col: 1,
			row: 1,
			release: false,
			wheel: null,
			motion: true,
			leftClick: false,
			rightClick: false,
		});
		workspace.handleAppViewportMouse({
			button: 32,
			col: 12,
			row: 1,
			release: false,
			wheel: null,
			motion: true,
			leftClick: false,
			rightClick: false,
		});

		expect(main.clears).toBe(1);
		expect(side.clears).toBe(0);
	});

	it("uses viewport-tail rendering during an active sash drag and settles with a full render", () => {
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "agent", "right")).toBe(true);
		const main = new TailPane();
		const agent = new TailPane();
		const workspace = new WorkspaceLayout({
			model,
			height: () => 6,
			requestRender: () => {},
			panes: [
				{ paneId: "main", title: "Main", component: main, overflow: "tail", minWidth: 3 },
				{ paneId: "agent", title: "Agent", component: agent, overflow: "tail", minWidth: 3 },
			],
		});
		workspace.render(21);
		main.fullRenders = 0;
		agent.fullRenders = 0;

		workspace.handleAppViewportMouse({
			button: 0,
			col: 10,
			row: 2,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			rightClick: false,
		});
		workspace.handleAppViewportMouse({
			button: 32,
			col: 12,
			row: 2,
			release: false,
			wheel: null,
			motion: true,
			leftClick: false,
			rightClick: false,
		});
		workspace.render(21);
		expect(main.fullRenders + agent.fullRenders).toBe(0);
		expect(main.tailRenders + agent.tailRenders).toBe(2);

		workspace.handleAppViewportMouse({
			button: 0,
			col: 12,
			row: 2,
			release: true,
			wheel: null,
			motion: false,
			leftClick: false,
			rightClick: false,
		});
		workspace.render(21);
		expect(main.fullRenders + agent.fullRenders).toBe(2);
	});

	it("supports recursively nested pane counts without a fixed layout limit", () => {
		const model = WorkspaceModel.single("pane-0");
		for (let index = 1; index <= 16; index++) {
			const edge = index % 2 === 0 ? "bottom" : "right";
			expect(model.splitPane(`pane-${index - 1}`, `pane-${index}`, edge)).toBe(true);
		}

		const frame = layoutWorkspace(model.root, { x: 0, y: 0, width: 400, height: 200 }, () => ({
			minWidth: 1,
			minHeight: 1,
		}));
		expect(frame.panes.size).toBe(17);
		expect(frame.panes.has("pane-16")).toBe(true);
	});
});
