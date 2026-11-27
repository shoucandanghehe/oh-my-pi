import type { InputEvent, MouseEvent } from "../driver/contract";
import { dropCutImages, holdsImage } from "../driver/images/anchor";
import { clipViewportImages } from "../driver/images/viewport";
import type { UiNode } from "../node";
import { untrack } from "../reactive";
import type { Surface } from "../surface";
import { truncate } from "../text/width";
import type { SelectionMotion, TermBackendOptions, TranscriptScroll } from "./backend";
import { type Block, type Cell, type Hit, type PaintEnvironment, paintNode } from "./paint";
import { type TranscriptDocument, type TranscriptIndex, transcriptIndex } from "./transcript-document";
import { TranscriptPointer } from "./transcript-pointer";
import { TranscriptSearch } from "./transcript-search";
import type { WidgetContext } from "./widgets";

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
}

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
	#index: TranscriptIndex | undefined;
	#pointer: TranscriptPointer | undefined;

	constructor(readonly host: FullscreenWindowHost) {
		this.#surface = host.surface;
	}

	get painted(): boolean {
		return this.#window !== undefined;
	}

	get following(): boolean {
		return this.painted && this.#anchor === undefined;
	}

	get wheel(): boolean {
		return !!this.#window?.wheel && this.searchable;
	}

	resetPointer(): void {
		this.#pointer?.reset();
	}

	blurPointer(): boolean {
		return this.#pointer?.blur() ?? false;
	}

	capturePointer(mouse: MouseEvent, row: number): boolean {
		return this.#pointer?.capture(mouse, row) ?? false;
	}

	pointerInput(mouse: MouseEvent, row: number): void {
		this.#pointer?.input(mouse, row);
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
			const main = untrack(() => this.#surface.main());
			const top = this.#anchor ?? view.top;
			if (!top || !this.host.isPrompt) return false;
			const step = by === "next-prompt" ? 1 : -1;
			let index = main.indexOf(top.node);
			if (step > 0 || top.row === 0) index += step;
			for (; index >= 0 && index < main.length; index += step) {
				const node = main[index]!;
				if (!this.host.isPrompt(node)) continue;
				this.#anchor = { node, row: 0 };
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
		const doc = this.#index!.read();
		const maxTop = Math.max(0, doc.rows - view.rows);
		const origin = this.#anchor && doc.entry(this.#anchor.node);
		const from = origin ? origin.top + Math.min(this.#anchor!.row, origin.size - 1) : maxTop;
		this.#seek(by === "start" ? 0 : by === "end" ? maxTop : from + delta, doc);
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
		this.#index?.dispose();
		this.#index = undefined;
	}
	#seek(offset: number, doc = this.#index?.read()): void {
		if (!doc || !this.#window) return;
		const target = Math.max(0, Math.trunc(offset));
		const entry = target < doc.rows - this.#window.rows ? doc.at(target) : undefined;
		this.#anchor = entry ? { node: entry.node, row: target - entry.top } : undefined;
		this.host.requestRender();
	}

	#sessionPointer(): TranscriptPointer {
		const options = this.host;
		return (this.#pointer ??= new TranscriptPointer({
			available: () => this.host.acceptsPointer() && this.wheel && !this.#search,
			document: () => this.#index!.read(),
			scroll: delta => this.scroll(delta),
			scrollTo: offset => this.#seek(offset),
			now: options.clock ?? (() => performance.now()),
			wheelLines: options.wheelLines ?? (() => 0),
			copyOnSelect: options.copyOnSelect ?? (() => true),
			copy: options.copySelection,
		}));
	}

	#document(width: number): TranscriptDocument {
		if (this.#index?.width !== width) {
			this.#index?.dispose();
			this.#index = transcriptIndex(
				width,
				this.#surface.main,
				node => this.#paint(node, width).rows,
				this.host.separator ?? (() => 1),
			);
		}
		return this.#index.read();
	}

	/**
	 * The fullscreen session frame (before layers): the transcript window over the dock pinned to the
	 * bottom row. The window follows the tail, or starts at {@link #anchor} (clamped to the
	 * transcript; one that reaches the tail follows it again) with a row counting what is below it.
	 */
	paint(
		screenWidth: number,
		height: number,
		hits: { hit: Hit; top: number; left: number }[],
		wheel: boolean,
	): { rows: string[]; cursor: Cell | null } {
		let cursor: Cell | null = null;
		const search = this.#search;
		const dock: { block: Block; top: number }[] = [];
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
			dock.push({ block, top: dockRows - skip });
			dockRows += block.rows.length - skip;
		}
		const room = Math.max(0, height - dockRows);
		const main = this.#surface.main();
		const lane = screenWidth > 1 && (this.host.scrollbar?.() ?? true);
		const width = lane ? screenWidth - 1 : screenWidth;
		const doc = this.#document(width);
		const size = (i: number): number => doc.entry(main[i]!)?.size ?? 0;

		if (search) {
			this.#anchor = search.reveal(main, i => this.#paint(main[i]!, width).rows, size, this.#anchor, room);
		}

		const maxTop = Math.max(0, doc.rows - room);
		const anchored = this.#anchor && doc.entry(this.#anchor.node);
		const offset =
			room && anchored ? Math.min(maxTop, anchored.top + Math.min(this.#anchor!.row, anchored.size - 1)) : maxTop;
		const first = doc.at(offset);
		const index = first?.index ?? main.length;
		const skip = first ? offset - first.top : 0;
		const below = offset < maxTop ? maxTop - offset + 1 : 0; // The indicator replaces the last content row.
		this.#anchor = below && first ? { node: first.node, row: skip } : undefined;

		// The window: entry rows from the top down, the indicator taking its last row while anchored.
		const indicator = below > 0 && !lane && room > 1;
		const content = indicator ? room - 1 : room;
		const window: string[] = [];
		for (let i = index; i < main.length && window.length < content; i++) {
			const rows = size(i);
			if (rows === 0) continue;
			const node = main[i]!;
			const block = this.#paint(node, width);
			const lead = rows - block.rows.length;
			// Window row of the block's first row (negative: cut above the window).
			const top = window.length + lead - (i === index ? skip : 0);
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
		};

		this.#sessionPointer().update(
			{
				doc,
				top: offset,
				rows: room,
				content: Math.min(content, doc.rows - offset),
				width,
				scrollbar: lane && room > 0 && doc.rows > room,
			},
			window,
			this.host.theme(),
		);
		const rows = window;
		if (search) {
			const bar = search.bar(screenWidth, room);
			rows.push(bar.text);
			return { rows, cursor: { row: room, col: bar.col } };
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
		return { rows, cursor };
	}
}
