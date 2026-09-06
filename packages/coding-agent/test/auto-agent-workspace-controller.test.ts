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
		requestRender: () => {},
		onDetachError: () => {
			throw new Error("Unexpected detach failure");
		},
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
	it("switches overflow tabs with pixel mouse and keyboard, and captures a drag into Main", () => {
		const h = createWorkspace();
		try {
			for (const id of ["A", "B", "C"]) h.add(id);
			const lines = h.paint().split("\n");
			const tabRow = lines.findIndex(line => line.includes(" A ") && line.includes(" C "));
			const tabCol = lines[tabRow]!.indexOf(" C ") + 1;
			const press = parseSgrMouse("\x1b[<0;1;1M")!;
			h.workspace.handleAppViewportMouse({ ...press, row: tabRow + 0.5, col: tabCol + 0.5 });
			expect(h.viewers.get("C")!.focused).toBe(true);
			h.input("\x1b[1;3D");
			expect(h.viewers.get("B")!.focused).toBe(true);
			h.input("\x1b[1;3C");
			expect(h.viewers.get("C")!.focused).toBe(true);
			const selected = h.paint().split("\n");
			const headerRow = selected.findIndex(line => line.includes("C running"));
			const headerCol = selected[headerRow]!.indexOf("C running");
			h.workspace.handleAppViewportMouse({ ...press, row: headerRow + 0.5, col: headerCol + 0.5 });
			const release = parseSgrMouse("\x1b[<0;1;1m")!;
			h.workspace.handleAppViewportMouse({ ...release, row: 10.5, col: 10.5 });
			expect(h.panes.has("agent:C")).toBe(true);
			h.paint();
			expect(h.workspace.focusedPaneId).toBe("agent:C");
		} finally {
			h.dispose();
		}
	});

	it("keeps Main identical for batched and painted registrations, including overflow", () => {
		const batched = createWorkspace();
		const painted = createWorkspace();
		try {
			batched.add("A");
			painted.add("A");
			painted.paint();
			const mainAfterFirst = { ...painted.workspace.frame!.panes.get("main")! };
			for (const id of ["B", "C", "D"]) {
				batched.add(id);
				painted.add(id);
				painted.paint();
				expect(painted.workspace.frame!.panes.get("main")).toEqual(mainAfterFirst);
			}
			batched.paint();
			expect([...batched.workspace.frame!.panes]).toEqual([...painted.workspace.frame!.panes]);
			expect(batched.workspace.focusedPaneId).toBe("main");
			for (const viewer of batched.viewers.values()) expect(viewer.focused).toBe(false);
		} finally {
			batched.dispose();
			painted.dispose();
		}
	});

	it("closes ended viewers, refills from overflow, and reclaims Main after the last exit", () => {
		vi.useFakeTimers();
		const h = createWorkspace();
		try {
			for (const id of ["A", "B", "C"]) h.add(id);
			const split = h.workspace.model.root;
			if (split.kind !== "split") throw new Error("Expected an auxiliary region");
			h.workspace.model.resizeSplit(split.splitId, 0, 65, 54);
			h.paint();
			const main = { ...h.workspace.frame!.panes.get("main")! };
			const disposeA = vi.spyOn(h.viewers.get("A")!, "dispose");
			h.registry.setStatus("A", "idle");
			vi.advanceTimersByTime(2_000);
			expect(disposeA).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1_100);
			h.paint();
			expect(disposeA).toHaveBeenCalledTimes(1);
			expect(h.workspace.frame!.panes.get("main")).toEqual(main);
			h.workspace.focusPane("auto-agents");
			expect([...h.viewers.values()].filter(viewer => viewer.focused)).toHaveLength(1);
			h.workspace.focusPane("main");
			h.registry.setStatus("B", "parked");
			h.registry.setStatus("C", "idle");
			vi.advanceTimersByTime(3_100);
			h.paint();
			expect([...h.workspace.frame!.panes.keys()]).toEqual(["main"]);
			h.add("D");
			h.paint();
			expect(h.workspace.frame!.panes.get("main")).toEqual(main);
		} finally {
			h.dispose();
		}
	});

	it("does not close the viewer already focused when its run yields", () => {
		vi.useFakeTimers();
		const h = createWorkspace();
		try {
			h.add("A");
			h.paint();
			h.workspace.focusPane("auto-agents");
			expect(h.viewers.get("A")!.focused).toBe(true);
			h.registry.setStatus("A", "idle");
			vi.advanceTimersByTime(4_000);
			expect(h.workspace.model.hasPane("auto-agents")).toBe(true);
			h.input("\x1b");
			expect(h.workspace.model.hasPane("auto-agents")).toBe(false);
			h.registry.setStatus("A", "running");
			expect(h.workspace.model.hasPane("auto-agents")).toBe(true);
		} finally {
			h.dispose();
		}
	});

	it("removes a completed hidden agent without disturbing visible slots", () => {
		const h = createWorkspace();
		try {
			for (const id of ["A", "B", "C"]) h.add(id);
			h.paint();
			const disposeC = vi.spyOn(h.viewers.get("C")!, "dispose");
			h.registry.setStatus("C", "idle");
			expect(disposeC).toHaveBeenCalledTimes(1);
			h.workspace.focusPane("auto-agents");
			expect(h.viewers.get("A")!.focused).toBe(true);
		} finally {
			h.dispose();
		}
	});

	it("hides and restores the dock on resize without losing its viewers or Main ratio", () => {
		const h = createWorkspace();
		try {
			h.add("A");
			h.add("B");
			h.paint();
			const main = { ...h.workspace.frame!.panes.get("main")! };
			const disposeA = vi.spyOn(h.viewers.get("A")!, "dispose");
			h.workspace.focusPane("auto-agents");
			h.paint(60, 40);
			expect([...h.workspace.frame!.panes.keys()]).toEqual(["main"]);
			expect(h.workspace.focusedPaneId).toBe("main");
			expect(h.workspace.model.hasPane("auto-agents")).toBe(true);
			expect(disposeA).not.toHaveBeenCalled();
			h.paint(120, 40);
			expect(h.workspace.frame!.panes.get("main")).toEqual(main);
		} finally {
			h.dispose();
		}
	});

	it("leaves manual workspaces untouched and honors a user-closed automatic region", () => {
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
			const layout = h.workspace.model.root;
			h.add("A");
			expect(h.workspace.model.root).toBe(layout);
			h.panes.close("btw");
			h.add("B");
			h.paint();
			h.controller.closeDock();
			h.add("C");
			expect(h.workspace.model.root).toEqual({ kind: "pane", paneId: "main" });
			expect(h.controller.openManual("A")).toBe(true);
			expect(h.panes.has("agent:A")).toBe(true);
			expect(h.workspace.model.hasPane("auto-agents")).toBe(true);
		} finally {
			h.dispose();
		}
	});

	it("transfers the last automatic viewer to manual ownership without another split or auto-close", () => {
		vi.useFakeTimers();
		const h = createWorkspace(90, 30);
		try {
			h.add("A");
			h.paint();
			const disposeA = vi.spyOn(h.viewers.get("A")!, "dispose");
			const main = { ...h.workspace.frame!.panes.get("main")! };
			expect(h.controller.openManual("A")).toBe(true);
			h.paint();
			expect(h.workspace.frame!.panes.get("main")).toEqual(main);
			expect(h.workspace.model.hasPane("auto-agents")).toBe(false);
			expect(h.panes.has("agent:A")).toBe(true);
			h.registry.setStatus("A", "idle");
			vi.advanceTimersByTime(4_000);
			expect(disposeA).not.toHaveBeenCalled();
			h.input("\x1b");
			expect(h.panes.has("agent:A")).toBe(false);
			expect(disposeA).toHaveBeenCalledTimes(1);
		} finally {
			h.dispose();
		}
	});
});
