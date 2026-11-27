import type { FramePlan, MouseEvent } from "../driver/contract";
import { DEFAULT_CELL } from "../driver/images/fit";
import { maskOverlayImages, paneImage, splitImageRow } from "../driver/images/viewport";
import { column, normalizeRow } from "../driver/output/ansi";
import type { KeyEvent } from "../events";
import type { UiNode } from "../node";
import { type Accessor, batch, computed, createRoot, type Signal, signal } from "../reactive";
import type { Surface } from "../surface";
import { stripEscapes } from "../text/ansi";
import { flattenLine, singleLine, stripControl } from "../text/sanitize";
import { padTo, sliceColumns, truncate, visibleWidth } from "../text/width";
import type { Theme } from "../theme/contract";
import type {
	AnsiWorkspace,
	WorkspaceEdge,
	WorkspaceMainView,
	WorkspaceOpenOptions,
	WorkspacePaneMinimum,
	WorkspaceSurface,
} from "../workspace";
import type { FullscreenWindow } from "./fullscreen-window";
import type { Cell, Hit } from "./paint";
import { petrifyRows } from "./petrification";

export interface FrameHit {
	readonly hit: Hit;
	top: number;
	left: number;
}

export interface PointerCover {
	readonly top: number;
	readonly bottom: number;
	readonly left: number;
	readonly right: number;
	readonly firstHit: number;
}

export interface InputFrame {
	readonly layer: readonly UiNode[];
	readonly hits: readonly FrameHit[];
	readonly covers: readonly PointerCover[];
	readonly rail?: { readonly width: number; readonly inset: number };
}

export interface WorkspacePane {
	readonly mount: WorkspaceSurface;
	readonly leaf: Leaf;
	readonly label: string;
	readonly window: FullscreenWindow;
	input?: InputFrame;
	snapshot?: {
		width: number;
		height: number;
		read: Accessor<FramePlan>;
		revision: Signal<number>;
		dirty: boolean;
		cells: { source: string; padded: string }[];
		dispose(): void;
	};
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
	moved: boolean;
	snapshot?: readonly string[];
	drop?: { readonly root: Layout; readonly target: string; readonly edge: WorkspaceEdge };
}

type PointerDrag = MoveDrag | { readonly kind: "resize"; readonly sash: Sash; readonly start: number };

interface Geometry {
	readonly panes: ReadonlyMap<string, WorkspaceRect>;
	readonly sashes: readonly Sash[];
}

interface WorkspacePlacement {
	readonly layout: Layout;
	readonly rect: WorkspaceRect;
	readonly splits: number;
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

/** Equal cells along one grid axis, using the same binary sashes as manually split panes. */
function stack(nodes: readonly Layout[], axis: Split["axis"], nextIndex: () => number): Layout {
	if (nodes.length === 1) return nodes[0]!;
	const middle = Math.ceil(nodes.length / 2);
	return {
		index: nextIndex(),
		axis,
		first: stack(nodes.slice(0, middle), axis, nextIndex),
		second: stack(nodes.slice(middle), axis, nextIndex),
		ratio: middle / nodes.length,
	};
}

/** Try both orientations of a grid, favoring room above the tightest pane's minimum. */
function gridPlacement(
	panes: readonly Leaf[],
	entry: Leaf,
	box: WorkspaceRect,
	sequence: number,
): WorkspacePlacement | undefined {
	let best: (WorkspacePlacement & { scale: number; mainArea: number }) | undefined;
	for (const axis of ["x", "y"] as const) {
		const innerAxis = axis === "x" ? "y" : "x";
		for (let count = 1; count <= panes.length; count++) {
			const base = Math.floor(panes.length / count);
			const extra = panes.length % count;
			for (const extraAtStart of extra === 0 ? [true] : [true, false]) {
				let index = sequence;
				const nextIndex = () => ++index;
				let offset = 0;
				const groups: Layout[] = [];
				for (let group = 0; group < count; group++) {
					const larger = extraAtStart ? group < extra : group >= count - extra;
					const end = offset + base + Number(larger);
					groups.push(stack(panes.slice(offset, end), innerAxis, nextIndex));
					offset = end;
				}
				const layout = stack(groups, axis, nextIndex);
				const frame = geometry(layout, box);
				if (frame.panes.size !== panes.length) continue;
				let scale = Number.POSITIVE_INFINITY;
				for (const pane of panes) {
					const rect = frame.panes.get(pane.id)!;
					scale = Math.min(scale, rect.width / pane.width, rect.height / pane.height);
				}
				const main = frame.panes.get(MAIN)!;
				const mainArea = main.width * main.height;
				if (!best || scale > best.scale || (scale === best.scale && mainArea > best.mainArea)) {
					best = { layout, rect: frame.panes.get(entry.id)!, splits: index - sequence, scale, mainArea };
				}
			}
		}
	}
	return best;
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
	readonly main: WorkspacePane;
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
	#hoverWindow: FullscreenWindow | undefined;
	readonly tailMotion = signal(false);
	#disposed = false;

	constructor(
		main: WorkspaceSurface,
		private readonly createWindow: (mount: WorkspaceSurface, id: string) => FullscreenWindow,
		minimum?: WorkspacePaneMinimum,
	) {
		const entry = leaf(MAIN, minimum);
		this.#layout = signal<Layout>(entry);
		this.main = { mount: main, leaf: entry, label: "Main", window: createWindow(main, MAIN) };
		this.#panes.set(MAIN, this.main);
	}

	active(): string {
		return this.#focused();
	}

	pointerMotion(): boolean {
		for (const id of this.#geometry.read().panes.keys()) {
			if (this.#panes.get(id)?.mount.ansiRail) return true;
		}
		return this.tailMotion();
	}

	mainSize(): { columns: number; rows: number } {
		const { panes } = this.#geometry.read();
		const rect = panes.get(MAIN)!;
		return { columns: rect.width, rows: rect.height - (panes.size > 1 ? 1 : 0) };
	}

	invalidate(id?: string): void {
		if (id !== undefined) {
			const snapshot = this.#panes.get(id)?.snapshot;
			if (snapshot) snapshot.dirty = true;
		} else {
			for (const { snapshot } of this.#panes.values()) if (snapshot) snapshot.dirty = true;
		}
	}

	updateTailMotion(scrollbar: boolean, split: boolean): void {
		const anchored = (pane: WorkspacePane) => pane.window.wheel && !pane.window.following;
		this.tailMotion.set(
			scrollbar &&
				(split
					? [...this.#geometry.read().panes.keys()].some(id => anchored(this.#panes.get(id)!))
					: anchored(this.main)),
		);
	}

	visibleMain(surface: Surface): WorkspaceMainView | undefined {
		return this.transcript(surface)?.visibleMain();
	}

	transcript(surface: Surface): FullscreenWindow | undefined {
		for (const id of this.#geometry.read().panes.keys()) {
			const pane = this.#panes.get(id);
			if (pane?.mount.surface === surface) return pane.window;
		}
		return undefined;
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
		create: (close: () => void, rows: () => number, columns: () => number) => WorkspaceSurface,
		options: WorkspaceOpenOptions = {},
	): boolean {
		if (this.#disposed || !id) return false;
		if (this.#panes.has(id)) {
			return options.focus === false ? this.#geometry.read().panes.has(id) : this.focus(id);
		}
		const entry = leaf(id, options);
		const position = this.#openPlacement(entry, options);
		if (!position) return false;
		const { layout, rect, splits } = position;
		// During construction the new surface needs its proposed size; after admission it
		// follows the same geometry the compositor paints, even across a terminal resize.
		let constructing = true;
		let closed = false;
		const close = (): void => {
			if (constructing) closed = true;
			else if (!closed && this.#panes.get(id) === pane) this.close(id);
		};
		const dimensions = () => {
			const current = this.#geometry.read().panes.get(id);
			if (constructing) return rect;
			return !closed && this.#panes.get(id) === pane ? current : undefined;
		};
		const rows = () => Math.max(0, (dimensions()?.height ?? 0) - 1);
		const columns = () => dimensions()?.width ?? 0;
		const mount = create(close, rows, columns);
		constructing = false;
		if (closed) {
			mount.surface.dispose();
			mount.dispose?.();
			return false;
		}
		this.#sequence += splits;
		const pane = {
			mount,
			leaf: entry,
			label: flattenLine(stripControl(options.label ?? id)),
			window: this.createWindow(mount, id),
		};
		this.#panes.set(id, pane);
		this.endPointer();
		batch(() => {
			this.#layout.set(layout);
			if (options.focus !== false) this.#focused.set(id);
		});
		return true;
	}

	#openPlacement(entry: Leaf, options: WorkspaceOpenOptions): WorkspacePlacement | undefined {
		const current = this.#geometry.read();
		const targets =
			options.target === undefined
				? [...new Set([this.#focused.peek(), ...current.panes.keys()])]
				: [options.target];
		const edges: readonly WorkspaceEdge[] = options.edge === undefined ? ["right", "bottom"] : [options.edge];
		const share = options.ratio ?? 0.5;
		const ratio = Number.isFinite(share) ? Math.max(0.1, Math.min(0.9, share)) : 0.5;
		const box = this.#size.peek();
		for (const target of targets) {
			if (!current.panes.has(target)) continue;
			if (options.canSplit && !options.canSplit(target, this.#panes.size === 1)) continue;
			for (const edge of edges) {
				const layout = insertPane(this.#layout.peek(), target, entry, edge, ratio, this.#sequence + 1);
				const prospective = geometry(layout, box);
				const rect = prospective.panes.get(entry.id);
				if (rect && prospective.panes.size === current.panes.size + 1) return { layout, rect, splits: 1 };
			}
		}
		if (options.target !== undefined || options.edge !== undefined || options.canSplit) return undefined;
		return gridPlacement([...this.#panes.values()].map(pane => pane.leaf).concat(entry), entry, box, this.#sequence);
	}

	close(id: string): boolean {
		if (id === MAIN) return false;
		const pane = this.#panes.get(id);
		if (!pane) return false;
		this.#panes.delete(id);
		pane.snapshot?.dispose();
		if (this.#hoverWindow === pane.window) this.#hoverWindow = undefined;
		this.endPointer();
		batch(() => {
			this.#layout.set(replacePane(this.#layout.peek(), id)!);
			if (this.#focused.peek() === id) this.#focused.set(MAIN);
		});
		pane.window.closeSearch();
		pane.window.hide();
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
		if (this.#capture) this.#panes.get(this.#capture)?.window.blurPointer();
		this.#drag = undefined;
		this.#capture = undefined;
	}

	pause(): void {
		this.endPointer();
		this.#frame = undefined;
		this.#hoverWindow = undefined;
		for (const pane of this.#panes.values()) {
			pane.snapshot?.dispose();
			pane.snapshot = undefined;
			pane.window.closeSearch();
			pane.window.hide();
			pane.input = undefined;
		}
	}

	/** Compose the visible pane bodies, moving only the active pane's cursor into screen cells. */
	paint(
		paintPane: (pane: WorkspacePane, width: number, height: number) => FramePlan,
		theme: Theme,
		reduceMotion: boolean,
	): FramePlan {
		const frame = this.#geometry.read();
		this.#frame = frame;
		const { panes, sashes } = frame;
		const active = this.active();
		const cell = this.main.window.host.images?.cell() ?? DEFAULT_CELL;
		const fragments: { id?: string; rect: WorkspaceRect; rows: string[] }[] = [];
		let cursor: Cell | null = null;
		for (const [id, rect] of panes) {
			const pane = this.#panes.get(id)!;
			const width = rect.width;
			const height = rect.height - 1;
			if (!pane.snapshot || pane.snapshot.width !== width || pane.snapshot.height !== height) {
				pane.snapshot?.dispose();
				pane.snapshot = createRoot(dispose => {
					const revision = signal(0);
					const read = computed(() => {
						revision();
						return paintPane(pane, width, height);
					});
					return { width, height, read, revision, dirty: false, cells: [], dispose };
				});
			}
			// A pane may request another frame while painting, before its computed has subscribed.
			if (pane.snapshot.dirty) {
				pane.snapshot.dirty = false;
				pane.snapshot.revision.update(n => n + 1);
			}
			const plan = pane.snapshot.read();
			const focused = active === id;
			let label = theme.style(focused ? "accent strong" : "muted", `${focused ? "●" : "○"} ${pane.label}`);
			for (const span of pane.mount.titleDetail?.(focused, width) ?? [])
				label += theme.style(span.s, singleLine(stripControl(span.t)));
			const bar =
				id === MAIN
					? label
					: `${padTo(truncate(label, rect.width - 2, ""), rect.width - 2)} ${theme.fg("muted", "×")}`;
			const rows = [bar, ...plan.fullscreen!];
			const petrification = pane.mount.petrification?.();
			fragments.push({
				id,
				rect,
				rows:
					petrification === undefined || reduceMotion ? rows : petrifyRows(rows, rect.width, petrification, theme),
			});
			if (active === id && plan.cursor && plan.cursor.row < rect.height - 1) {
				cursor = {
					row: rect.y + 1 + plan.cursor.row,
					col: rect.x + Math.min(rect.width - 1, plan.cursor.col),
				};
			}
		}
		// The preview covers the target's painted rows without laying out or hit-testing the dragged pane there.
		const drop = this.#dropPreview(id => fragments.find(fragment => fragment.id === id)!.rows);
		if (drop) {
			const { rect, rows } = fragments.find(fragment => fragment.id === drop.target)!;
			const vertical = drop.edge === "top" || drop.edge === "bottom";
			const width = vertical ? rect.width : Math.floor(rect.width / 2);
			const height = vertical ? Math.floor(rect.height / 2) : rect.height;
			const left = drop.edge === "right" ? rect.width - width : 0;
			const top = drop.edge === "bottom" ? rect.height - height : 0;
			const restore = maskOverlayImages(rows, top, height, left, width, cell.w);
			const border = theme.fg("accent", "┃");
			for (let row = 0; row < height; row++) {
				let preview: string;
				if (row === 0) preview = theme.fg("accent", `┏${"━".repeat(width - 2)}┓`);
				else if (row === height - 1) preview = theme.fg("accent", `┗${"━".repeat(width - 2)}┛`);
				else {
					const ghost = padTo(normalizeRow(drop.snapshot[row] ?? "", width - 2), width - 2);
					preview = `${border}${theme.fg("muted", ghost)}${border}`;
				}
				const line = padTo(normalizeRow(rows[top + row] ?? "", rect.width), rect.width);
				const before = padTo(normalizeRow(sliceColumns(line, 0, left), left), left);
				const after = sliceColumns(line, left + width, rect.width);
				// A wide character crossing the cut is dropped without shifting the remaining cells.
				const remaining = rect.width - left - width - visibleWidth(after);
				rows[top + row] = `${before}${preview}${" ".repeat(Math.max(0, remaining))}${after}`;
			}
			restore?.();
		}
		for (const { rect, split: sash } of sashes) {
			const line = theme.fg("border", sash.axis === "x" ? "│" : "─".repeat(rect.width));
			fragments.push({ rect, rows: Array.from({ length: rect.height }, () => line) });
		}
		const rows = Array.from({ length: this.#size().height }, () => "");
		const images: string[] = [];
		// For any given row, the rectangles form disjoint columns from left to right.
		for (const { id, rect, rows: lines } of fragments.sort((a, b) => a.rect.x - b.rect.x)) {
			const cache = id ? this.#panes.get(id)!.snapshot!.cells : undefined;
			for (let row = 0; row < rect.height; row++) {
				const raw = lines[row] ?? "";
				const split = splitImageRow(raw);
				const y = rect.y + row;
				const source = split?.text ?? raw;
				const old = cache?.[row];
				const padded = old?.source === source ? old.padded : padTo(normalizeRow(source, rect.width), rect.width);
				if (cache && old?.source !== source) cache[row] = { source, padded };
				rows[y] += padded;
				for (const image of split?.images ?? []) {
					// A body image may not reach above the pane's title.
					if (image.above >= row) continue;
					const bytes = paneImage(image, rect.width - image.x, cell.w, cell.h);
					if (bytes) images[y] = (images[y] ?? "") + column(rect.x + image.x) + bytes;
				}
			}
		}
		// Draw graphics after all text on the scanline; trailing pads from neighboring panes
		// must not move the image cursor or cross its painted cells.
		for (let row = 0; row < rows.length; row++) rows[row] += images[row] ?? "";
		return { viewport: [], cursor, fullscreen: rows };
	}

	dispose(): void {
		this.#disposed = true;
		for (const id of this.#panes.keys()) this.close(id);
		this.#geometry.dispose();
	}

	#dropPreview(
		capture: (source: string) => readonly string[],
	): { readonly target: string; readonly edge: WorkspaceEdge; readonly snapshot: readonly string[] } | undefined {
		const drag = this.#drag;
		if (drag?.kind !== "move" || !drag.moved) return undefined;
		drag.snapshot ??= capture(drag.id).map(line => stripEscapes(splitImageRow(line)?.text ?? line));
		if (drag.drop) return { target: drag.drop.target, edge: drag.drop.edge, snapshot: drag.snapshot };
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
					drag.moved ||= drag.row !== mouse.row || drag.col !== mouse.col;
					const drop = this.#dropAt(drag, mouse);
					if (drop) drag.drop = drop;
					else delete drag.drop;
				} else if (mouse.action === "release") {
					const drop = drag.drop && this.#dropAt(drag, mouse);
					this.#drag = undefined;
					if (drop) {
						this.#sequence++;
						this.#layout.set(drop.root);
						this.#panes.get(drag.id)?.mount.onManualLayout?.();
					}
				}
			} else if (mouse.action === "release") this.#drag = undefined;
			else if (mouse.action === "drag") {
				const { sash, start } = drag;
				const pointer = sash.split.axis === "x" ? mouse.col : mouse.row;
				const first = Math.max(sash.minFirst, Math.min(sash.total - sash.minSecond, sash.first + pointer - start));
				const before = this.#geometry.read();
				const current = before.sashes.find(candidate => candidate.split.index === sash.split.index);
				if (!current || first === current.first) return undefined;
				this.#layout.set(setRatio(this.#layout.peek(), sash.split.index, first / sash.total));
				const after = this.#geometry.read();
				for (const [id, rect] of before.panes) {
					const resized = after.panes.get(id);
					if (resized && (resized.width !== rect.width || resized.height !== rect.height)) {
						this.#panes.get(id)?.mount.onManualLayout?.();
					}
				}
			}
			return undefined;
		}
		const frame = this.#frame;
		if (mouse.action === "move") {
			const body = frame && [...frame.panes].find(([, rect]) => contains(rect, mouse) && mouse.row > rect.y);
			const next = body && this.#panes.get(body[0])?.window;
			if (next !== this.#hoverWindow) {
				this.#hoverWindow?.leavePointer();
				this.#hoverWindow = next;
			}
		}
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
				this.#drag = { kind: "move", id, row: mouse.row, col: mouse.col, moved: false };
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
