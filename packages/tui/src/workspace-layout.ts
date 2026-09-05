import { matchesKey } from "./keys";
import type { MouseRoutable, SgrMouseEvent } from "./mouse";
import { markKittyPlacementClipRows } from "./terminal-capabilities";
import type { TextSelectionRange } from "./text-selection";
import type {
	AppViewportHoverProvider,
	AppViewportInputOwner,
	AppViewportTextSelectionRect,
	Component,
	TargetedRender,
	ViewportTailProvider,
} from "./tui";
import { componentContains, renderTargeted } from "./tui";
import { padding, sliceByColumn, TERMINAL_STATE_TERMINATOR, truncateToWidth, visibleWidth } from "./utils";

export type WorkspaceAxis = "x" | "y";
export type WorkspaceEdge = "left" | "right" | "top" | "bottom";

export interface WorkspaceRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WorkspacePaneNode {
	readonly kind: "pane";
	readonly paneId: string;
}

export interface WorkspaceSplitChild {
	readonly node: WorkspaceLayoutNode;
	readonly weight: number;
}

export interface WorkspaceSplitNode {
	readonly kind: "split";
	readonly splitId: string;
	readonly axis: WorkspaceAxis;
	readonly children: readonly WorkspaceSplitChild[];
}

export type WorkspaceLayoutNode = WorkspacePaneNode | WorkspaceSplitNode;

export interface WorkspacePaneConstraints {
	minWidth: number;
	minHeight: number;
}

export type WorkspaceConstraintProvider = (paneId: string) => WorkspacePaneConstraints;

export interface WorkspaceSash {
	splitId: string;
	boundary: number;
	axis: WorkspaceAxis;
	rect: WorkspaceRect;
	beforeSize: number;
	afterSize: number;
	beforeMin: number;
	afterMin: number;
}

export interface WorkspaceFrame {
	panes: ReadonlyMap<string, WorkspaceRect>;
	splits: ReadonlyMap<string, WorkspaceRect>;
	sashes: readonly WorkspaceSash[];
	constrained: boolean;
}

export interface ViewportHeightAware {
	setViewportHeight(height: number): void;
}

/** Component-owned viewport that explicitly manages its own follow-bottom state. */
export interface ComponentViewportTailProvider extends ViewportTailProvider {
	readonly componentViewportTail: true;
	renderViewportTailTargeted?(width: number, maxRows: number, targets: readonly Component[]): readonly string[];
}

export interface WorkspacePaneHeaderProvider {
	renderWorkspaceHeader(width: number, focused: boolean): string;
}
export interface WorkspacePane {
	paneId: string;
	title: string;
	component: Component;
	/** Static component, or a resolver for panes whose input widget changes
	 *  over time (e.g. an editor slot that swaps in dialogs). Resolved on every
	 *  focus transition; `undefined` falls back to `component`. */
	focusTarget?: Component | (() => Component | undefined);
	/** Pane-owned identity/status row; falls back to the workspace renderer. */
	renderHeader?: (width: number, focused: boolean) => string;
	minWidth?: number;
	minHeight?: number;
	overflow?: "head" | "tail";
	scroll?: "workspace" | "component";
}

export interface WorkspaceLayoutOptions {
	model: WorkspaceModel;
	panes: readonly WorkspacePane[];
	height: () => number;
	requestRender: () => void;
	requestComponentRender?: (component: Component) => void;
	focus?: (component: Component) => void;
	renderHeader?: (pane: WorkspacePane, width: number, focused: boolean) => string;
	/** Style or replace sash glyphs. Output must preserve the input's visible width. */
	renderSash?: (text: string, axis: WorkspaceAxis) => string;
	renderDropPreview?: (text: string) => string;
	renderDropPreviewGhost?: (text: string) => string;
}

interface RemovePaneResult {
	node: WorkspaceLayoutNode | undefined;
	removed: boolean;
}

interface ReplaceSplitResult {
	node: WorkspaceLayoutNode;
	changed: boolean;
}

interface MinimumSize {
	width: number;
	height: number;
}

function positiveWeight(weight: number): number {
	return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function validateLayoutNode(node: WorkspaceLayoutNode, paneIds: Set<string>, splitIds: Set<string>): void {
	if (node.kind === "pane") {
		if (!node.paneId) throw new Error("Workspace pane id is required");
		if (paneIds.has(node.paneId)) throw new Error(`Duplicate workspace pane: ${node.paneId}`);
		paneIds.add(node.paneId);
		return;
	}
	if (!node.splitId) throw new Error("Workspace split id is required");
	if (splitIds.has(node.splitId)) throw new Error(`Duplicate workspace split: ${node.splitId}`);
	if (node.children.length < 2) throw new Error(`Workspace split requires at least two children: ${node.splitId}`);
	splitIds.add(node.splitId);
	for (const child of node.children) validateLayoutNode(child.node, paneIds, splitIds);
}

function containsPane(node: WorkspaceLayoutNode, paneId: string): boolean {
	if (node.kind === "pane") return node.paneId === paneId;
	return node.children.some(child => containsPane(child.node, paneId));
}

function containsSplit(node: WorkspaceLayoutNode, splitId: string): boolean {
	if (node.kind === "pane") return false;
	if (node.splitId === splitId) return true;
	return node.children.some(child => containsSplit(child.node, splitId));
}

function normalizeNode(node: WorkspaceLayoutNode): WorkspaceLayoutNode {
	if (node.kind === "pane") return node;
	const children: WorkspaceSplitChild[] = [];
	for (const child of node.children) {
		const normalized = normalizeNode(child.node);
		const parentWeight = positiveWeight(child.weight);
		if (normalized.kind === "split" && normalized.axis === node.axis) {
			const nestedWeight = normalized.children.reduce((sum, nested) => sum + positiveWeight(nested.weight), 0);
			for (const nested of normalized.children) {
				children.push({
					node: nested.node,
					weight: parentWeight * (positiveWeight(nested.weight) / nestedWeight),
				});
			}
		} else {
			children.push({ node: normalized, weight: parentWeight });
		}
	}
	if (children.length === 1) return children[0]!.node;
	return { ...node, children };
}

function insertBeside(
	node: WorkspaceLayoutNode,
	targetPaneId: string,
	inserted: WorkspacePaneNode,
	edge: WorkspaceEdge,
	splitId: string,
): ReplaceSplitResult {
	if (node.kind === "pane") {
		if (node.paneId !== targetPaneId) return { node, changed: false };
		const insertedFirst = edge === "left" || edge === "top";
		const axis: WorkspaceAxis = edge === "left" || edge === "right" ? "x" : "y";
		return {
			node: {
				kind: "split",
				splitId,
				axis,
				children: insertedFirst
					? [
							{ node: inserted, weight: 1 },
							{ node, weight: 1 },
						]
					: [
							{ node, weight: 1 },
							{ node: inserted, weight: 1 },
						],
			},
			changed: true,
		};
	}
	for (let index = 0; index < node.children.length; index++) {
		const child = node.children[index]!;
		const result = insertBeside(child.node, targetPaneId, inserted, edge, splitId);
		if (!result.changed) continue;
		const children = [...node.children];
		children[index] = { ...child, node: result.node };
		return { node: { ...node, children }, changed: true };
	}
	return { node, changed: false };
}

function removePane(node: WorkspaceLayoutNode, paneId: string): RemovePaneResult {
	if (node.kind === "pane") {
		return node.paneId === paneId ? { node: undefined, removed: true } : { node, removed: false };
	}
	for (let index = 0; index < node.children.length; index++) {
		const child = node.children[index]!;
		const result = removePane(child.node, paneId);
		if (!result.removed) continue;
		const children = [...node.children];
		if (result.node) {
			children[index] = { ...child, node: result.node };
		} else {
			const removedWeight = positiveWeight(child.weight);
			children.splice(index, 1);
			const neighborIndex = index > 0 ? index - 1 : 0;
			const neighbor = children[neighborIndex];
			if (neighbor) {
				children[neighborIndex] = { ...neighbor, weight: positiveWeight(neighbor.weight) + removedWeight };
			}
		}
		if (children.length === 0) return { node: undefined, removed: true };
		return { node: normalizeNode({ ...node, children }), removed: true };
	}
	return { node, removed: false };
}

function resizeSplit(
	node: WorkspaceLayoutNode,
	splitId: string,
	boundary: number,
	beforeSize: number,
	afterSize: number,
): ReplaceSplitResult {
	if (node.kind === "pane") return { node, changed: false };
	if (node.splitId === splitId) {
		if (boundary < 0 || boundary >= node.children.length - 1) return { node, changed: false };
		const before = node.children[boundary]!;
		const after = node.children[boundary + 1]!;
		const pairWeight = positiveWeight(before.weight) + positiveWeight(after.weight);
		const pairSize = Math.max(1, beforeSize + afterSize);
		const beforeWeight = pairWeight * (Math.max(0, beforeSize) / pairSize);
		const children = [...node.children];
		children[boundary] = { ...before, weight: Math.max(Number.EPSILON, beforeWeight) };
		children[boundary + 1] = { ...after, weight: Math.max(Number.EPSILON, pairWeight - beforeWeight) };
		return { node: { ...node, children }, changed: true };
	}
	for (let index = 0; index < node.children.length; index++) {
		const child = node.children[index]!;
		const result = resizeSplit(child.node, splitId, boundary, beforeSize, afterSize);
		if (!result.changed) continue;
		const children = [...node.children];
		children[index] = { ...child, node: result.node };
		return { node: { ...node, children }, changed: true };
	}
	return { node, changed: false };
}

export class WorkspaceModel {
	#root: WorkspaceLayoutNode;
	#splitSequence = 0;

	constructor(root: WorkspaceLayoutNode) {
		validateLayoutNode(root, new Set(), new Set());
		this.#root = normalizeNode(root);
	}

	static single(paneId: string): WorkspaceModel {
		return new WorkspaceModel({ kind: "pane", paneId });
	}

	get root(): WorkspaceLayoutNode {
		return this.#root;
	}

	hasPane(paneId: string): boolean {
		return containsPane(this.#root, paneId);
	}

	splitPane(targetPaneId: string, newPaneId: string, edge: WorkspaceEdge): boolean {
		if (!targetPaneId || !newPaneId || this.hasPane(newPaneId)) return false;
		const result = insertBeside(
			this.#root,
			targetPaneId,
			{ kind: "pane", paneId: newPaneId },
			edge,
			this.#nextSplitId(),
		);
		if (!result.changed) return false;
		this.#root = normalizeNode(result.node);
		return true;
	}

	closePane(paneId: string): boolean {
		if (!this.hasPane(paneId) || this.#root.kind === "pane") return false;
		const result = removePane(this.#root, paneId);
		if (!result.removed || !result.node) return false;
		this.#root = normalizeNode(result.node);
		return true;
	}

	/** Replace the complete split tree after a caller has validated new geometry. */
	replaceLayout(root: WorkspaceLayoutNode): void {
		validateLayoutNode(root, new Set(), new Set());
		this.#root = normalizeNode(root);
	}

	movePane(paneId: string, targetPaneId: string, edge: WorkspaceEdge): boolean {
		if (paneId === targetPaneId || !this.hasPane(paneId) || !this.hasPane(targetPaneId)) return false;
		const removal = removePane(this.#root, paneId);
		if (!removal.removed || !removal.node) return false;
		const insertion = insertBeside(removal.node, targetPaneId, { kind: "pane", paneId }, edge, this.#nextSplitId());
		if (!insertion.changed) return false;
		this.#root = normalizeNode(insertion.node);
		return true;
	}

	resizeSplit(splitId: string, boundary: number, beforeSize: number, afterSize: number): boolean {
		if (!containsSplit(this.#root, splitId)) return false;
		const result = resizeSplit(this.#root, splitId, boundary, beforeSize, afterSize);
		if (!result.changed) return false;
		this.#root = result.node;
		return true;
	}

	#nextSplitId(): string {
		let splitId: string;
		do {
			splitId = `workspace-split-${++this.#splitSequence}`;
		} while (containsSplit(this.#root, splitId));
		return splitId;
	}
}

function minimumSize(
	node: WorkspaceLayoutNode,
	constraints: WorkspaceConstraintProvider,
	sashSize: number,
	cache: Map<WorkspaceLayoutNode, MinimumSize>,
): MinimumSize {
	const cached = cache.get(node);
	if (cached) return cached;
	let result: MinimumSize;
	if (node.kind === "pane") {
		const pane = constraints(node.paneId);
		result = {
			width: Math.max(1, Math.trunc(pane.minWidth)),
			height: Math.max(1, Math.trunc(pane.minHeight)),
		};
	} else {
		const childMinimums = node.children.map(child => minimumSize(child.node, constraints, sashSize, cache));
		result =
			node.axis === "x"
				? {
						width:
							childMinimums.reduce((sum, child) => sum + child.width, 0) + sashSize * (node.children.length - 1),
						height: Math.max(...childMinimums.map(child => child.height)),
					}
				: {
						width: Math.max(...childMinimums.map(child => child.width)),
						height:
							childMinimums.reduce((sum, child) => sum + child.height, 0) +
							sashSize * (node.children.length - 1),
					};
	}
	cache.set(node, result);
	return result;
}

function apportion(total: number, weights: readonly number[]): number[] {
	if (weights.length === 0) return [];
	if (total <= 0) return weights.map(() => 0);
	const normalized = weights.map(positiveWeight);
	const weightTotal = normalized.reduce((sum, weight) => sum + weight, 0);
	const ideals = normalized.map(weight => (total * weight) / weightTotal);
	const sizes = ideals.map(Math.floor);
	let remainder = total - sizes.reduce((sum, size) => sum + size, 0);
	const order = ideals
		.map((ideal, index) => ({ index, fraction: ideal - Math.floor(ideal) }))
		.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
	for (let index = 0; remainder > 0; index = (index + 1) % order.length) {
		sizes[order[index]!.index]!++;
		remainder--;
	}
	return sizes;
}

function allocateSizes(
	total: number,
	weights: readonly number[],
	minimums: readonly number[],
): { sizes: number[]; constrained: boolean } {
	const minTotal = minimums.reduce((sum, minimum) => sum + minimum, 0);
	if (total < minTotal) {
		const basis = minimums.some(minimum => minimum > 0) ? minimums : weights;
		return { sizes: apportion(total, basis), constrained: true };
	}
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const sizes = new Array<number>(weights.length).fill(0);
	const active = new Set(weights.map((_weight, index) => index));
	let remaining = total;
	while (active.size > 0) {
		const activeWeight = [...active].reduce((sum, index) => sum + positiveWeight(weights[index]!), 0);
		let fixed = false;
		for (const index of active) {
			const ideal = (remaining * positiveWeight(weights[index]!)) / activeWeight;
			if (ideal >= minimums[index]!) continue;
			sizes[index] = minimums[index]!;
			remaining -= sizes[index]!;
			active.delete(index);
			fixed = true;
		}
		if (fixed) continue;
		const activeIndices = [...active];
		const allocated = apportion(
			remaining,
			activeIndices.map(index => weights[index]!),
		);
		for (let offset = 0; offset < activeIndices.length; offset++) {
			sizes[activeIndices[offset]!] = allocated[offset]!;
		}
		break;
	}
	return { sizes, constrained: false };
}

export function layoutWorkspace(
	root: WorkspaceLayoutNode,
	rect: WorkspaceRect,
	constraints: WorkspaceConstraintProvider,
	sashSize = 1,
): WorkspaceFrame {
	const panes = new Map<string, WorkspaceRect>();
	const splits = new Map<string, WorkspaceRect>();
	const sashes: WorkspaceSash[] = [];
	let constrained = false;
	const normalizedRect = {
		x: Math.trunc(rect.x),
		y: Math.trunc(rect.y),
		width: Math.max(0, Math.trunc(rect.width)),
		height: Math.max(0, Math.trunc(rect.height)),
	};
	const preferredSashSize = Math.max(0, Math.trunc(sashSize));
	const minimums = new Map<WorkspaceLayoutNode, MinimumSize>();

	const place = (node: WorkspaceLayoutNode, nodeRect: WorkspaceRect): void => {
		const minimum = minimumSize(node, constraints, preferredSashSize, minimums);
		if (nodeRect.width < minimum.width || nodeRect.height < minimum.height) constrained = true;
		if (node.kind === "pane") {
			panes.set(node.paneId, nodeRect);
			return;
		}
		splits.set(node.splitId, nodeRect);
		const dimension = node.axis === "x" ? nodeRect.width : nodeRect.height;
		const boundaryCount = Math.max(0, node.children.length - 1);
		const actualSashSize =
			boundaryCount === 0 ? 0 : Math.min(preferredSashSize, Math.floor(dimension / boundaryCount));
		if (actualSashSize < preferredSashSize) constrained = true;
		const contentSize = Math.max(0, dimension - actualSashSize * boundaryCount);
		const childMinimums = node.children.map(child =>
			minimumSize(child.node, constraints, preferredSashSize, minimums),
		);
		const allocation = allocateSizes(
			contentSize,
			node.children.map(child => child.weight),
			childMinimums.map(child => (node.axis === "x" ? child.width : child.height)),
		);
		constrained ||= allocation.constrained;
		let offset = 0;
		for (let index = 0; index < node.children.length; index++) {
			const childSize = allocation.sizes[index]!;
			const childRect =
				node.axis === "x"
					? { x: nodeRect.x + offset, y: nodeRect.y, width: childSize, height: nodeRect.height }
					: { x: nodeRect.x, y: nodeRect.y + offset, width: nodeRect.width, height: childSize };
			place(node.children[index]!.node, childRect);
			offset += childSize;
			if (index >= boundaryCount) continue;
			const sashRect =
				node.axis === "x"
					? { x: nodeRect.x + offset, y: nodeRect.y, width: actualSashSize, height: nodeRect.height }
					: { x: nodeRect.x, y: nodeRect.y + offset, width: nodeRect.width, height: actualSashSize };
			sashes.push({
				splitId: node.splitId,
				boundary: index,
				axis: node.axis,
				rect: sashRect,
				beforeSize: childSize,
				afterSize: allocation.sizes[index + 1]!,
				beforeMin: node.axis === "x" ? childMinimums[index]!.width : childMinimums[index]!.height,
				afterMin: node.axis === "x" ? childMinimums[index + 1]!.width : childMinimums[index + 1]!.height,
			});
			offset += actualSashSize;
		}
	};

	place(root, normalizedRect);
	return { panes, splits, sashes, constrained };
}

function buildBalancedGridLayout(
	paneIds: readonly string[],
	groupCount: number,
	outerAxis: WorkspaceAxis,
	extraAtStart: boolean,
): WorkspaceLayoutNode {
	const baseGroupSize = Math.floor(paneIds.length / groupCount);
	const remainder = paneIds.length % groupCount;
	const innerAxis: WorkspaceAxis = outerAxis === "x" ? "y" : "x";
	const prefix = `workspace-reflow-${outerAxis}-${groupCount}-${extraAtStart ? "start" : "end"}`;
	let splitSequence = 0;
	let offset = 0;
	const groups: WorkspaceLayoutNode[] = [];
	for (let index = 0; index < groupCount; index++) {
		const getsExtra = extraAtStart ? index < remainder : index >= groupCount - remainder;
		const groupSize = baseGroupSize + (getsExtra ? 1 : 0);
		const paneNodes: WorkspaceLayoutNode[] = paneIds
			.slice(offset, offset + groupSize)
			.map(paneId => ({ kind: "pane", paneId }));
		offset += groupSize;
		groups.push(
			paneNodes.length === 1
				? paneNodes[0]!
				: {
						kind: "split",
						splitId: `${prefix}-${++splitSequence}`,
						axis: innerAxis,
						children: paneNodes.map(node => ({ node, weight: 1 })),
					},
		);
	}
	if (groups.length === 1) return groups[0]!;
	return {
		kind: "split",
		splitId: `${prefix}-${++splitSequence}`,
		axis: outerAxis,
		children: groups.map(node => ({ node, weight: 1 })),
	};
}

function findWorkspaceReflowLayout(
	panes: readonly WorkspacePane[],
	width: number,
	height: number,
): WorkspaceLayoutNode | undefined {
	if (panes.length === 0) return undefined;
	const paneById = new Map(panes.map(pane => [pane.paneId, pane]));
	const paneIds = panes.map(pane => pane.paneId);
	const constraints = (paneId: string): WorkspacePaneConstraints => {
		const pane = paneById.get(paneId);
		return { minWidth: pane?.minWidth ?? 10, minHeight: pane?.minHeight ?? 3 };
	};
	let best:
		| {
				root: WorkspaceLayoutNode;
				minimumScale: number;
				anchorArea: number;
		  }
		| undefined;
	for (const outerAxis of ["x", "y"] as const) {
		for (let groupCount = 1; groupCount <= paneIds.length; groupCount++) {
			const remainder = paneIds.length % groupCount;
			for (const extraAtStart of remainder === 0 ? [true] : [true, false]) {
				const root = buildBalancedGridLayout(paneIds, groupCount, outerAxis, extraAtStart);
				const frame = layoutWorkspace(root, { x: 0, y: 0, width, height }, constraints);
				if (frame.constrained) continue;
				let minimumScale = Number.POSITIVE_INFINITY;
				for (const pane of panes) {
					const paneRect = frame.panes.get(pane.paneId);
					if (!paneRect) {
						minimumScale = 0;
						break;
					}
					const minimum = constraints(pane.paneId);
					minimumScale = Math.min(
						minimumScale,
						paneRect.width / minimum.minWidth,
						paneRect.height / minimum.minHeight,
					);
				}
				const anchorRect = frame.panes.get(paneIds[0]!);
				const anchorArea = anchorRect ? anchorRect.width * anchorRect.height : 0;
				if (
					!best ||
					minimumScale > best.minimumScale ||
					(minimumScale === best.minimumScale && anchorArea > best.anchorArea)
				) {
					best = { root, minimumScale, anchorArea };
				}
			}
		}
	}
	return best?.root;
}

interface WorkspaceResizeDrag {
	kind: "resize";
	splitId: string;
	boundary: number;
	axis: WorkspaceAxis;
	start: number;
	beforeSize: number;
	afterSize: number;
	beforeMin: number;
	afterMin: number;
}

interface WorkspaceMoveDrag {
	kind: "move";
	paneId: string;
	startRow: number;
	startCol: number;
	active: boolean;
}

type WorkspaceDrag = WorkspaceResizeDrag | WorkspaceMoveDrag;

interface WorkspaceDropTarget {
	paneId: string;
	edge: WorkspaceEdge;
}

function firstPaneId(node: WorkspaceLayoutNode): string {
	if (node.kind === "pane") return node.paneId;
	return firstPaneId(node.children[0]!.node);
}

function containsPoint(rect: WorkspaceRect, row: number, col: number): boolean {
	return col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height;
}

function fitWorkspaceLine(line: string, width: number): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(line, width);
	const fitted = truncated + padding(Math.max(0, width - visibleWidth(truncated)));
	return line.includes("\x1b") ? fitted + TERMINAL_STATE_TERMINATOR : fitted;
}

interface WorkspacePaneViewport {
	offset: number;
	maxOffset: number;
	followBottom: boolean;
}

interface TextSelectionAware {
	setTextSelectionActive(active: boolean): void;
}

function textSelectionAware(component: Component | undefined): TextSelectionAware | undefined {
	if (!component) return undefined;
	const candidate = component as Component & Partial<TextSelectionAware>;
	if (typeof candidate.setTextSelectionActive !== "function") return undefined;
	// The runtime method check above establishes the optional capability.
	return candidate as Component & TextSelectionAware;
}

/**
 * App-viewport workspace compositor with recursively nested panes. The layout
 * tree owns geometry; pane components retain their own content and scroll state.
 */
export class WorkspaceLayout implements Component, AppViewportInputOwner, TargetedRender {
	readonly #model: WorkspaceModel;
	readonly #panes = new Map<string, WorkspacePane>();
	readonly #viewports = new Map<string, WorkspacePaneViewport>();
	readonly #height: () => number;
	readonly #requestRender: () => void;
	readonly #requestComponentRender: ((component: Component) => void) | undefined;
	readonly #focus: ((component: Component) => void) | undefined;
	readonly #renderHeader: ((pane: WorkspacePane, width: number, focused: boolean) => string) | undefined;
	readonly #renderSash: (text: string, axis: WorkspaceAxis) => string;
	readonly #renderDropPreview: (text: string) => string;
	readonly #renderDropPreviewGhost: (text: string) => string;
	#focusedPaneId: string;
	#frame: WorkspaceFrame | undefined;
	#drag: WorkspaceDrag | undefined;
	#dropTarget: WorkspaceDropTarget | undefined;
	#dragSnapshot: readonly string[] | undefined;
	#hoveredPaneId: string | undefined;
	#textSelectionPaneId: string | undefined;
	#paneRenderCache = new Map<string, { component: Component; width: number; height: number; lines: string[] }>();
	#targetedPaneTargets: Map<string, Component[]> | undefined;
	readonly #chromeRenderTarget: Component = { render: () => [] };
	#targetPaneCache = new WeakMap<Component, { paneId: string; component: Component }>();
	#renderWidth = 0;
	#renderHeight = 0;
	#renderRoot: WorkspaceLayoutNode | undefined;

	constructor(options: WorkspaceLayoutOptions) {
		this.#model = options.model;
		this.#height = options.height;
		this.#requestRender = options.requestRender;
		this.#requestComponentRender = options.requestComponentRender;
		this.#focus = options.focus;
		this.#renderHeader = options.renderHeader;
		this.#renderSash = options.renderSash ?? (text => text);
		this.#renderDropPreview = options.renderDropPreview ?? (text => text);
		this.#renderDropPreviewGhost = options.renderDropPreviewGhost ?? (text => text);
		for (const pane of options.panes) {
			if (this.#panes.has(pane.paneId)) throw new Error(`Duplicate workspace pane: ${pane.paneId}`);
			this.#panes.set(pane.paneId, pane);
		}
		this.#focusedPaneId = firstPaneId(this.#model.root);
	}

	get model(): WorkspaceModel {
		return this.#model;
	}

	get frame(): WorkspaceFrame | undefined {
		return this.#frame;
	}

	get focusedPaneId(): string {
		return this.#focusedPaneId;
	}

	containsComponent(component: Component): boolean {
		if (component === this.#chromeRenderTarget) return true;
		return this.#findTargetPane(component) !== undefined;
	}

	#findTargetPane(target: Component): string | undefined {
		const cached = this.#targetPaneCache.get(target);
		if (
			cached !== undefined &&
			this.#panes.get(cached.paneId)?.component === cached.component &&
			componentContains(cached.component, target)
		) {
			return cached.paneId;
		}
		for (const [paneId, pane] of this.#panes) {
			if (!componentContains(pane.component, target)) continue;
			this.#targetPaneCache.set(target, { paneId, component: pane.component });
			return paneId;
		}
		this.#targetPaneCache.delete(target);
		return undefined;
	}

	focusPane(paneId: string): boolean {
		const pane = this.#panes.get(paneId);
		if (!pane) return false;
		const previousPane = this.#panes.get(this.#focusedPaneId);
		const previousFocus = previousPane ? this.#paneFocusComponent(previousPane) : undefined;
		const nextFocus = this.#paneFocusComponent(pane);
		this.#focusedPaneId = paneId;
		this.#focus?.(nextFocus);
		if (this.#requestComponentRender) {
			this.#requestComponentRender(this.#chromeRenderTarget);
			if (previousFocus) this.#requestComponentRender(previousFocus);
			this.#requestComponentRender(nextFocus);
		} else {
			this.#requestRender();
		}
		return true;
	}

	#paneFocusComponent(pane: WorkspacePane): Component {
		const target = typeof pane.focusTarget === "function" ? pane.focusTarget() : pane.focusTarget;
		return target ?? pane.component;
	}

	focusNextPane(direction: 1 | -1 = 1): boolean {
		const paneIds = [...(this.#frame?.panes.keys() ?? [])];
		if (paneIds.length < 2) return false;
		const current = Math.max(0, paneIds.indexOf(this.#focusedPaneId));
		const next = (current + direction + paneIds.length) % paneIds.length;
		return this.focusPane(paneIds[next]!);
	}

	splitPane(targetPaneId: string, pane: WorkspacePane, edge: WorkspaceEdge): boolean {
		if (this.#panes.has(pane.paneId) || !this.#canDock(targetPaneId, pane, edge)) return false;
		if (!this.#model.splitPane(targetPaneId, pane.paneId, edge)) return false;
		this.#panes.set(pane.paneId, pane);
		this.#targetPaneCache = new WeakMap();
		this.focusPane(pane.paneId);
		return true;
	}

	/**
	 * Rebuild the whole split tree to insert a pane when no current rectangle
	 * can be split in place. Existing components, focus targets, and scroll
	 * state survive; only geometry and equalized split weights change.
	 */
	reflowPane(pane: WorkspacePane): boolean {
		if (this.#panes.has(pane.paneId) || !this.#frame || this.#renderWidth <= 0 || this.#renderHeight <= 0) {
			return false;
		}
		const root = findWorkspaceReflowLayout([...this.#panes.values(), pane], this.#renderWidth, this.#renderHeight);
		if (!root) return false;
		this.#model.replaceLayout(root);
		this.#panes.set(pane.paneId, pane);
		this.#targetPaneCache = new WeakMap();
		this.#drag = undefined;
		this.#dropTarget = undefined;
		this.#dragSnapshot = undefined;
		this.focusPane(pane.paneId);
		return true;
	}

	closePane(paneId: string): boolean {
		if (!this.#model.closePane(paneId)) return false;
		if (this.#hoveredPaneId === paneId) this.#setHoveredPane(undefined);
		const pane = this.#panes.get(paneId);
		this.#panes.delete(paneId);
		this.#targetPaneCache = new WeakMap();
		this.#viewports.delete(paneId);
		this.#paneRenderCache.delete(paneId);
		pane?.component.dispose?.();
		if (this.#focusedPaneId === paneId) {
			this.#focusedPaneId = firstPaneId(this.#model.root);
			const next = this.#panes.get(this.#focusedPaneId);
			if (next) this.#focus?.(this.#paneFocusComponent(next));
		}
		this.#requestRender();
		return true;
	}

	movePane(paneId: string, targetPaneId: string, edge: WorkspaceEdge): boolean {
		const pane = this.#panes.get(paneId);
		if (!pane || !this.#canDock(targetPaneId, pane, edge)) return false;
		if (!this.#model.movePane(paneId, targetPaneId, edge)) return false;
		this.#focusedPaneId = paneId;
		this.#focus?.(this.#paneFocusComponent(pane));
		this.#requestRender();
		return true;
	}

	wantsAppViewportHover(): boolean {
		for (const pane of this.#panes.values()) {
			const provider = pane.component as Component & Partial<AppViewportHoverProvider>;
			if (provider.wantsAppViewportHover?.()) return true;
		}
		return false;
	}

	handleAppViewportInput(data: string): boolean {
		const pane = this.#panes.get(this.#focusedPaneId);
		if (
			!matchesKey(data, "pageUp") &&
			!matchesKey(data, "alt+pageUp") &&
			!matchesKey(data, "pageDown") &&
			!matchesKey(data, "alt+pageDown") &&
			!matchesKey(data, "alt+home") &&
			!matchesKey(data, "alt+end")
		) {
			return false;
		}
		if (pane?.scroll === "component") {
			pane.component.handleInput?.(data);
			return true;
		}
		const page = Math.max(1, (this.#frame?.panes.get(this.#focusedPaneId)?.height ?? 3) - 2);
		if (matchesKey(data, "pageUp") || matchesKey(data, "alt+pageUp")) {
			return this.#scrollPane(this.#focusedPaneId, -page);
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "alt+pageDown")) {
			return this.#scrollPane(this.#focusedPaneId, page);
		}
		if (matchesKey(data, "alt+home")) return this.#scrollPane(this.#focusedPaneId, "top");
		return this.#scrollPane(this.#focusedPaneId, "bottom");
	}

	getAppViewportTextSelectionRect(row: number, col: number): AppViewportTextSelectionRect | undefined {
		const paneId = this.#paneAt(row, col);
		const pane = paneId ? this.#panes.get(paneId) : undefined;
		const rect = paneId ? this.#frame?.panes.get(paneId) : undefined;
		if (!paneId || !pane || !rect || row < rect.y + 1) return undefined;
		const localRow = Math.floor(row) - rect.y - 1;
		const rowOffset = pane.scroll === "component" ? 0 : (this.#viewports.get(paneId)?.offset ?? 0);
		const contentRow = localRow + rowOffset;
		const leftInset = Math.max(
			0,
			Math.min(Math.trunc(pane.component.getTextSelectionInset?.(contentRow) ?? 0), rect.width - 1),
		);
		const rightInset = Math.max(
			0,
			Math.min(Math.trunc(pane.component.getTextSelectionRightInset?.(contentRow) ?? 0), rect.width - leftInset - 1),
		);
		let regionStart = 0;
		let regionEnd = rect.height - 2;
		const scrollOffsetAt = pane.scroll === "component" ? pane.component.getTextSelectionScrollOffset : undefined;
		if (scrollOffsetAt) {
			const scrollable = scrollOffsetAt.call(pane.component, localRow) !== undefined;
			regionStart = localRow;
			while (
				regionStart > 0 &&
				(scrollOffsetAt.call(pane.component, regionStart - 1) !== undefined) === scrollable
			) {
				regionStart--;
			}
			regionEnd = localRow;
			while (
				regionEnd < rect.height - 2 &&
				(scrollOffsetAt.call(pane.component, regionEnd + 1) !== undefined) === scrollable
			) {
				regionEnd++;
			}
		}
		return {
			row: rect.y + 1 + regionStart,
			col: rect.x + leftInset,
			width: rect.width - leftInset - rightInset,
			height: regionEnd - regionStart + 1,
		};
	}

	getAppViewportTextSelectionScrollOffset(row: number, col: number): number | undefined {
		const paneId = this.#paneAt(row, col);
		const pane = paneId ? this.#panes.get(paneId) : undefined;
		const rect = paneId ? this.#frame?.panes.get(paneId) : undefined;
		if (!paneId || !pane || !rect || row < rect.y + 1) return undefined;
		if (pane.scroll !== "component") return this.#viewports.get(paneId)?.offset ?? 0;
		return pane.component.getTextSelectionScrollOffset?.(Math.floor(row) - rect.y - 1);
	}

	setAppViewportTextSelectionActive(active: boolean, row?: number, col?: number): void {
		if (!active) {
			const previous = this.#textSelectionPaneId;
			this.#textSelectionPaneId = undefined;
			if (previous) textSelectionAware(this.#panes.get(previous)?.component)?.setTextSelectionActive(false);
			return;
		}
		if (row === undefined || col === undefined) return;
		const paneId = this.#paneAt(row, col);
		if (!paneId) return;
		if (this.#textSelectionPaneId && this.#textSelectionPaneId !== paneId) {
			textSelectionAware(this.#panes.get(this.#textSelectionPaneId)?.component)?.setTextSelectionActive(false);
		}
		this.#textSelectionPaneId = paneId;
		textSelectionAware(this.#panes.get(paneId)?.component)?.setTextSelectionActive(true);
	}

	getAppViewportTextSelection(selection: TextSelectionRange): string | undefined {
		const startPaneId = this.#paneAt(selection.start.row, selection.start.col);
		const endPaneId = this.#paneAt(selection.end.row, selection.end.col);
		if (startPaneId && endPaneId && startPaneId !== endPaneId) return undefined;
		const paneId = startPaneId ?? endPaneId;
		const pane = paneId ? this.#panes.get(paneId) : undefined;
		const rect = paneId ? this.#frame?.panes.get(paneId) : undefined;
		if (!paneId || !pane?.component.getTextSelection || !rect) return undefined;
		const rowOffset = pane.scroll === "component" ? 0 : (this.#viewports.get(paneId)?.offset ?? 0);
		return pane.component.getTextSelection({
			start: {
				row: selection.start.row - rect.y - 1 + rowOffset,
				col: selection.start.col - rect.x,
			},
			end: {
				row: selection.end.row - rect.y - 1 + rowOffset,
				col: selection.end.col - rect.x,
			},
		});
	}

	handleAppViewportMouse(event: SgrMouseEvent): boolean {
		const drag = this.#drag;
		if (drag) {
			if (event.release) {
				if (drag.kind === "move" && drag.active && this.#dropTarget) {
					this.movePane(drag.paneId, this.#dropTarget.paneId, this.#dropTarget.edge);
				}
				this.#drag = undefined;
				this.#dropTarget = undefined;
				this.#dragSnapshot = undefined;
				this.#requestRender();
				return true;
			}
			if (event.motion) {
				if (drag.kind === "resize") {
					const pointer = drag.axis === "x" ? event.col : event.row;
					const rawDelta = pointer - drag.start;
					const delta = Math.max(
						drag.beforeMin - drag.beforeSize,
						Math.min(rawDelta, drag.afterSize - drag.afterMin),
					);
					this.#model.resizeSplit(drag.splitId, drag.boundary, drag.beforeSize + delta, drag.afterSize - delta);
				} else {
					drag.active ||= Math.abs(event.row - drag.startRow) + Math.abs(event.col - drag.startCol) > 0;
					this.#dropTarget = drag.active ? this.#dropTargetAt(event.row, event.col, drag.paneId) : undefined;
				}
				this.#requestRender();
				return true;
			}
			return true;
		}

		if (event.leftClick) {
			const sash = this.#frame?.sashes.find(candidate => containsPoint(candidate.rect, event.row, event.col));
			if (sash) {
				this.#drag = {
					kind: "resize",
					splitId: sash.splitId,
					boundary: sash.boundary,
					axis: sash.axis,
					start: sash.axis === "x" ? event.col : event.row,
					beforeSize: sash.beforeSize,
					afterSize: sash.afterSize,
					beforeMin: sash.beforeMin,
					afterMin: sash.afterMin,
				};
				return true;
			}
			const paneId = this.#paneAt(event.row, event.col);
			if (paneId) {
				this.focusPane(paneId);
				const rect = this.#frame?.panes.get(paneId);
				if (rect && event.row === rect.y) {
					this.#dragSnapshot = undefined;
					this.#drag = {
						kind: "move",
						paneId,
						startRow: event.row,
						startCol: event.col,
						active: false,
					};
					return true;
				}
			}
		}

		const paneId = this.#paneAt(event.row, event.col);
		const pane = paneId ? this.#panes.get(paneId) : undefined;
		const rect = paneId ? this.#frame?.panes.get(paneId) : undefined;
		if (event.motion) this.#setHoveredPane(pane && rect && event.row > rect.y ? paneId : undefined);
		if (!paneId || !pane || !rect || event.row <= rect.y) return event.wheel !== null;
		const line = event.row - rect.y - 1;
		const col = event.col - rect.x;
		if (event.wheel !== null && pane.scroll !== "component") {
			this.#scrollPane(paneId, event.wheel * 3);
			return true;
		}
		const mouseTarget = pane.component as Component & Partial<MouseRoutable>;
		if (mouseTarget.routeMouse) {
			const handled = mouseTarget.routeMouse(event, line, col);
			if (handled === false) return false;
			if (pane.scroll !== "component") this.#requestRender();
			return true;
		}
		if (pane.component.handleInput && event.wheel !== null) {
			const suffix = event.release ? "m" : "M";
			pane.component.handleInput(`\x1b[<${event.button};${col + 1};${line + 1}${suffix}`);
			if (pane.scroll !== "component") this.#requestRender();
			return true;
		}
		return event.wheel !== null;
	}

	render(width: number): readonly string[] {
		const height = Math.max(1, Math.trunc(this.#height()));
		const canvasWidth = Math.max(1, Math.trunc(width));
		this.#frame = layoutWorkspace(this.#model.root, { x: 0, y: 0, width: canvasWidth, height }, paneId => {
			const pane = this.#panes.get(paneId);
			return { minWidth: pane?.minWidth ?? 10, minHeight: pane?.minHeight ?? 3 };
		});
		const lines = [...this.#renderNode(this.#model.root)];
		if (this.#dropTarget) {
			const rect = this.#frame.panes.get(this.#dropTarget.paneId);
			if (rect) this.#paintDropPreview(lines, canvasWidth, rect, this.#dropTarget.edge);
		}
		this.#renderWidth = canvasWidth;
		this.#renderHeight = height;
		this.#renderRoot = this.#model.root;
		return lines;
	}

	renderTargeted(width: number, targets: readonly Component[]): readonly string[] {
		const height = Math.max(1, Math.trunc(this.#height()));
		const canvasWidth = Math.max(1, Math.trunc(width));
		if (
			targets.length === 0 ||
			this.#frame === undefined ||
			this.#renderWidth !== canvasWidth ||
			this.#renderHeight !== height ||
			this.#renderRoot !== this.#model.root
		) {
			return this.render(width);
		}
		const grouped = new Map<string, Component[]>();
		for (const target of targets) {
			if (target === this.#chromeRenderTarget) continue;
			const ownerId = this.#findTargetPane(target);
			if (!ownerId) return this.render(width);
			const paneTargets = grouped.get(ownerId);
			if (paneTargets) paneTargets.push(target);
			else grouped.set(ownerId, [target]);
		}
		this.#targetedPaneTargets = grouped;
		try {
			return this.render(width);
		} finally {
			this.#targetedPaneTargets = undefined;
		}
	}

	invalidate(): void {
		this.#paneRenderCache.clear();
		for (const pane of this.#panes.values()) pane.component.invalidate?.();
	}

	dispose(): void {
		this.#setHoveredPane(undefined);
		for (const pane of this.#panes.values()) pane.component.dispose?.();
		this.#panes.clear();
		this.#targetPaneCache = new WeakMap();
		this.#paneRenderCache.clear();
		this.#viewports.clear();
		this.#frame = undefined;
		this.#drag = undefined;
		this.#dropTarget = undefined;
		this.#dragSnapshot = undefined;
	}

	#setHoveredPane(paneId: string | undefined): void {
		if (paneId === this.#hoveredPaneId) return;
		const previous = this.#hoveredPaneId ? this.#panes.get(this.#hoveredPaneId) : undefined;
		const provider = previous?.component as (Component & Partial<AppViewportHoverProvider>) | undefined;
		provider?.clearAppViewportHover?.();
		this.#hoveredPaneId = paneId;
	}

	#renderNode(node: WorkspaceLayoutNode): string[] {
		if (!this.#frame) return [];
		if (node.kind === "pane") {
			const rect = this.#frame.panes.get(node.paneId);
			return rect ? this.#renderPane(node.paneId, rect) : [];
		}
		const rect = this.#frame.splits.get(node.splitId);
		if (!rect) return [];
		const renderedChildren = node.children.map(child => this.#renderNode(child.node));
		if (node.axis === "x") {
			const lines: string[] = [];
			for (let row = 0; row < rect.height; row++) {
				let line = "";
				for (let index = 0; index < renderedChildren.length; index++) {
					line += renderedChildren[index]![row] ?? "";
					if (index >= renderedChildren.length - 1) continue;
					const sash = this.#frame.sashes.find(
						candidate => candidate.splitId === node.splitId && candidate.boundary === index,
					);
					const sashText = "│".repeat(sash?.rect.width ?? 0);
					line += this.#renderSash(sashText, "x");
				}
				lines.push(fitWorkspaceLine(line, rect.width));
			}
			return lines;
		}
		const lines: string[] = [];
		for (let index = 0; index < renderedChildren.length; index++) {
			lines.push(...renderedChildren[index]!);
			if (index >= renderedChildren.length - 1) continue;
			const sash = this.#frame.sashes.find(
				candidate => candidate.splitId === node.splitId && candidate.boundary === index,
			);
			const sashText = "─".repeat(rect.width);
			for (let row = 0; row < (sash?.rect.height ?? 0); row++) lines.push(this.#renderSash(sashText, "y"));
		}
		return lines.slice(0, rect.height);
	}

	#renderPane(paneId: string, rect: WorkspaceRect): string[] {
		if (rect.height <= 0) return [];
		const pane = this.#panes.get(paneId);
		if (!pane)
			return Array.from({ length: rect.height }, () => fitWorkspaceLine(`Missing pane: ${paneId}`, rect.width));
		const paneTargets = this.#targetedPaneTargets?.get(paneId);
		if (this.#targetedPaneTargets && !paneTargets) {
			const cached = this.#paneRenderCache.get(paneId);
			if (
				cached &&
				cached.component === pane.component &&
				cached.width === rect.width &&
				cached.height === rect.height
			) {
				return cached.lines;
			}
		}
		const focused = paneId === this.#focusedPaneId;
		const header = pane.renderHeader
			? pane.renderHeader(rect.width, focused)
			: this.#renderHeader
				? this.#renderHeader(pane, rect.width, focused)
				: `${focused ? ">" : " "}${pane.title}`;
		const contentHeight = Math.max(0, rect.height - 1);
		const heightAware = pane.component as Component & Partial<ViewportHeightAware>;
		const componentOwnsViewport = pane.scroll === "component";
		if (componentOwnsViewport) heightAware.setViewportHeight?.(contentHeight);
		const componentWidth = Math.max(1, rect.width);
		const tailProvider = pane.component as Component & Partial<ViewportTailProvider>;
		const componentTailProvider = pane.component as Component & Partial<ComponentViewportTailProvider>;
		let content: readonly string[];
		if (componentOwnsViewport) {
			if (
				paneTargets &&
				componentTailProvider.componentViewportTail &&
				componentTailProvider.renderViewportTailTargeted
			) {
				content = componentTailProvider.renderViewportTailTargeted(rect.width, contentHeight, paneTargets);
			} else if (paneTargets) {
				content = renderTargeted(pane.component, componentWidth, paneTargets).slice(0, contentHeight);
			} else if (componentTailProvider.componentViewportTail && componentTailProvider.renderViewportTail) {
				content = componentTailProvider.renderViewportTail(rect.width, contentHeight);
			} else {
				content = pane.component.render(componentWidth).slice(0, contentHeight);
			}
		} else {
			const targetedContent = paneTargets ? renderTargeted(pane.component, componentWidth, paneTargets) : undefined;
			const useTail =
				targetedContent === undefined &&
				this.#drag?.kind === "resize" &&
				tailProvider.renderViewportTail !== undefined;
			const viewport = this.#viewports.get(paneId) ?? {
				offset: 0,
				maxOffset: 0,
				followBottom: pane.overflow === "tail",
			};
			if (useTail && viewport.followBottom) {
				content = tailProvider.renderViewportTail!(rect.width, contentHeight);
			} else {
				const rendered = targetedContent ?? pane.component.render(componentWidth);
				viewport.maxOffset = Math.max(0, rendered.length - contentHeight);
				viewport.offset = viewport.followBottom
					? viewport.maxOffset
					: Math.max(0, Math.min(viewport.offset, viewport.maxOffset));
				content = rendered.slice(viewport.offset, viewport.offset + contentHeight);
				this.#viewports.set(paneId, viewport);
			}
		}
		const lines = [fitWorkspaceLine(header, rect.width)];
		for (let row = 0; row < contentHeight; row++) {
			const contentLine = content[row] ?? "";
			lines.push(fitWorkspaceLine(markKittyPlacementClipRows(contentLine, row), rect.width));
		}
		const drag = this.#drag;
		if (drag?.kind === "move" && drag.active && drag.paneId === paneId && !this.#dragSnapshot) {
			this.#dragSnapshot = lines.map(line => Bun.stripANSI(line));
		}
		this.#paneRenderCache.set(paneId, {
			component: pane.component,
			width: rect.width,
			height: rect.height,
			lines,
		});
		return lines;
	}

	#paintDropPreview(lines: string[], canvasWidth: number, rect: WorkspaceRect, edge: WorkspaceEdge): void {
		const previewWidth = edge === "left" || edge === "right" ? Math.max(1, Math.floor(rect.width / 2)) : rect.width;
		const previewHeight =
			edge === "top" || edge === "bottom" ? Math.max(1, Math.floor(rect.height / 2)) : rect.height;
		const startCol = rect.x + (edge === "right" ? rect.width - previewWidth : 0);
		const startRow = rect.y + (edge === "bottom" ? rect.height - previewHeight : 0);
		for (let row = startRow; row < startRow + previewHeight; row++) {
			const current = lines[row] ?? padding(canvasWidth);
			const left = sliceByColumn(current, 0, startCol);
			const right = sliceByColumn(current, startCol + previewWidth, canvasWidth - startCol - previewWidth);
			let preview: string;
			if (previewWidth === 1 && previewHeight === 1) {
				preview = `${TERMINAL_STATE_TERMINATOR}${this.#renderDropPreview("█")}${TERMINAL_STATE_TERMINATOR}`;
			} else if (previewHeight === 1) {
				preview = `${TERMINAL_STATE_TERMINATOR}${this.#renderDropPreview("━".repeat(previewWidth))}${TERMINAL_STATE_TERMINATOR}`;
			} else if (previewWidth === 1) {
				preview = `${TERMINAL_STATE_TERMINATOR}${this.#renderDropPreview("┃")}${TERMINAL_STATE_TERMINATOR}`;
			} else if (row === startRow || row === startRow + previewHeight - 1) {
				const top = row === startRow;
				const frame = `${top ? "┏" : "┗"}${"━".repeat(previewWidth - 2)}${top ? "┓" : "┛"}`;
				preview = `${TERMINAL_STATE_TERMINATOR}${this.#renderDropPreview(frame)}${TERMINAL_STATE_TERMINATOR}`;
			} else {
				const innerWidth = previewWidth - 2;
				const snapshotRow = this.#dragSnapshot?.[row - startRow] ?? "";
				const ghost = fitWorkspaceLine(sliceByColumn(snapshotRow, 1, innerWidth, true), innerWidth);
				const border = `${TERMINAL_STATE_TERMINATOR}${this.#renderDropPreview("┃")}${TERMINAL_STATE_TERMINATOR}`;
				const styledGhost = `${TERMINAL_STATE_TERMINATOR}${this.#renderDropPreviewGhost(ghost)}${TERMINAL_STATE_TERMINATOR}`;
				preview = `${border}${styledGhost}${border}`;
			}
			lines[row] = fitWorkspaceLine(`${left}${preview}${right}`, canvasWidth);
		}
	}

	#scrollPane(paneId: string, amount: number | "top" | "bottom"): boolean {
		const viewport = this.#viewports.get(paneId);
		if (!viewport) return false;
		if (amount === "top") {
			viewport.offset = 0;
		} else if (amount === "bottom") {
			viewport.offset = viewport.maxOffset;
		} else {
			viewport.offset = Math.max(0, Math.min(viewport.maxOffset, viewport.offset + amount));
		}
		viewport.followBottom = viewport.offset >= viewport.maxOffset;
		this.#requestRender();
		return true;
	}

	#paneAt(row: number, col: number): string | undefined {
		if (!this.#frame) return undefined;
		for (const [paneId, rect] of this.#frame.panes) {
			if (containsPoint(rect, row, col)) return paneId;
		}
		return undefined;
	}

	#dropTargetAt(row: number, col: number, sourcePaneId: string): WorkspaceDropTarget | undefined {
		const targetPaneId = this.#paneAt(row, col);
		if (!targetPaneId || targetPaneId === sourcePaneId || !this.#frame) return undefined;
		const rect = this.#frame.panes.get(targetPaneId);
		const source = this.#panes.get(sourcePaneId);
		if (!rect || !source) return undefined;
		const localX = col - rect.x;
		const localY = row - rect.y;
		const candidates: Array<{ edge: WorkspaceEdge; distance: number }> = [];
		const horizontalZone = Math.max(1, Math.floor(rect.width / 4));
		const verticalZone = Math.max(1, Math.floor(rect.height / 4));
		if (localX < horizontalZone) candidates.push({ edge: "left", distance: localX / horizontalZone });
		if (localX >= rect.width - horizontalZone) {
			candidates.push({ edge: "right", distance: (rect.width - 1 - localX) / horizontalZone });
		}
		if (localY < verticalZone) candidates.push({ edge: "top", distance: localY / verticalZone });
		if (localY >= rect.height - verticalZone) {
			candidates.push({ edge: "bottom", distance: (rect.height - 1 - localY) / verticalZone });
		}
		candidates.sort((a, b) => a.distance - b.distance);
		const edge = candidates[0]?.edge;
		return edge && this.#canDock(targetPaneId, source, edge) ? { paneId: targetPaneId, edge } : undefined;
	}

	#canDock(targetPaneId: string, pane: WorkspacePane, edge: WorkspaceEdge): boolean {
		if (targetPaneId === pane.paneId || !this.#model.hasPane(targetPaneId)) return false;
		const targetRect = this.#frame?.panes.get(targetPaneId);
		const target = this.#panes.get(targetPaneId);
		if (!targetRect || !target) return true;
		const axis: WorkspaceAxis = edge === "left" || edge === "right" ? "x" : "y";
		const available = axis === "x" ? targetRect.width : targetRect.height;
		const targetMinimum = axis === "x" ? (target.minWidth ?? 10) : (target.minHeight ?? 3);
		const paneMinimum = axis === "x" ? (pane.minWidth ?? 10) : (pane.minHeight ?? 3);
		return available >= targetMinimum + paneMinimum + 1;
	}
}
