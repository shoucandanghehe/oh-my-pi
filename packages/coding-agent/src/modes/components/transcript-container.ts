import type { RowMeasurement } from "@oh-my-pi/pi-natives";
import type {
	Component,
	HistoryBatch,
	TextSelectionRange,
	VirtualViewportFrame,
	VirtualViewportProvider,
	VirtualRowAnchor,
	VirtualViewportRequest,
} from "@oh-my-pi/pi-tui";
import {
	Container,
	componentContains,
	extractComponentTextSelection,
	measureComponentRows,
	getPaddingX,
	getWidthConfigEpoch,
	normalizeTextSelection,
	TERMINAL,
} from "@oh-my-pi/pi-tui";
import { logger, waitForImmediate } from "@oh-my-pi/pi-utils";
import { withCodeHighlightingDisabledForLayout } from "../theme/tui-adapters";
import { isToolActivityComponent } from "./tool-activity";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
}

/** Presentation declaration captured permanently when a block is added. */
export type TranscriptBlockMode = "mutable" | "appendOnly";

/** Immutable width-independent identity for one stable semantic row. */
export interface TranscriptStableRow {
	readonly key: string;
}

/**
 * Explicit semantic-row contract for a block whose stable head may enter native
 * history before finalization. Every later array must extend the prior keys
 * exactly; each row renderer is deterministic for its width.
 * A publication that breaks these invariants (e.g. a mid-stream theme change
 * re-coloring already-emitted bytes) freezes further stable-row emission for
 * that block instead of failing the render — see {@link TranscriptContainer}.
 */
export interface AppendOnlyTranscriptBlock {
	readonly transcriptBlockMode: "appendOnly";
	getTranscriptStableRows(): readonly TranscriptStableRow[];
	/**
	 * Render the first `count` semantic rows at the requested current width.
	 * Counts are monotonic identities, not physical row counts; this output must
	 * prefix the block's full render at the same width.
	 */
	renderTranscriptStableRows(count: number, width: number): readonly string[];
	/**
	 * Discard every published stable row so the block re-renders its head from
	 * scratch. Called only alongside a destructive display reset (e.g. a
	 * thinking-visibility toggle) that clears the native scrollback those rows
	 * occupied — the sole context in which the append-only "published bytes never
	 * change" contract may be retracted. Optional: blocks whose stable-row
	 * presentation never changes may omit it.
	 */
	resetTranscriptStableRows?(): void;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	/** Render the row that must remain represented under emergency viewport pressure. */
	renderTranscriptBlockEmergencyRow?(width: number): string | undefined;
	/** Whether finalized rows may retire into immutable terminal history. */
	isTranscriptBlockAppendOnly?(): boolean;
	getTranscriptBlockVersion?(): number;
}

interface ExpandableBlock {
	setExpanded(expanded: boolean): void;
}

function setBlockExpanded(component: Component, expanded: boolean): void {
	const candidate = component as Component & Partial<ExpandableBlock>;
	candidate.setExpanded?.(expanded);
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport until pressure.
 * - `committed`: logically retired; replay never rewinds this state.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
	mode: TranscriptBlockMode;
	stableRows: readonly TranscriptStableRow[];
	renderedStableByWidth: Map<number, readonly string[]>;
	emitted: number;
	/**
	 * Set when a published stable row drifted (retraction, byte change within a
	 * width epoch, or no longer a render prefix). Rows already in native
	 * scrollback cannot be retracted, so the entry keeps its last good stable
	 * state for emitted-row slicing but never emits another mid-stream row.
	 */
	stableFrozen: boolean;
}

type RetirementPolicy = "pressure" | "flush";
type Offered =
	| { batch: HistoryBatch; kind: "append"; entry: number; emittedEnd: number }
	| { batch: HistoryBatch; kind: "commit"; end: number }
	| { batch: HistoryBatch; kind: "replay" };

interface VirtualBlockExtent {
	component: Component;
	contribution: readonly string[] | undefined;
	rawRef: readonly string[] | undefined;
	measuredWidth: number;
	measuredGeneration: number;
	measuredVersion: number | undefined;
	layoutWidth: number;
	layoutGeneration: number;
	layoutVersion: number | undefined;
	measurement?: RowMeasurement;
}

interface VirtualLayoutMeasurement {
	entry: VirtualBlockExtent;
	width: number;
	generation: number;
	version: number | undefined;
	bodyRows: number;
	measurement: RowMeasurement | undefined;
}

interface VirtualWarmup {
	token: number;
	width: number;
	generation: number;
	entries: VirtualBlockExtent[];
}

/**
 * Affine Fenwick index: unmeasured blocks share an estimate; measured blocks
 * contribute exact weights. A nonempty block includes one separator, with the
 * first separator removed from document coordinates.
 */
class VirtualRowIndex {
	#heights: (number | undefined)[] = [];
	#sums: number[] = [0];
	#counts: number[] = [0];
	#knownWeight = 0;
	#knownCount = 0;
	estimatedBodyRows = 1;

	get totalRows(): number {
		return Math.max(
			0,
			this.#knownWeight + (this.#heights.length - this.#knownCount) * (this.estimatedBodyRows + 1) - 1,
		);
	}

	knownBodyRows(index: number): number | undefined {
		return this.#heights[index];
	}

	bodyRows(index: number): number {
		return this.#heights[index] ?? this.estimatedBodyRows;
	}

	startRow(index: number): number {
		return Math.max(0, this.#prefix(index) - 1);
	}

	separator(index: number): number {
		return this.bodyRows(index) > 0 && this.#prefix(index) > 0 ? 1 : 0;
	}

	append(height?: number): void {
		this.#heights.push(height);
		if (height !== undefined) {
			this.#knownWeight += height > 0 ? height + 1 : 0;
			this.#knownCount++;
		}
		this.#rebuildNode(this.#heights.length);
	}

	set(index: number, height: number): void {
		const previous = this.#heights[index];
		if (previous === height) return;
		this.#heights[index] = height;
		const delta = (height > 0 ? height + 1 : 0) - (previous !== undefined && previous > 0 ? previous + 1 : 0);
		const countDelta = previous === undefined ? 1 : 0;
		this.#knownWeight += delta;
		this.#knownCount += countDelta;
		for (let node = index + 1; node < this.#sums.length; node += node & -node) {
			this.#sums[node]! += delta;
			this.#counts[node]! += countDelta;
		}
	}

	remove(index: number): void {
		const previous = this.#heights[index];
		if (previous !== undefined) {
			this.#knownWeight -= previous > 0 ? previous + 1 : 0;
			this.#knownCount--;
		}
		this.#heights.splice(index, 1);
		this.#sums.length = this.#heights.length + 1;
		this.#counts.length = this.#sums.length;
		for (let node = index + 1; node < this.#sums.length; node++) this.#rebuildNode(node);
	}

	find(row: number): number {
		let index = 0;
		let sum = 0;
		const target = row + 1;
		for (let bit = 2 ** Math.floor(Math.log2(this.#heights.length || 1)); bit >= 1; bit /= 2) {
			const next = index + bit;
			if (next >= this.#sums.length) continue;
			const weight = this.#sums[next]! + ((next & -next) - this.#counts[next]!) * (this.estimatedBodyRows + 1);
			if (sum + weight <= target) {
				sum += weight;
				index = next;
			}
		}
		return index < this.#heights.length ? index : -1;
	}

	next(index: number): number {
		return this.find(this.startRow(index + 1));
	}

	#prefix(count: number): number {
		let rows = 0;
		for (let node = count; node > 0; node -= node & -node) {
			rows += this.#sums[node]! + ((node & -node) - this.#counts[node]!) * (this.estimatedBodyRows + 1);
		}
		return rows;
	}

	#rebuildNode(node: number): void {
		const height = this.#heights[node - 1];
		let sum = height !== undefined && height > 0 ? height + 1 : 0;
		let count = height === undefined ? 0 : 1;
		const start = node - (node & -node);
		for (let child = node - 1; child > start; child -= child & -child) {
			sum += this.#sums[child]!;
			count += this.#counts[child]!;
		}
		this.#sums[node] = sum;
		this.#counts[node] = count;
	}
}

const MAX_LIVE_BLOCKS = 256;
/** Grace before a pressure-blocked frontier is reported; a streaming block may legitimately hold it briefly. */
const PINNED_FRONTIER_WARN_MS = 30_000;
const EMPTY_ROWS: readonly string[] = [];
const EMPTY_STABLE_ROWS: readonly TranscriptStableRow[] = [];
const VIRTUAL_OVERSCAN_BLOCKS = 8;
const VIRTUAL_WARMUP_CHUNK_ENTRIES = 32;
const VIRTUAL_WARMUP_CHUNK_MS = 4;
const VIRTUAL_FRAME_MAX_BLOCKS = 128;
const VIRTUAL_LAYOUT_COMMIT_MAX_ENTRIES = 4096;

function isBlockFinalized(component: Component): boolean {
	return (component as Component & FinalizableBlock).isTranscriptBlockFinalized?.() ?? true;
}

function isBlockExplicitlyFinalized(component: Component): boolean {
	return (component as Component & FinalizableBlock).isTranscriptBlockFinalized?.() === true;
}

function canRetire(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return isBlockFinalized(component) && (block.isTranscriptBlockAppendOnly?.() ?? true);
}

function blockMode(component: Component): TranscriptBlockMode {
	return (component as Component & Partial<AppendOnlyTranscriptBlock>).transcriptBlockMode === "appendOnly"
		? "appendOnly"
		: "mutable";
}

function getBlockVersion(component: Component): number | undefined {
	return (component as Component & FinalizableBlock).getTranscriptBlockVersion?.();
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Whether `prefix` matches `rows` byte-for-byte from the top. */
export function isRowPrefix(prefix: readonly string[], rows: readonly string[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index] !== rows[index]) return false;
	}
	return true;
}

function isStablePrefix(prefix: readonly TranscriptStableRow[], rows: readonly TranscriptStableRow[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index]!.key !== rows[index]!.key) return false;
	}
	return true;
}

/** Strip leading/trailing all-blank rows; the viewport allocator measures blocks by this trimmed height. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container implements VirtualViewportProvider {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: Offered | undefined;
	#replayPending = false;
	#replayRequested = false;
	#toolActivityVisible = true;
	#expanded = false;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };
	// Start rows from the last full render(), keyed by child component (transcript deep-links).
	#childStartRows = new Map<Component, number>();
	// Canonical O(1) owner lookup for component-scoped animation frames. Without
	// this, every spinner tick walks the complete transcript once per ancestor.
	#directChildIndices = new Map<Component, number>();
	#targetOwnerIndices = new WeakMap<Component, number>();
	// Watchdog for the wedge where an unfinalized frontier block pins pressure
	// retirement: everything behind it stays live and degrades to one-line
	// allocations. Logs once per pinned episode after a grace period.
	#pinnedFrontier: { index: number; since: number; logged: boolean } | undefined;
	#virtualEntries: VirtualBlockExtent[] = [];
	#virtualRowIndex = new VirtualRowIndex();
	#virtualMeasurementConfig = "";
	#visibleVirtualEntries = new Set<VirtualBlockExtent>();
	#virtualStructureDirty = false;
	#virtualLayoutDirtyFrom = 0;
	#virtualEstimateSeeded = false;
	#virtualLayoutComplete = false;
	#virtualWarmupToken = 0;
	#virtualWarmup: VirtualWarmup | undefined;
	#pendingVirtualMeasurements = new Map<VirtualBlockExtent, VirtualLayoutMeasurement>();
	#virtualRepaintPending = false;
	#virtualDisposed = false;
	readonly #onVirtualLayoutUpdate: ((component: Component) => void) | undefined;
	#virtualWidth = -1;
	#virtualGeneration = -1;
	#generation = 0;

	constructor(onVirtualLayoutUpdate?: (component: Component) => void) {
		super();
		this.#onVirtualLayoutUpdate = onVirtualLayoutUpdate;
	}

	get #virtualTotalRows(): number {
		return this.#virtualRowIndex.totalRows;
	}

	override addChild(component: Component): void {
		// New transcript blocks arrive on the frame hot path. Extend the prepared
		// ledger in place; removals and pre-structure batches still take full reconcile.
		const canExtendVirtualLedger =
			!this.#virtualStructureDirty && this.#virtualEntries.length === this.children.length;
		this.#virtualDisposed = false;
		this.#cancelVirtualWarmup();
		super.addChild(component);
		this.#directChildIndices.set(component, this.children.length - 1);
		this.#applyPresentationState(component);
		this.#entries.push({
			component,
			state: "active",
			mode: blockMode(component),
			stableRows: EMPTY_STABLE_ROWS,
			renderedStableByWidth: new Map(),
			emitted: 0,
			stableFrozen: false,
		});
		if (!canExtendVirtualLedger) {
			this.#virtualStructureDirty = true;
			this.#virtualLayoutDirtyFrom = 0;
			return;
		}
		this.#virtualEntries.push({
			component,
			rawRef: undefined,
			contribution: undefined,
			measuredWidth: -1,
			measuredGeneration: -1,
			measuredVersion: undefined,
			layoutWidth: -1,
			layoutGeneration: -1,
			layoutVersion: undefined,
		});
		this.#virtualLayoutDirtyFrom = Math.min(this.#virtualLayoutDirtyFrom, this.#virtualEntries.length - 1);
		this.#virtualRowIndex.append();
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index < 0 || !this.canRemoveBlock(component)) return;
		const synchronized = !this.#virtualStructureDirty && this.#virtualEntries.length === this.children.length;
		const removed = synchronized ? this.#virtualEntries[index] : undefined;
		this.#cancelVirtualWarmup();
		super.removeChild(component);
		this.#entries.splice(index, 1);
		this.#directChildIndices.delete(component);
		// Superseded poll/todo cards are usually near the tail. Preserve the
		// unchanged prefix instead of allocating a full-history index per removal.
		for (let shifted = index; shifted < this.children.length; shifted++) {
			this.#directChildIndices.set(this.children[shifted]!, shifted);
		}
		this.#targetOwnerIndices = new WeakMap();
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
		this.#childStartRows.delete(component);
		if (synchronized) {
			this.#virtualEntries.splice(index, 1);
			this.#virtualRowIndex.remove(index);
			if (removed) {
				this.#visibleVirtualEntries.delete(removed);
				this.#pendingVirtualMeasurements.delete(removed);
			}
			this.#virtualLayoutDirtyFrom = Math.min(this.#virtualLayoutDirtyFrom, index);
		} else {
			this.#virtualStructureDirty = true;
			this.#virtualLayoutDirtyFrom = 0;
		}
	}

	override clear(): void {
		this.#cancelVirtualWarmup();
		super.clear();
		this.#entries = [];
		this.#directChildIndices = new Map();
		this.#targetOwnerIndices = new WeakMap();
		this.#frontier = 0;
		this.#offered = undefined;
		this.#childStartRows.clear();
		this.#pinnedFrontier = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#virtualEntries = [];
		this.#virtualRowIndex = new VirtualRowIndex();
		this.#virtualMeasurementConfig = "";
		this.#visibleVirtualEntries = new Set<VirtualBlockExtent>();
		this.#pendingVirtualMeasurements = new Map();
		this.#virtualEstimateSeeded = false;
		this.#virtualDisposed = false;
		this.#virtualStructureDirty = false;
		this.#virtualLayoutDirtyFrom = 0;
		this.#generation++;
	}

	/** Stop deferred work without discarding the displayed transcript. */
	cancelVirtualLayout(): void {
		this.#cancelVirtualWarmup();
		this.#pendingVirtualMeasurements.clear();
	}

	override dispose(): void {
		this.cancelVirtualLayout();
		super.dispose();
		this.#virtualDisposed = true;
	}

	/**
	 * Reconcile child identities without rendering. Incremental transcript
	 * builders call this at yield boundaries; exact row heights are measured
	 * once when the viewport supplies its width.
	 */
	prepareVirtualStructure(): void {
		this.#syncVirtualStructure();
	}

	/**
	 * Move an already-built transcript into this empty container without
	 * rebuilding child lifecycle or virtual-layout state.
	 */
	adoptContentsFrom(source: TranscriptContainer): void {
		if (source === this) return;
		if (this.children.length > 0) {
			throw new Error("TranscriptContainer.adoptContentsFrom requires an empty destination");
		}
		this.#cancelVirtualWarmup();
		const children = source.children;
		const directChildIndices = source.#directChildIndices;
		const targetOwnerIndices = source.#targetOwnerIndices;
		const entries = source.#entries;
		const frontier = source.#frontier;
		const nextBatchId = source.#nextBatchId;
		const offered = source.#offered;
		const toolActivityVisible = source.#toolActivityVisible;
		const expanded = source.#expanded;
		const lastFrame = source.#lastFrame;
		const virtualEntries = source.#virtualEntries;
		const virtualRowIndex = source.#virtualRowIndex;
		const virtualMeasurementConfig = source.#virtualMeasurementConfig;
		const pendingVirtualMeasurements = source.#pendingVirtualMeasurements;
		const virtualEstimateSeeded = source.#virtualEstimateSeeded;
		const virtualLayoutComplete = source.#virtualLayoutComplete;
		const visibleVirtualEntries = source.#visibleVirtualEntries;
		const virtualStructureDirty = source.#virtualStructureDirty;
		const virtualLayoutDirtyFrom = source.#virtualLayoutDirtyFrom;
		const virtualWidth = source.#virtualWidth;
		const virtualGeneration = source.#virtualGeneration;
		const generation = source.#generation;

		source.clear();
		super.clear();
		this.children = children;
		this.#entries = entries;
		this.#directChildIndices = directChildIndices;
		this.#targetOwnerIndices = targetOwnerIndices;
		this.#frontier = frontier;
		this.#nextBatchId = nextBatchId;
		this.#offered = offered;
		this.#toolActivityVisible = toolActivityVisible;
		this.#expanded = expanded;
		this.#lastFrame = lastFrame;
		this.#virtualEntries = virtualEntries;
		this.#virtualRowIndex = virtualRowIndex;
		this.#virtualMeasurementConfig = virtualMeasurementConfig;
		this.#pendingVirtualMeasurements = pendingVirtualMeasurements;
		this.#virtualEstimateSeeded = virtualEstimateSeeded;
		this.#virtualLayoutComplete = virtualLayoutComplete;
		this.#virtualDisposed = false;
		this.#visibleVirtualEntries = visibleVirtualEntries;
		this.#virtualStructureDirty = virtualStructureDirty;
		this.#virtualLayoutDirtyFrom = virtualLayoutDirtyFrom;
		this.#virtualWidth = virtualWidth;
		this.#virtualGeneration = virtualGeneration;
		this.#generation = generation;
	}

	override containsComponent(component: Component): boolean {
		return component === this || this.#ownerIndex(component) >= 0;
	}

	#ownerIndex(component: Component): number {
		const directIndex = this.#directChildIndices.get(component);
		if (directIndex !== undefined) return directIndex;
		const cachedIndex = this.#targetOwnerIndices.get(component);
		if (cachedIndex !== undefined) {
			const cachedOwner = this.children[cachedIndex];
			if (cachedOwner !== undefined && componentContains(cachedOwner, component)) return cachedIndex;
		}
		const ownerIndex = this.children.findIndex(child => componentContains(child, component));
		if (ownerIndex >= 0) this.#targetOwnerIndices.set(component, ownerIndex);
		else this.#targetOwnerIndices.delete(component);
		return ownerIndex;
	}

	override invalidate(): void {
		this.#cancelVirtualWarmup();
		this.#generation++;
		super.invalidate();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cancelVirtualWarmup();
		for (const entry of this.#visibleVirtualEntries) this.#applyPresentationState(entry.component);
		this.#generation++;
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	/**
	 * Forget the append-only emission ledger — emitted counts, published stable
	 * rows, per-width render cache, and freeze state — for every block, and ask
	 * each append-only block to drop its own published rows. The next replay then
	 * re-renders each block from its current {@link Component.render}, applying a
	 * changed presentation (e.g. a thinking-visibility toggle) to rows that were
	 * already emitted as stable heads while streaming (#10177).
	 *
	 * Callers MUST pair this with a scrollback-clearing {@link resetDisplay}: the
	 * emitted rows it forgets still sit in native history until that clear
	 * rewrites them, so unpaired use would duplicate them on the next retirement.
	 */
	resetStableEmission(): void {
		this.#syncEntries();
		if (this.#offered?.kind === "append") this.#offered = undefined;
		for (const entry of this.#entries) {
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth = new Map();
			entry.stableFrozen = false;
			if (entry.mode === "appendOnly") {
				(entry.component as Component & AppendOnlyTranscriptBlock).resetTranscriptStableRows?.();
			}
		}
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0) return false;
		if (this.#offered?.kind === "commit" && index < this.#offered.end) return false;
		if (this.#offered?.kind === "append" && index === this.#offered.entry) return false;
		return true;
	}

	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Permanently captured presentation mode per block (diagnostics and tests). */
	blockModes(): readonly TranscriptBlockMode[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.mode);
	}

	/** Emitted stable semantic-row counts in transcript order. */
	emittedStableRows(): readonly number[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.emitted);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Prepares one atomic replay of the committed ledger and an emitted active-head prefix. */
	beginReplay(): void {
		this.#syncEntries();
		if (this.#offered !== undefined) {
			this.#replayRequested = true;
			return;
		}
		this.#startReplay();
	}
	/**
	 * Drop a not-yet-offered replay so a shutdown flush emits only un-retired
	 * rows. The terminal already holds the committed ledger; re-streaming it at
	 * quit is pure write volume. An already offered replay batch stays valid.
	 */
	cancelReplay(): void {
		this.#replayPending = false;
		this.#replayRequested = false;
	}

	/** Total rows the live, un-emitted tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const { entry, index } of this.#liveEntries()) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			const block = rendered.slice(this.#projectedEmitted(entry, index, width));
			if (block.length > 0) total += block.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Render the live tail, constrained to the supplied transcript height. */
	renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) return EMPTY_ROWS;

		const shown: Array<{ entry: TranscriptEntry; index: number }> = [];
		const blocks: (readonly string[])[] = [];
		let total = 0;
		for (const candidate of live) {
			this.#setAllocation(candidate.entry.component, Number.MAX_SAFE_INTEGER, frame);
			const rendered = this.#renderEntry(candidate.entry, width);
			const block = rendered.slice(this.#projectedEmitted(candidate.entry, candidate.index, width));
			if (block.length === 0) continue;
			total += block.length + (shown.length > 0 ? 1 : 0);
			shown.push(candidate);
			blocks.push(block);
		}
		if (shown.length === 0) return EMPTY_ROWS;
		if (shown.length > capacity) return this.#renderEmergency(shown, width, capacity, frame);
		if (total <= capacity) {
			const output: string[] = [];
			for (const rendered of blocks) {
				if (output.length > 0) output.push("");
				output.push(...rendered);
			}
			return output;
		}

		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const allocation: number[] = new Array(shown.length).fill(1);
		let surplus = capacity - shown.length;
		// Surplus rows favor ordinary transcript blocks over dynamic tool-activity
		// cards (newest-first within each class), so a growing tool card collapses to
		// its compact form instead of clipping already-visible assistant text (#9718).
		const order: number[] = [];
		for (let index = shown.length - 1; index >= 0; index--) {
			if (!isToolActivityComponent(shown[index]!.entry.component)) order.push(index);
		}
		for (let index = shown.length - 1; index >= 0; index--) {
			if (isToolActivityComponent(shown[index]!.entry.component)) order.push(index);
		}
		for (const index of order) {
			if (surplus <= 0) break;
			const extra = Math.min(Math.max(0, blocks[index]!.length - 1), surplus);
			allocation[index] += extra;
			surplus -= extra;
		}
		const output: string[] = [];
		for (let index = 0; index < shown.length; index++) {
			const candidate = shown[index]!;
			const allocated = allocation[index]!;
			this.#setAllocation(candidate.entry.component, allocated, frame);
			const rendered = this.#renderEntry(candidate.entry, width).slice(
				this.#projectedEmitted(candidate.entry, candidate.index, width),
			);
			if (rendered.length <= allocated) output.push(...rendered);
			else output.push(...rendered.slice(rendered.length - allocated));
		}
		return output.length > capacity ? output.slice(output.length - capacity) : output;
	}

	/** Offers stable-head emission or the shortest finalized prefix needed under pressure. */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Returns only a prepared complete replay, never a normal retirement offer. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) {
			return this.#offered.kind === "replay" ? this.#offered.batch : undefined;
		}
		if (!this.#replayPending) return undefined;
		const rows = this.#renderReplay(width);
		this.#replayPending = false;
		if (rows.length === 0) return undefined;
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "replay" };
		this.#offered = { batch, kind: "replay" };
		return batch;
	}

	/** Offers the complete currently eligible prefix for graceful shutdown. */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		return this.#peekBatch(width, 0, "flush");
	}

	/** Recompose the unacknowledged batch so a discarded TUI frame can be rendered again. */
	rerenderOfferedBatch(width: number): HistoryBatch | undefined {
		const offered = this.#offered;
		if (offered === undefined) return undefined;
		let rows: readonly string[];
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined) return undefined;
			const before = this.#renderStablePrefix(entry, entry.emitted, width);
			const after = this.#renderStablePrefix(entry, offered.emittedEnd, width);
			rows = after.slice(before.length);
		} else if (offered.kind === "commit") {
			rows = this.#renderRange(this.#frontier, offered.end, width, true);
		} else {
			rows = this.#renderReplay(width);
		}
		offered.batch = { id: offered.batch.id, rows, kind: offered.batch.kind };
		return offered.batch;
	}

	#peekBatch(width: number, capacity: number, policy: RetirementPolicy): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		const replay = this.peekReplayBatch(width);
		if (replay !== undefined) return replay;

		this.#completeFullyEmittedHeads(width);
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const rendered: (readonly string[])[] = new Array(live.length);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			const candidate = live[index]!;
			this.#setAllocation(candidate.entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const renderedEntry = this.#renderEntry(candidate.entry, width);
			const rows = renderedEntry.slice(
				this.#renderStablePrefix(candidate.entry, candidate.entry.emitted, width).length,
			);
			rendered[index] = rows;
			heights[index] = rows.length;
			if (rows.length > 0) total += rows.length + (visible++ > 0 ? 1 : 0);
		}
		const overflowing = total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing) {
			this.#pinnedFrontier = undefined;
			return undefined;
		}

		const head = this.#entries[this.#frontier];
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted < head.stableRows.length
		) {
			const emittedEnd = head.emitted + 1;
			const before = this.#renderStablePrefix(head, head.emitted, width);
			const after = this.#renderStablePrefix(head, emittedEnd, width);
			if (!isRowPrefix(before, after) || after.length === before.length) {
				this.#freezeStableRows(head, EMPTY_ROWS, "semantic row render added no suffix");
				return undefined;
			}
			const batch: HistoryBatch = {
				id: this.#nextBatchId++,
				rows: after.slice(before.length),
				kind: "append",
			};
			this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
			this.#pinnedFrontier = undefined;
			return batch;
		}

		let end = this.#frontier;
		let freed = 0;
		let index = 0;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			if (
				policy === "pressure" &&
				total - freed <= room &&
				this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS
			)
				break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.#frontier) {
			if (policy === "pressure") this.#notePinnedFrontier();
			return undefined;
		}
		this.#pinnedFrontier = undefined;
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows: this.#renderRange(this.#frontier, end, width, true),
			kind: "append",
		};
		this.#offered = { batch, end, kind: "commit" };
		return batch;
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined || offered.entry !== this.#frontier || offered.emittedEnd !== entry.emitted + 1)
				return;
			entry.emitted = offered.emittedEnd;
		} else if (offered.kind === "commit") {
			for (let index = this.#frontier; index < offered.end; index++) {
				this.#entries[index]!.state = "committed";
				this.#entries[index]!.emitted = 0;
			}
			this.#frontier = offered.end;
		}
		this.#offered = undefined;
		if (this.#replayRequested) this.#startReplay();
	}

	/**
	 * Render only the trailing `maxRows` semantic rows, walking blocks bottom-up.
	 * Used by the transient resize-buffer repaint, which needs one viewport of
	 * tail rows per resize event — never the full committed ledger.
	 */
	renderTail(width: number, maxRows: number): readonly string[] {
		this.#syncEntries();
		const cap = Math.max(0, Math.trunc(maxRows));
		if (cap === 0) return EMPTY_ROWS;
		const rows: string[] = [];
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.unshift("");
			rows.unshift(...block);
			if (rows.length >= cap) break;
		}
		return rows.length > cap ? rows.slice(rows.length - cap) : rows;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#syncEntries();
		this.#childStartRows.clear();
		this.#syncVirtualEntries(width);
		const rows: string[] = [];
		for (let index = 0; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			const component = entry.component;
			this.#applyPresentationState(component);
			this.#setAllocation(component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const raw = component.render(width);
			const block = this.#renderEntry(entry, width, raw);
			this.#recordVirtualMeasurement(index, width, raw, block);
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			this.#childStartRows.set(entry.component, rows.length);
			rows.push(...block);
		}
		return rows;
	}

	/** Rendered row where a child's block begins in the full or virtual transcript. */
	getChildStartRow(child: Component, width?: number): number | undefined {
		if (width !== undefined) {
			this.#syncVirtualEntries(Math.max(1, width));
			const index = this.children.indexOf(child);
			const entry = index >= 0 ? this.#virtualEntries[index] : undefined;
			if (entry) return this.#virtualRowIndex.startRow(index) + this.#virtualRowIndex.separator(index);
		}
		return this.#childStartRows.get(child);
	}

	#renderEntry(entry: TranscriptEntry, width: number, raw?: readonly string[]): readonly string[] {
		const rendered = trimBlankEdges(raw ?? entry.component.render(width));
		if (entry.mode === "mutable" || entry.stableFrozen) return rendered;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		const stable = appendOnly.getTranscriptStableRows();
		if (!isStablePrefix(entry.stableRows, stable)) {
			return this.#freezeStableRows(entry, rendered, "publication retracted the published prefix");
		}
		if (entry.emitted > stable.length) {
			return this.#freezeStableRows(entry, rendered, "publication retracted emitted history");
		}
		const published =
			stable.length > entry.stableRows.length
				? [...entry.stableRows, ...stable.slice(entry.stableRows.length)]
				: entry.stableRows;
		const stableRendered = appendOnly.renderTranscriptStableRows(published.length, width);
		if (!isRowPrefix(stableRendered, rendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows no longer render as a prefix of the block");
		}
		const priorRender = entry.renderedStableByWidth.get(width);
		if (priorRender && !isRowPrefix(priorRender, stableRendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows changed within a width epoch");
		}
		entry.stableRows = published;
		entry.renderedStableByWidth.set(width, stableRendered.slice());
		return rendered;
	}

	/**
	 * Demote a drifting append-only publication: rows already written to native
	 * scrollback cannot be retracted, so keep the last good stable state for
	 * emitted-row slicing and stop mid-stream emission for this block. The block
	 * still renders and retires whole on finalization; worst case is the old
	 * finalize-time behavior plus a possible stale-byte seam in scrollback.
	 */
	#freezeStableRows(entry: TranscriptEntry, rendered: readonly string[], reason: string): readonly string[] {
		entry.stableFrozen = true;
		logger.warn("Append-only transcript block frozen", { reason, emitted: entry.emitted });
		return rendered;
	}

	#renderStablePrefix(entry: TranscriptEntry, count: number, width: number): readonly string[] {
		if (count === 0) return EMPTY_ROWS;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		return appendOnly.renderTranscriptStableRows(Math.min(count, entry.stableRows.length), width);
	}
	/**
	 * Record that pressure retirement is blocked behind a not-yet-settled
	 * frontier block, and log its identity once the episode outlives the grace
	 * period. A block that never finalizes (a dropped terminal event) pins the
	 * whole live region here with no visible symptom other than degraded
	 * one-line layout, so the log line is the only forensic trail.
	 */
	#notePinnedFrontier(): void {
		const entry = this.#entries[this.#frontier];
		if (entry === undefined) return;
		const now = Date.now();
		if (this.#pinnedFrontier?.index !== this.#frontier) {
			this.#pinnedFrontier = { index: this.#frontier, since: now, logged: false };
			return;
		}
		if (this.#pinnedFrontier.logged || now - this.#pinnedFrontier.since < PINNED_FRONTIER_WARN_MS) return;
		this.#pinnedFrontier.logged = true;
		logger.warn("Transcript retirement pinned by unfinalized frontier block", {
			component: entry.component.constructor.name,
			state: entry.state,
			mode: entry.mode,
			liveBlocks: this.#liveCount(),
		});
	}

	#renderRange(start: number, end: number, width: number, trailingBlank: boolean): readonly string[] {
		const rows: string[] = [];
		for (let index = start; index < end; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			// Only the range head is sliced by its emitted stable prefix; every other
			// entry renders whole, so the append-only verification pass (a second
			// full render of the block's stable prefix) is skipped for them. This
			// keeps a complete-ledger replay at one render per block.
			const rendered =
				index === start ? this.#renderEntry(entry, width) : trimBlankEdges(entry.component.render(width));
			const emittedRows = index === start ? this.#renderStablePrefix(entry, entry.emitted, width).length : 0;
			const block = rendered.slice(emittedRows);
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		if (trailingBlank && rows.length > 0) rows.push("");
		return rows;
	}

	#renderReplay(width: number): readonly string[] {
		const rows = Array.from(this.#renderRange(0, this.#frontier, width, true));
		const head = this.#entries[this.#frontier];
		if (head?.mode === "appendOnly" && head.emitted > 0) {
			this.#setAllocation(head.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			this.#renderEntry(head, width);
			rows.push(...this.#renderStablePrefix(head, head.emitted, width));
		}
		return rows;
	}

	#completeFullyEmittedHeads(width: number): void {
		while (this.#frontier < this.#entries.length) {
			const entry = this.#entries[this.#frontier]!;
			if (entry.mode !== "appendOnly" || entry.state !== "settled") return;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			if (entry.emitted !== entry.stableRows.length) return;
			if (this.#renderStablePrefix(entry, entry.emitted, width).length !== rendered.length) return;
			entry.state = "committed";
			entry.emitted = 0;
			this.#frontier++;
		}
	}

	#startReplay(): void {
		const head = this.#entries[this.#frontier];
		this.#replayPending = this.#frontier > 0 || (head?.mode === "appendOnly" && head.emitted > 0);
		this.#replayRequested = false;
	}
	override renderTargeted(width: number, targets: readonly Component[]): readonly string[] {
		width = Math.max(1, width);
		this.#syncVirtualEntries(width);
		if (
			targets.length === 0 ||
			targets.includes(this) ||
			this.#virtualEntries.some(
				entry =>
					entry.contribution === undefined ||
					entry.measuredWidth !== width ||
					entry.measuredGeneration !== this.#generation,
			)
		) {
			return this.render(width);
		}
		const measured = new Set<Component>();
		for (const target of targets) {
			const index = this.#ownerIndex(target);
			if (index < 0 || measured.has(this.children[index]!)) continue;
			measured.add(this.children[index]!);
			this.#measureVirtualEntry(index, width);
		}
		if (measured.size === 0) return this.render(width);
		return this.#renderVirtualRows(0, this.#virtualTotalRows);
	}

	override hasVirtualViewport(): boolean {
		return true;
	}

	override getEstimatedVirtualRows(width: number): number {
		this.#syncVirtualEntries(Math.max(1, width));
		return this.#virtualTotalRows;
	}

	/** Visible body range of direct children [from, to), using the virtual layout ledger. */
	getVirtualRowRange(width: number, from: number, to: number): { start: number; end: number } | undefined {
		this.#syncVirtualEntries(Math.max(1, width));
		const end = Math.min(to, this.#virtualEntries.length);
		if (from >= end) return undefined;
		const startRow = this.#virtualRowIndex.startRow(from);
		const endRow = this.#virtualRowIndex.startRow(end);
		if (endRow <= startRow) return undefined;
		const first = this.#virtualRowIndex.find(startRow);
		const last = this.#virtualRowIndex.find(endRow - 1);
		if (first < 0 || last < first) return undefined;
		return {
			start: this.#virtualRowIndex.startRow(first) + this.#virtualRowIndex.separator(first),
			end:
				this.#virtualRowIndex.startRow(last) +
				this.#virtualRowIndex.separator(last) +
				this.#virtualRowIndex.bodyRows(last),
		};
	}

	override getVirtualRowAnchor(width: number, row: number): VirtualRowAnchor | undefined {
		this.#syncVirtualEntries(Math.max(1, width));
		if (row < 0 || row >= this.#virtualTotalRows) return undefined;
		const index = this.#virtualRowIndex.find(row);
		const entry = this.#virtualEntries[index];
		if (!entry) return undefined;
		return {
			component: entry.component,
			row: row - this.#virtualRowIndex.startRow(index) - this.#virtualRowIndex.separator(index),
			width,
		};
	}

	override resolveVirtualRowAnchor(_width: number, anchor: VirtualRowAnchor): number | undefined {
		const index = this.#directChildIndices.get(anchor.component);
		if (index === undefined || this.#virtualEntries[index]?.component !== anchor.component) return undefined;
		const separator = this.#virtualRowIndex.separator(index);
		return (
			this.#virtualRowIndex.startRow(index) +
			separator +
			Math.max(-separator, Math.min(anchor.row, Math.max(0, this.#virtualRowIndex.bodyRows(index) - 1)))
		);
	}

	override renderVirtualViewport(width: number, request: VirtualViewportRequest): VirtualViewportFrame {
		return this.#renderVirtualViewport(width, request);
	}

	override renderVirtualViewportTargeted(
		width: number,
		request: VirtualViewportRequest,
		targets: readonly Component[],
	): VirtualViewportFrame {
		const targeted = new Set<number>();
		for (const target of targets) {
			if (target === this) return this.#renderVirtualViewport(width, request);
			const ownerIndex = this.#ownerIndex(target);
			if (ownerIndex < 0) return this.#renderVirtualViewport(width, request);
			targeted.add(ownerIndex);
		}
		return this.#renderVirtualViewport(width, request, targeted);
	}

	override renderViewportTail(width: number, maxRows: number): readonly string[] {
		return this.#renderVirtualViewport(width, {
			rows: Math.max(0, Math.trunc(maxRows)),
			offset: 0,
			followBottom: true,
		}).lines;
	}

	/** Direct transcript blocks intersecting an inclusive estimated virtual row range. */
	getVirtualBlocksInRowRange(width: number, startRow: number, endRow: number): readonly Component[] {
		this.#syncVirtualEntries(Math.max(1, width));
		const start = Math.max(0, Math.trunc(startRow));
		const end = Math.max(start, Math.trunc(endRow));
		const blocks: Component[] = [];
		let index = this.#virtualRowIndex.find(start);
		while (index >= 0 && index < this.#virtualEntries.length) {
			const entry = this.#virtualEntries[index]!;
			const startRow = this.#virtualRowIndex.startRow(index);
			if (startRow > end) break;
			const contentStart = startRow + this.#virtualRowIndex.separator(index);
			const bodyRows = this.#virtualRowIndex.bodyRows(index);
			const contentEnd = contentStart + bodyRows - 1;
			if (bodyRows > 0 && contentStart <= end && contentEnd >= start) blocks.push(entry.component);
			index = this.#virtualRowIndex.next(index);
		}
		return blocks;
	}

	override getVirtualTextSelectionInset(width: number, row: number): number {
		return this.#getVirtualTextSelectionInset(width, row, false);
	}

	override getVirtualTextSelectionRightInset(width: number, row: number): number {
		return this.#getVirtualTextSelectionInset(width, row, true);
	}

	override getVirtualTextSelection(width: number, selection: TextSelectionRange): string | undefined {
		this.#syncVirtualEntries(Math.max(1, width));
		const normalized = normalizeTextSelection(selection);
		if (normalized.start.row < 0 || normalized.end.row >= this.#virtualTotalRows) return undefined;
		const first = this.#virtualRowIndex.find(normalized.start.row);
		const last = this.#virtualRowIndex.find(normalized.end.row);
		if (first < 0 || last < 0) return undefined;
		const firstRow =
			normalized.start.row - this.#virtualRowIndex.startRow(first) - this.#virtualRowIndex.separator(first);
		const lastRow = normalized.end.row - this.#virtualRowIndex.startRow(last) - this.#virtualRowIndex.separator(last);
		const parts: string[] = [];
		for (let index = first; index <= last; index++) {
			const entry = this.#virtualEntries[index]!;
			let raw =
				entry.measuredWidth === width && entry.measuredGeneration === this.#generation ? entry.rawRef : undefined;
			if (!raw) {
				// Copy may cross skipped history. Materialize only this explicit
				// selection, without changing the displayed layout mid-copy.
				this.#applyPresentationState(entry.component);
				this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
				raw = entry.component.render(width);
			}
			let leading = 0;
			let end = raw.length;
			while (leading < end && isPlainBlank(raw[leading]!)) leading++;
			while (end > leading && isPlainBlank(raw[end - 1]!)) end--;
			const bodyRows = end - leading;
			if (bodyRows === 0) continue;
			if (index > first || (firstRow < 0 && this.#virtualRowIndex.separator(index) > 0)) parts.push("");
			const from = index === first ? Math.max(0, firstRow) : 0;
			const to = index === last ? Math.min(lastRow, bodyRows - 1) : bodyRows - 1;
			if (from > to) continue;
			const part = extractComponentTextSelection(entry.component, raw, {
				start: {
					row: leading + from,
					col: index === first && firstRow >= 0 ? normalized.start.col : 0,
				},
				end: {
					row: leading + to,
					col: index === last && lastRow < bodyRows ? normalized.end.col : Number.MAX_SAFE_INTEGER,
				},
			});
			if (part === undefined) return undefined;
			parts.push(part);
		}
		return parts.length > 0 ? parts.join("\n") : undefined;
	}

	#getVirtualTextSelectionInset(width: number, row: number, right: boolean): number {
		this.#syncVirtualEntries(Math.max(1, width));
		const targetRow = Math.trunc(row);
		if (targetRow < 0 || targetRow >= this.#virtualTotalRows) return 0;
		const index = this.#virtualRowIndex.find(targetRow);
		const entry = this.#virtualEntries[index];
		if (!entry?.rawRef || entry.measuredWidth !== width || entry.measuredGeneration !== this.#generation) return 0;
		const contentStart = this.#virtualRowIndex.startRow(index) + this.#virtualRowIndex.separator(index);
		if (targetRow < contentStart) return 0;
		let leadingBlankRows = 0;
		while (leadingBlankRows < entry.rawRef.length && isPlainBlank(entry.rawRef[leadingBlankRows]!)) {
			leadingBlankRows++;
		}
		const componentRow = leadingBlankRows + targetRow - contentStart;
		return right
			? (entry.component.getTextSelectionRightInset?.(componentRow) ?? 0)
			: (entry.component.getTextSelectionInset?.(componentRow) ?? 0);
	}
	#renderVirtualViewport(
		width: number,
		request: VirtualViewportRequest,
		targeted?: ReadonlySet<number>,
	): VirtualViewportFrame {
		width = Math.max(1, width);
		const rows = Math.max(0, Math.trunc(request.rows));
		this.#syncVirtualEntries(width);
		let offset = request.followBottom
			? Math.max(0, this.#virtualTotalRows - rows)
			: Math.max(0, Math.min(Math.trunc(request.offset), Math.max(0, this.#virtualTotalRows - rows)));
		// Capture in the displayed coordinate space before committing background
		// corrections. Wheel deltas and scrollbar jumps both refer to that space.
		const anchor = request.followBottom ? undefined : this.getVirtualRowAnchor(width, offset);
		const anchoredOffset = (): number => {
			const maxOffset = Math.max(0, this.#virtualTotalRows - rows);
			if (request.followBottom) return maxOffset;
			const anchored = anchor ? this.resolveVirtualRowAnchor(width, anchor) : undefined;
			return Math.max(0, Math.min(anchored ?? offset, maxOffset));
		};
		this.#commitVirtualMeasurements();
		offset = anchoredOffset();
		const measured = new Set<number>();
		if (targeted) {
			for (const index of targeted) {
				measured.add(index);
				this.#measureVirtualEntry(index, width, true);
			}
			offset = anchoredOffset();
		}

		const deadline = this.#onVirtualLayoutUpdate ? performance.now() + VIRTUAL_WARMUP_CHUNK_MS : Infinity;
		const maxBlocks = this.#onVirtualLayoutUpdate
			? Math.max(VIRTUAL_FRAME_MAX_BLOCKS, rows + VIRTUAL_OVERSCAN_BLOCKS * 2)
			: Infinity;
		while (rows > 0 && this.#virtualTotalRows > 0 && measured.size < maxBlocks) {
			const firstVisible = this.#virtualRowIndex.find(offset);
			const lastVisible = this.#virtualRowIndex.find(Math.min(this.#virtualTotalRows - 1, offset + rows - 1));
			if (firstVisible < 0 || lastVisible < 0) break;
			const candidates: number[] = [];
			for (let index = firstVisible; index >= 0 && index <= lastVisible; index = this.#virtualRowIndex.next(index)) {
				candidates.push(index);
			}
			if (request.followBottom) candidates.reverse();
			for (let extra = 1; extra <= VIRTUAL_OVERSCAN_BLOCKS; extra++) {
				if (firstVisible - extra >= 0) candidates.push(firstVisible - extra);
				if (lastVisible + extra < this.#virtualEntries.length) candidates.push(lastVisible + extra);
			}
			let changed = false;
			for (const needsRender of [true, false]) {
				for (const index of candidates) {
					if (measured.has(index)) continue;
					if (measured.size >= maxBlocks) break;
					if ((index < firstVisible || index > lastVisible) && performance.now() >= deadline) continue;
					const entry = this.#virtualEntries[index]!;
					if (!this.#hasCurrentVirtualRows(entry, width) !== needsRender) continue;
					measured.add(index);
					if (targeted && !targeted.has(index) && this.#hasCurrentVirtualRows(entry, width)) continue;
					changed = this.#measureVirtualEntry(index, width) || changed;
				}
			}
			if (!this.#virtualEstimateSeeded) {
				let bodyRows = 0;
				let samples = 0;
				for (const index of measured) {
					const entry = this.#virtualEntries[index];
					if (entry?.measuredWidth !== width || entry.measuredGeneration !== this.#generation) continue;
					const count = entry.contribution?.length ?? 0;
					if (count > 0) {
						bodyRows += count;
						samples++;
					}
				}
				if (samples > 0) {
					const estimate = Math.max(1, Math.round(bodyRows / samples));
					changed ||= estimate !== this.#virtualRowIndex.estimatedBodyRows;
					this.#virtualRowIndex.estimatedBodyRows = estimate;
					this.#virtualEstimateSeeded = true;
				}
			}
			offset = anchoredOffset();
			if (!changed) break;
		}

		const lines = this.#renderVirtualRows(offset, rows);
		this.#visibleVirtualEntries.clear();
		const first = this.#virtualRowIndex.find(offset);
		const last = this.#virtualRowIndex.find(Math.min(this.#virtualTotalRows - 1, offset + rows - 1));
		let incomplete = false;
		for (let index = first; index >= 0 && index <= last; index = this.#virtualRowIndex.next(index)) {
			const entry = this.#virtualEntries[index]!;
			this.#visibleVirtualEntries.add(entry);
			incomplete ||= !this.#hasCurrentVirtualRows(entry, width);
		}
		if (rows > 0 && this.#onVirtualLayoutUpdate) {
			this.#scheduleVirtualWarmup(width);
			if (this.#pendingVirtualMeasurements.size > 0 || incomplete) this.#requestVirtualRepaint();
		}
		return { lines, estimatedTotalRows: this.#virtualTotalRows, offset };
	}

	#hasCurrentVirtualRows(entry: VirtualBlockExtent, width: number): boolean {
		return (
			entry.contribution !== undefined &&
			entry.rawRef !== undefined &&
			entry.measuredWidth === width &&
			entry.measuredGeneration === this.#generation &&
			entry.measuredVersion === getBlockVersion(entry.component)
		);
	}

	#syncVirtualEntries(width: number): void {
		const measurementConfig = `${getWidthConfigEpoch()}:${getPaddingX(1)}:${TERMINAL.imageProtocol}:${TERMINAL.textSizing}:${TERMINAL.hyperlinks}`;
		if (this.#virtualMeasurementConfig !== measurementConfig) {
			this.#virtualMeasurementConfig = measurementConfig;
			this.#generation++;
		}
		this.#syncVirtualStructure();
		if (this.#virtualWidth !== width || this.#virtualGeneration !== this.#generation) {
			this.#cancelVirtualWarmup();
			this.#pendingVirtualMeasurements.clear();
			this.#virtualWidth = width;
			this.#virtualGeneration = this.#generation;
			this.#virtualEstimateSeeded = false;
			this.#virtualLayoutDirtyFrom = 0;
		}
		// Exports and standalone synchronous consumers retain their exact layout
		// contract. Mounted viewports instead fill the same index incrementally.
		if (!this.#onVirtualLayoutUpdate) {
			withCodeHighlightingDisabledForLayout(() => {
				for (let index = this.#virtualLayoutDirtyFrom; index < this.#virtualEntries.length; index++) {
					const measurement = this.#measureVirtualLayout(index, width);
					if (measurement) this.#applyVirtualMeasurement(measurement);
				}
			});
			this.#virtualLayoutDirtyFrom = this.#virtualEntries.length;
			this.#virtualLayoutComplete = true;
		}
	}

	#cancelVirtualWarmup(): void {
		this.#virtualWarmupToken++;
		this.#virtualWarmup = undefined;
		this.#virtualLayoutComplete = false;
		this.#virtualRepaintPending = false;
	}

	#requestVirtualRepaint(): void {
		if (!this.#onVirtualLayoutUpdate || this.#virtualDisposed || this.#virtualRepaintPending) return;
		this.#virtualRepaintPending = true;
		const token = this.#virtualWarmupToken;
		setImmediate(() => {
			if (token !== this.#virtualWarmupToken || this.#virtualDisposed) return;
			this.#virtualRepaintPending = false;
			this.#onVirtualLayoutUpdate?.(this);
		});
	}

	#scheduleVirtualWarmup(width: number): void {
		if (this.#virtualDisposed || this.#virtualLayoutComplete || this.#virtualWarmup) return;
		const warmup: VirtualWarmup = {
			token: this.#virtualWarmupToken,
			width,
			generation: this.#generation,
			entries: this.#virtualEntries,
		};
		this.#virtualWarmup = warmup;
		setImmediate(() => {
			void this.#runVirtualWarmup(warmup)
				.catch(error => {
					logger.warn("Transcript background layout stopped", { error: String(error) });
				})
				.finally(() => {
					// Keep a failed attempt parked until a new layout epoch or mutation
					// invalidates it, rather than retrying a broken renderer each frame.
					if (this.#virtualWarmup === warmup && this.#virtualLayoutComplete) this.#virtualWarmup = undefined;
				});
		});
	}

	#virtualWarmupIsCurrent(warmup: VirtualWarmup): boolean {
		return (
			!this.#virtualDisposed &&
			this.#virtualWarmup === warmup &&
			this.#virtualWarmupToken === warmup.token &&
			this.#generation === warmup.generation &&
			this.#virtualWidth === warmup.width &&
			this.#virtualEntries === warmup.entries
		);
	}

	async #runVirtualWarmup(warmup: VirtualWarmup): Promise<void> {
		let index = warmup.entries.length - 1;
		while (index >= 0) {
			if (!this.#virtualWarmupIsCurrent(warmup)) return;
			const started = performance.now();
			let count = 0;
			withCodeHighlightingDisabledForLayout(() => {
				while (
					index >= 0 &&
					count < VIRTUAL_WARMUP_CHUNK_ENTRIES &&
					performance.now() - started < VIRTUAL_WARMUP_CHUNK_MS
				) {
					const entry = warmup.entries[index]!;
					const pending = this.#pendingVirtualMeasurements.get(entry);
					if (
						!pending ||
						pending.width !== warmup.width ||
						pending.generation !== warmup.generation ||
						pending.version !== getBlockVersion(entry.component)
					) {
						const measurement = this.#measureVirtualLayout(index, warmup.width);
						if (measurement && this.#virtualWarmupIsCurrent(warmup)) {
							if (
								!this.#visibleVirtualEntries.has(entry) &&
								measurement.bodyRows === this.#virtualRowIndex.bodyRows(index)
							) {
								// Equal-height offscreen results change no displayed coordinates.
								this.#applyVirtualMeasurement(measurement);
							} else {
								this.#pendingVirtualMeasurements.set(entry, measurement);
							}
						}
					}
					index--;
					count++;
				}
			});
			if (!this.#virtualWarmupIsCurrent(warmup)) return;
			if (this.#pendingVirtualMeasurements.size > 0) this.#requestVirtualRepaint();
			if (index >= 0) await waitForImmediate();
		}
		if (this.#virtualWarmupIsCurrent(warmup)) this.#virtualLayoutComplete = true;
	}

	#commitVirtualMeasurements(): void {
		if (this.#pendingVirtualMeasurements.size === 0) return;
		const started = performance.now();
		let count = 0;
		for (const [entry, measurement] of this.#pendingVirtualMeasurements) {
			this.#pendingVirtualMeasurements.delete(entry);
			this.#applyVirtualMeasurement(measurement);
			count++;
			if (count >= VIRTUAL_LAYOUT_COMMIT_MAX_ENTRIES || performance.now() - started >= VIRTUAL_WARMUP_CHUNK_MS)
				break;
		}
	}

	#applyVirtualMeasurement(measurement: VirtualLayoutMeasurement): void {
		const { entry, width, generation, version } = measurement;
		const index = this.#directChildIndices.get(entry.component);
		if (index === undefined || this.#virtualEntries[index] !== entry) return;
		if (
			width !== this.#virtualWidth ||
			generation !== this.#generation ||
			version !== getBlockVersion(entry.component)
		) {
			this.#cancelVirtualWarmup();
			this.#requestVirtualRepaint();
			return;
		}
		if (
			entry.measuredWidth === width &&
			entry.measuredGeneration === generation &&
			entry.measuredVersion === version &&
			entry.contribution !== undefined
		)
			return;
		this.#virtualRowIndex.set(index, measurement.bodyRows);
		entry.layoutWidth = width;
		entry.layoutGeneration = generation;
		entry.layoutVersion = version;
		entry.measurement = measurement.measurement;
		if (entry.measuredWidth !== width || entry.measuredGeneration !== generation) {
			entry.rawRef = undefined;
			entry.contribution = undefined;
		}
	}

	#syncVirtualStructure(): boolean {
		const children = this.children;
		const entries = this.#virtualEntries;
		if (!this.#virtualStructureDirty && entries.length === children.length) return false;
		this.#cancelVirtualWarmup();
		const previous = new Map(entries.map((entry, index) => [entry.component, index]));
		const rowIndex = new VirtualRowIndex();
		rowIndex.estimatedBodyRows = this.#virtualRowIndex.estimatedBodyRows;
		const next = children.map(component => {
			const previousIndex = previous.get(component);
			rowIndex.append(previousIndex === undefined ? undefined : this.#virtualRowIndex.knownBodyRows(previousIndex));
			if (previousIndex !== undefined) return entries[previousIndex]!;
			return {
				component,
				rawRef: undefined,
				contribution: undefined,
				measuredWidth: -1,
				measuredGeneration: -1,
				measuredVersion: undefined,
				layoutWidth: -1,
				layoutGeneration: -1,
				layoutVersion: undefined,
			};
		});
		this.#virtualEntries = next;
		this.#virtualRowIndex = rowIndex;
		this.#directChildIndices = new Map(children.map((component, index) => [component, index]));
		this.#targetOwnerIndices = new WeakMap();
		this.#visibleVirtualEntries.clear();
		this.#virtualLayoutDirtyFrom = 0;
		this.#virtualStructureDirty = false;
		return true;
	}

	#measureVirtualLayout(index: number, width: number): VirtualLayoutMeasurement | undefined {
		const entry = this.#virtualEntries[index];
		if (!entry) return undefined;
		let currentVersion = getBlockVersion(entry.component);
		if (
			entry.layoutWidth === width &&
			entry.layoutGeneration === this.#generation &&
			entry.layoutVersion === currentVersion &&
			(isBlockExplicitlyFinalized(entry.component) || currentVersion !== undefined)
		)
			return undefined;
		const pending = this.#pendingVirtualMeasurements.get(entry);
		if (pending?.width === width && pending.generation === this.#generation && pending.version === currentVersion) {
			return pending;
		}
		this.#applyPresentationState(entry.component);
		this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
		currentVersion = getBlockVersion(entry.component);
		const reusable = entry.layoutGeneration === this.#generation && entry.layoutVersion === currentVersion;
		const bodyRows = Math.max(
			0,
			Math.trunc(
				reusable && entry.measurement
					? entry.measurement.measureRows(width)
					: measureComponentRows(entry.component, width),
			),
		);
		const measurement =
			reusable && entry.measurement
				? entry.measurement
				: currentVersion !== undefined && isBlockExplicitlyFinalized(entry.component)
					? entry.component.getRowMeasurement?.(width)
					: undefined;
		return { entry, width, generation: this.#generation, version: currentVersion, bodyRows, measurement };
	}

	#measureVirtualEntry(index: number, width: number, force = false): boolean {
		const entry = this.#virtualEntries[index];
		if (!entry) return false;
		this.#applyPresentationState(entry.component);
		const currentVersion = getBlockVersion(entry.component);
		if (
			!force &&
			entry.contribution !== undefined &&
			entry.rawRef !== undefined &&
			entry.measuredWidth === width &&
			entry.measuredGeneration === this.#generation &&
			entry.measuredVersion === currentVersion &&
			isBlockExplicitlyFinalized(entry.component)
		) {
			return false;
		}
		const previousRows = this.#virtualRowIndex.bodyRows(index);
		this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
		const raw = entry.component.render(width);
		const contribution = trimBlankEdges(raw);
		this.#recordVirtualMeasurement(index, width, raw, contribution);
		return contribution.length !== previousRows;
	}

	#recordVirtualMeasurement(
		index: number,
		width: number,
		raw: readonly string[],
		contribution: readonly string[],
	): void {
		const entry = this.#virtualEntries[index];
		if (!entry) return;
		if (
			entry.measurement &&
			(entry.layoutGeneration !== this.#generation || entry.layoutVersion !== getBlockVersion(entry.component))
		) {
			entry.measurement = undefined;
			this.#pendingVirtualMeasurements.delete(entry);
		}
		entry.rawRef = raw;
		entry.contribution = contribution;
		this.#virtualRowIndex.set(index, contribution.length);
		entry.measuredWidth = width;
		entry.measuredGeneration = this.#generation;
		entry.measuredVersion = getBlockVersion(entry.component);
		entry.layoutWidth = width;
		entry.layoutGeneration = this.#generation;
		entry.layoutVersion = entry.measuredVersion;
		this.#pendingVirtualMeasurements.delete(entry);
	}

	#renderVirtualRows(offset: number, rows: number): readonly string[] {
		const end = Math.min(this.#virtualTotalRows, offset + rows);
		const lines: string[] = [];
		let index = this.#virtualRowIndex.find(offset);
		while (index >= 0 && index < this.#virtualEntries.length && lines.length < rows) {
			const entry = this.#virtualEntries[index]!;
			const startRow = this.#virtualRowIndex.startRow(index);
			if (startRow >= end) break;
			const separator = this.#virtualRowIndex.separator(index);
			const rowCount = this.#virtualRowIndex.bodyRows(index) + separator;
			const contribution =
				entry.measuredWidth === this.#virtualWidth && entry.measuredGeneration === this.#generation
					? entry.contribution
					: undefined;
			const from = Math.max(offset, startRow);
			const to = Math.min(end, startRow + rowCount);
			for (let row = from; row < to; row++) {
				const local = row - startRow;
				lines.push(local < separator ? "" : (contribution?.[local - separator] ?? ""));
			}
			index = this.#virtualRowIndex.next(index);
		}
		return lines;
	}

	#renderEmergency(
		shown: readonly { entry: TranscriptEntry; index: number }[],
		width: number,
		rows: number,
		frame: AnimationFrame,
	): readonly string[] {
		let visibleRows = rows;
		let visible: { entry: TranscriptEntry; index: number }[] = [];
		let emergencyCandidate: { entry: TranscriptEntry; index: number } | undefined;
		let emergencyRow: string | undefined;
		let hiddenActive = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			visible = visibleRows > 0 ? shown.slice(-visibleRows) : [];
			emergencyCandidate = undefined;
			emergencyRow = undefined;
			const visibleStart = shown.length - visibleRows;
			for (let index = visibleStart - 1; index >= 0; index--) {
				const candidate = shown[index]!;
				const block = candidate.entry.component as Component & FinalizableBlock;
				const row =
					candidate.entry.state === "settled" ? block.renderTranscriptBlockEmergencyRow?.(width) : undefined;
				if (row === undefined) continue;
				emergencyCandidate = candidate;
				emergencyRow = row;
				visible = [candidate, ...visible.slice(1)];
				break;
			}

			let activeTotal = 0;
			for (const candidate of shown) {
				if (candidate.entry.state === "active") activeTotal++;
			}
			hiddenActive = activeTotal;
			for (const candidate of visible) {
				if (candidate.entry.state === "active") hiddenActive--;
			}
			// The summary row itself represents the newest active block when no
			// active row fits beside it; report only the additional backlog.
			if (hiddenActive === activeTotal && hiddenActive > 0) hiddenActive--;
			if (attempt === 0 && hiddenActive > 0) {
				visibleRows = Math.max(0, rows - 1);
				continue;
			}
			break;
		}

		const output = hiddenActive > 0 ? [`${hiddenActive} more transcript blocks active`] : [];
		for (const candidate of visible) {
			if (candidate === emergencyCandidate) {
				output.push(emergencyRow ?? "");
				continue;
			}
			this.#applyPresentationState(candidate.entry.component);
			this.#setAllocation(candidate.entry.component, 1, frame);
			const rendered = this.#renderEntry(candidate.entry, width).slice(
				this.#projectedEmitted(candidate.entry, candidate.index, width),
			);
			output.push(rendered[0] ?? "");
		}
		return output.slice(0, rows);
	}

	#projectedEmitted(entry: TranscriptEntry, index: number, width: number): number {
		const offered = this.#offered;
		const count = offered?.kind === "append" && offered.entry === index ? offered.emittedEnd : entry.emitted;
		return this.#renderStablePrefix(entry, count, width).length;
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	#applyPresentationState(component: Component): void {
		setBlockExpanded(component, this.#expanded);
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
	}

	#settleFinalized(): void {
		for (const entry of this.#entries) {
			if (entry.state === "active" && canRetire(entry.component)) entry.state = "settled";
		}
	}

	#liveEntries(): Array<{ entry: TranscriptEntry; index: number }> {
		const start = this.#offered?.kind === "commit" ? this.#offered.end : this.#frontier;
		const live: Array<{ entry: TranscriptEntry; index: number }> = [];
		for (let index = start; index < this.#entries.length; index++) live.push({ entry: this.#entries[index]!, index });
		return live;
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(
			component =>
				existing.get(component) ?? {
					component,
					state: "active",
					mode: blockMode(component),
					stableRows: EMPTY_STABLE_ROWS,
					renderedStableByWidth: new Map(),
					emitted: 0,
					stableFrozen: false,
				},
		);
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one conservative mutable semantic transcript block. */
export class TranscriptBlock extends Container {}
