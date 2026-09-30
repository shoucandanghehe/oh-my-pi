/**
 * Fullscreen rewind over lazily replayed user turns. Up/Down step through
 * rendered items, Left/Right visit user turns or sibling branches, and `f`
 * searches the rendered current path. Only searching materializes all turns;
 * ordinary navigation paints the viewport without mutating the live transcript.
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
import { RewindHistory, type RewindHistoryItem, type RewindHistoryTarget } from "./rewind-history";
import {
	composeOutlineColumn,
	type OutlineTarget,
	type ViewportOutlineColumn,
	positionRail,
	isUserTurnEntry,
	userTurnLabel,
} from "../chat/transcript-outline";
import type { TspPickerItem, TspPickerProps } from "@oh-my-pi/pi-wire";
import { compact, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";
import { CLOSE_ACTION, type PickerEvent, picker, pickerAction, pickerEvent, pickerQuery } from "../native/picker";
import { isNativeRendering } from "../native/state";
import {
	collectBlocks,
	EARLIER_TURNS_KEY,
	earlierTurnsItem,
	TIMELINE_COLUMNS,
	targetCopy,
	timelineItem,
	turnItem,
	turnPreview,
} from "./copy-selector";

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
	/** Native list items for this column, built on first describe. */
	nativeItems?: NativeNode[];
	/** Picker catalogue while this column's tab is open: the main items, then this branch's. */
	pickerItems?: { main: readonly TspPickerItem[]; items: TspPickerItem[] };
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

	/** Filter field while the filter prompt is open; undefined shows the full transcript. */
	#filterInput: Input | undefined;
	/** Filter query while the filter prompt is open; undefined shows the full transcript. */
	get #filter(): string | undefined {
		return this.#filterInput?.getValue();
	}
	/** Native search uses raw turn text, not terminal layout or collapsed rows. */
	#nativeTexts = new WeakMap<OutlineTarget, string>();
	#native: { memo: string; node: NativeNode } | undefined;
	#nativeItems: { targets: readonly RewindHistoryTarget[]; items: NativeNode[] } | undefined;
	#pickerItems: { targets: readonly RewindHistoryTarget[]; items: TspPickerItem[] } | undefined;
	#picker: { memo: string; node: NativeNode } | undefined;
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
		this.#native = undefined;
		this.#picker = undefined;
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

	#outlinedHistory(): RewindHistory | undefined {
		return this.#activeVariant > 0 ? this.#stripColumns()[this.#activeVariant - 1]?.history : this.#history;
	}

	#outlinedTarget(): OutlineTarget | undefined {
		return this.#outlinedHistory()?.target;
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
		if (!this.#history.move(delta, userOnly, isNativeRendering() ? undefined : Math.max(1, this.#width - 1))) return;
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
		if (history?.move(delta, false, isNativeRendering() ? undefined : width)) {
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
			this.#left();
			return;
		}
		if (matchesKey(data, "right")) {
			this.#right();
			return;
		}
		if (isNativeRendering() && (data === "a" || data === "A")) {
			this.#loadEarlier();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#selectOutlined();
			return;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.#scrollToSelection = false;
			this.deps.requestRender();
		}
	}

	/** `f`: open the filter over the whole branch. */
	#openFilter(): void {
		if (isNativeRendering()) this.#history.loadAll();
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
			if (input.getValue() !== before) this.#filterChanged();
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

	#filterChanged(): void {
		this.#refreshFilter();
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	/** ANSI search measures rows; native search uses the catalogue without rendering. */
	#refreshFilter(): void {
		if (!isNativeRendering()) this.#filterItems = this.#history.items(Math.max(1, this.#width - 1));
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
	 * ANSI matches rendered rows (including expansion state); native matches
	 * raw turn text, commands and tool output without terminal layout.
	 */
	#filterMatches(): readonly RewindHistoryTarget[] {
		const words = (this.#filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		const patterns = words.map(word =>
			/^[\p{Script=Latin}\p{N}_]+$/u.test(word)
				? new RegExp(`(?<![\\p{L}\\p{N}_])${RegExp.escape(word)}(?![\\p{L}\\p{N}_])`, "u")
				: new RegExp(RegExp.escape(word), "u"),
		);
		if (isNativeRendering()) {
			return this.#history.targets.filter(({ target }) => {
				let text = this.#nativeTexts.get(target);
				if (text === undefined) {
					const blocks = collectBlocks(target.entries);
					text = [targetCopy(target, blocks).content, ...blocks.map(block => block.content)]
						.join("\n")
						.toLowerCase();
					this.#nativeTexts.set(target, text);
				}
				return patterns.every(pattern => pattern.test(text));
			});
		}
		return this.#filterItems.filter(item => {
			const text = Bun.stripANSI(item.rows.join("\n")).toLowerCase();
			return patterns.every(pattern => pattern.test(text));
		});
	}

	// ========================================================================
	// Native
	// ========================================================================

	/** A `picker` is its own sheet: the backend mounts it in `layer`, over the transcript. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	/** A branch tab click moves between the current path and its alternates, as Left/Right do. */
	#showVariant(value: string | undefined): void {
		const variant = Number(value);
		if (!Number.isInteger(variant) || variant === this.#activeVariant) return;
		if (variant < 0 || variant > this.#stripColumns().length) return;
		if (variant > 0) this.#stripColumns()[variant - 1]!.history.resetSelection();
		if (variant === 0) {
			this.#activeVariant = 0;
			this.#stopSlide();
			this.deps.requestRender();
		} else {
			this.#slideTo(variant);
		}
	}

	/**
	 * Picker pointer events: a row click outlines that turn, a second click
	 * rewinds there (Enter); the action bar and tabs run their keys' paths.
	 */
	#handlePickerEvent(event: PickerEvent): void {
		if (event.kind === "action") {
			switch (event.act) {
				case "tab":
					this.#showVariant(event.value);
					return;
				case "rewind":
					if (this.#filter === undefined) this.#selectOutlined();
					else this.#selectFiltered();
					return;
				case "lateral":
					// A click steps back a user turn, or on to the next branch (wrapping to the current path).
					if (this.#filter !== undefined) this.#stepFiltered(-1, true);
					else if (this.#stripColumns().length === 0) this.#left();
					else if (this.#activeVariant < this.#stripColumns().length) this.#right();
					else this.#showVariant("0");
					return;
				case "filter":
					this.#openFilter();
					return;
				case "earlier":
					this.#loadEarlier();
					return;
				case "close":
					if (this.#filter === undefined) this.deps.onCancel();
					else this.#closeFilter();
					return;
				case "clear":
					this.#closeFilter();
					return;
				default:
					return;
			}
		}
		if (!this.#outline(event.item)) return;
		this.deps.requestRender();
		if (event.kind === "activate") {
			if (this.#filter === undefined) this.#selectOutlined();
			else this.#selectFiltered();
		}
	}

	#loadEarlier(): void {
		this.#history.loadAll();
		this.deps.requestRender();
	}

	/** Outline the turn `id`: on the active branch tab, or on the main path (leaving the tab). */
	#outline(id: string): boolean {
		const branch = this.#activeVariant > 0 ? this.#outlinedHistory() : undefined;
		if (branch?.selectTurn(id)) {
			this.#scrollToSelection = true;
			return true;
		}
		if (this.#filter !== undefined && !this.#filterMatches().some(item => item.target.turnId === id)) return false;
		if (!this.#history.selectTurn(id)) return false;
		this.#activeVariant = 0;
		this.#stopSlide();
		this.#scrollToSelection = true;
		return true;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event);
		if (picked) {
			this.#handlePickerEvent(picked);
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (event.key === "branches") {
			this.#showVariant(event.item);
			return;
		}
		// A click on an item outlines it and rewinds there, as Enter would.
		if (event.key === "list") {
			if (event.item === EARLIER_TURNS_KEY) {
				this.#loadEarlier();
				return;
			}
			if (this.#filter !== undefined && !this.#filterMatches().some(item => item.target.turnId === event.item))
				return;
			if (!this.#history.selectTurn(event.item)) return;
			this.#activeVariant = 0;
			this.#stopSlide();
		} else if (event.key === "branch" && this.#activeVariant > 0) {
			if (!this.#outlinedHistory()?.selectTurn(event.item)) return;
		} else {
			return;
		}
		this.#scrollToSelection = true;
		this.deps.requestRender();
		this.#selectOutlined();
	}

	describe(cx: DescribeContext): NativeNode {
		return cx.supports("picker") ? this.#describePicker() : this.#describeCard();
	}

	#nativeMemo(): string {
		return `${this.#history.target?.turnId}|${this.#activeVariant}|${this.#outlinedTarget()?.turnId}|${this.#history.truncated}|${this.#expanded}|${this.#filter ?? "\0"}|${this.#filterInput?.getCursor()}`;
	}

	/**
	 * The `timeline` picker: one row per turn, the branch tabs at a fork, the
	 * filter as the query, and the outlined turn's own transcript components
	 * as the preview under the drop warning.
	 */
	#describePicker(): NativeNode {
		const filter = this.#filter;
		const memo = this.#nativeMemo();
		const cached = this.#picker;
		if (cached?.memo === memo) return cached.node;

		const targets = this.#history.targets;
		const selected = targets.findIndex(item => item.target === this.#history.target);
		if (this.#pickerItems?.targets !== targets) {
			this.#pickerItems = { targets, items: targets.map(item => timelineItem(item.target)) };
		}
		const main = this.#pickerItems.items;
		const columns = filter === undefined ? this.#stripColumns() : [];
		const column = columns[this.#activeVariant - 1];
		const matches = filter === undefined ? undefined : this.#filterMatches();
		const props: TspPickerProps = {
			title: "Rewind",
			subtitle: "Pick the point to continue from",
			icon: "rewind",
			noun: "turns",
			size: "lg",
			layout: "timeline",
			preview: "side",
			...pickerQuery(this.#filterInput ?? null),
			placeholder: "Filter turns…",
			columns: TIMELINE_COLUMNS,
			items: main,
			selected: this.#history.target?.turnId ?? null,
			total: targets.length,
			empty: "Nothing to rewind to",
		};
		if (matches) {
			props.order = matches.map(item => item.target.turnId);
			if (!matches.some(item => item.target === this.#history.target)) props.selected = null;
		}
		if (columns.length > 0) {
			props.tabs = [
				{ id: "0", label: "Current" },
				...columns.map((strip, index) => ({
					id: String(index + 1),
					label: strip.label.length > 32 ? `${strip.label.slice(0, 31)}…` : strip.label,
				})),
			];
			props.tab = String(this.#activeVariant);
		}
		if (column) {
			// The shared history above the fork, then the alternate branch.
			if (column.pickerItems?.main !== main) {
				column.pickerItems = {
					main,
					items: [...main, ...column.history.targets.map(item => timelineItem(item.target))],
				};
			}
			props.items = column.pickerItems.items;
			props.order = [
				...targets.slice(0, selected).map(item => item.target.turnId),
				...column.history.targets.map(item => item.target.turnId),
			];
			props.selected = column.history.target?.turnId ?? null;
		}
		props.actions = compact([
			pickerAction("rewind", "Rewind here", "enter", { primary: true }),
			pickerAction("lateral", columns.length > 0 ? "Branches" : "User turns", ["left", "right"]),
			filter === undefined ? pickerAction("filter", "Filter", "f") : undefined,
			filter === undefined && this.#history.truncated ? pickerAction("earlier", "Earlier turns", "a") : undefined,
			filter === undefined ? CLOSE_ACTION : { ...CLOSE_ACTION, label: "Show all" },
		]);

		const preview: NativeChild[] = [];
		const outlined = this.#outlinedTarget();
		if (outlined && props.selected !== null) {
			// A user turn rewinds past itself (its text returns to the editor); anything else keeps itself.
			const kept = column || outlined.isUserTurn ? selected : selected + 1;
			const dropped = targets.length - kept;
			preview.push(
				text(
					dropped > 0
						? [
								span("Continue from here: everything below is dropped", "warning"),
								span(`${theme.sep.dot}${dropped} turn${dropped === 1 ? "" : "s"}`, "dim"),
							]
						: [span("Continue from here: nothing below to drop", "warning")],
					{ role: "omp.rewind.drop" },
				),
				...(column?.history ?? this.#history).preview,
			);
		}
		const root = picker(props, preview);
		this.#picker = { memo, node: root };
		return root;
	}

	#describeCard(): NativeNode {
		const memo = this.#nativeMemo();
		const cached = this.#native;
		if (cached?.memo === memo) return cached.node;

		const filter = this.#filter;
		const children: NativeChild[] = [];
		const allItems = this.#history.targets;
		const columns = filter === undefined ? this.#stripColumns() : [];
		const matches = filter === undefined ? undefined : this.#filterMatches();
		if (filter !== undefined && matches) {
			children.push(
				this.#filterInput!,
				node(
					"list",
					{
						selected: matches.some(item => item.target === this.#history.target)
							? this.#history.target!.turnId
							: null,
						filter,
						empty: `No items match "${filter}"`,
						virtual: true,
						max: 0.5,
					},
					matches.map(item => turnItem(item.target)),
					"list",
				),
			);
		} else {
			children.push(
				node(
					"list",
					{
						selected: this.#history.target?.turnId ?? null,
						empty: "Nothing to rewind to",
						virtual: true,
						max: 0.5,
					},
					this.#mainItems(allItems),
					"list",
				),
			);
		}
		if (columns.length > 0) {
			children.push(
				node(
					"tabs",
					{
						items: [
							{ id: "0", label: "current" },
							...columns.map((column, index) => ({ id: String(index + 1), label: column.label })),
						],
						active: String(this.#activeVariant),
					},
					undefined,
					"branches",
				),
			);
			const column = columns[this.#activeVariant - 1];
			if (column) {
				column.nativeItems ??= column.history.targets.map(item => turnItem(item.target));
				children.push(
					node(
						"list",
						{ selected: column.history.target?.turnId ?? null, virtual: true, max: 0.4 },
						column.nativeItems,
						"branch",
					),
				);
			}
		}
		const outlined = this.#outlinedTarget();
		if (outlined && (!matches || matches.some(item => item.target === outlined))) {
			const item = targetCopy(outlined, collectBlocks(outlined.entries));
			children.push(
				node("section", { head: [span(item.label, "strong")] }, [turnPreview(outlined, item.content)], "preview"),
			);
		}
		const upDown = actionHint(["tui.select.up", "tui.select.down"], "step");
		children.push(
			hintsRow(
				filter === undefined
					? [
							upDown,
							{ keys: ["left", "right"], label: columns.length > 0 ? "branches" : "user turns" },
							{ keys: ["f"], label: "filter" },
							{ keys: ["enter"], label: "rewind" },
							this.#history.truncated ? { keys: ["a"], label: "earlier turns" } : undefined,
							actionHint("tui.select.cancel", "cancel"),
						]
					: [
							upDown,
							{ keys: ["left", "right"], label: "user turns" },
							{ keys: ["enter"], label: "rewind" },
							actionHint("tui.select.cancel", "show all"),
						],
			),
		);
		const root = overlayCard(
			"omp.overlay.rewind",
			[
				span(`${theme.icon.rewind} `),
				span("Rewind", "strong"),
				span(`${theme.sep.dot}pick the point to continue from`, "dim"),
			],
			children,
		);
		this.#native = { memo, node: root };
		return root;
	}

	#mainItems(targets: readonly RewindHistoryTarget[]): NativeNode[] {
		if (this.#nativeItems?.targets !== targets) {
			const items = targets.map(item => turnItem(item.target));
			if (this.#history.truncated) items.unshift(earlierTurnsItem);
			this.#nativeItems = { targets, items };
		}
		return this.#nativeItems.items;
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
		const footer =
			filtered?.footer ??
			theme.fg(
				"dim",
				`message ${this.#history.position}/${this.#history.entries.length}  ${editorKeys("tui.select.up", "tui.select.down")} step  ${formatKeyHints(["left", "right"])} ${lateral}  ${formatKeyHint("f")} filter  ${formatKeyHint("enter")} rewind  ${expandKeyHint()} expand  ${editorKey("tui.select.cancel")} cancel`,
			);
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
		const matching = new Set(this.#filterMatches().map(item => item.target));
		const matches = this.#filterItems.filter(item => matching.has(item.target));
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
