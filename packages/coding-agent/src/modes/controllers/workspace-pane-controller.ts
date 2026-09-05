import type { Component, WorkspaceEdge, WorkspaceLayout, WorkspacePaneHeaderProvider } from "@oh-my-pi/pi-tui";

const MAIN_WORKSPACE_PANE_ID = "main";

export interface WorkspacePaneOptions {
	key: string;
	paneId: string;
	title: string;
	minWidth: number;
	minHeight: number;
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
		if (existing && this.workspace.model.hasPane(existing)) return this.workspace.focusPane(existing);
		if (existing) this.#paneIdByKey.delete(options.key);

		const component = options.createPane(() => {
			this.close(options.key);
		});
		const headerProvider = component as Component & Partial<WorkspacePaneHeaderProvider>;
		const renderHeader = headerProvider.renderWorkspaceHeader?.bind(headerProvider);
		const candidates = [...(this.workspace.frame?.panes.keys() ?? [])]
			.filter(paneId => paneId !== MAIN_WORKSPACE_PANE_ID && paneId !== options.paneId)
			.sort((a, b) => {
				const aRect = this.workspace.frame?.panes.get(a);
				const bRect = this.workspace.frame?.panes.get(b);
				return (bRect?.width ?? 0) * (bRect?.height ?? 0) - (aRect?.width ?? 0) * (aRect?.height ?? 0);
			});
		candidates.push(MAIN_WORKSPACE_PANE_ID);
		for (const targetPaneId of candidates) {
			const rect = this.workspace.frame?.panes.get(targetPaneId);
			const preferred: WorkspaceEdge = rect && rect.height > rect.width ? "bottom" : "right";
			const alternate: WorkspaceEdge = preferred === "right" ? "bottom" : "right";
			for (const edge of [preferred, alternate]) {
				if (
					this.workspace.splitPane(
						targetPaneId,
						{
							paneId: options.paneId,
							title: options.title,
							component,
							renderHeader,
							focusTarget: component,
							scroll: "component",
							minWidth: options.minWidth,
							minHeight: options.minHeight,
						},
						edge,
					)
				) {
					this.#paneIdByKey.set(options.key, options.paneId);
					return true;
				}
			}
		}
		component.dispose?.();
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
		for (const key of [...this.#paneIdByKey.keys()]) this.close(key);
	}

	focusMain(): boolean {
		return this.workspace.focusPane(MAIN_WORKSPACE_PANE_ID);
	}
}
