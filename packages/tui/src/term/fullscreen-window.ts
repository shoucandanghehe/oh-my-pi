import type { InputEvent, MouseEvent } from "../driver/contract";
import { dropCutImages, holdsImage } from "../driver/images/anchor";
import { clipViewportImages } from "../driver/images/viewport";
import type { UiNode } from "../node";
import { untrack } from "../reactive";
import type { MainScrollScope, Surface } from "../surface";
import { truncate } from "../text/width";
import type { WorkspaceMainView } from "../workspace";
import type { SelectionMotion, TermBackendOptions, TranscriptScroll } from "./backend";
import { type Block, type Cell, type PaintEnvironment, paintNode } from "./paint";
import { plainTranscriptText } from "./transcript-cells";
import { TranscriptDocument } from "./transcript-document";
import { TranscriptPointer } from "./transcript-pointer";
import { TranscriptSearch } from "./transcript-search";
import type { WidgetContext } from "./widgets";
import type { FrameHit } from "./workspace";

/** The top of the fullscreen transcript window: a `main` node and a row of its entry (separator rows first). */
interface ScrollAnchor {
	readonly node: UiNode;
	readonly row: number;
}

/** The fullscreen transcript window as the last frame drew it. */
interface SessionWindow {
	/** Its first row (the tail-following window's too, so scrolling starts from what is on screen). */
	readonly top: ScrollAnchor | undefined;
	/** Transcript rows on screen (the indicator row included). */
	readonly rows: number;
	readonly width: number;
	/** The wheel scrolls it: no modal sheet owns the pointer. */
	readonly wheel: boolean;
	readonly nodes: readonly UiNode[];
}

/** The reading point survives a topic remount even though its nodes do not. */
interface Bookmark {
	readonly index: number;
	readonly kind: UiNode["kind"];
	readonly width: number;
	readonly row: number;
	readonly textOffset: number | undefined;
}

const contentLength = (line: string): number => plainTranscriptText(line).replace(/\s+/gu, "").length;

const OVERSCAN = 4;

interface FullscreenWindowHost extends Pick<
	TermBackendOptions,
	| "screen"
	| "separator"
	| "theme"
	| "images"
	| "scrollbar"
	| "clock"
	| "wheelLines"
	| "copyOnSelect"
	| "copySelection"
	| "isPrompt"
> {
	readonly surface: Surface;
	readonly env: PaintEnvironment;
	readonly acceptsPointer: () => boolean;
	readonly requestRender: () => void;
	readonly settleFrame: () => void;
	readonly widgetContext: (node: UiNode) => WidgetContext;
}

const FULLSCREEN_KINDS: ReadonlySet<string> = new Set(["picker", "prefs"]);

export function isFullscreen(node: UiNode): boolean {
	const props = node.props();
	if (node.kind === "picker") return !("modal" in props && props.modal === false);
	if (FULLSCREEN_KINDS.has(node.kind)) return true;
	return node.kind === "overlay" && "size" in props && props.size === "full";
}

/** One app-owned transcript and its fixed dock, in window-local cells. */
export class FullscreenWindow {
	readonly #surface: Surface;
	#anchor: ScrollAnchor | undefined;
	#search: TranscriptSearch | undefined;
	#window: SessionWindow | undefined;
	#index: TranscriptDocument | undefined;
	readonly #widths = new Map<number, TranscriptDocument>();
	#pointer: TranscriptPointer | undefined;
	#scope: MainScrollScope | undefined;
	#bookmark: Bookmark | undefined;
	readonly #bookmarks = new Map<string, Bookmark>();

	constructor(readonly host: FullscreenWindowHost) {
		this.#surface = host.surface;
	}

	get painted(): boolean {
		return this.#window !== undefined;
	}

	get following(): boolean {
		return this.painted && this.#anchor === undefined;
	}

	visibleMain(): WorkspaceMainView | undefined {
		return this.#window && { nodes: this.#window.nodes, followingTail: this.following };
	}

	get wheel(): boolean {
		return !!this.#window?.wheel && this.searchable;
	}

	resetPointer(): void {
		this.#pointer?.reset();
		this.host.requestRender();
	}

	blurPointer(): boolean {
		const changed = this.#pointer?.blur() ?? false;
		if (changed) this.host.requestRender();
		return changed;
	}

	leavePointer(): void {
		this.#pointer?.leave();
	}

	capturePointer(mouse: MouseEvent, row: number): boolean {
		const captured = this.#pointer?.capture(mouse, row) ?? false;
		if (captured) this.host.requestRender();
		return captured;
	}

	pointerInput(mouse: MouseEvent, row: number): void {
		this.#pointer?.input(mouse, row);
		if (mouse.action === "press" && mouse.button === "left" && this.#pointer?.holdingTranscript)
			this.#anchor ??= this.#window?.top;
		if (mouse.action === "press") this.host.requestRender();
	}

	#paint(node: UiNode, width: number): Block {
		return paintNode(this.host.env, node, width);
	}

	/**
	 * Scroll the fullscreen transcript window: by `by` (a page is the window less one row), or by a
	 * row count (negative: up). Scrolling to the end follows the tail again. False when no window is
	 * on screen (inline mode, a fullscreen layer up): the caller's key goes elsewhere.
	 */
	scroll(by: TranscriptScroll): boolean {
		const view = this.#window;
		if (!view) return false;
		const page = Math.max(1, view.rows - 1);
		if (by === "previous-prompt" || by === "next-prompt") {
			const doc = this.#index!;
			const main = untrack(this.#surface.main);
			const top = this.#anchor ?? view.top;
			if (!top || !this.host.isPrompt) return false;
			const step = by === "next-prompt" ? 1 : -1;
			let index = doc.indexOf(top.node);
			if (step > 0 || top.row === 0) index += step;
			for (; index >= 0 && index < main.length; index += step) {
				const node = main[index]!;
				if (!this.host.isPrompt(node)) continue;
				this.#anchor = { node, row: 0 };
				this.#remember(doc, view.width);
				this.host.requestRender();
				break;
			}
			return true;
		}
		if (by === "half-up" || by === "half-down")
			by = (by === "half-up" ? -1 : 1) * Math.max(1, Math.floor(view.rows / 2));
		const delta =
			typeof by === "number"
				? by
				: by === "page-up"
					? -page
					: by === "page-down"
						? page
						: by === "line-up"
							? -1
							: by === "line-down"
								? 1
								: 0;
		const doc = this.#index!;
		const maxTop = Math.max(0, doc.rows - view.rows);
		const origin = this.#anchor ? doc.entry(this.#anchor.node) : doc.at(maxTop);
		const row = origin ? Math.min(origin.size - 1, this.#anchor?.row ?? maxTop - origin.top) : 0;
		this.#seek(
			by === "start" ? 0 : by === "end" ? maxTop : origin ? doc.offset(origin, row, delta) : maxTop + delta,
			doc,
		);
		return true;
	}

	/** Open a terminal-local transcript search without moving focus or editing the composer's draft. */
	openSearch(): boolean {
		if (!this.#window || !this.searchable) return false;
		if (!this.#search) {
			this.#pointer?.reset();
			this.#search = new TranscriptSearch(
				this.#anchor,
				this.#surface.focused(),
				this.host.env,
				this.host.widgetContext,
			);
			this.host.requestRender();
		}
		return true;
	}

	get searchable(): boolean {
		if (this.host.screen?.() !== "fullscreen") return false;
		if (this.#search && this.#search.owner !== this.#surface.focused()) return false;
		return !this.#surface
			.layer()
			.some(
				node =>
					isFullscreen(node) || (node.kind === "overlay" && (node.props() as { modal?: boolean }).modal === true),
			);
	}

	closeSearch(accept = false): void {
		const search = this.#search;
		if (!search) return;
		this.#anchor = (accept ? search.selectedAnchor : undefined) ?? search.savedAnchor;
		search.dispose();
		this.#search = undefined;
	}

	searchInput(event: InputEvent): boolean {
		const search = this.#search;
		if (!search) return false;
		if (!this.searchable) {
			this.closeSearch();
			this.host.requestRender();
			return false;
		}
		if (
			event.type === "mouse" &&
			event.mouse.action === "press" &&
			event.mouse.row < (this.#window?.rows ?? 0) &&
			(event.mouse.button === "wheel-up" || event.mouse.button === "wheel-down")
		) {
			search.browse();
			this.#pointer?.input(event.mouse, event.mouse.row);
			return true;
		}
		if (
			event.type === "key" &&
			event.key.kind !== "release" &&
			(event.key.id === "pageUp" || event.key.id === "pageDown")
		) {
			search.browse();
			return this.scroll(event.key.id === "pageUp" ? "page-up" : "page-down");
		}
		const action = search.input(event);
		if (!action) return false;
		if (action !== "handled") {
			// The terminal may deliver the query, navigation and accept before a coalesced frame.
			if (action === "accept") this.host.settleFrame();
			this.closeSearch(action === "accept");
		}
		this.host.requestRender();
		return true;
	}

	/** Copy selected fullscreen transcript text. False leaves the key available to the focused widget. */
	copySelection(): boolean {
		return this.#pointer?.copy() ?? false;
	}

	/** Adjust an existing selection without stealing navigation from the composer when none is active. */
	extendSelection(direction: SelectionMotion): boolean {
		if (!this.#pointer?.adjust(direction)) return false;
		this.host.requestRender();
		return true;
	}

	hide(resetAnchor = false): void {
		if (resetAnchor) this.#anchor = undefined;
		this.#window = undefined;
		this.#pointer?.reset();
		this.#pointer = undefined;
		this.#widths.clear();
		this.#index = undefined;
	}

	#remember(doc: TranscriptDocument, width: number): void {
		if (!this.#scope) return;
		const anchor = this.#anchor;
		const entry = anchor && doc.entry(anchor.node);
		this.#bookmark = undefined;
		if (!anchor || !entry) return;
		const row = anchor.row - entry.lead;
		let textOffset: number | undefined;
		if (row >= 0) {
			const lines = doc.lines(anchor.node);
			textOffset = 0;
			for (let i = 0; i < row && i < lines.length; i++) textOffset += contentLength(lines[i]!);
		}
		this.#bookmark = { index: entry.index, kind: anchor.node.kind, row, width, textOffset };
	}

	#seek(offset: number, doc = this.#index): void {
		if (!doc || !this.#window) return;
		const target = Math.max(0, Math.trunc(offset));
		const entry = target < doc.rows - this.#window.rows ? doc.at(target) : undefined;
		this.#anchor = entry ? { node: entry.node, row: target - entry.top } : undefined;
		this.#remember(doc, this.#window.width);
		this.host.requestRender();
	}

	#sessionPointer(): TranscriptPointer {
		const options = this.host;
		return (this.#pointer ??= new TranscriptPointer({
			available: () => this.host.acceptsPointer() && this.wheel && !this.#search,
			requestRender: options.requestRender,
			document: () => this.#index!,
			scroll: delta => this.scroll(delta),
			scrollTo: offset => this.#seek(offset),
			now: options.clock ?? (() => performance.now()),
			wheelLines: options.wheelLines ?? (() => 0),
			copyOnSelect: options.copyOnSelect ?? (() => true),
			get copy() {
				return options.copySelection;
			},
		}));
	}

	#document(width: number): TranscriptDocument {
		let doc = this.#widths.get(width);
		if (!doc) {
			doc = new TranscriptDocument(
				this.#surface.main,
				node => paintNode(this.host.env, node, width, undefined, true),
				this.host.separator ?? (() => 1),
				this.#index?.estimate,
				node => this.#paint(node, width),
			);
		}
		// Keep the current and previous width: terminal resize often toggles between the two.
		this.#widths.delete(width);
		this.#widths.set(width, doc);
		if (this.#widths.size > 2) this.#widths.delete(this.#widths.keys().next().value!);
		doc.sync();
		return (this.#index = doc);
	}

	#position(doc: TranscriptDocument, room: number): number {
		const max = Math.max(0, doc.rows - room);
		const anchor = this.#anchor;
		if (!anchor || !room) return max;
		const index = doc.indexOf(anchor.node);
		if (index < 0) return max;
		return Math.min(max, doc.start(index) + Math.max(0, Math.min(anchor.row, doc.size(index) - 1)));
	}

	#visible(doc: TranscriptDocument, nodes: readonly UiNode[], room: number): Map<number, Block> {
		const blocks = new Map<number, Block>();
		if (!room) return blocks;
		const anchor = this.#anchor && doc.indexOf(this.#anchor.node);
		if (anchor !== undefined && anchor >= 0) doc.measure(anchor);
		const limit = Math.max(128, room + OVERSCAN * 2);
		const fill = (): void => {
			const following = this.#position(doc, room) === Math.max(0, doc.rows - room);
			for (
				let i = doc.indexAt(following ? doc.rows - 1 : this.#position(doc, room));
				i >= 0 && i < nodes.length && blocks.size < limit;
				i = doc.indexAt(following ? doc.start(i) - 1 : doc.start(i + 1))
			) {
				const top = this.#position(doc, room);
				if (following ? doc.start(i + 1) <= top : doc.start(i) >= top + room) break;
				if (blocks.has(i)) continue;
				blocks.set(i, doc.measure(i, true));
			}
		};
		fill();
		const top = this.#position(doc, room);
		const first = doc.indexAt(top);
		const last = doc.indexAt(Math.min(doc.rows, top + room) - 1);
		// Nearby blocks give short scrolls exact heights, without animating or acquiring their images.
		const nearby = new Set<number>();
		for (let i = 1; i <= OVERSCAN; i++) {
			nearby.add(first - i);
			nearby.add(last + i);
			nearby.add(nodes.length - i); // Empty and streaming tail nodes can gain rows without a list change.
		}
		for (const i of nearby) if (i >= 0 && i < nodes.length && !blocks.has(i)) doc.measure(i);
		let sum = 0;
		let count = 0;
		for (const [i, block] of blocks) {
			if (!block.rows.length) continue;
			sum += doc.size(i);
			count++;
		}
		doc.seed(sum, count);
		fill();
		if (blocks.size >= limit) this.host.requestRender();
		return blocks;
	}

	/**
	 * The fullscreen session frame (before layers): the transcript window over the dock pinned to the
	 * bottom row. The window follows the tail, or starts at {@link #anchor} (clamped to the
	 * transcript; one that reaches the tail follows it again) with a row counting what is below it.
	 */
	paint(
		screenWidth: number,
		height: number,
		hits: FrameHit[],
		wheel: boolean,
	): { rows: string[]; cursor: Cell | null } {
		let cursor: Cell | null = null;
		const scope = this.#surface.mainScrollScope?.();
		const previousScope = this.#scope;
		let bookmark: Bookmark | undefined;
		if (scope?.key !== previousScope?.key || scope?.preview !== previousScope?.preview) {
			if (previousScope && !previousScope.preview) {
				if (this.#bookmark) this.#bookmarks.set(previousScope.key, this.#bookmark);
				else this.#bookmarks.delete(previousScope.key);
			}
			this.#scope = scope;
			bookmark = scope && this.#bookmarks.get(scope.key);
			this.closeSearch();
			this.#anchor = undefined;
			this.resetPointer();
		}
		const search = this.#search;
		const dock: { node: UiNode; block: Block; top: number }[] = [];
		let dockRows = search ? 1 : 0;
		for (const node of search ? [] : this.#surface.dock()) {
			const block = this.#paint(node, screenWidth);
			// Inline dock painters include breathing room between the ledger and controls.
			// On the fixed screen give leading, purely decorative blank rows back to the transcript.
			let skip = 0;
			if (!dockRows && block.rows[0] === "" && !block.covering && !block.rows.some(holdsImage)) {
				while (
					block.rows[skip] === "" &&
					block.cursor?.row !== skip &&
					!block.hits?.some(hit => hit.row <= skip && skip < hit.row + hit.height)
				)
					skip++;
			}
			dock.push({ node, block, top: dockRows - skip });
			dockRows += block.rows.length - skip;
		}
		const room = Math.max(0, height - dockRows);
		const main = this.#surface.main();
		const lane = screenWidth > 1 && (this.host.scrollbar?.() ?? true);
		const width = lane ? screenWidth - 1 : screenWidth;
		const previous = this.#index;
		const continuing = previous?.pending;
		const doc = this.#document(width);
		if (bookmark) {
			const node = main[bookmark.index];
			if (node?.kind === bookmark.kind) doc.measure(bookmark.index);
			const entry = node?.kind === bookmark.kind ? doc.entry(node) : undefined;
			if (entry && node) {
				let row = bookmark.row;
				if (width !== bookmark.width && bookmark.textOffset !== undefined) {
					const lines = doc.lines(node);
					let offset = bookmark.textOffset;
					for (row = 0; row < lines.length - 1; row++) {
						const length = contentLength(lines[row]!);
						if (offset < length) break;
						offset -= length;
					}
				}
				this.#anchor = { node, row: Math.max(0, Math.min(entry.size - 1, row + entry.lead)) };
			}
		}

		if (search) {
			this.#anchor = search.reveal(
				main,
				i => doc.measure(i).rows,
				i => doc.size(i),
				this.#anchor,
				room,
			);
		}
		if (room && continuing && previous === doc) doc.refine();
		const blocks = this.#visible(doc, main, room);
		doc.painted(blocks);
		if (room && doc.pending) this.host.requestRender();

		const maxTop = Math.max(0, doc.rows - room);
		const offset = this.#position(doc, room);
		const first = doc.at(offset);
		const index = first?.index ?? main.length;
		const skip = first ? offset - first.top : 0;
		const below = offset < maxTop ? maxTop - offset + 1 : 0; // The indicator replaces the last content row.
		// Even at the tail, a held selection pins the last painted rows before more output arrives.
		this.#anchor = (below || this.#pointer?.holdingTranscript) && first ? { node: first.node, row: skip } : undefined;
		this.#remember(doc, width);

		// The window: entry rows from the top down, the indicator taking its last row while anchored.
		const indicator = below > 0 && !lane && room > 1;
		const content = indicator ? room - 1 : room;
		const window: string[] = [];
		const nodes: UiNode[] = [];
		for (let i = index; i < main.length && window.length < content; i = doc.indexAt(doc.start(i + 1))) {
			const rows = doc.size(i);
			const node = main[i]!;
			const block = blocks.get(i);
			if (!block) break; // A long run of changing empty blocks can exhaust this frame's layout budget.
			const lead = rows - block.rows.length;
			// Window row of the block's first row (negative: cut above the window).
			const top = window.length + lead - (i === index ? skip : 0);
			if (top < content && top + block.rows.length > 0) nodes.push(node);
			for (let r = i === index ? skip : 0; r < rows && window.length < content; r++) {
				const raw = r < lead ? "" : block.rows[r - lead]!;
				window.push(search ? search.highlight(node, r, raw) : raw);
			}
			if (this.host.images) {
				const from = Math.max(0, -top);
				const to = Math.min(block.rows.length, content - top);
				clipViewportImages(window, top + from, block.rows, from, to, this.host.images.cell().h);
			}
			if (block.cursor && this.#surface.focused()) {
				const row = top + block.cursor.row;
				if (row >= 0 && row < window.length) cursor = { row, col: block.cursor.col };
			}
			for (const hit of block.hits ?? []) {
				if (top + hit.row >= 0 && top + hit.row + hit.height <= window.length) hits.push({ hit, top, left: 0 });
			}
		}
		dropCutImages(window, 0);
		if (indicator) {
			const theme = this.host.theme();
			window.push(truncate(theme.fg("dim", `↓ ${below} ${below === 1 ? "line" : "lines"} below`), width, ""));
		}
		while (window.length < room) window.push("");
		this.#window = {
			top: index < main.length ? { node: main[index]!, row: skip } : undefined,
			rows: room,
			width,
			wheel,
			nodes,
		};

		const rows = window;
		if (search) {
			const bar = search.bar(screenWidth, room);
			rows.push(bar.text);
			cursor = { row: room, col: bar.col };
		}
		const dockTop = rows.length;
		for (const placed of dock) {
			for (let row = Math.max(0, -placed.top); row < placed.block.rows.length; row++)
				rows.push(placed.block.rows[row]!);
			if (placed.block.cursor)
				cursor = { row: dockTop + placed.top + placed.block.cursor.row, col: placed.block.cursor.col };
			for (const hit of placed.block.hits ?? []) hits.push({ hit, top: dockTop + placed.top, left: 0 });
		}
		// A dock taller than the screen keeps its bottom rows (the editor).
		const over = rows.length - height;
		if (over > 0) {
			rows.splice(0, over);
			dropCutImages(rows, 0);
			if (cursor) cursor = cursor.row >= over ? { row: cursor.row - over, col: cursor.col } : null;
			for (const entry of hits) entry.top -= over;
		}
		this.#sessionPointer().update(
			{
				doc,
				nodes: this.#surface.main,
				block: doc.block,
				screenTop: 0,
				dock: () => {
					// The fixed dock already has exact block placements, including partially clipped nodes.
					const entries = dock.map(({ node, block, top }, index) => ({
						node,
						block,
						top,
						index,
						lead: 0,
						size: block.rows.length,
					}));
					const at = (row: number) => entries.find(entry => row >= entry.top && row < entry.top + entry.size);
					const entry = (node: UiNode) => entries.find(entry => entry.node === node);
					return {
						doc: {
							rows: dockRows,
							at,
							entry,
							line: row => {
								const hit = at(row);
								return hit?.block.rows[row - hit.top] ?? "";
							},
						},
						nodes: () => entries.map(e => e.node),
						block: node => entry(node)!.block,
						top: Math.max(0, over),
						screenTop: room,
						content: Math.min(height, dockRows),
						width: screenWidth,
					};
				},
				top: offset,
				rows: room,
				content: Math.min(content, doc.rows - offset),
				width,
				scrollbar: lane && room > 0 && doc.rows > room,
			},
			window,
			this.host.theme(),
		);
		return { rows, cursor };
	}
}
