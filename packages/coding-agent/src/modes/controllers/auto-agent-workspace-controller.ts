import type { WorkspaceEdge, WorkspaceLayout } from "@oh-my-pi/pi-tui";
import type { RegistryEvent } from "../../registry/agent-registry";
import type { AgentTranscriptViewer } from "../components/agent-transcript-viewer";
import type { WorkspacePaneController } from "./workspace-pane-controller";

const MAIN_PANE_ID = "main";
const MAIN_READABLE_WIDTH = 48;
const AGENT_READABLE_WIDTH = 36;

interface AutoAgentWorkspaceOptions {
	workspace: WorkspaceLayout;
	panes: WorkspacePaneController;
	createViewer: (id: string, close: () => void) => AgentTranscriptViewer;
}

/** Automatic visibility policy; every transcript is an ordinary Workspace pane. */
export class AutoAgentWorkspaceController {
	readonly #automatic = new Map<string, AgentTranscriptViewer>();
	readonly #running = new Set<string>();
	readonly #dismissed = new Set<string>();

	constructor(private readonly options: AutoAgentWorkspaceOptions) {}

	handleEvent(event: RegistryEvent): void {
		const { ref } = event;
		if (ref.kind !== "sub" || event.type === "metadata_changed") return;
		if (event.type !== "removed" && ref.status === "running") {
			this.#running.add(ref.id);
			this.#automatic.get(ref.id)?.cancelAutoClose();
			this.#fillVacancies();
			return;
		}
		this.#running.delete(ref.id);
		this.#dismissed.delete(ref.id);
		const viewer = this.#automatic.get(ref.id);
		if (!viewer || viewer.autoCloseProtected) return;
		viewer.startAutoClose(() => {
			if (this.#automatic.get(ref.id) !== viewer) return;
			this.#automatic.delete(ref.id);
			this.options.panes.close(`agent:${ref.id}`);
			this.#fillVacancies();
		});
	}

	/** An explicit open pins the existing pane without moving or recreating it. */
	openManual(id: string, edge?: WorkspaceEdge): boolean {
		const viewer = this.#automatic.get(id);
		if (viewer) {
			if (!this.options.workspace.focusPane(`agent:${id}`)) return false;
			viewer.cancelAutoClose();
			this.#automatic.delete(id);
			return true;
		}
		return this.#open(id, false, edge ? { targetPaneId: MAIN_PANE_ID, edge } : undefined);
	}

	reset(): void {
		this.#running.clear();
		this.#dismissed.clear();
		for (const id of this.#automatic.keys()) this.options.panes.close(`agent:${id}`);
		this.#automatic.clear();
	}

	#fillVacancies(): void {
		const { workspace, panes } = this.options;
		for (const id of this.#automatic.keys()) {
			if (panes.has(`agent:${id}`)) continue;
			this.#automatic.delete(id);
			if (this.#running.has(id)) this.#dismissed.add(id);
		}
		for (const id of this.#running) {
			if (this.#dismissed.has(id) || panes.has(`agent:${id}`)) continue;
			// Never split a manual/operated pane or reflow a user's workspace.
			const frame = workspace.getLayoutFrame();
			const main = frame?.panes.get(MAIN_PANE_ID);
			if (workspace.model.root.kind === "pane" && workspace.model.root.paneId === MAIN_PANE_ID) {
				if (
					!this.#open(id, true, {
						targetPaneId: MAIN_PANE_ID,
						edge: !main || main.width >= MAIN_READABLE_WIDTH + AGENT_READABLE_WIDTH + 1 ? "right" : "bottom",
					})
				)
					break;
				continue;
			}
			const candidates = [...this.#automatic]
				.filter(([agentId, viewer]) => !viewer.autoCloseProtected && frame?.panes.has(`agent:${agentId}`))
				.sort(([a], [b]) => {
					const aRect = frame!.panes.get(`agent:${a}`)!;
					const bRect = frame!.panes.get(`agent:${b}`)!;
					return aRect.y - bRect.y || aRect.x - bRect.x;
				});
			for (const [agentId] of candidates) {
				const targetPaneId = `agent:${agentId}`;
				const rect = frame!.panes.get(targetPaneId)!;
				if (this.#open(id, true, { targetPaneId, edge: main && rect.x !== main.x ? "bottom" : "right" })) break;
			}
			if (!panes.has(`agent:${id}`)) break;
		}
	}

	#open(id: string, automatic: boolean, placement?: { targetPaneId: string; edge: WorkspaceEdge }): boolean {
		const key = `agent:${id}`;
		let viewer: AgentTranscriptViewer | undefined;
		const opened = this.options.panes.open({
			key,
			paneId: key,
			title: id,
			minWidth: automatic ? AGENT_READABLE_WIDTH : 24,
			minHeight: automatic ? 12 : 6,
			focus: !automatic,
			placement,
			onLayoutChange: () => {
				viewer?.cancelAutoClose();
				this.#automatic.delete(id);
			},
			createPane: close => {
				viewer = this.options.createViewer(id, () => {
					if (this.#running.has(id)) this.#dismissed.add(id);
					this.#automatic.delete(id);
					close();
					this.#fillVacancies();
				});
				return viewer;
			},
		});
		if (opened && automatic && viewer) this.#automatic.set(id, viewer);
		return opened;
	}
}
