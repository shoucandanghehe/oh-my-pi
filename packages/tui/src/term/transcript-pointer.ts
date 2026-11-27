/** Mouse gestures owned by the fullscreen transcript, never by the inline or native renderers. */
import type { MouseEvent } from "../driver/contract";
import { withImageGutter } from "../driver/images/viewport";
import { coveredCells } from "../driver/output/ansi";
import type { UiNode } from "../node";
import type { Theme } from "../theme/contract";
import type { SelectionMotion } from "./backend";
import type { Block } from "./paint";
import {
	plainTranscriptText,
	reflowCell,
	selectedText,
	styleTranscriptCells,
	transcriptLine,
} from "./transcript-cells";
import type { TranscriptDocument } from "./transcript-document";
import { TranscriptWheel } from "./transcript-wheel";

type SelectionDocument = Pick<TranscriptDocument, "entry" | "at" | "line" | "rows">;

interface SelectionView {
	nodes(): readonly UiNode[];
	block(node: UiNode): Block;
	readonly doc: SelectionDocument;
	readonly top: number;
	readonly width: number;
	readonly screenTop: number;
	/** Actual visible document rows, excluding padding, indicator and dock. */
	readonly content: number;
}

interface PointerWindow extends SelectionView {
	readonly rows: number;
	dock(): SelectionView;
	readonly scrollbar: boolean;
}

interface PointerHost {
	available(): boolean;
	document(): TranscriptDocument;
	scroll(delta: number): void;
	scrollTo(offset: number): void;
	now(): number;
	requestRender(): void;
	wheelLines(): number;
	copyOnSelect(): boolean;
	copy?: (text: string) => void;
}

/** A span on a painted block row, independent of the window and of any nodes inserted above it. */
interface Span {
	node: UiNode;
	row: number;
	block: Block;
	text: string;
	start: number;
	end: number;
}

type Unit = "cell" | "word" | "row";
interface Pointer {
	row: number;
	col: number;
}
let words: Intl.Segmenter | undefined;
// pi follows iTerm's path-like word joiners. Keep Intl word boundaries between adjacent scripts.
const JOINERS = "/-+\\~_.";

function wordAt(text: string, offset: number): [number, number] {
	let start = 0;
	let end = 0;
	let previousWord = false;
	let previousJoiner = false;
	words ??= new Intl.Segmenter(undefined, { granularity: "word" });
	for (const part of words.segment(text)) {
		const joiner = part.segment.length === 1 && JOINERS.includes(part.segment);
		const word = !!part.isWordLike || joiner;
		if (!(previousWord && word && (previousJoiner || joiner))) {
			if (end > offset) break;
			start = part.index;
		}
		end = part.index + part.segment.length;
		previousWord = word;
		previousJoiner = joiner;
	}
	return [start, end];
}

function spanAt(view: SelectionView, pointer: Pointer, unit: Unit): Span | undefined {
	if (view.content === 0) return undefined;
	const row = view.top + Math.max(0, Math.min(view.content - 1, pointer.row - view.screenTop));
	const entry = view.doc.at(row);
	if (!entry) return undefined;
	const { text, cells } = transcriptLine(view.doc.line(row));
	const last = cells.at(-1);
	const width = last ? last.col + last.width : 0;
	const col = Math.max(0, Math.min(view.width - 1, pointer.col));
	const hit = cells.find(cell => cell.col + cell.width > col);
	let start = hit?.col ?? width;
	let end = hit ? start + hit.width : width;
	if (unit === "row") {
		start = 0;
		end = width;
	} else if (unit === "word" && hit) {
		const [first, after] = wordAt(text, hit.start);
		const left = cells.find(cell => cell.end > first);
		const right = cells.findLast(cell => cell.start < after);
		if (left && right) {
			start = left.col;
			end = right.col + right.width;
		}
	}
	return { node: entry.node, row: row - entry.top - entry.lead, block: view.block(entry.node), text, start, end };
}

function sameSpan(a: Span, b: Span): boolean {
	return a.node === b.node && a.row === b.row && a.start === b.start && a.end === b.end && a.text === b.text;
}

function spanOrder(left: Span, leftIndex: number, right: Span, rightIndex: number): number {
	return leftIndex - rightIndex || left.row - right.row || left.start - right.start;
}

/** Document row of an endpoint. Never copy unrelated text after a block is removed or reflowed. */
function resolve(doc: SelectionDocument, span: Span, view: SelectionView) {
	const entry = doc.entry(span.node);
	if (!entry || span.row < -entry.lead) return undefined;
	const raw = span.row < 0 ? "" : view.block(span.node).rows[span.row];
	if (raw === undefined) return;
	const text = plainTranscriptText(raw);
	if (text.startsWith(span.text)) return entry;
	// A stream may replace the padding after a selected prefix with more text.
	const tail = transcriptLine(span.block.rows[span.row] ?? "").cells.findLast(cell => cell.col < span.end);
	if (tail && text.startsWith(span.text.trimEnd()) && text.startsWith(span.text.slice(0, tail.end))) return entry;
}

interface Bounds {
	first: number;
	left: Span;
	last: number;
	right: Span;
}

function thumb(view: PointerWindow): { start: number; size: number; travel: number; max: number } {
	const max = view.doc.rows - view.rows;
	// Four vertical dot pairs per cell. Keep at least one full cell to grab.
	const size = 4 * Math.max(1, Math.min(view.rows - 1, Math.round((view.rows * view.rows) / view.doc.rows)));
	const travel = 4 * view.rows - size;
	return { start: Math.round((view.top / max) * travel), size, travel, max };
}

const inverse = (text: string): string => `\x1b[7m${text}\x1b[27m`;

export class TranscriptPointer {
	readonly #wheel = new TranscriptWheel();
	#view?: PointerWindow;
	#inDock = false;
	#tailHover = false;
	#origin?: Span;
	#focus?: Span;
	#unit: Unit = "cell";
	#active = false;
	#press?: Pointer;
	#lastClick?: { word: Span; time: number; count: number };
	#grab?: number;
	#thumbRow = 0;
	#preferredColumn: number | undefined;
	#edge?: Pointer;
	#timer?: Timer;

	constructor(readonly host: PointerHost) {}

	get holdingTranscript(): boolean {
		return !!this.#press && !this.#inDock;
	}

	#selectionView(view = this.#view!): SelectionView {
		return this.#inDock ? view.dock() : view;
	}

	leave(): void {
		if (!this.#tailHover) return;
		this.#tailHover = false;
		this.host.requestRender();
	}

	update(view: PointerWindow, rows: string[], theme: Theme): void {
		const previous = this.#view;
		if (previous && previous.width !== view.width && this.#origin && this.#focus) {
			const next = this.#selectionView(view);
			const origin = this.#origin;
			const focus = this.#focus;
			const a = next.doc.entry(origin.node);
			const b = next.doc.entry(focus.node);
			const reverse = a && b && spanOrder(origin, a.index, focus, b.index) > 0;
			const move = (span: Span, end: boolean): Span | undefined => {
				if (!next.doc.entry(span.node)) return;
				const block = next.block(span.node);
				const point = reflowCell(span.block, block, { row: span.row, col: end ? span.end : span.start }, end);
				if (point)
					return {
						node: span.node,
						block,
						row: point.row,
						text: plainTranscriptText(block.rows[point.row] ?? ""),
						start: point.col,
						end: point.col,
					};
			};
			this.#origin = move(origin, !!reverse);
			this.#focus = move(focus, !reverse);
			if (!this.#origin || !this.#focus) this.reset();
			this.#lastClick = undefined;
		}
		this.#view = view;
		if (!view.scrollbar) this.#grab = undefined;
		if (!view.scrollbar || view.top >= view.doc.rows - view.rows) this.#tailHover = false;
		if (this.#edge && previous?.top !== view.top) this.#extend(this.#edge);
		const selection = this.#selectionView(view);
		const bounds = this.#bounds(selection, selection.doc);
		if (bounds) {
			for (
				let row = Math.max(bounds.first, selection.top);
				row <= Math.min(bounds.last, selection.top + selection.content - 1);
				row++
			) {
				const y = row - selection.top + selection.screenTop;
				const entry = selection.doc.at(row)!;
				const fact = selection.block(entry.node).textRows?.[row - entry.top - entry.lead];
				rows[y] = styleTranscriptCells(
					rows[y]!,
					Math.max(row === bounds.first ? bounds.left.start : 0, fact?.start ?? 0),
					Math.min(row === bounds.last ? bounds.right.end : selection.width, fact?.end ?? Infinity),
					inverse,
				);
			}
		}
		if (!view.scrollbar) return;
		const { start, size } = thumb(view);
		const track = theme.fg("dim", "│");
		const dots = [0x09, 0x12, 0x24, 0xc0];
		for (let y = 0; y < view.rows; y++) {
			// Padding a continuation row would overwrite cells occupied by the scaled heading above.
			if (coveredCells(rows, y) > 0) continue;
			let mask = 0;
			for (let dot = 0; dot < 4; dot++) {
				const at = y * 4 + dot;
				if (at >= start && at < start + size) mask |= dots[dot]!;
			}
			const control =
				y === view.rows - 1 && view.top < view.doc.rows - view.rows
					? theme.fg("accent", this.#tailHover ? inverse("▽") : "▽")
					: mask
						? theme.fg(this.#grab === undefined ? "muted" : "accent", String.fromCodePoint(0x2800 + mask))
						: track;
			rows[y] = withImageGutter(rows[y]!, view.width, control);
		}
	}

	reset(): void {
		this.#stopEdge();
		this.#wheel.reset();
		this.#origin = this.#focus = this.#press = this.#grab = this.#lastClick = undefined;
		this.#inDock = false;
		this.#tailHover = false;
		this.#active = false;
		this.#preferredColumn = undefined;
	}

	/** Losing focus or mouse reporting cannot leave a drag waiting for a release that will never come. */
	blur(): boolean {
		const changed = (!!this.#press && this.#active) || this.#grab !== undefined || this.#tailHover;
		this.#tailHover = false;
		if (this.#press || this.#grab !== undefined) this.reset();
		this.#lastClick = undefined;
		this.#wheel.reset();
		return changed;
	}

	#bounds(view: SelectionView, doc: SelectionDocument): Bounds | undefined {
		const origin = this.#origin;
		const focus = this.#focus;
		if (!origin || !focus) return;
		const a = resolve(doc, origin, view);
		const b = resolve(doc, focus, view);
		if (!a || !b) {
			this.reset();
			return undefined;
		}
		if (!this.#active) return undefined;
		const left = spanOrder(origin, a.index, focus, b.index) <= 0;
		const first = a.top + a.lead + origin.row;
		const last = b.top + b.lead + focus.row;
		return left
			? { first, left: origin, last, right: focus }
			: { first: last, left: focus, last: first, right: origin };
	}

	copy(): boolean {
		if (!this.#active || !this.host.copy || !this.host.available()) return false;
		const view = this.#selectionView();
		const transcript = this.#inDock ? undefined : this.host.document();
		const doc = transcript ?? view.doc;
		const bounds = this.#bounds(view, doc);
		if (!bounds) return false;
		const chunks: string[] = [];
		const first = doc.entry(bounds.left.node)!;
		const last = doc.entry(bounds.right.node)!;
		const nodes = view.nodes();
		for (let i = first.index; i <= last.index; i++) {
			const node = nodes[i]!;
			// Skipped blocks still have estimated separators until their real heights are known.
			const block = transcript?.pending ? transcript.measure(i) : view.block(node);
			const entry = doc.entry(node);
			if (!entry || !block.rows.length) continue;
			const from = i === first.index ? bounds.left.row : -entry.lead;
			const to = i === last.index ? bounds.right.row : block.rows.length - 1;
			for (let r = from; r <= to; r++) {
				const fact = block.textRows?.[r];
				if (chunks.length) chunks.push(fact?.join ?? "\n");
				chunks.push(
					selectedText(
						block.rows[r] ?? "",
						fact,
						i === first.index && r === from ? bounds.left.start : 0,
						i === last.index && r === to ? bounds.right.end : Infinity,
					),
				);
			}
		}
		const text = chunks.join("");
		if (!text) return false;
		this.host.copy(text);
		return true;
	}

	/** Keyboard selection moves the active end, never the fixed anchor (even after crossing it). */
	adjust(motion: SelectionMotion): boolean {
		if (!this.#active || !this.host.available()) return false;
		const view = this.#selectionView();
		const doc = this.#inDock ? view.doc : this.host.document();
		const bounds = this.#bounds(view, doc);
		if (!bounds) return false;
		if (motion === "clear") {
			this.reset();
			return true;
		}
		this.#stopEdge();
		this.#press = this.#lastClick = undefined;
		const origin = this.#origin!;
		const focus = this.#focus!;
		const reversed = bounds.left !== origin;
		const a = reversed ? bounds.last : bounds.first;
		let row = reversed ? bounds.first : bounds.last;
		const anchor = reversed ? origin.end : origin.start;
		let caret = reversed ? focus.start : focus.end;
		let line = transcriptLine(doc.line(row));
		const tail = line.cells.at(-1);
		const end = tail ? tail.col + tail.width : 0;
		if (motion === "up" || motion === "down") {
			this.#preferredColumn ??= caret;
			const next = Math.min(doc.rows - 1, Math.max(0, row + (motion === "up" ? -1 : 1)));
			if (next === row) return true;
			row = next;
			line = transcriptLine(doc.line(row));
			const last = line.cells.at(-1);
			const target = line.cells.find(cell => cell.col + cell.width > this.#preferredColumn!);
			caret = target?.col ?? (last ? last.col + last.width : 0);
		} else {
			this.#preferredColumn = undefined;
			if (motion === "line-start") caret = 0;
			else if (motion === "line-end") caret = end;
			else if (motion === "left") {
				if (caret > 0) caret = line.cells.findLast(cell => cell.col < caret)?.col ?? 0;
				else if (row > 0) {
					line = transcriptLine(doc.line(--row));
					const last = line.cells.at(-1);
					caret = last ? last.col + last.width : 0;
				}
			} else if (caret < end) {
				const next = line.cells.find(cell => cell.col + cell.width > caret)!;
				caret = next.col + next.width;
			} else if (row + 1 < doc.rows) {
				line = transcriptLine(doc.line(++row));
				caret = 0;
			}
		}
		this.#origin = { ...origin, start: anchor, end: anchor };
		const entry = doc.at(row)!;
		this.#focus = {
			node: entry.node,
			block: view.block(entry.node),
			row: row - entry.top - entry.lead,
			text: line.text,
			start: caret,
			end: caret,
		};
		this.#active = row !== a || anchor !== caret;
		if (this.#inDock) return true;
		if (row < view.top) this.host.scrollTo(row);
		else if (row >= view.top + view.content)
			this.host.scrollTo(Math.min(doc.rows - this.#view!.rows, Math.max(0, row - this.#view!.rows + 2)));
		return true;
	}

	#extend(pointer: Pointer): void {
		if (!this.#view || !this.#press) return;
		const target = spanAt(this.#selectionView(), pointer, this.#unit);
		if (!target) return;
		this.#focus = target;
		this.#active = this.#unit !== "cell" || !sameSpan(this.#origin!, target) || pointer.col !== this.#press.col;
	}

	#stopEdge(): void {
		clearInterval(this.#timer);
		this.#timer = this.#edge = undefined;
	}

	#autoScroll(pointer: Pointer): void {
		const view = this.#view!;
		if (!view.content || (pointer.row > 0 && pointer.row < view.content - 1)) {
			this.#stopEdge();
			return;
		}
		this.#edge = pointer;
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			const current = this.#view;
			if (!this.host.available() || !current || !this.#edge) {
				this.blur();
				return;
			}
			const next = current.top + (this.#edge.row <= 0 ? -1 : 1);
			if (next < 0 || next > current.doc.rows - current.rows) this.#stopEdge();
			else this.host.scrollTo(next);
		}, 50);
		this.#timer.unref();
	}

	#scrollThumb(row: number): void {
		const { travel, max } = thumb(this.#view!);
		if (travel > 0)
			this.host.scrollTo(Math.round((Math.min(travel, Math.max(0, 4 * row - this.#grab!)) * max) / travel));
	}

	/** Continue the existing press before hit-testing the current pointer location. */
	capture(mouse: MouseEvent & { readonly rowFraction?: number }, row: number): boolean {
		const view = this.#view;
		const hover =
			!!view?.scrollbar && view.top < view.doc.rows - view.rows && row === view.rows - 1 && mouse.col === view.width;
		if (this.#tailHover !== hover) {
			this.#tailHover = hover;
			this.host.requestRender();
		}
		const y = row + (mouse.rowFraction ?? 0);
		if (!this.#view || (!this.#press && this.#grab === undefined)) return false;
		if (mouse.action === "press" && !mouse.button.startsWith("wheel-")) {
			if (mouse.button === "right" && this.#active) {
				this.#stopEdge();
				this.#press = undefined;
				return false; // Let the pane copy the held range before clearing it.
			}
			this.reset(); // A new press without a release supersedes the previous gesture.
			return false;
		}
		if ((mouse.button !== "left" && mouse.button !== "none") || mouse.action === "press") return false;
		if (mouse.action === "move" && mouse.button === "none") {
			this.blur(); // All-motion report after a lost release.
			return false;
		}
		if (this.#grab !== undefined) {
			if (y !== this.#thumbRow) {
				this.#thumbRow = y;
				this.#scrollThumb(y);
			}
			if (mouse.action === "release") this.#grab = undefined;
			return true;
		}
		const pointer = { row, col: mouse.col };
		this.#extend(pointer);
		if (mouse.action === "release") {
			this.#stopEdge();
			this.#press = undefined;
			if (this.host.copyOnSelect()) this.copy();
		} else {
			this.#lastClick = undefined;
			if (!this.#inDock) this.#autoScroll(pointer);
		}
		return true;
	}

	/** A report not consumed by a widget or layer. Only unmodified left presses start a drag. */
	input(mouse: MouseEvent & { readonly rowFraction?: number }, row: number): void {
		const view = this.#view;
		if (!view || mouse.action !== "press") return;
		if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
			const direction = mouse.button === "wheel-up" ? -1 : 1;
			const lines = this.#wheel.lines(direction, this.host.now(), this.host.wheelLines());
			this.host.scroll(direction * lines * (mouse.mods.includes("alt") ? 5 : 1));
			return;
		}
		if (mouse.button !== "left" || mouse.mods.length) return;
		if (view.scrollbar && mouse.col === view.width && row >= 0 && row < view.rows) {
			this.reset();
			if (row === view.rows - 1 && view.top < view.doc.rows - view.rows) {
				this.host.scrollTo(view.doc.rows - view.rows);
				return;
			}
			const { start, size } = thumb(view);
			const y = row + (mouse.rowFraction ?? 0);
			const grabbed = row * 4 < start + size && (row + 1) * 4 > start;
			this.#grab = grabbed ? y * 4 - start : Math.floor(size / 8) * 4;
			this.#thumbRow = y;
			if (!grabbed) this.#scrollThumb(y);
			return;
		}
		// The indicator is an explicit jump to the live tail, not selectable transcript text.
		if (!view.scrollbar && view.rows > 1 && view.top + view.rows < view.doc.rows && row === view.rows - 1) {
			this.reset();
			this.host.scrollTo(view.doc.rows - view.rows);
			return;
		}
		this.#inDock = row >= view.rows;
		const source = this.#selectionView();
		if (
			row < source.screenTop ||
			row >= source.screenTop + source.content ||
			mouse.col < 0 ||
			mouse.col >= source.width
		) {
			this.reset();
			return;
		}
		this.#preferredColumn = undefined;
		const pointer = { row, col: mouse.col };
		const word = spanAt(source, pointer, "word");
		if (!word) return;
		const previous = this.#lastClick;
		const time = this.host.now();
		const count =
			previous && time - previous.time <= 500 && sameSpan(previous.word, word) ? (previous.count % 3) + 1 : 1;
		this.#lastClick = { word, time, count };
		this.#unit = count === 2 ? "word" : count === 3 ? "row" : "cell";
		this.#origin = this.#focus = this.#unit === "word" ? word : spanAt(source, pointer, this.#unit);
		this.#press = pointer;
		this.#active = count > 1;
	}
}
