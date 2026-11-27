import type { InputEvent, MouseEvent } from "./driver/contract";
import type { KeyEvent } from "./events";
import type { UiNode } from "./node";
import type { Surface } from "./surface";
import type { SelectionMotion, TranscriptScroll } from "./term/backend";

/** A left rail drawn alongside one ANSI workspace surface, below the pane header. */
export interface AnsiWorkspaceRail {
	readonly node: UiNode;
	/** Visible cells, and the number reserved for the rail instead of the conversation. */
	layout(columns: number): { readonly width: number; readonly inset: number };
	/** Pane-local pointer cells and the rail width from the last painted frame. */
	pointer(mouse: MouseEvent, width: number): boolean;
	leave(): void;
}

/** A pane is an ordinary reactive surface with its own input callbacks. */
export interface WorkspaceSurface {
	readonly surface: Surface;
	readonly ansiRail?: AnsiWorkspaceRail;
	readonly onKey?: (key: KeyEvent) => boolean;
	/** Consume input before the focused node. Replay keeps the event on this pane, even if focus moves. */
	readonly intercept?: (event: InputEvent, replay: () => void) => boolean;
	/** Right-click clipboard request from this pane when there is no selection to copy. */
	readonly onPasteRequest?: () => void;
	/** Whether a transcript block starts a semantic prompt. */
	readonly isPrompt?: (node: UiNode) => boolean;
	/** Progress of the ANSI pane's exit animation. Undefined paints the original content. */
	readonly petrification?: () => number | undefined;
	/** A user redocked this pane or changed its size by dragging a sash. */
	readonly onManualLayout?: () => void;
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
	/** Restrict automatic placement to permitted splits, without reflowing the existing tree. */
	readonly canSplit?: (id: string, onlyPane: boolean) => boolean;
	/** Defaults to a right-hand split, then a bottom split if there is not enough width. */
	readonly edge?: WorkspaceEdge;
	/** Fraction of the available cells initially allocated to the new pane. Default 0.5. */
	readonly ratio?: number;
	readonly label?: string;
	readonly focus?: boolean;
}

/** Transcript blocks intersecting the last painted viewport, in display order. */
export interface WorkspaceMainView {
	readonly nodes: readonly UiNode[];
	readonly followingTail: boolean;
}

/** Commands for one fullscreen transcript, independent of the active pane. */
export interface TranscriptControls {
	scroll(by: TranscriptScroll): boolean;
	openSearch(): boolean;
	copySelection(): boolean;
	extendSelection(motion: SelectionMotion): boolean;
}

export interface AnsiWorkspace {
	/** Id of the focused pane (reactive). The original host surface is `main`. */
	active(): string;
	/** Whether any visible pane needs hover reports (reactive). */
	pointerMotion(): boolean;
	/** Focus an existing visible pane. */
	focus(id: string): boolean;
	/** Query the visible transcript blocks of a mounted pane. */
	visibleMain(surface: Surface): WorkspaceMainView | undefined;
	/** Transcript commands for this surface when its pane is visible. */
	transcript(surface: Surface): TranscriptControls | undefined;
	/** Close a secondary pane without stopping its session or closing the main surface. */
	close(id: string): boolean;
	/**
	 * Open a pane, or focus it if already open. False means no room (the factory was not
	 * called) or the existing pane is hidden. `rows` and `columns` report the reactive body size
	 * (including the dock, excluding the title), and zero while hidden.
	 */
	open(
		id: string,
		create: (close: () => void, rows: () => number, columns: () => number) => WorkspaceSurface,
		options?: WorkspaceOpenOptions,
	): boolean;
}
