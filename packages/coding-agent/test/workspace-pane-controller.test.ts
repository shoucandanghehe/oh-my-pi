import { describe, expect, it } from "bun:test";
import { WorkspacePaneController } from "@oh-my-pi/pi-coding-agent/modes/controllers/workspace-pane-controller";
import { type Component, WorkspaceLayout, WorkspaceModel } from "@oh-my-pi/pi-tui";

class FakePane implements Component {
	disposed = false;
	renderWorkspaceHeader(_width: number, focused: boolean): string {
		return `custom:${focused ? "focused" : "idle"}`;
	}

	render(width: number): readonly string[] {
		return ["pane".padEnd(width)];
	}

	dispose(): void {
		this.disposed = true;
	}
}

class MainPane implements Component {
	render(width: number): readonly string[] {
		return ["main".padEnd(width)];
	}
}

describe("WorkspacePaneController", () => {
	it("creates, reuses, and closes independently keyed panes without replacing main", () => {
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => 12,
			requestRender: () => {},
			panes: [{ paneId: "main", title: "Main", component: new MainPane(), minWidth: 20, minHeight: 6 }],
		});
		workspace.render(120);
		const created: Array<{ key: string; pane: FakePane; close: () => void }> = [];
		const controller = new WorkspacePaneController(workspace);
		const open = (key: string, paneId: string) =>
			controller.open({
				key,
				paneId,
				title: key,
				minWidth: 24,
				minHeight: 6,
				createPane: close => {
					const pane = new FakePane();
					created.push({ key, pane, close });
					return pane;
				},
			});

		expect(open("agent:Worker", "agent:Worker")).toBe(true);
		workspace.render(120);
		expect(controller.has("agent:Worker")).toBe(true);
		expect(workspace.render(120)[0]).toContain("custom:focused");
		expect(created.map(entry => entry.key)).toEqual(["agent:Worker"]);
		expect(workspace.model.hasPane("agent:Worker")).toBe(true);

		expect(open("agent:Worker", "agent:Worker")).toBe(true);
		expect(created).toHaveLength(1);
		expect(workspace.focusedPaneId).toBe("agent:Worker");

		expect(open("btw", "btw")).toBe(true);
		workspace.render(120);
		expect(workspace.model.hasPane("btw")).toBe(true);
		expect(workspace.model.hasPane("main")).toBe(true);

		created[0]!.close();
		expect(controller.has("agent:Worker")).toBe(false);
		expect(created[0]!.pane.disposed).toBe(true);
		expect(workspace.model.hasPane("agent:Worker")).toBe(false);
	});
	it("opens background panes without stealing the current focus", () => {
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => 20,
			requestRender: () => {},
			panes: [{ paneId: "main", title: "Main", component: new MainPane(), minWidth: 20, minHeight: 6 }],
		});
		workspace.render(120);
		const controller = new WorkspacePaneController(workspace);

		expect(
			controller.open({
				key: "agent:Worker",
				paneId: "agent:Worker",
				title: "Worker",
				minWidth: 24,
				minHeight: 6,
				focus: false,
				createPane: () => new FakePane(),
			}),
		).toBe(true);

		expect(workspace.focusedPaneId).toBe("main");
		expect(workspace.model.hasPane("agent:Worker")).toBe(true);
	});
	it("reflows all panes when no existing pane can be split in place", () => {
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			height: () => 20,
			requestRender: () => {},
			panes: [{ paneId: "main", title: "Main", component: new MainPane(), minWidth: 40, minHeight: 8 }],
		});
		workspace.render(90);
		const controller = new WorkspacePaneController(workspace);
		const open = (id: string) =>
			controller.open({
				key: `agent:${id}`,
				paneId: `agent:${id}`,
				title: id,
				minWidth: 24,
				minHeight: 6,
				focus: false,
				createPane: () => new FakePane(),
			});

		for (const id of ["A", "B", "C"]) {
			expect(open(id)).toBe(true);
			workspace.render(90);
		}
		expect(open("D")).toBe(true);
		workspace.render(90);

		expect(workspace.frame?.constrained).toBe(false);
		expect([...workspace.frame!.panes.keys()].sort()).toEqual(["agent:A", "agent:B", "agent:C", "agent:D", "main"]);
		for (const [id, rect] of workspace.frame!.panes) {
			expect(rect.width).toBeGreaterThanOrEqual(id === "main" ? 40 : 24);
			expect(rect.height).toBeGreaterThanOrEqual(id === "main" ? 8 : 6);
		}
	});
});
