import type { WorkspaceEdge, WorkspaceLayout } from "@oh-my-pi/pi-tui";
import type { RegistryEvent } from "../../registry/agent-registry";
import type { AgentTranscriptViewer } from "../components/agent-transcript-viewer";
import { AutoAgentDock } from "../components/auto-agent-dock";
import type { WorkspacePaneController } from "./workspace-pane-controller";

const DOCK_PANE_ID = "auto-agents";
const MAIN_PANE_ID = "main";
const MAIN_READABLE_WIDTH = 48;
const MAIN_READABLE_HEIGHT = 12;
const DOCK_READABLE_WIDTH = 36;
const DOCK_READABLE_HEIGHT = 14;

interface AutoAgentWorkspaceOptions {
	workspace: WorkspaceLayout;
	panes: WorkspacePaneController;
	createViewer: (id: string, close: () => void) => AgentTranscriptViewer;
	requestRender: () => void;
	onDetachError: () => void;
}

/** Owns automatic presentation, never the geometry of manual panes. */
export class AutoAgentWorkspaceController {
	#dock: AutoAgentDock | undefined;
	readonly #running = new Set<string>();
	readonly #dismissed = new Set<string>();
	#suppressed = false;
	#closedPlacement: { edge: WorkspaceEdge; ratio: number } | undefined;

	constructor(private readonly options: AutoAgentWorkspaceOptions) {}

	handleEvent(event: RegistryEvent): void {
		const { ref } = event;
		if (ref.kind !== "sub" || event.type === "metadata_changed") return;
		if (event.type !== "removed" && ref.status === "running") {
			this.#running.add(ref.id);
			const viewer = this.#dock?.getViewer(ref.id);
			if (viewer) viewer.cancelAutoClose();
			else this.#openAutomatic(ref.id);
			return;
		}
		this.#running.delete(ref.id);
		this.#dismissed.delete(ref.id);
		const dock = this.#dock;
		const viewer = dock?.getViewer(ref.id);
		if (!dock || !viewer || viewer.autoCloseProtected) return;
		if (!this.options.workspace.getLayoutFrame()?.panes.has(DOCK_PANE_ID) || !dock.visibleAgentIds.includes(ref.id)) {
			this.#removeAutomatic(ref.id);
			return;
		}
		viewer.startAutoClose(() => {
			if (this.#dock?.getViewer(ref.id) === viewer) this.#removeAutomatic(ref.id);
		});
	}

	/** An explicit open transfers ownership to a persistent manual pane. */
	openManual(id: string, edge?: WorkspaceEdge): boolean {
		if (this.#suppressed) {
			this.#suppressed = false;
			for (const runningId of this.#running) {
				if (runningId !== id) this.#openAutomatic(runningId);
			}
		}
		const key = `agent:${id}`;
		const dock = this.#dock;
		const transferred = dock?.remove(id);
		transferred?.cancelAutoClose();
		const opened = this.options.panes.open({
			key,
			paneId: key,
			title: id,
			minWidth: 24,
			minHeight: 6,
			placement: edge ? { targetPaneId: MAIN_PANE_ID, edge } : undefined,
			disposeOnFailure: !transferred,
			replacePaneId: transferred && dock?.size === 0 ? DOCK_PANE_ID : undefined,
			createPane: close => transferred ?? this.options.createViewer(id, close),
		});
		if (!opened) {
			if (transferred) dock?.add(id, transferred);
			return false;
		}
		if (this.#running.has(id)) this.#dismissed.add(id);
		this.#suppressed = false;
		if (dock?.size === 0) this.#closeEmptyDock();
		for (const runningId of this.#running) this.#openAutomatic(runningId);
		return true;
	}

	/** Explicit region close disables automatic reopening until a manual open. */
	closeDock(): void {
		this.#suppressed = true;
		this.#rememberPlacement();
		this.#dock = undefined;
		this.options.workspace.closePane(DOCK_PANE_ID);
	}

	reset(): void {
		this.#dock = undefined;
		this.options.workspace.closePane(DOCK_PANE_ID);
		this.#running.clear();
		this.#dismissed.clear();
		this.#suppressed = false;
		this.#closedPlacement = undefined;
	}

	#openAutomatic(id: string): void {
		if (this.#suppressed || this.#dismissed.has(id) || this.options.panes.has(`agent:${id}`) || this.#dock?.has(id))
			return;
		if (!this.#dock && !this.#createDock()) return;
		this.#dock!.add(
			id,
			this.options.createViewer(id, () => {
				// A header drag or explicit open may have transferred this viewer.
				if (!this.#dock?.has(id)) {
					this.options.panes.close(`agent:${id}`);
					return;
				}
				if (this.#running.has(id)) this.#dismissed.add(id);
				this.#removeAutomatic(id);
			}),
		);
	}

	#createDock(): boolean {
		const { workspace } = this.options;
		// Never guess where a user-created workspace wants a new automatic region.
		if (workspace.model.root.kind !== "pane" || workspace.model.root.paneId !== MAIN_PANE_ID) return false;
		const frame = workspace.getLayoutFrame();
		const main = frame?.panes.get(MAIN_PANE_ID);
		const edge: WorkspaceEdge =
			this.#closedPlacement?.edge ??
			(!main || main.width >= MAIN_READABLE_WIDTH + DOCK_READABLE_WIDTH + 1 ? "right" : "bottom");
		const sideBySide = edge === "right" || edge === "left";
		const dock = new AutoAgentDock({
			axis: sideBySide ? "y" : "x",
			requestRender: this.options.requestRender,
			onClose: () => this.closeDock(),
			onCloseAgent: id => {
				if (this.#running.has(id)) this.#dismissed.add(id);
				this.#removeAutomatic(id);
			},
			onDetach: (id, targetEdge) => {
				if (!this.openManual(id, targetEdge)) this.options.onDetachError();
			},
		});
		const opened = workspace.splitPane(
			MAIN_PANE_ID,
			{
				paneId: DOCK_PANE_ID,
				title: "Agents",
				component: dock,
				focusTarget: dock,
				scroll: "component",
				minWidth: DOCK_READABLE_WIDTH,
				minHeight: DOCK_READABLE_HEIGHT,
				isVisible: (width, height) =>
					sideBySide
						? width >= MAIN_READABLE_WIDTH + DOCK_READABLE_WIDTH + 1 && height >= DOCK_READABLE_HEIGHT
						: width >= MAIN_READABLE_WIDTH && height >= MAIN_READABLE_HEIGHT + DOCK_READABLE_HEIGHT + 1,
			},
			edge,
			{ focus: false, ratio: this.#closedPlacement?.ratio ?? 0.6 },
		);
		if (!opened) {
			dock.dispose();
			return false;
		}
		this.#dock = dock;
		this.#closedPlacement = undefined;
		return true;
	}

	#removeAutomatic(id: string): void {
		this.#dock?.remove(id)?.dispose();
		if (this.#dock?.size === 0) this.#closeEmptyDock();
	}

	#closeEmptyDock(): void {
		this.#rememberPlacement();
		this.#dock = undefined;
		this.options.workspace.closePane(DOCK_PANE_ID);
	}

	#rememberPlacement(): void {
		const root = this.options.workspace.model.root;
		if (root.kind !== "split" || root.children.length !== 2) return;
		const mainIndex = root.children.findIndex(
			child => child.node.kind === "pane" && child.node.paneId === MAIN_PANE_ID,
		);
		if (mainIndex < 0) return;
		const main = root.children[mainIndex]!;
		const dock = root.children[1 - mainIndex]!;
		if (dock.node.kind !== "pane" || dock.node.paneId !== DOCK_PANE_ID) return;
		this.#closedPlacement = {
			edge: root.axis === "x" ? (mainIndex === 0 ? "right" : "left") : mainIndex === 0 ? "bottom" : "top",
			ratio: main.weight / (main.weight + dock.weight),
		};
	}
}
