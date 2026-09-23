/**
 * Fullscreen esc-esc rewind selector.
 *
 * Replays the current session's branch with {@link ChatTranscriptBuilder} on
 * the alternate screen (`ui.showOverlay(..., { fullscreen: true })`) and moves
 * a dotted outline over the rendered transcript block the rewind would land
 * on, instead of listing user messages in a detached picker. Entries that
 * render nothing (notices, hidden custom messages, tool results folded into
 * their call cards) are never outlined: results fold into the turn that
 * rendered their call so rewinding a turn keeps its tool output, and the rest
 * are skipped entirely.
 *
 * When the outlined turn has sibling branches in the session tree, the region
 * below the divergence renders as a horizontal strip of half-width columns —
 * the current path first, each alternate branch beside it — and Left/Right
 * slide between them with an eased camera animation. Sibling columns are
 * fully rendered transcripts of that branch's most-recent path, built lazily
 * and cached per divergence.
 *
 * Keys: Up/Down step through rendered items in transcript order (within the
 * active column when a strip is open), Left/Right slide between branch
 * variants at a fork and jump between user turns elsewhere, `f` opens a
 * filter (typing narrows the current path to matching items; Esc leaves the
 * filter with the selection kept), Enter rewinds to the outlined item, A loads
 * earlier turns without changing selection (stepping above the oldest replayed
 * turn loads them too), Esc cancels.
 *
 * In a TSP terminal (Tern) the same replay is a page, not a sheet: a screen
 * surface of the transcript's own blocks with `pick`/`drop` marks in place of
 * the dotted outline (see `describeScreen`).
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
	type VirtualViewportFrame,
} from "../index";
import type { MessageRenderer } from "../chat/extension-types";
import type { TranscriptEntryLike as TranscriptEntry } from "../chat/transcript-entry";
import { theme } from "../theme/theme";
import { matchesAppToolsExpand, matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { DynamicBorder } from "../chrome/dynamic-border";
import { padToWidth } from "../render/utils";
import { expandKeyHint } from "../render/render-utils";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
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
import type { TspMark } from "@oh-my-pi/pi-wire";
import { kbd, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeScreen, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, actionHint, hintsRow } from "../native/overlay";
import { isNativeRendering } from "../native/state";
import { collectBlocks, targetCopy } from "./copy-selector";

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
	expandThinkingBlocks?: () => boolean;
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

/**
 * A replayed block on the rewind page, carrying a transient `mark`: it
 * describes as the block with the mark merged into its root props, and hands
 * events and rendering to the block.
 */
class MarkedBlock implements Component {
	mark: TspMark | undefined;
	#memo: { node: NativeNode; mark: TspMark; out: NativeNode } | undefined;

	constructor(readonly block: Component) {}

	render(width: number): readonly string[] {
		return this.block.render(width);
	}

	invalidate(): void {
		this.block.invalidate?.();
	}

	describe(cx: DescribeContext): NativeNode | null {
		const described = this.block.describe?.(cx) ?? null;
		const mark = this.mark;
		if (!described || !mark) return described;
		const memo = this.#memo;
		if (memo?.node === described && memo.mark === mark) return memo.out;
		const out = node(described.k, { ...described.p, mark }, described.c, described.key);
		this.#memo = { node: described, mark, out };
		return out;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.block.handleNativeEvent?.(event);
	}
}

const kMarked = Symbol("rewind.marked");

/** A replayed block tagged with its page wrapper, so stepping reuses one wrapper per block. */
interface MarkTagged {
	[kMarked]?: MarkedBlock;
}

/** The page's first row while older history is unreplayed: `a` loads it. */
const EARLIER_TURNS = node(
	"row",
	{ role: "omp.rewind.earlier", gap: "xs", align: "center" },
	[kbd("a"), text([span("load earlier turns", "muted")])],
	"earlier",
);

/** Blank columns between branch-strip columns. */
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

	/** Filter field while the filter prompt is open; undefined shows the full transcript. */
	#filterInput: Input | undefined;
	/** Filter query while the filter prompt is open; undefined shows the full transcript. */
	get #filter(): string | undefined {
		return this.#filterInput?.getValue();
	}
	/** Compiled word patterns of the last filter query. */
	#filterPatterns: { query: string; patterns: RegExp[] } | undefined;
	#filterMemo: { query: string; items: RewindHistoryItem[]; matches: RewindHistoryItem[] } | undefined;
	/** Last described bar and the state it was built from. */
	#bar: { memo: string; targets: OutlineTarget[]; node: NativeNode } | undefined;
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
		// The camera slide is repaint-only; a native surface has no camera to move.
		if (isNativeRendering()) {
			this.deps.requestRender();
			return;
		}
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
			this.#openFilter();
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

	/** `f`: open the filter over the whole branch. */
	#openFilter(): void {
		this.#scrollToSelection = true;
		const input = new Input();
		input.prompt = `${theme.fg("accent", "filter:")} `;
		input.placeholder = "words…";
		this.#filterInput = input;
		this.#activeVariant = 0;
		this.#refreshFilter();
		this.#stopSlide();
		this.deps.requestRender();
	}

	/** Left: the previous branch at a fork, else the previous user turn. */
	#left(): void {
		if (this.#activeVariant > 0) this.#slideTo(this.#activeVariant - 1);
		else this.#moveMain(-1, true);
	}

	/** Right: the next branch at a fork, else the next user turn. */
	#right(): void {
		const columns = this.#stripColumns();
		if (this.#activeVariant < columns.length) {
			columns[this.#activeVariant]!.history.resetSelection();
			this.#slideTo(this.#activeVariant + 1);
		} else if (this.#activeVariant === 0) {
			this.#moveMain(1, true);
		}
	}

	/** Enter while filtering: rewind to the selection when it matches. */
	#selectFiltered(): void {
		const item = this.#filterMatches().find(item => item.target.entryId === this.#history.target?.entryId);
		if (item) this.deps.onSelect(item.target.entryId);
	}

	/** Enter: rewind to the outlined turn (main path or the active branch column). */
	#selectOutlined(): void {
		const target = this.#outlinedTarget();
		if (target) this.deps.onSelect(target.entryId);
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
			this.#selectFiltered();
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
		const input = this.#filterInput!;
		const before = input.getValue();
		if (matchesKey(data, "backspace") && before.length === 0) {
			this.#closeFilter();
			return;
		}
		if (input.handleInput(data)) {
			if (input.getValue() !== before) this.#setFilter(input.getValue());
			else this.deps.requestRender();
			return;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.#scrollToSelection = false;
			this.deps.requestRender();
		}
	}

	#closeFilter(): void {
		this.#filterInput = undefined;
		this.#filterItems = [];
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	#setFilter(query: string): void {
		this.#filterInput?.setValue(query);
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
			matches.findLast(
				item =>
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
		const next =
			delta < 0
				? matches.findLast(
						item =>
							item.point.chunk < point.chunk ||
							(item.point.chunk === point.chunk && item.point.target < point.target),
					)
				: matches.find(
						item =>
							item.point.chunk > point.chunk ||
							(item.point.chunk === point.chunk && item.point.target > point.target),
					);
		if (!next) return;
		this.#history.select(next.point);
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	/**
	 * Visible main-path target indices whose rendered text contains every
	 * whitespace-separated Latin query word as a whole word (case-insensitive:
	 * `ls` matches `ls -la` but not `tools`). Other scripts match substrings so
	 * a Chinese query can find text inside a sentence without spaces.
	 * All visible targets match an empty query.
	 * Matching the rendered rows keeps results honest: collapsed tool output
	 * only matches once Ctrl+O expands it.
	 */
	#filterMatches(): RewindHistoryItem[] {
		const query = this.#filter ?? "";
		const memo = this.#filterMemo;
		if (memo?.query === query && memo.items === this.#filterItems) return memo.matches;
		const patterns = this.#compileFilter(query);
		const matches = this.#filterItems.filter(item => {
			const text = Bun.stripANSI(item.rows.join("\n")).toLowerCase();
			return patterns.every(pattern => pattern.test(text));
		});
		this.#filterMemo = { query, items: this.#filterItems, matches };
		return matches;
	}

	/** Word patterns of `query`, compiled once per distinct query. */
	#compileFilter(query: string): RegExp[] {
		const cached = this.#filterPatterns;
		if (cached?.query === query) return cached.patterns;
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const patterns = words.map(word =>
			/^[\p{Script=Latin}\p{N}_]+$/u.test(word)
				? new RegExp(`(?<![\\p{L}\\p{N}_])${RegExp.escape(word)}(?![\\p{L}\\p{N}_])`, "u")
				: new RegExp(RegExp.escape(word), "u"),
		);
		this.#filterPatterns = { query, patterns };
		return patterns;
	}

	// ========================================================================
	// Native: the transcript as a page
	// ========================================================================

	/**
	 * The rewind page: the replayed transcript fills a screen surface block by
	 * block, as the live one reads, the outlined turn marked `pick` under a
	 * "Continue from here" caption (revealed as the outline moves) and what the
	 * rewind drops marked `drop`. At a fork the region below it becomes a strip
	 * of branch columns, the current path first. The bar is this component's
	 * own node, docked under the page, so the filter field keeps the caret.
	 */
	describeScreen(_cx: DescribeContext): NativeScreen {
		return { role: "omp.rewind", main: this.#page(), dock: [this] };
	}

	/** The page's blocks, marked for the current outline. */
	#page(): NativeChild[] {
		const blocks = this.#builder.container.children;
		const page: NativeChild[] = [];
		const filter = this.#filter;
		if (filter !== undefined) {
			// Only the matching turns of the current path, like the filtered frame.
			const matches = this.#filterMatches();
			for (const index of matches) {
				const target = this.#targets[index]!;
				const picked = index === this.#selected;
				if (picked) page.push(this.#caption(this.#targets, index, "main"));
				for (let i = target.start; i < target.end; i++)
					page.push(this.#marked(blocks[i]!, picked ? "pick" : undefined));
			}
			if (matches.length === 0) {
				page.push(text([span(`No turns match "${filter}"`, "muted")], { role: "omp.rewind.empty" }));
			}
			return page;
		}
		if (this.#truncated) page.push(EARLIER_TURNS);
		const columns = this.#stripColumns();
		const anchor = this.#targets[this.#selected];
		if (columns.length === 0 || !anchor) {
			this.#markRun(page, blocks, 0, this.#targets, this.#selected, "main");
			return page;
		}
		// Shared history above the fork at full width, then the branches side by side.
		for (let i = 0; i < anchor.start; i++) page.push(this.#marked(blocks[i]!, undefined));
		const count = columns.length + 1;
		const current: NativeChild[] = [this.#columnHead(0, count, "current")];
		this.#markRun(
			current,
			blocks,
			anchor.start,
			this.#targets,
			this.#activeVariant === 0 ? this.#selected : -1,
			"main",
		);
		const strip = [this.#column(0, current, "current")];
		for (let index = 0; index < columns.length; index++) {
			const column = columns[index]!;
			const active = this.#activeVariant === index + 1;
			const children: NativeChild[] = [this.#columnHead(index + 1, count, column.label)];
			const picked = active ? this.#siblingSelected : -1;
			this.#markRun(children, column.builder.container.children, 0, column.targets, picked, column.rootId);
			strip.push(this.#column(index + 1, children, column.rootId));
		}
		page.push(node("row", { role: "omp.rewind.strip", gap: "lg", align: "start" }, strip, "strip"));
		return page;
	}

	/**
	 * Push `blocks[from..]` marked for `targets[picked]` (-1: none): unmarked
	 * above it, then the caption and `pick` on its blocks, `drop` below.
	 */
	#markRun(
		out: NativeChild[],
		blocks: readonly Component[],
		from: number,
		targets: readonly OutlineTarget[],
		picked: number,
		column: string,
	): void {
		const target = targets[picked];
		for (let i = from; i < blocks.length; i++) {
			if (target && i === target.start) out.push(this.#caption(targets, picked, column));
			const mark = !target || i < target.start ? undefined : i < target.end ? "pick" : "drop";
			out.push(this.#marked(blocks[i]!, mark));
		}
	}

	/**
	 * The line over the outlined turn: what Enter does and what it drops.
	 * Keyed by the turn, so every step adds a fresh one that scrolls into view.
	 */
	#caption(targets: readonly OutlineTarget[], picked: number, column: string): NativeNode {
		const target = targets[picked]!;
		const below = targets.length - picked - 1;
		const spans = [
			span(`${theme.icon.rewind} `, "accent"),
			span(target.isUserTurn ? "Rewind to here" : "Continue from here", "accent strong"),
		];
		if (target.isUserTurn) spans.push(span(`${theme.sep.dot}the prompt returns to the editor`, "dim"));
		spans.push(
			span(
				below > 0
					? `${theme.sep.dot}${below} turn${below === 1 ? "" : "s"} below dropped`
					: `${theme.sep.dot}nothing below to drop`,
				"dim",
			),
		);
		const caption = text(spans, { role: "omp.rewind.here", wrap: "none" });
		return { ...caption, key: `here:${column}:${target.turnId}`, reveal: "start" };
	}

	/** One branch column of the strip; the active one carries the accent tone. */
	#column(index: number, children: readonly NativeChild[], key: string): NativeNode {
		const active = index === this.#activeVariant;
		return node(
			"col",
			{ role: "omp.rewind.branch", gap: "lg", ...(active ? { tone: "accent" } : {}) },
			children,
			key,
		);
	}

	/** A strip column's caption: `⎇ i/n · label`. */
	#columnHead(index: number, count: number, label: string): NativeNode {
		const active = index === this.#activeVariant;
		return text(
			[
				span(`${theme.icon.branch} `, active ? "accent" : "dim"),
				span(`${index + 1}/${count}`, active ? "accent" : "dim"),
				span(`${theme.sep.dot}${label}`, active ? "strong" : "dim"),
			],
			{ role: "omp.rewind.branch.head", wrap: "none" },
		);
	}

	/** `block` wrapped to carry `mark`; one wrapper per block, so ids and view state persist while stepping. */
	#marked(block: Component & MarkTagged, mark: TspMark | undefined): MarkedBlock {
		const marked = (block[kMarked] ??= new MarkedBlock(block));
		marked.mark = mark;
		return marked;
	}

	/** The bar docked under the page: position, key hints, Cancel and Rewind; the filter field while filtering. */
	describe(_cx: DescribeContext): NativeNode {
		const filter = this.#filter;
		const columns = filter === undefined ? this.#stripColumns() : [];
		const memo = `${this.#selected}|${this.#activeVariant}|${this.#siblingSelected}|${this.#truncated}|${columns.length}|${filter ?? "\0"}`;
		if (this.#bar?.memo === memo && this.#bar.targets === this.#targets) return this.#bar.node;

		const title = text([span(`${theme.icon.rewind} `, "accent"), span("Rewind", "strong")], { wrap: "none" });
		const upDown = actionHint(["tui.select.up", "tui.select.down"], "step");
		const rewind = actionButton("Rewind here", "rewind", { keys: "enter", tone: "accent" });
		let children: NativeChild[];
		if (filter === undefined) {
			const column = columns[this.#activeVariant - 1];
			const at = column ? this.#siblingSelected : this.#selected;
			const of = column ? column.targets.length : this.#targets.length;
			children = [
				title,
				text([span(`${at + 1}/${of}`, "dim")], { wrap: "none" }),
				hintsRow([
					upDown,
					{ keys: ["left", "right"], label: columns.length > 0 ? "branches" : "user turns" },
					{ keys: ["f"], label: "filter" },
					this.#truncated ? { keys: ["a"], label: "earlier turns" } : undefined,
				]),
				actionBar([null, actionButton("Cancel", "cancel", { keys: "escape" }), rewind]),
			];
		} else {
			const matches = this.#filterMatches();
			const at = matches.indexOf(this.#selected);
			children = [
				title,
				this.#filterInput!,
				text(
					[
						matches.length === 0
							? span("no matches", "error")
							: span(`${at >= 0 ? at + 1 : "-"}/${matches.length}`, "dim"),
					],
					{ wrap: "none" },
				),
				hintsRow([upDown, { keys: ["left", "right"], label: "user turns" }]),
				actionBar([null, actionButton("Show all", "cancel", { keys: "escape" }), rewind]),
			];
		}
		const root = node("row", { role: "omp.rewind.bar", gap: "md", align: "center", wrap: true }, children);
		this.#bar = { memo, targets: this.#targets, node: root };
		return root;
	}

	/** The bar's buttons run their keys' paths; everything else belongs to the blocks. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		const filtering = this.#filter !== undefined;
		if (event.act === "rewind") {
			if (filtering) this.#selectFiltered();
			else this.#selectOutlined();
		} else if (event.act === "cancel") {
			if (filtering) this.#closeFilter();
			else this.deps.onCancel();
		}
	}

	// ========================================================================
	// Render
	// ========================================================================

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
		const composed =
			filtered?.column ??
			(columns.length > 0
				? this.#renderStrip(columns, contentWidth)
				: this.#history.column(contentWidth, { selected: this.#history.point }));
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
		const lateral = columns.length > 0 ? "branches" : "user turns";
		const footer = filtered?.footer ??
			theme.fg("dim", `message ${this.#history.position}/${this.#history.entries.length}  ${editorKeys("tui.select.up", "tui.select.down")} step  ${formatKeyHints(["left", "right"])} ${lateral}  ${formatKeyHint("f")} filter  ${formatKeyHint("enter")} rewind  ${expandKeyHint()} expand  ${editorKey("tui.select.cancel")} cancel`);
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
		const count =
			matches.length === 0
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
			footer: `${this.#filterInput!.render(visibleWidth(`filter: ${this.#filter}`) + 1)[0]}  ${count}  ${theme.fg("dim", `${editorKeys("tui.select.up", "tui.select.down")} step  ${formatKeyHints(["left", "right"])} user turns  ${formatKeyHint("enter")} rewind  ${expandKeyHint()} expand  ${editorKey("tui.select.cancel")} show all`)}`,
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
							line +=
								padding(Math.max(0, column.left - filled)) + padToWidth(clipped, column.right - column.left);
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
