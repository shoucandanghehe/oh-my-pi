import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { AutoAgentWorkspaceController } from "@oh-my-pi/pi-coding-agent/modes/controllers/auto-agent-workspace-controller";
import { WorkspacePaneController } from "@oh-my-pi/pi-coding-agent/modes/controllers/workspace-pane-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	type Component,
	type Focusable,
	parseSgrMouse,
	ProcessTerminal,
	TUI,
	WorkspaceLayout,
	WorkspaceModel,
} from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});
afterAll(() => resetSettingsForTest());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function createWorkspace(width = 120, initialHeight = 40) {
	let height = initialHeight;
	let focus: Component & Partial<Focusable> = { render: () => ["Main"], focused: true };
	const ui = new TUI(new ProcessTerminal());
	const workspace = new WorkspaceLayout({
		model: WorkspaceModel.single("main"),
		height: () => height,
		requestRender: () => {},
		focus: component => {
			focus.focused = false;
			focus = component;
			focus.focused = true;
		},
		panes: [{ paneId: "main", title: "Main", component: focus, minWidth: 40, minHeight: 8 }],
	});
	workspace.render(width);
	const panes = new WorkspacePaneController(workspace);
	const registry = new AgentRegistry();
	const viewers = new Map<string, AgentTranscriptViewer>();
	const controller = new AutoAgentWorkspaceController({
		workspace,
		panes,
		createViewer: (id, onClose) => {
			const viewer = new AgentTranscriptViewer({
				agentId: id,
				registry,
				ui,
				cwd: process.cwd(),
				expandKeys: ["ctrl+o"],
				hubKeys: ["ctrl+a"],
				createStatusLine: () => ({
					getTopBorder: () => ({ content: "", width: 0, revision: 0 }),
					dispose: () => {},
				}),
				requestRender: () => {},
				onClose,
				onHubToggle: () => {},
			});
			viewers.set(id, viewer);
			return viewer;
		},
	});
	const unsubscribe = registry.onChange(event => controller.handleEvent(event));
	return {
		workspace,
		panes,
		registry,
		viewers,
		controller,
		add(id: string) {
			registry.register({ id, displayName: id, kind: "sub", parentId: "Main", status: "running", session: null });
		},
		paint(nextWidth = width, nextHeight = height) {
			width = nextWidth;
			height = nextHeight;
			return Bun.stripANSI(workspace.render(width).join("\n"));
		},
		input(data: string) {
			focus.handleInput?.(data);
		},
		dispose() {
			unsubscribe();
			controller.reset();
			panes.dispose();
		},
	};
}

describe("automatic agent workspace", () => {
	it("opens ordinary panes without a two-pane cap, leaving Main and focus stable", () => {
		const h = createWorkspace(160, 80);
		try {
			h.add("A");
			h.paint();
			const main = { ...h.workspace.frame!.panes.get("main")! };
			for (const id of ["B", "C", "D"]) h.add(id);
			h.paint();
			expect([...h.workspace.frame!.panes.keys()].sort()).toEqual([
				"agent:A",
				"agent:B",
				"agent:C",
				"agent:D",
				"main",
			]);
			expect(h.workspace.frame!.panes.get("main")).toEqual(main);
			expect(h.workspace.focusedPaneId).toBe("main");
		} finally {
			h.dispose();
		}
	});

	it("defers when space is full, refills after exit, and cancels exit on a resumed run", () => {
		vi.useFakeTimers();
		const h = createWorkspace();
		try {
			for (const id of ["A", "B", "C"]) h.add(id);
			h.paint();
			expect(h.panes.has("agent:C")).toBe(false);
			const main = { ...h.workspace.frame!.panes.get("main")! };
			h.registry.setStatus("A", "idle");
			vi.advanceTimersByTime(2_000);
			expect(h.panes.has("agent:A")).toBe(true);
			h.registry.setStatus("A", "running");
			vi.advanceTimersByTime(2_000);
			expect(h.panes.has("agent:A")).toBe(true);
			h.registry.setStatus("A", "idle");
			vi.advanceTimersByTime(3_100);
			h.paint();
			expect(h.panes.has("agent:A")).toBe(false);
			expect(h.panes.has("agent:C")).toBe(true);
			expect(h.workspace.frame!.panes.get("main")).toEqual(main);
			h.registry.setStatus("B", "idle");
			h.registry.setStatus("C", "idle");
			vi.advanceTimersByTime(3_100);
			h.paint();
			expect([...h.workspace.frame!.panes.keys()]).toEqual(["main"]);
		} finally {
			h.dispose();
		}
	});

	it("focuses headers without moving panes and permits dragging out and back through Workspace", () => {
		vi.useFakeTimers();
		const h = createWorkspace(160, 60);
		const press = parseSgrMouse("\x1b[<0;1;1M")!;
		const release = parseSgrMouse("\x1b[<0;1;1m")!;
		const motion = parseSgrMouse("\x1b[<32;1;1M")!;
		try {
			h.add("A");
			h.add("B");
			h.paint();
			const root = h.workspace.model.root;
			for (const id of ["A", "B", "A"]) {
				const rect = h.workspace.frame!.panes.get(`agent:${id}`)!;
				h.workspace.handleAppViewportMouse({ ...press, row: rect.y + 0.2, col: rect.x + 2.2 });
				h.workspace.handleAppViewportMouse({ ...motion, row: rect.y + 0.3, col: rect.x + 2.3 });
				h.workspace.handleAppViewportMouse({ ...release, row: rect.y + 0.3, col: rect.x + 2.3 });
				expect(h.workspace.focusedPaneId).toBe(`agent:${id}`);
				expect(h.workspace.model.root).toBe(root);
				h.paint();
			}
			const original = h.workspace.frame!.panes.get("agent:A")!;
			h.workspace.handleAppViewportMouse({ ...press, row: original.y, col: original.x + 2 });
			h.workspace.handleAppViewportMouse({ ...motion, row: 20, col: 1 });
			h.workspace.handleAppViewportMouse({ ...release, row: 20, col: 1 });
			h.paint();
			expect(h.workspace.frame!.panes.get("agent:A")!.x).toBeLessThan(h.workspace.frame!.panes.get("main")!.x);
			const moved = h.workspace.frame!.panes.get("agent:A")!;
			const target = h.workspace.frame!.panes.get("agent:B")!;
			h.workspace.handleAppViewportMouse({ ...press, row: moved.y, col: moved.x + 2 });
			h.workspace.handleAppViewportMouse({
				...motion,
				row: target.y + target.height - 1,
				col: target.x + target.width / 2,
			});
			h.workspace.handleAppViewportMouse({
				...release,
				row: target.y + target.height - 1,
				col: target.x + target.width / 2,
			});
			h.paint();
			expect(h.workspace.frame!.panes.get("agent:A")!.x).toBe(h.workspace.frame!.panes.get("agent:B")!.x);
			expect(h.workspace.frame!.panes.get("agent:A")!.y).toBeGreaterThan(h.workspace.frame!.panes.get("agent:B")!.y);
			h.workspace.focusPane("main");
			h.registry.setStatus("A", "idle");
			vi.advanceTimersByTime(4_000);
			expect(h.panes.has("agent:A")).toBe(true);
		} finally {
			h.dispose();
		}
	});

	it("allows resizing between agents and preserves user-sized panes after they yield", () => {
		vi.useFakeTimers();
		const h = createWorkspace(160, 60);
		try {
			h.add("A");
			h.add("B");
			h.paint();
			const before = h.workspace.frame!.panes.get("agent:A")!.height;
			const sash = h.workspace.frame!.sashes.find(item => item.axis === "y")!;
			const col = sash.rect.x + 2;
			const row = sash.rect.y;
			h.workspace.handleAppViewportMouse({ ...parseSgrMouse("\x1b[<0;1;1M")!, row, col });
			h.workspace.handleAppViewportMouse({ ...parseSgrMouse("\x1b[<32;1;1M")!, row: row + 4, col });
			h.workspace.handleAppViewportMouse({ ...parseSgrMouse("\x1b[<0;1;1m")!, row: row + 4, col });
			h.paint();
			expect(h.workspace.frame!.panes.get("agent:A")!.height).toBeGreaterThan(before);
			h.registry.setStatus("A", "idle");
			h.registry.setStatus("B", "idle");
			vi.advanceTimersByTime(4_000);
			expect(h.panes.has("agent:A")).toBe(true);
			expect(h.panes.has("agent:B")).toBe(true);
		} finally {
			h.dispose();
		}
	});

	it("protects focused and explicitly opened panes, and suppresses a closed pane for its current run", () => {
		vi.useFakeTimers();
		const h = createWorkspace();
		try {
			h.add("A");
			h.paint();
			h.workspace.focusPane("agent:A");
			h.registry.setStatus("A", "idle");
			vi.advanceTimersByTime(4_000);
			expect(h.panes.has("agent:A")).toBe(true);
			h.registry.setStatus("A", "running");
			h.input("\x1b");
			expect(h.panes.has("agent:A")).toBe(false);
			h.add("B");
			expect(h.panes.has("agent:A")).toBe(false);
			h.registry.setStatus("A", "idle");
			h.registry.setStatus("A", "running");
			expect(h.panes.has("agent:A")).toBe(true);
			h.paint();
			const root = h.workspace.model.root;
			expect(h.controller.openManual("A")).toBe(true);
			expect(h.workspace.model.root).toBe(root);
			h.workspace.focusPane("main");
			h.registry.setStatus("A", "idle");
			vi.advanceTimersByTime(4_000);
			expect(h.panes.has("agent:A")).toBe(true);
		} finally {
			h.dispose();
		}
	});

	it("does not split manual panes to automatically display a waiting agent", () => {
		const h = createWorkspace();
		try {
			h.panes.open({
				key: "btw",
				paneId: "btw",
				title: "BTW",
				minWidth: 28,
				minHeight: 8,
				createPane: () => ({ render: () => ["BTW"] }),
			});
			h.paint();
			const root = h.workspace.model.root;
			h.add("A");
			expect(h.workspace.model.root).toBe(root);
			expect(h.panes.has("agent:A")).toBe(false);
			expect(h.controller.openManual("A")).toBe(true);
			expect(h.panes.has("agent:A")).toBe(true);
		} finally {
			h.dispose();
		}
	});
});
