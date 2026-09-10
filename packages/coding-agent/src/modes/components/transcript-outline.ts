/**
 * Shared engine for the ephemeral fullscreen transcript selectors (esc-esc
 * rewind, `/copy`): replay session entries through {@link ChatTranscriptBuilder},
 * map each rendered turn to a selectable target, and compose gutter-prefixed
 * columns with a dotted outline around the selected target.
 */
import type {
	Component,
	VirtualViewportFrame,
	VirtualViewportProvider,
	VirtualViewportRequest,
} from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { SessionMessageEntry } from "../../session/session-entries";
import { type ThemeColor, theme } from "../theme/theme";
import type { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { fit } from "./overlay-box";
import type { TranscriptContainer } from "./transcript-container";
import { isUsageRowBlock } from "./usage-row";

/** One selectable transcript item: a message entry plus its rendered block range. */
export interface OutlineTarget {
	/** Entry the selection resolves to; extended over trailing componentless tool results. */
	entryId: string;
	/** Entry that opened this turn (pre-fold) — anchor for tree lookups. */
	turnId: string;
	/** Real user prompt — drives user-turn jumps and role-specific actions. */
	isUserTurn: boolean;
	/** First transcript-container child rendered by this entry. */
	start: number;
	/** One past the last child rendered by this entry. */
	end: number;
	/** Entries this target spans: the turn plus any folded tool results. */
	entries: SessionMessageEntry[];
}

/** Composed rows of one column plus the outline's line range within them. */
export interface ComposedColumn {
	lines: string[];
	selStart: number;
	selEnd: number;
}
/** Presentation of the dotted outline: stroke color and an optional caption inset into the top rule. */
export interface OutlineStyle {
	color?: ThemeColor;
	/** Short affordance label (e.g. "3 blocks →") drawn into the top rule's right end. */
	caption?: string;
}

// User bubbles wrap their rows in OSC 133 prompt-zone marks (see
// user-message.ts). Re-emitting those inside the alternate-screen overlay
// latches the terminal's prompt semantics onto overlay rows and garbles the
// frame, so embedded rows shed them; the transcript proper keeps its zones.
const OSC133_SPAN_REGEX = /\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Copy-on-write removal of OSC 133 spans from a rendered row array. */
export function stripPromptZones(rows: readonly string[]): readonly string[] {
	let sanitized: string[] | undefined;
	for (let index = 0; index < rows.length; index++) {
		if (!rows[index]!.includes("\x1b]133;")) continue;
		sanitized ??= rows.slice();
		sanitized[index] = rows[index]!.replace(OSC133_SPAN_REGEX, "");
	}
	return sanitized ?? rows;
}

/**
 * Prompt-zone-stripped rows for one selector column.
 *
 * The selectors recompose their whole column on every keystroke, and stripping
 * every child's rows again per frame is pure waste on a long session. Per the
 * {@link Component} render contract a child returns the same array while its
 * rows are unchanged, so the stripped copy is keyed on that array: a child that
 * repaints itself asynchronously (Kitty image conversion, todo strike frames)
 * hands back a new array and is stripped again.
 */
export class OutlineRowCache {
	#stripped = new WeakMap<Component, { rows: readonly string[]; stripped: readonly string[] }>();

	rows(children: readonly Component[], width: number): Array<readonly string[]> {
		const columns: Array<readonly string[]> = [];
		for (const child of children) {
			const rows = child.render(width);
			const cached = this.#stripped.get(child);
			if (cached && cached.rows === rows) {
				columns.push(cached.stripped);
				continue;
			}
			const stripped = stripPromptZones(rows);
			this.#stripped.set(child, { rows, stripped });
			columns.push(stripped);
		}
		return columns;
	}
}

/**
 * Append `entries` to `builder`, returning the selectable targets they
 * produce. Tool results fold into the previous target (so a turn's rewind
 * and `/copy` keep its output, including lazily created children such as
 * the grouped-read card); notices and hidden messages that render nothing
 * are skipped. Usage rows flushed at the head of an append are attributed
 * to the turn above.
 */
export function appendOutlineEntries(builder: ChatTranscriptBuilder, entries: SessionMessageEntry[]): OutlineTarget[] {
	const targets: OutlineTarget[] = [];
	for (const entry of entries) {
		const children = builder.container.children;
		const before = children.length;
		builder.appendEntries([entry]);
		const after = children.length;
		let start = before;
		while (start < after && isUsageRowBlock(children[start]!)) {
			const previous = targets.at(-1);
			if (previous && previous.end === start) previous.end = start + 1;
			start++;
		}
		const previous = targets.at(-1);
		if (entry.message.role === "toolResult" && previous) {
			previous.entryId = entry.id;
			previous.entries.push(entry);
			if (after > previous.end) previous.end = after;
			continue;
		}
		if (start >= after) continue;
		targets.push({
			entryId: entry.id,
			turnId: entry.id,
			isUserTurn: entry.message.role === "user" && userMessageHasText(entry.message),
			start,
			end: after,
			entries: [entry],
		});
	}
	return targets;
}

/** Per-target "renders at least one non-blank row" flags at the given rows. */
export function outlineVisibility(
	childRows: readonly (readonly string[])[],
	targets: readonly OutlineTarget[],
): boolean[] {
	return targets.map(target => {
		for (let index = target.start; index < target.end; index++) {
			if (childRows[index]!.some(row => /\S/.test(row))) return true;
		}
		return false;
	});
}

/** Dotted horizontal rule with rounded corners, spanning the outline width. */
export function outlineRule(
	left: string,
	right: string,
	innerWidth: number,
	color: ThemeColor = "accent",
	caption?: string,
): string {
	const label = caption ? ` ${caption} ` : "";
	const fill = Math.max(0, innerWidth + 2 - visibleWidth(label));
	return (
		theme.fg(color, left + theme.boxDotted.horizontal.repeat(fill)) +
		theme.bold(theme.fg(color, label)) +
		theme.fg(color, right)
	);
}

/** Wrap pre-rendered rows in the dotted outline (rules above/below, `┆` sides). */
export function outlineRows(rows: readonly string[], innerWidth: number, style: OutlineStyle = {}): string[] {
	const color = style.color ?? "accent";
	const vertical = theme.fg(color, theme.boxDotted.vertical);
	const lines: string[] = [
		outlineRule(theme.boxRound.topLeft, theme.boxRound.topRight, innerWidth, color, style.caption),
	];
	for (const row of rows) lines.push(`${vertical} ${fit(row, innerWidth)} ${vertical}`);
	lines.push(outlineRule(theme.boxRound.bottomLeft, theme.boxRound.bottomRight, innerWidth, color));
	return lines;
}

/**
 * Compose one column: gutter-prefixed rows for `childRows[from, to)` with a
 * dotted outline around `targets[selected]`. `header` rows, when given, lead
 * the column.
 */
export function composeOutlineColumn(
	childRows: readonly (readonly string[])[],
	from: number,
	to: number,
	targets: readonly OutlineTarget[],
	selected: number,
	columnWidth: number,
	header: string[] | undefined,
	style: OutlineStyle = {},
): ComposedColumn {
	const inner = Math.max(10, columnWidth - 4);
	const lines: string[] = header ? [...header] : [];
	let selStart = -1;
	let selEnd = -1;
	const target = selected >= 0 ? targets[selected] : undefined;
	for (let index = from; index < to; index++) {
		if (target && index === target.start && target.end <= to) {
			const segment: string[] = [];
			for (let child = target.start; child < target.end; child++) segment.push(...childRows[child]!);
			// Outline only the non-blank core; edge spacers stay outside.
			let head = 0;
			let tail = segment.length;
			while (head < tail && !/\S/.test(segment[head]!)) head++;
			while (tail > head && !/\S/.test(segment[tail - 1]!)) tail--;
			for (let row = 0; row < head; row++) lines.push("");
			selStart = lines.length;
			lines.push(...outlineRows(segment.slice(head, tail), inner, style));
			selEnd = lines.length;
			for (let row = tail; row < segment.length; row++) lines.push("");
			index = target.end - 1;
			continue;
		}
		for (const row of childRows[index]!) lines.push(row ? `  ${row}` : row);
	}
	return { lines, selStart, selEnd };
}

export interface ViewportOutlineColumn extends VirtualViewportProvider {
	readonly length: number;
	readonly selStart: number;
	readonly selEnd: number;
}

/** A column backed by the existing transcript viewport, not a full array of rendered history. */
export class VirtualOutlineColumn implements ViewportOutlineColumn {
	constructor(
		readonly container: TranscriptContainer,
		readonly from: number,
		readonly to: number,
		readonly target: OutlineTarget | undefined,
		readonly width: number,
		readonly header: readonly string[] = [],
	) {}

	get #inner(): number {
		return Math.max(10, this.width - 4);
	}

	get #range(): { start: number; end: number } {
		return this.container.getVirtualRowRange(this.#inner, this.from, this.to) ?? { start: 0, end: 0 };
	}

	get #selection(): { start: number; end: number } | undefined {
		const target = this.target;
		return target && target.start >= this.from && target.end <= this.to
			? this.container.getVirtualRowRange(this.#inner, target.start, target.end)
			: undefined;
	}

	get length(): number {
		const range = this.#range;
		return this.header.length + range.end - range.start + (this.#selection ? 2 : 0);
	}

	get selStart(): number {
		const selection = this.#selection;
		return selection ? this.header.length + selection.start - this.#range.start : -1;
	}

	get selEnd(): number {
		const selection = this.#selection;
		return selection ? this.header.length + selection.end - this.#range.start + 2 : -1;
	}

	hasVirtualViewport(): boolean {
		return true;
	}

	getEstimatedVirtualRows(): number {
		return this.length;
	}

	renderVirtualViewport(_width: number, request: VirtualViewportRequest): VirtualViewportFrame {
		let offset = request.offset;
		let lines: readonly string[] = [];
		for (let pass = 0; pass < 3; pass++) {
			const total = this.length;
			offset = request.followBottom
				? Math.max(0, total - request.rows)
				: Math.max(0, Math.min(offset, Math.max(0, total - request.rows)));
			lines = this.#slice(offset, offset + request.rows);
			if (total === this.length) break;
		}
		return { lines, offset, estimatedTotalRows: this.length };
	}

	#slice(from: number, to: number): string[] {
		const range = this.#range;
		const selection = this.#selection;
		const top = this.selStart;
		const bottom = this.selEnd - 1;
		const end = Math.min(to, this.length);
		const lines: string[] = [];
		let row = Math.max(0, from);
		while (row < end) {
			if (row < this.header.length) {
				lines.push(this.header[row++]!);
				continue;
			}
			if (selection && (row === top || row === bottom)) {
				lines.push(
					outlineRule(
						row === top ? theme.boxRound.topLeft : theme.boxRound.bottomLeft,
						row === top ? theme.boxRound.topRight : theme.boxRound.bottomRight,
						this.#inner,
					),
				);
				row++;
				continue;
			}
			const beforeOutline = selection && row < top;
			const insideOutline = selection && row > top && row < bottom;
			const segmentEnd = Math.min(end, beforeOutline ? top : insideOutline ? bottom : end);
			const offset =
				range.start +
				row -
				this.header.length -
				(selection && row > top ? 1 : 0) -
				(selection && row > bottom ? 1 : 0);
			const frame = this.container.renderVirtualViewport(this.#inner, {
				offset,
				rows: segmentEnd - row,
				followBottom: false,
			});
			const vertical = theme.fg("accent", theme.boxDotted.vertical);
			for (const text of stripPromptZones(frame.lines)) {
				lines.push(insideOutline ? `${vertical} ${fit(text, this.#inner)} ${vertical}` : text ? `  ${text}` : "");
			}
			row = segmentEnd;
		}
		return lines;
	}
}

/** Centered position rail for horizontally windowed content: `… ○ ◉ ○ …`. */
export function positionRail(
	count: number,
	active: number,
	moreLeft: boolean,
	moreRight: boolean,
	width: number,
): string {
	const dots: string[] = [];
	for (let index = 0; index < count; index++) {
		dots.push(index === active ? theme.fg("accent", theme.radio.selected) : theme.fg("dim", theme.radio.unselected));
	}
	const rail = `${moreLeft ? theme.fg("dim", "… ") : "  "}${dots.join(" ")}${moreRight ? theme.fg("dim", " …") : ""}`;
	const pad = Math.max(0, Math.floor((width - visibleWidth(rail)) / 2));
	return " ".repeat(pad) + rail;
}

/** Plain text of a user message (string or text blocks), single line. */
export function userMessageText(message: Extract<SessionMessageEntry["message"], { role: "user" }>): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map(block => block.text)
					.join(" ");
	return text.replace(/\s+/g, " ").trim();
}

/** Whether a user message carries prompt text (string or text blocks). */
export function userMessageHasText(message: SessionMessageEntry["message"]): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content.trim().length > 0;
	return message.content.some(block => block.type === "text" && block.text.trim().length > 0);
}
