/**
 * Fullscreen rewind over lazily replayed user turns. Up/Down step through
 * rendered items, Left/Right visit user turns or sibling branches, and `f`
 * searches the rendered current path. Only searching materializes all turns;
 * ordinary navigation paints the viewport without mutating the live transcript.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	extractPrintableText,
	matchesKey,
	padding,
	routeSgrMouseInput,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	type VirtualViewportFrame,
} from "../index";
import type { MessageRenderer } from "../chat/extension-types";
import type { TranscriptEntryLike as TranscriptEntry } from "../chat/transcript-entry";
import { theme } from "../theme/theme";
import { matchesAppToolsExpand, matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { DynamicBorder } from "../chrome/dynamic-border";
import { padToWidth } from "../render/utils";
import { ScrollView } from "../components/scroll-view";
import { RewindHistory, type RewindHistoryItem } from "./rewind-history";
import {
	composeOutlineColumn,
	type OutlineTarget,
	type ViewportOutlineColumn,
	positionRail,
	isUserTurnEntry,
	userTurnLabel,
} from "../chat/transcript-outline";

export interface BranchVariantPath {
	rootId: string;
	entries: TranscriptEntry[];
}

export interface RewindSelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	linkTargets?: ReadonlyMap<string, string>;
	requestRender: () => void;
	siblingPaths?: (entryId: string) => BranchVariantPath[];
	onSelect: (entryId: string) => void;
	onCancel: () => void;
}

interface SiblingColumn {
	history: RewindHistory;
	label: string;
}

const CHROME_ROWS = 5;
const STRIP_GAP = 2;
const SLIDE_MS = 160;

export class RewindSelectorComponent implements Component {
	#history: RewindHistory;
	#scrollView = new ScrollView([], {
		height: 10,
		scrollbar: "auto",
		theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
	});
	#border = new DynamicBorder();
	#scrollToSelection = true;
	#expanded = false;
	#width = 80;
	#variantCache = new Map<string, SiblingColumn[]>();
	#activeVariant = 0;
	#slide: { from: number; to: number; startedAt: number } | undefined;
	#slideTimer: NodeJS.Timeout | undefined;

	/** Filter query while the filter prompt is open; undefined shows the full transcript. */
	#filter: string | undefined;
	#filterItems: RewindHistoryItem[] = [];

	constructor(
		entries: TranscriptEntry[],
		private readonly deps: RewindSelectorDeps,
	) {
		this.#history = new RewindHistory(entries, deps);
	}

	get hasTargets(): boolean {
		return this.#history.target !== undefined;
	}

	invalidate(): void {
		this.#history.invalidate();
		for (const columns of this.#variantCache.values()) for (const column of columns) column.history.invalidate();
	}

	dispose(): void {
		this.#stopSlide();
		this.#history.dispose();
		for (const columns of this.#variantCache.values()) for (const column of columns) column.history.dispose();
		this.#variantCache.clear();
	}

	#stripColumns(): SiblingColumn[] {
		const target = this.#history.target;
		if (!target || !this.deps.siblingPaths) return [];
		const cached = this.#variantCache.get(target.turnId);
		if (cached) return cached;
		const columns: SiblingColumn[] = [];
		for (const sibling of this.deps.siblingPaths(target.turnId)) {
			if (sibling.entries.length === 0) continue;
			const history = new RewindHistory(sibling.entries, this.deps, "first");
			history.setExpanded(this.#expanded);
			const firstUser = sibling.entries.find(isUserTurnEntry);
			const label = (firstUser && userTurnLabel(firstUser)) || sibling.rootId;
			columns.push({ history, label });
		}
		this.#variantCache.set(target.turnId, columns);
		return columns;
	}

	#stopSlide(): void {
		this.#slide = undefined;
		clearInterval(this.#slideTimer);
		this.#slideTimer = undefined;
	}

	#slidePosition(now: number): number {
		if (!this.#slide) return this.#activeVariant;
		const t = Math.min(1, (now - this.#slide.startedAt) / SLIDE_MS);
		return this.#slide.from + (this.#slide.to - this.#slide.from) * (1 - (1 - t) ** 3);
	}

	#slideTo(variant: number): void {
		const now = Date.now();
		this.#slide = { from: this.#slidePosition(now), to: variant, startedAt: now };
		this.#activeVariant = variant;
		this.#slideTimer ??= setInterval(() => {
			if (!this.#slide || Date.now() - this.#slide.startedAt >= SLIDE_MS) this.#stopSlide();
			this.deps.requestRender();
		}, 16);
		this.deps.requestRender();
	}

	#moveMain(delta: -1 | 1, userOnly: boolean): void {
		if (!this.#history.move(delta, userOnly, Math.max(1, this.#width - 1))) return;
		this.#activeVariant = 0;
		this.#stopSlide();
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	#moveVertical(delta: -1 | 1): void {
		if (this.#activeVariant === 0) {
			this.#moveMain(delta, false);
			return;
		}
		const history = this.#stripColumns()[this.#activeVariant - 1]?.history;
		const width = Math.max(24, Math.floor((this.#width - 1 - STRIP_GAP) / 2));
		if (history?.move(delta, false, width)) {
			this.#scrollToSelection = true;
			this.deps.requestRender();
		} else if (delta === -1) {
			this.#activeVariant = 0;
			this.#stopSlide();
			this.#moveMain(-1, false);
			this.#scrollToSelection = true;
			this.deps.requestRender();
		}
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollToSelection = false;
					const before = this.#scrollView.getScrollOffset();
					this.#scrollView.scroll(event.wheel * 3);
					if (before !== this.#scrollView.getScrollOffset()) this.deps.requestRender();
				}
				return true;
			});
			return;
		}
		if (this.#filter !== undefined) {
			this.#handleFilterInput(data);
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			this.deps.onCancel();
			return;
		}
		if (matchesKey(data, "f")) {
			this.#filter = "";
			this.#activeVariant = 0;
			this.#stopSlide();
			this.#scrollToSelection = true;
			this.#refreshFilter();
			this.deps.requestRender();
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#toggleExpanded();
			return;
		}
		if (matchesSelectUp(data)) {
			this.#moveVertical(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#moveVertical(1);
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#activeVariant > 0) this.#slideTo(this.#activeVariant - 1);
			else this.#moveMain(-1, true);
			return;
		}
		if (matchesKey(data, "right")) {
			const columns = this.#stripColumns();
			if (this.#activeVariant < columns.length) {
				columns[this.#activeVariant]!.history.resetSelection();
				this.#slideTo(this.#activeVariant + 1);
			} else if (this.#activeVariant === 0) this.#moveMain(1, true);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const history =
				this.#activeVariant > 0 ? this.#stripColumns()[this.#activeVariant - 1]?.history : this.#history;
			const target = history?.target;
			if (target) this.deps.onSelect(target.entryId);
			return;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.#scrollToSelection = false;
			this.deps.requestRender();
		}
	}

	#toggleExpanded(): void {
		this.#expanded = !this.#expanded;
		this.#history.setExpanded(this.#expanded);
		for (const columns of this.#variantCache.values())
			for (const column of columns) column.history.setExpanded(this.#expanded);
		if (this.#filter !== undefined) this.#refreshFilter();
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	#handleFilterInput(data: string): void {
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			this.#closeFilter();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const target = this.#filterMatches().find(item => item.target.entryId === this.#history.target?.entryId);
			if (target) this.deps.onSelect(target.target.entryId);
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#toggleExpanded();
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "left")) {
			this.#stepFiltered(-1, !matchesSelectUp(data));
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "right")) {
			this.#stepFiltered(1, !matchesSelectDown(data));
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.#filter!.length === 0) this.#closeFilter();
			else this.#setFilter(this.#filter!.slice(0, -1));
			return;
		}
		const printable = extractPrintableText(data);
		if (printable) {
			this.#setFilter(this.#filter! + printable);
			return;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.#scrollToSelection = false;
			this.deps.requestRender();
		}
	}

	#closeFilter(): void {
		this.#filter = undefined;
		this.#filterItems = [];
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	#setFilter(query: string): void {
		this.#filter = query;
		this.#refreshFilter();
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	/** Search materializes rendered targets only while the filter is open. */
	#refreshFilter(): void {
		this.#filterItems = this.#history.items(Math.max(1, this.#width - 1));
		const matches = this.#filterMatches();
		const point = this.#history.point;
		if (!point || matches.some(item => item.target.entryId === this.#history.target?.entryId)) return;
		const next =
			matches.findLast(item =>
				item.point.chunk < point.chunk || (item.point.chunk === point.chunk && item.point.target < point.target),
			) ?? matches.at(-1);
		if (next) {
			this.#history.select(next.point);
			this.#scrollToSelection = true;
		}
	}

	#stepFiltered(delta: -1 | 1, userTurnsOnly: boolean): void {
		const point = this.#history.point;
		if (!point) return;
		const matches = this.#filterMatches().filter(item => !userTurnsOnly || item.target.isUserTurn);
		const next = delta < 0
			? matches.findLast(item =>
					item.point.chunk < point.chunk || (item.point.chunk === point.chunk && item.point.target < point.target),
				)
			: matches.find(item =>
					item.point.chunk > point.chunk || (item.point.chunk === point.chunk && item.point.target > point.target),
				);
		if (!next) return;
		this.#history.select(next.point);
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	/** Every query word must match a whole rendered word, including expansion state. */
	#filterMatches(): RewindHistoryItem[] {
		const words = (this.#filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		const patterns = words.map(
			word => new RegExp(`(?<![\\p{L}\\p{N}_])${RegExp.escape(word)}(?![\\p{L}\\p{N}_])`, "u"),
		);
		return this.#filterItems.filter(item => {
			const text = Bun.stripANSI(item.rows.join("\n")).toLowerCase();
			return patterns.every(pattern => pattern.test(text));
		});
	}

	render(width: number): readonly string[] {
		this.#width = width;
		const contentWidth = Math.max(1, width - 1);
		const before = this.#history.point;
		this.#history.ensureVisible(contentWidth);
		if (before !== this.#history.point) {
			this.#activeVariant = 0;
			this.#stopSlide();
		}
		if (this.#filter !== undefined) this.#refreshFilter();
		const columns = this.#filter === undefined ? this.#stripColumns() : [];
		const filtered = this.#filter === undefined ? undefined : this.#filterColumn(contentWidth);
		const composed = filtered?.column ?? (
			columns.length > 0
				? this.#renderStrip(columns, contentWidth)
				: this.#history.column(contentWidth, { selected: this.#history.point })
		);
		const followBottom =
			!this.#scrollToSelection && this.#scrollView.getScrollOffset() === this.#scrollView.getMaxScrollOffset();
		const height = Math.max(3, (this.deps.ui.terminal?.rows || process.stdout.rows || 40) - CHROME_ROWS);
		this.#scrollView.setHeight(height);
		let visible: readonly string[] = [];
		let selectionEdge: "top" | "bottom" | undefined;
		for (let pass = 0; pass < 3; pass++) {
			const total = composed.length;
			const selectionStart = composed.selStart;
			const selectionEnd = composed.selEnd;
			this.#scrollView.setTotalRows(total);
			if (this.#scrollToSelection && selectionStart >= 0) {
				const offset = this.#scrollView.getScrollOffset();
				const top = Math.max(0, selectionStart - 1);
				const bottom = Math.min(total, selectionEnd + 1);
				selectionEdge ??= top < offset ? "top" : bottom > offset + height ? "bottom" : undefined;
				if (selectionEdge === "top") this.#scrollView.setScrollOffset(top);
				else if (selectionEdge === "bottom") this.#scrollView.setScrollOffset(bottom - height);
			}
			const frame = composed.renderVirtualViewport(contentWidth, {
				rows: height,
				offset: this.#scrollView.getScrollOffset(),
				followBottom,
			});
			visible = frame.lines;
			this.#scrollView.setTotalRows(frame.estimatedTotalRows);
			this.#scrollView.setScrollOffset(frame.offset);
			if (
				!this.#scrollToSelection ||
				(total === composed.length && selectionStart === composed.selStart && selectionEnd === composed.selEnd)
			)
				break;
		}
		this.#scrollToSelection = false;
		this.#scrollView.setLines(visible);
		const lateral = columns.length > 0 ? "←/→ branches" : "←/→ user turns";
		const footer = filtered?.footer ??
			theme.fg("dim", `message ${this.#history.position}/${this.#history.entries.length}  ↑/↓ step  ${lateral}  f filter  enter rewind  ctrl+o expand  esc cancel`);
		return [
			...this.#border.render(width),
			` ${theme.icon.rewind} ${theme.bold("Rewind")}${theme.sep.dot}${theme.fg("dim", "pick the point to continue from")}`,
			...this.#border.render(width),
			...this.#scrollView.render(width),
			` ${truncateToWidth(footer, Math.max(0, width - 1))}`,
			...this.#border.render(width),
		];
	}

	#filterColumn(width: number): { column: ViewportOutlineColumn; footer: string } {
		const matches = this.#filterMatches();
		const rows = matches.map(item => item.rows);
		const targets: OutlineTarget[] = matches.map((item, index) => ({
			...item.target,
			start: index,
			end: index + 1,
		}));
		const selected = matches.findIndex(item => item.target.entryId === this.#history.target?.entryId);
		const composed = composeOutlineColumn(rows, 0, rows.length, targets, selected, width, undefined);
		const lines = matches.length ? composed.lines : [theme.fg("muted", `  No items match "${this.#filter}"`)];
		const count = matches.length === 0
			? theme.fg("error", "no matches")
			: theme.fg("dim", `${selected >= 0 ? selected + 1 : "-"}/${matches.length}`);
		return {
			column: {
				length: lines.length,
				selStart: composed.selStart,
				selEnd: composed.selEnd,
				hasVirtualViewport: () => true,
				getEstimatedVirtualRows: () => lines.length,
				renderVirtualViewport: (_width, request) => {
					const maxOffset = Math.max(0, lines.length - request.rows);
					const offset = request.followBottom ? maxOffset : Math.max(0, Math.min(request.offset, maxOffset));
					return { lines: lines.slice(offset, offset + request.rows), offset, estimatedTotalRows: lines.length };
				},
			},
			footer: `${theme.fg("accent", "filter:")} ${this.#filter}${theme.fg("accent", "▏")}  ${count}  ${theme.fg("dim", "↑/↓ step  ←/→ user turns  enter rewind  ctrl+o expand  esc show all")}`,
		};
	}

	#renderStrip(columns: SiblingColumn[], width: number): ViewportOutlineColumn {
		const point = this.#history.point!;
		const colWidth = Math.max(24, Math.floor((width - STRIP_GAP) / 2));
		const prefix = this.#history.column(width, { to: point });
		const count = columns.length + 1;
		const caption = (index: number, label: string): string[] => [
			` ${theme.fg(index === this.#activeVariant ? "accent" : "dim", truncateToWidth(`${theme.icon.branch} ${index + 1}/${count} ${theme.sep.dot} ${label}`, colWidth - 2))}`,
			"",
		];
		const composed = [
			this.#history.column(colWidth, {
				from: point,
				selected: this.#activeVariant === 0 ? point : undefined,
				header: caption(0, "current"),
			}),
		];
		for (let index = 0; index < columns.length; index++) {
			const column = columns[index]!;
			if (this.#activeVariant === index + 1) column.history.ensureVisible(colWidth);
			composed.push(
				column.history.column(colWidth, {
					selected: this.#activeVariant === index + 1 ? column.history.point : undefined,
					header: caption(index + 1, column.label),
				}),
			);
		}
		const stride = colWidth + STRIP_GAP;
		const totalWidth = count * colWidth + (count - 1) * STRIP_GAP;
		const cameraAt = (position: number) =>
			Math.max(0, Math.min(position * stride - (width - colWidth) / 2, Math.max(0, totalWidth - width)));
		const camera = cameraAt(this.#slidePosition(Date.now()));
		const settled = cameraAt(this.#activeVariant);
		const rail =
			count > 2
				? [positionRail(count, this.#activeVariant, settled > 0.5, settled + width < totalWidth - 0.5, width), ""]
				: [];
		const active = composed[this.#activeVariant]!;
		const totalRows = () => prefix.length + rail.length + Math.max(...composed.map(column => column.length));
		return {
			get length() {
				return totalRows();
			},
			get selStart() {
				return active.selStart < 0 ? -1 : prefix.length + rail.length + active.selStart;
			},
			get selEnd() {
				return active.selEnd < 0 ? -1 : prefix.length + rail.length + active.selEnd;
			},
			hasVirtualViewport: () => true,
			getEstimatedVirtualRows: totalRows,
			renderVirtualViewport: (_width, request): VirtualViewportFrame => {
				let offset = request.followBottom
					? Math.max(0, totalRows() - request.rows)
					: Math.max(0, Math.min(request.offset, Math.max(0, totalRows() - request.rows)));
				const lines: string[] = [];
				if (offset < prefix.length) {
					const frame = prefix.renderVirtualViewport(width, {
						rows: Math.min(request.rows, prefix.length - offset),
						offset,
						followBottom: false,
					});
					lines.push(...frame.lines);
					offset = frame.offset;
				}
				const stripStart = prefix.length + rail.length;
				for (let row = Math.max(offset, prefix.length); row < Math.min(offset + request.rows, stripStart); row++)
					lines.push(rail[row - prefix.length]!);
				let start = Math.max(0, offset - stripStart);
				let end = Math.min(offset + request.rows - stripStart, Math.max(...composed.map(column => column.length)));
				if (end > start) {
					const visible = composed.flatMap((column, index) => {
						const x0 = index * stride - camera;
						const left = Math.max(0, x0);
						const right = Math.min(width, x0 + colWidth);
						return right <= left ? [] : [{ column, index, x0, left, right, rows: [] as readonly string[] }];
					});
					const primary =
						visible.find(item => item.index === this.#activeVariant && item.column.length > start) ??
						visible.find(item => item.column.length > start);
					if (primary) {
						const frame = primary.column.renderVirtualViewport(colWidth, {
							offset: start,
							rows: Math.min(end, primary.column.length) - start,
							followBottom:
								request.followBottom &&
								primary.column.length === Math.max(...composed.map(column => column.length)),
						});
						primary.rows = frame.lines;
						if (offset >= stripStart) {
							start = frame.offset;
							offset = stripStart + start;
							end = Math.min(start + request.rows, Math.max(...composed.map(column => column.length)));
						}
					}
					for (const item of visible) {
						if (item === primary || start >= item.column.length) continue;
						item.rows = item.column.renderVirtualViewport(colWidth, {
							offset: start,
							rows: Math.min(end, item.column.length) - start,
							followBottom: false,
						}).lines;
					}
					for (let row = start; row < end; row++) {
						let line = "";
						let filled = 0;
						for (const column of visible) {
							const source = padToWidth(column.rows[row - start] ?? "", colWidth);
							const clipped = sliceByColumn(source, column.left - column.x0, column.right - column.left, true);
							line += padding(Math.max(0, column.left - filled)) + padToWidth(clipped, column.right - column.left);
							filled = column.right;
						}
						lines.push(line);
					}
				}
				return { lines, offset, estimatedTotalRows: totalRows() };
			},
		};
	}
}
