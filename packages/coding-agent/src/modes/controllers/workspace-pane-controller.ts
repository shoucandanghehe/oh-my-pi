import type { Component, WorkspaceEdge, WorkspaceLayout, WorkspacePaneHeaderProvider } from "@oh-my-pi/pi-tui";

const MAIN_WORKSPACE_PANE_ID = "main";

export interface WorkspacePaneOptions {
	key: string;
	paneId: string;
	title: string;
	minWidth: number;
	minHeight: number;
	focus?: boolean;
	placement?: { targetPaneId: string; edge: WorkspaceEdge };
	replacePaneId?: string;
	/** A caller transferring an existing component retains it when docking fails. */
	disposeOnFailure?: boolean;
	createPane: (close: () => void) => Component;
}

/** Owns persistent keyed panes while WorkspaceLayout owns their geometry. */
export class WorkspacePaneController {
	readonly #paneIdByKey = new Map<string, string>();

	constructor(private readonly workspace: WorkspaceLayout) {}

	has(key: string): boolean {
		const paneId = this.#paneIdByKey.get(key);
		return paneId !== undefined && this.workspace.model.hasPane(paneId);
	}

	open(options: WorkspacePaneOptions): boolean {
		const existing = this.#paneIdByKey.get(options.key);
		if (existing && this.workspace.model.hasPane(existing)) {
			return options.focus === false || this.workspace.focusPane(existing);
		}
		if (existing) this.#paneIdByKey.delete(options.key);

		const component = options.createPane(() => {
			this.close(options.key);
		});
		const headerProvider = component as Component & Partial<WorkspacePaneHeaderProvider>;
		const renderHeader = headerProvider.renderWorkspaceHeader?.bind(headerProvider);
		const pane = {
			paneId: options.paneId,
			title: options.title,
			component,
			renderHeader,
			focusTarget: component,
			scroll: "component" as const,
			minWidth: options.minWidth,
			minHeight: options.minHeight,
		};
		if (options.replacePaneId) {
			if (this.workspace.replacePane(options.replacePaneId, pane)) {
				this.#paneIdByKey.set(options.key, options.paneId);
				if (options.placement) {
					this.workspace.movePane(options.paneId, options.placement.targetPaneId, options.placement.edge);
				}
				return true;
			}
			if (options.disposeOnFailure !== false) component.dispose?.();
			return false;
		}
		const frame = this.workspace.getLayoutFrame();
		const candidates = [...(frame?.panes.keys() ?? [])]
			.filter(paneId => paneId !== MAIN_WORKSPACE_PANE_ID && paneId !== options.paneId)
			.sort((a, b) => {
				const aRect = frame?.panes.get(a);
				const bRect = frame?.panes.get(b);
				return (bRect?.width ?? 0) * (bRect?.height ?? 0) - (aRect?.width ?? 0) * (aRect?.height ?? 0);
			});
		candidates.push(MAIN_WORKSPACE_PANE_ID);
		for (const targetPaneId of options.placement ? [options.placement.targetPaneId] : candidates) {
			const rect = frame?.panes.get(targetPaneId);
			const preferred: WorkspaceEdge = rect && rect.height > rect.width ? "bottom" : "right";
			const alternate: WorkspaceEdge = preferred === "right" ? "bottom" : "right";
			for (const edge of options.placement ? [options.placement.edge] : [preferred, alternate]) {
				if (this.workspace.splitPane(targetPaneId, pane, edge, { focus: options.focus })) {
					this.#paneIdByKey.set(options.key, options.paneId);
					return true;
				}
			}
		}
		if (!options.placement && this.workspace.reflowPane(pane, { focus: options.focus })) {
			this.#paneIdByKey.set(options.key, options.paneId);
			return true;
		}
		if (options.disposeOnFailure !== false) component.dispose?.();
		return false;
	}

	close(key: string): boolean {
		const paneId = this.#paneIdByKey.get(key);
		if (!paneId) return false;
		if (!this.workspace.closePane(paneId)) return false;
		this.#paneIdByKey.delete(key);
		return true;
	}

	dispose(): void {
		for (const key of this.#paneIdByKey.keys()) this.close(key);
	}

	focusMain(): boolean {
		return this.workspace.focusPane(MAIN_WORKSPACE_PANE_ID);
	}
}
