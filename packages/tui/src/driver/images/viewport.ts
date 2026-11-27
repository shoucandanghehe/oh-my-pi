/** Graphics which are not text cells need explicit clipping/damage in an alternate-screen viewport. */
import { escapeLength, SgrState, sgrParams, stripEscapes, tokens } from "../../text/ansi";
import { padTo, visibleWidth } from "../../text/width";
import { wrapTmuxPassthrough } from "../mux/tmux";
import { column } from "../output/ansi";
import { KITTY_PLACEHOLDER, kittyDeletePlacement } from "./kitty";
import { type SixelBands, sixelBands, sliceSixel } from "./sixel-window";

const ANCHOR = /\x1b7\x1b\[(\d+)A/;
const ANCHORS = new RegExp(ANCHOR.source, "g");
const TMUX = "\x1bPtmux;";
const ST = "\x1b\\";
const DIRECT_KITTY = /\x1b_Ga=p,q=2,C=1,i=(\d+),p=(\d+),/g;
const IMAGE = /\x1b(?:_Ga=[pT],|\]1337;File=|P(?:[\d;]*q|tmux;\x1b\x1b(?:_G|\]|P[\d;]*q)|\x1b(?:_G|\]1337;)))/g;

const DRAW_POSITION = /(?:\x1b\[(\d+)G)?(?:\x1b7\x1b\[(\d+)A)?$/;

interface Anchored {
	readonly row: number;
	readonly first: number;
	readonly prefix: string;
	readonly suffix: string;
	readonly sequence: string;
	/** The native encoder's band index is built lazily, the first time a viewport cuts this image. */
	bands?: SixelBands | null;
	crop?: { top: number; room: number; sequence: string };
}

// Row arrays belong to immutable paint blocks. An anchored tail of a huge, cached block is indexed
// only on its first partial paint; scrolling the same block doesn't scan the offscreen text again.
const kAnchors = Symbol("pi-tui.viewport-image-anchors");
interface ImageRows extends ReadonlyArray<string> {
	[kAnchors]?: Anchored[];
}
function anchors(rows: ImageRows): readonly Anchored[] {
	if (rows[kAnchors]) return rows[kAnchors];
	const result: Anchored[] = [];
	for (let i = 0; i < rows.length; ++i) {
		const row = rows[i]!;
		const anchor = ANCHOR.exec(row);
		if (!anchor) continue;
		const end = row.indexOf("\x1b8", anchor.index + anchor[0].length);
		if (end < 0) continue;
		result.push({
			row: i,
			first: i - Number(anchor[1]),
			prefix: row.slice(0, anchor.index),
			sequence: row.slice(anchor.index + anchor[0].length, end),
			suffix: row.slice(end + 2),
		});
	}
	if (Object.isExtensible(rows)) rows[kAnchors] = result;
	return result;
}

function crop(anchor: Anchored, top: number, room: number): string {
	const hit = anchor.crop;
	if (hit && hit.top === top && hit.room === room) return hit.sequence;
	const wrapped = anchor.sequence.startsWith(TMUX);
	if (anchor.bands === undefined) {
		const raw = unwrapSixel(anchor.sequence);
		anchor.bands = sixelBands(raw) ?? null;
	}
	if (!anchor.bands) return "";
	let sequence = sliceSixel(anchor.bands, top, Math.min(room, anchor.bands.height - top));
	if (sequence && wrapped) sequence = wrapTmuxPassthrough(sequence);
	anchor.crop = { top, room, sequence };
	return sequence;
}

/** Repair the portion of an immutable block at [from,to) already copied to `frame`, starting at `dest`. */
export function clipViewportImages(
	frame: string[],
	dest: number,
	rows: readonly string[],
	from: number,
	to: number,
	cellHeight: number,
): void {
	if (to <= from || (from === 0 && to === rows.length)) return;
	for (const a of anchors(rows)) {
		if (a.first >= to) break;
		if (a.row < from || (a.first >= from && a.row < to)) continue;
		const start = Math.max(a.first, from);
		const last = Math.min(a.row, to - 1);
		const blank = a.prefix + a.suffix;
		if (a.row < to) frame[dest + a.row - from] = blank;
		const height = last - start + 1;
		const sequence = crop(a, (start - a.first) * cellHeight, height * cellHeight);
		if (!sequence) continue; // iTerm's inline File has no source rectangle. Keep its reserved rows.
		const target = dest + last - from;
		if (stripEscapes(frame[target]!) !== stripEscapes(blank)) continue; // Never replace another row's chrome.
		frame[target] = a.prefix + (height === 1 ? sequence : `\x1b7\x1b[${height - 1}A${sequence}\x1b8`) + a.suffix;
	}
}

/** Remap every direct Kitty band on this row, preserving its passthrough envelope. */
export function alternatePlacements(row: string, y: number, visible: Set<number>, deletions: Set<string>): string {
	if (row.includes(KITTY_PLACEHOLDER)) {
		const style = new SgrState();
		for (const token of tokens(row)) {
			if (token.escape) {
				const params = sgrParams(token.text);
				if (params !== undefined) style.apply(params);
			} else if (token.text.includes(KITTY_PLACEHOLDER)) {
				const rgb = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(style.foreground ?? "");
				if (rgb) visible.add((Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3]));
			}
		}
	}
	let index = 0;
	return row.replace(DIRECT_KITTY, (match, id: string, old: string, at: number) => {
		// Keep the upstream id for the first band on each row. Subsequent bands get a
		// separate 16-bit row range, all outside the 24-bit range for virtual placements.
		const placement = 0x100_0000 + y + index++ * 0x1_0000;
		const mux =
			row.slice(at - TMUX.length - 1, at) === `${TMUX}\x1b`
				? "tmux"
				: row.slice(at - 2, at) === "\x1bP"
					? "screen"
					: null;
		const image = Number(id);
		visible.add(image);
		deletions.add(kittyDeletePlacement(image, placement, mux));
		return `${match.slice(0, -old.length - 1)}${placement},`;
	});
}

/** Dirty cells which row-string equality misses: an iTerm/SIXEL anchor draws into the rows above it. */
export function rasterDamage(previous: readonly string[], next: readonly string[]): Uint8Array | undefined {
	let damage: Uint8Array | undefined;
	for (let y = 0; y < next.length; y++) {
		if (previous[y] === next[y]) continue;
		let first = y;
		for (const match of (previous[y] ?? "").matchAll(ANCHORS)) first = Math.min(first, y - Number(match[1]));
		(damage ??= new Uint8Array(next.length)).fill(1, Math.max(0, first), y + 1);
	}
	if (!damage) return undefined;
	for (let y = 0; y < next.length; y++) {
		if (damage[y]) continue;
		for (const match of next[y]!.matchAll(ANCHORS)) {
			if (damage.subarray(Math.max(0, y - Number(match[1])), y).includes(1)) {
				damage[y] = 1;
				break;
			}
		}
	}
	return damage;
}

interface Drawing {
	readonly bytes: string;
	readonly sequence: string;
	readonly x: number;
	readonly above: number;
}

/** Separate cursor-addressed drawings from text so pane padding cannot erase or displace them. */
export function splitImageRow(row: string): { text: string; images: Drawing[] } | undefined {
	if (!row.includes("\x1b")) return;
	let text = "";
	let end = 0;
	const images: Drawing[] = [];
	for (const draw of row.matchAll(IMAGE)) {
		const at = draw.index;
		if (at < end) continue;
		const prefix = row.slice(end, at);
		const anchor = DRAW_POSITION.exec(prefix)!;
		const screen = row.startsWith("\x1bP\x1b", at);
		let last = at + escapeLength(row, at);
		if (screen) {
			// Screen leaves the nested control literal and can wrap a large OSC in several DCS chunks.
			const close = (at: number): number => {
				const st = row.indexOf(ST, at + 2);
				return st < 0 ? 0 : st + ST.length;
			};
			last = close(at);
			if (row.startsWith("\x1bP\x1b_G", at) && row.startsWith(ST, last)) last += ST.length;
			else
				while (last > at && !row.slice(at, last).includes("\x07") && row.startsWith("\x1bP", last)) {
					const chunk = close(last);
					if (!chunk) break;
					last = chunk;
				}
		}
		if (last <= at) continue;
		text += prefix.slice(0, anchor.index);
		const above = Number(anchor[2] ?? 0);
		const sequence = row.slice(at, last);
		const anchored = anchor[2] !== undefined && row.startsWith("\x1b8", last);
		images.push({
			bytes: anchored ? `\x1b7\x1b[${above}A${sequence}\x1b8` : sequence,
			sequence,
			x: anchor[1] === undefined ? visibleWidth(text) : Number(anchor[1]) - 1,
			above: anchored ? above : 0,
		});
		end = anchored ? last + 2 : last;
	}
	if (images.length > 0) return { text: text + row.slice(end), images };
}

function unwrapSixel(sequence: string): string {
	return sequence.startsWith(TMUX) ? sequence.slice(TMUX.length, -ST.length).replaceAll("\x1b\x1b", "\x1b") : sequence;
}

/** A pane's remaining source rectangle, measured from the raster's own top-left cell. */
export function paneImage(image: Drawing, columns: number, cellWidth: number, cellHeight: number): string {
	if (columns <= 0) return "";
	const width = columns * cellWidth;
	const sixel = /^(?:\x1bPtmux;\x1b)?\x1bP[\d;]*q(?:"1;1;(\d+);(\d+))?/.exec(image.sequence);
	if (!sixel) {
		const cells = /(?:,c=|;width=)(\d+)/.exec(image.sequence);
		if (cells && Number(cells[1]) > columns) return "";
		// An unanchored iTerm File can move the cursor away from the other drawings on this line.
		return !image.above && image.sequence.includes("\x1b]1337;File=") ? `\x1b7${image.bytes}\x1b8` : image.bytes;
	}
	const room = (image.above + 1) * cellHeight;
	if (sixel[1] === undefined || sixel[2] === undefined) return "";
	if (Number(sixel[1]) <= width && Math.ceil(Number(sixel[2]) / 6) * 6 <= room) {
		return image.above ? image.bytes : `\x1b7${image.bytes}\x1b8`;
	}
	const bands = sixelBands(unwrapSixel(image.sequence));
	if (!bands) return "";
	let sliced = sliceSixel(bands, 0, room, Math.min(bands.width, width));
	if (!sliced) return "";
	if (image.sequence.startsWith(TMUX)) sliced = wrapTmuxPassthrough(sliced);
	return `\x1b7${image.above ? `\x1b[${image.above}A` : ""}${sliced}\x1b8`;
}

/** Add the scrollbar to a row without padding over the picture's pixels after drawing it. */
export function withImageGutter(row: string, width: number, mark: string): string {
	const split = splitImageRow(row);
	if (!split) return padTo(row, width) + mark;
	return padTo(split.text, width) + mark + split.images.map(image => column(image.x) + image.bytes).join("");
}

/**
 * Remove graphics under a sheet before text composition: slicing a control string as text can leak
 * its payload, or leave a last-row anchor drawing upward through the sheet. A placement next to (not
 * under) it is drawn after the text at its original column so trailing padding cannot erase it.
 */
export function maskOverlayImages(
	rows: string[],
	top: number,
	height: number,
	left: number,
	width: number,
	cellWidth: number,
	shift = 0,
): (() => void) | undefined {
	if (height <= 0) return;
	let kept: { row: number; bytes: string }[] | undefined;
	for (let y = top; y < rows.length; ++y) {
		const split = splitImageRow(rows[y]!);
		if (!split) continue;
		let touched = y < top + height;
		let bytes = "";
		for (const image of split.images) {
			const cells = /(?:,c=|;width=)(\d+)/.exec(image.sequence);
			const raster = cells ? null : /q"1;1;(\d+);/.exec(image.sequence);
			const w = cells ? Number(cells[1]) : raster ? Math.ceil(Number(raster[1]) / cellWidth) : Infinity;
			const covered = y - image.above < top + height && left < image.x + w && image.x < left + width;
			if (covered) touched = true;
			else bytes += column(image.x + shift) + image.bytes;
		}
		if (!touched) continue;
		rows[y] = split.text;
		if (bytes) (kept ??= []).push({ row: y, bytes });
	}
	if (kept)
		return () => {
			for (const image of kept) rows[image.row] += image.bytes;
		};
	return undefined;
}
