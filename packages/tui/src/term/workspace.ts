import type { MouseEvent } from "../driver/contract";
import type { KeyEvent } from "../events";
import type { UiNode } from "../node";
import { batch, computed, createRoot, signal } from "../reactive";
import { flattenLine, stripControl } from "../text/sanitize";
import type {
	AnsiWorkspace,
	WorkspaceEdge,
	WorkspaceOpenOptions,
	WorkspacePaneMinimum,
	WorkspaceSurface,
} from "../workspace";
import type { AppViewport, ViewportHit } from "./app-viewport";

export interface InputFrame {
	readonly layer: readonly UiNode[];
	readonly hits: readonly ViewportHit[];
}

export interface WorkspacePane {
	readonly mount: WorkspaceSurface;
	readonly leaf: Leaf;
	readonly label: string;
	readonly viewport: AppViewport;
	input?: InputFrame;
}

export interface WorkspaceRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface Split {
	readonly index: number;
	readonly axis: "x" | "y";
	readonly first: Layout;
	readonly second: Layout;
	readonly ratio: number;
}

interface Leaf {
	readonly id: string;
	readonly width: number;
	readonly height: number;
}

type Layout = Leaf | Split;

interface Sash {
	readonly rect: WorkspaceRect;
	readonly split: Split;
	readonly first: number;
	readonly total: number;
	readonly minFirst: number;
	readonly minSecond: number;
}

interface MoveDrag {
	readonly kind: "move";
	readonly id: string;
	readonly row: number;
	readonly col: number;
	drop?: { readonly root: Layout; readonly target: string; readonly edge: WorkspaceEdge };
}

type PointerDrag = MoveDrag | { readonly kind: "resize"; readonly sash: Sash; readonly start: number };

interface Geometry {
	readonly panes: ReadonlyMap<string, WorkspaceRect>;
	readonly sashes: readonly Sash[];
}

const MAIN = "main";
const MIN_WIDTH = 18;
const MIN_HEIGHT = 4;

function leaf(id: string, minimum?: WorkspacePaneMinimum): Leaf {
	const { minWidth = MIN_WIDTH, minHeight = MIN_HEIGHT } = minimum ?? {};
	return {
		id,
		width: Number.isFinite(minWidth) ? Math.max(4, Math.ceil(minWidth)) : MIN_WIDTH,
		height: Number.isFinite(minHeight) ? Math.max(2, Math.ceil(minHeight)) : MIN_HEIGHT,
	};
}

function minimum(node: Layout): { width: number; height: number; main: boolean } {
	if ("id" in node) return { width: node.width, height: node.height, main: node.id === MAIN };
	const a = minimum(node.first);
	const b = minimum(node.second);
	return {
		width: node.axis === "x" ? a.width + b.width + 1 : Math.max(a.width, b.width),
		height: node.axis === "y" ? a.height + b.height + 1 : Math.max(a.height, b.height),
		main: a.main || b.main,
	};
}

function geometry(layout: Layout, box: WorkspaceRect): Geometry {
	const panes = new Map<string, WorkspaceRect>();
	const sashes: Sash[] = [];
	const place = (node: Layout, rect: WorkspaceRect): void => {
		if ("id" in node) {
			panes.set(node.id, rect);
			return;
		}
		const a = minimum(node.first);
		const b = minimum(node.second);
		const horizontal = node.axis === "x";
		const dimension = horizontal ? "width" : "height";
		const cross = horizontal ? "height" : "width";
		const offset = node.axis;
		const total = rect[dimension] - 1;
		if (total < a[dimension] + b[dimension] || rect[cross] < Math.max(a[cross], b[cross])) {
			// When the terminal shrinks, park a subtree instead of drawing unusably small panes.
			// Main always survives, and growing the terminal brings parked panes back intact.
			place(b.main ? node.second : node.first, rect);
			return;
		}
		const first = Math.max(a[dimension], Math.min(total - b[dimension], Math.round(total * node.ratio)));
		place(node.first, { ...rect, [dimension]: first });
		sashes.push({
			rect: { ...rect, [offset]: rect[offset] + first, [dimension]: 1 },
			split: node,
			first,
			total,
			minFirst: a[dimension],
			minSecond: b[dimension],
		});
		place(node.second, { ...rect, [offset]: rect[offset] + first + 1, [dimension]: total - first });
	};
	place(layout, box);
	return { panes, sashes };
}

/** Replace or remove a leaf, collapsing the branch that lost a child. */
function replacePane(root: Layout, id: string, next?: (pane: Leaf) => Layout): Layout | undefined {
	if ("id" in root) return root.id === id ? next?.(root) : root;
	const first = replacePane(root.first, id, next);
	const second = replacePane(root.second, id, next);
	if (first === undefined) return second;
	if (second === undefined) return first;
	return first === root.first && second === root.second ? root : { ...root, first, second };
}

function insertPane(
	root: Layout,
	target: string,
	pane: Leaf,
	edge: WorkspaceEdge,
	ratio: number,
	index: number,
): Layout {
	const before = edge === "left" || edge === "top";
	return replacePane(root, target, other => ({
		index,
		axis: edge === "left" || edge === "right" ? "x" : "y",
		first: before ? pane : other,
		second: before ? other : pane,
		ratio: before ? ratio : 1 - ratio,
	}))!;
}

function setRatio(root: Layout, index: number, ratio: number): Layout {
	if ("id" in root) return root;
	if (root.index === index) return { ...root, ratio };
	const first = setRatio(root.first, index, ratio);
	const second = setRatio(root.second, index, ratio);
	return first === root.first && second === root.second ? root : { ...root, first, second };
}

function contains(rect: WorkspaceRect, mouse: MouseEvent): boolean {
	return (
		mouse.col >= rect.x && mouse.col < rect.x + rect.width && mouse.row >= rect.y && mouse.row < rect.y + rect.height
	);
}

/** Pane ownership and geometry; the terminal backend still owns painting, events and the only writer. */
export class TerminalWorkspace implements AnsiWorkspace {
	readonly #layout;
	readonly #size = signal<WorkspaceRect>({ x: 0, y: 0, width: 1, height: 1 });
	readonly #focused = signal(MAIN);
	readonly #panes = new Map<string, WorkspacePane>();
	readonly #geometry = createRoot(dispose => {
		const read = computed(() => geometry(this.#layout(), this.#size()));
		const split = computed(() => read().panes.size > 1);
		return { dispose, read, split };
	});
	#frame: Geometry | undefined;
	#sequence = 0;
	#drag: PointerDrag | undefined;
	#capture: string | undefined;
	#disposed = false;

	constructor(
		main: WorkspaceSurface,
		private readonly viewport: (mount: WorkspaceSurface) => AppViewport,
		minimum?: WorkspacePaneMinimum,
	) {
		const entry = leaf(MAIN, minimum);
		this.#layout = signal<Layout>(entry);
		this.#panes.set(MAIN, { mount: main, leaf: entry, label: "Main", viewport: viewport(main) });
	}

	active(): string {
		return this.#focused();
	}

	pane(id: string): WorkspacePane | undefined {
		return this.#panes.get(id);
	}

	split(): boolean {
		return this.#geometry.split();
	}

	focus(id: string): boolean {
		if (!this.#geometry.read().panes.has(id) || !this.#panes.has(id)) return false;
		this.#focused.set(id);
		return true;
	}

	open(
		id: string,
		create: (close: () => void, rows: () => number) => WorkspaceSurface,
		options: WorkspaceOpenOptions = {},
	): boolean {
		if (this.#disposed || !id) return false;
		if (this.#panes.has(id)) {
			return options.focus === false ? this.#geometry.read().panes.has(id) : this.focus(id);
		}
		const current = this.#geometry.read();
		const targets =
			options.target === undefined
				? [...new Set([this.#focused.peek(), ...current.panes.keys()])]
				: [options.target];
		const edges: readonly WorkspaceEdge[] = options.edge === undefined ? ["right", "bottom"] : [options.edge];
		const share = options.ratio ?? 0.5;
		const ratio = Number.isFinite(share) ? Math.max(0.1, Math.min(0.9, share)) : 0.5;
		const entry = leaf(id, options);
		for (const target of targets) {
			if (!current.panes.has(target)) continue;
			for (const edge of edges) {
				const layout = insertPane(this.#layout.peek(), target, entry, edge, ratio, this.#sequence + 1);
				const prospective = geometry(layout, this.#size.peek());
				const rect = prospective.panes.get(id);
				if (!rect || prospective.panes.size !== current.panes.size + 1) continue;
				// During construction the new surface needs its proposed size; after admission it
				// follows the same geometry the compositor paints, even across a terminal resize.
				let constructing = true;
				let closed = false;
				const close = (): void => {
					if (constructing) closed = true;
					else if (!closed && this.#panes.get(id) === pane) this.close(id);
				};
				const rows = (): number => {
					const height = this.#geometry.read().panes.get(id)?.height ?? 0;
					if (constructing) return rect.height - 1;
					return !closed && this.#panes.get(id) === pane ? Math.max(0, height - 1) : 0;
				};
				const mount = create(close, rows);
				constructing = false;
				if (closed) {
					mount.surface.dispose();
					mount.dispose?.();
					return false;
				}
				this.#sequence++;
				const pane = {
					mount,
					leaf: entry,
					label: flattenLine(stripControl(options.label ?? id)),
					viewport: this.viewport(mount),
				};
				this.#panes.set(id, pane);
				this.endPointer();
				batch(() => {
					this.#layout.set(layout);
					if (options.focus !== false) this.#focused.set(id);
				});
				return true;
			}
		}
		return false;
	}

	close(id: string): boolean {
		if (id === MAIN) return false;
		const pane = this.#panes.get(id);
		if (!pane) return false;
		this.#panes.delete(id);
		this.endPointer();
		batch(() => {
			this.#layout.set(replacePane(this.#layout.peek(), id)!);
			if (this.#focused.peek() === id) this.#focused.set(MAIN);
		});
		pane.viewport.pause();
		pane.mount.surface.dispose();
		pane.mount.dispose?.();
		return true;
	}

	resize(width: number, height: number): void {
		const size = this.#size.peek();
		if (size.width === width && size.height === height) return;
		this.endPointer();
		batch(() => {
			this.#size.set({ ...size, width, height });
			if (!this.#geometry.read().panes.has(this.#focused.peek())) this.#focused.set(MAIN);
		});
	}

	endPointer(): void {
		if (this.#capture) this.#panes.get(this.#capture)?.viewport.endDrag();
		this.#drag = undefined;
		this.#capture = undefined;
	}

	pause(): void {
		this.endPointer();
		this.#frame = undefined;
		for (const pane of this.#panes.values()) pane.viewport.pause();
	}

	dispose(): void {
		this.#disposed = true;
		for (const id of this.#panes.keys()) this.close(id);
		this.#geometry.dispose();
	}

	paintGeometry(): Geometry {
		const frame = this.#geometry.read();
		this.#frame = frame;
		return frame;
	}

	dropPreview(id: string): WorkspaceEdge | undefined {
		const drag = this.#drag;
		return drag?.kind === "move" && drag.drop?.target === id ? drag.drop.edge : undefined;
	}

	bodyHeight(id: string): number {
		const frame = this.#geometry.read();
		return Math.max(1, (frame.panes.get(id)?.height ?? 1) - (frame.panes.size > 1 ? 1 : 0));
	}

	key(key: KeyEvent): boolean {
		if (key.kind !== "press" || this.#panes.size <= 1) return false;
		if (key.id === "escape" && this.#drag) {
			this.endPointer();
			return true;
		}
		if (key.id === "alt+shift+home") return this.focus(MAIN);
		if (key.id === "alt+shift+w") return this.close(this.#focused.peek());
		return false;
	}

	pointer(
		mouse: MouseEvent,
	): { readonly pane: WorkspacePane; readonly id: string; readonly mouse: MouseEvent } | undefined {
		const drag = this.#drag;
		if (drag) {
			if (drag.kind === "move") {
				if (mouse.action === "drag") {
					const drop = this.#dropAt(drag, mouse);
					if (drop) drag.drop = drop;
					else delete drag.drop;
				} else if (mouse.action === "release") {
					const drop = drag.drop && this.#dropAt(drag, mouse);
					this.#drag = undefined;
					if (drop) {
						this.#sequence++;
						this.#layout.set(drop.root);
					}
				}
			} else if (mouse.action === "release") this.#drag = undefined;
			else if (mouse.action === "drag") {
				const { sash, start } = drag;
				const pointer = sash.split.axis === "x" ? mouse.col : mouse.row;
				const first = Math.max(sash.minFirst, Math.min(sash.total - sash.minSecond, sash.first + pointer - start));
				this.#layout.set(setRatio(this.#layout.peek(), sash.split.index, first / sash.total));
			}
			return undefined;
		}
		const frame = this.#frame;
		if (!frame || frame !== this.#geometry.read()) return undefined;
		const press = mouse.action === "press";
		const leftPress = press && mouse.button === "left";
		if (leftPress) {
			this.endPointer();
			const sash = frame.sashes.find(candidate => contains(candidate.rect, mouse));
			if (sash) {
				this.#drag = { kind: "resize", sash, start: sash.split.axis === "x" ? mouse.col : mouse.row };
				return undefined;
			}
		}
		const captured = this.#capture;
		if (mouse.action === "release") this.#capture = undefined;
		const hit =
			captured && (mouse.action === "drag" || mouse.action === "release")
				? ([captured, frame.panes.get(captured)] as const)
				: [...frame.panes].find(([, rect]) => contains(rect, mouse));
		if (!hit?.[1]) return undefined;
		const [id, rect] = hit;
		const pane = this.#panes.get(id)!;
		const header = frame.panes.size > 1 ? 1 : 0;
		if (header && mouse.row === rect.y && !captured) {
			if (leftPress && id !== MAIN && mouse.col === rect.x + rect.width - 1) this.close(id);
			else if (leftPress) {
				this.focus(id);
				this.#drag = { kind: "move", id, row: mouse.row, col: mouse.col };
			}
			return undefined;
		}
		if (press && (mouse.button === "left" || mouse.button === "right")) this.focus(id);
		if (leftPress) this.#capture = id;
		return {
			id,
			pane,
			mouse: {
				...mouse,
				row: Math.max(0, Math.min(rect.height - header - 1, mouse.row - rect.y - header)),
				col: Math.max(0, Math.min(rect.width - 1, mouse.col - rect.x)),
			},
		};
	}

	#dropAt(drag: MoveDrag, mouse: MouseEvent): MoveDrag["drop"] {
		if (drag.row === mouse.row && drag.col === mouse.col) return undefined;
		const frame = this.#frame;
		if (!frame || frame !== this.#geometry.read()) return undefined;
		const target = [...frame.panes].find(([id, rect]) => id !== drag.id && contains(rect, mouse));
		if (!target) return undefined;
		const pane = this.#panes.get(drag.id);
		if (!pane) return undefined;
		const [id, rect] = target;
		const horizontal = (mouse.col - rect.x + 0.5) / rect.width;
		const vertical = (mouse.row - rect.y + 0.5) / rect.height;
		const edges: readonly [WorkspaceEdge, number][] = [
			["left", horizontal],
			["right", 1 - horizontal],
			["top", vertical],
			["bottom", 1 - vertical],
		];
		const nearest = edges.reduce((a, b) => (a[1] <= b[1] ? a : b));
		if (nearest[1] > 0.25) return undefined;
		const [edge] = nearest;
		const root = insertPane(replacePane(this.#layout.peek(), drag.id)!, id, pane.leaf, edge, 0.5, this.#sequence + 1);
		const next = geometry(root, this.#size.peek());
		// Dragging must not silently hide another visible pane to fit the new split.
		for (const id of frame.panes.keys()) if (!next.panes.has(id)) return undefined;
		return { root, target: id, edge };
	}
}
