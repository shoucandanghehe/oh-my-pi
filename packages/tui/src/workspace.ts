import type { InputEvent } from "./driver/contract";
import type { KeyEvent } from "./events";
import type { Surface } from "./surface";

/** A pane is an ordinary reactive surface with its own input callbacks. */
export interface WorkspaceSurface {
	readonly surface: Surface;
	readonly onKey?: (key: KeyEvent) => boolean;
	/** Consume decoded input before it reaches this surface's focused node. Pointer cells are pane-local. */
	readonly intercept?: (event: InputEvent) => boolean;
	/** Release application resources in addition to the surface, which the workspace disposes. */
	readonly dispose?: () => void;
}

export type WorkspaceEdge = "left" | "right" | "top" | "bottom";

export interface WorkspacePaneMinimum {
	/** Minimum pane size in terminal cells (including its title row). Default 18×4. */
	readonly minWidth?: number;
	readonly minHeight?: number;
}

export interface WorkspaceOpenOptions extends WorkspacePaneMinimum {
	/** Split this pane. Defaults to the active pane, then tries other visible panes if it cannot fit. */
	readonly target?: string;
	/** Defaults to a right-hand split, then a bottom split if there is not enough width. */
	readonly edge?: WorkspaceEdge;
	/** Fraction of the available cells initially allocated to the new pane. Default 0.5. */
	readonly ratio?: number;
	readonly label?: string;
	readonly focus?: boolean;
}

export interface AnsiWorkspace {
	/** Id of the focused pane (reactive). The original host surface is `main`. */
	active(): string;
	/** Focus an existing visible pane. */
	focus(id: string): boolean;
	/** Close a secondary pane without stopping its session or closing the main surface. */
	close(id: string): boolean;
	/**
	 * Open a pane, or focus it if already open. False means no room (the factory was not
	 * called) or the existing pane is hidden. `rows` reports the reactive body height,
	 * including the dock, excluding the title, and zero while hidden.
	 */
	open(
		id: string,
		create: (close: () => void, rows: () => number) => WorkspaceSurface,
		options?: WorkspaceOpenOptions,
	): boolean;
}
