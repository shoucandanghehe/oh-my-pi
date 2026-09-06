import {
	type AppViewportHoverProvider,
	type AppViewportTextSelectionRect,
	type Component,
	componentContains,
	type Focusable,
	matchesKey,
	type MouseRoutable,
	padding,
	renderTargeted,
	type SgrMouseEvent,
	TERMINAL_STATE_TERMINATOR,
	type TargetedRender,
	type TextSelectionRange,
	truncateToWidth,
	type ViewportHeightAware,
	visibleWidth,
	type WorkspaceEdge,
} from "@oh-my-pi/pi-tui";
import { sanitizeStatusText } from "../shared";
import { theme } from "../theme/theme";
import type { AgentTranscriptViewer } from "./agent-transcript-viewer";

export interface AutoAgentDockOptions {
	axis: "x" | "y";
	requestRender: () => void;
	onClose: () => void;
	onCloseAgent: (id: string) => void;
	onDetach: (id: string, edge: WorkspaceEdge) => void;
}

interface AgentSlot {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

interface TabHitZone {
	start: number;
	end: number;
	id?: string;
	direction?: -1 | 1;
}

const CHROME_ROWS = 2;
const MIN_SLOT_WIDTH = 36;
const MIN_SLOT_HEIGHT = 11;

/** A stable, two-slot viewport over an insertion-ordered collection of agent transcripts. */
export class AutoAgentDock
	implements Component, Focusable, MouseRoutable, TargetedRender, ViewportHeightAware, AppViewportHoverProvider
{
	readonly #options: AutoAgentDockOptions;
	readonly #viewers = new Map<string, AgentTranscriptViewer>();
	// Keep logical sides even when one slot temporarily takes the entire viewport.
	readonly #slots: [string | undefined, string | undefined] = [undefined, undefined];
	#activeSlot: 0 | 1 = 0;
	#focused = false;
	#useTerminalCursor = false;
	#width = 0;
	#height = 0;
	#frame: AgentSlot[] = [];
	#tabOffset = 0;
	#tabHits: TabHitZone[] = [];
	#hoveredId: string | undefined;
	#selectionId: string | undefined;
	#drag: { id: string; row: number; col: number; active: boolean } | undefined;
	#disposed = false;
	readonly #cache = new Map<string, { width: number; height: number; focused: boolean; lines: readonly string[] }>();

	constructor(options: AutoAgentDockOptions) {
		this.#options = options;
	}

	get size(): number {
		return this.#viewers.size;
	}

	getViewer(id: string): AgentTranscriptViewer | undefined {
		return this.#viewers.get(id);
	}

	get focusedAgentId(): string | undefined {
		return this.#slots[this.#activeSlot];
	}

	get visibleAgentIds(): readonly string[] {
		// Registration/status events can precede the dock's first painted frame.
		if (this.#width === 0) return this.focusedAgentId ? [this.focusedAgentId] : [];
		return this.#layout().map(slot => slot.id);
	}

	get debugChildren(): readonly Component[] {
		return [...this.#viewers.values()];
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(focused: boolean) {
		this.#focused = focused;
		this.#syncFocus();
		if (!focused) this.clearAppViewportHover();
	}

	add(id: string, viewer: AgentTranscriptViewer): void {
		if (this.#disposed) throw new Error("Cannot add an agent to a disposed dock");
		if (this.#viewers.has(id)) {
			if (this.#viewers.get(id) !== viewer) throw new Error(`Duplicate dock agent: ${id}`);
			return;
		}
		if ([...this.#viewers.values()].includes(viewer)) throw new Error("Viewer already belongs to this dock");
		this.#viewers.set(id, viewer);
		const vacant = this.#slots.indexOf(undefined);
		if (vacant >= 0) this.#slots[vacant] = id;
		if (!this.focusedAgentId) this.#activeSlot = vacant === 1 ? 1 : 0;
		viewer.focused = false;
		viewer.setUseTerminalCursor(this.#useTerminalCursor);
		this.#syncFocus();
		this.#options.requestRender();
	}

	/** Transfer ownership without disposing the viewer or changing a surviving agent's logical side. */
	remove(id: string): AgentTranscriptViewer | undefined {
		const viewer = this.#viewers.get(id);
		if (!viewer) return undefined;
		this.#viewers.delete(id);
		this.#cache.delete(id);
		if (this.#selectionId === id) this.setTextSelectionActive(false);
		if (this.#hoveredId === id) this.#hoveredId = undefined;
		if (this.#drag?.id === id) this.#drag = undefined;
		viewer.setTextSelectionActive(false);
		viewer.clearAppViewportHover();
		viewer.focused = false;
		const index = this.#slots.indexOf(id);
		if (index >= 0) {
			this.#slots[index] = undefined;
			this.#slots[index] = [...this.#viewers.keys()].find(candidate => !this.#slots.includes(candidate));
		}
		if (!this.focusedAgentId) this.#activeSlot = this.#slots[0] ? 0 : 1;
		this.#frame = this.#frame.filter(slot => slot.id !== id);
		this.#syncFocus();
		this.#options.requestRender();
		return viewer;
	}

	has(id: string): boolean {
		return this.#viewers.has(id);
	}

	focusAgent(id: string): boolean {
		if (!this.#viewers.has(id)) return false;
		const index = this.#slots.indexOf(id);
		if (index >= 0) this.#activeSlot = index === 0 ? 0 : 1;
		else this.#slots[this.#activeSlot] = id;
		this.setTextSelectionActive(false);
		this.clearAppViewportHover();
		this.#drag = undefined;
		this.#syncFocus();
		this.#ensureTabVisible(id);
		this.#options.requestRender();
		return true;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
		for (const viewer of this.#viewers.values()) viewer.setUseTerminalCursor(useTerminalCursor);
	}

	setViewportHeight(height: number): void {
		this.#height = Math.max(0, Math.trunc(height));
		this.#syncFocus();
	}

	#syncFocus(): void {
		const selected = this.focusedAgentId;
		for (const [id, viewer] of this.#viewers) {
			const focused = this.#focused && id === selected;
			// Assigning true is meaningful to viewers: it abandons their auto-close animation.
			if (viewer.focused !== focused) viewer.focused = focused;
		}
	}

	#layout(): AgentSlot[] {
		if (this.#width <= 0 || this.#height <= CHROME_ROWS) return [];
		const height = this.#height - CHROME_ROWS;
		const canSplit =
			this.#options.axis === "x"
				? this.#width >= MIN_SLOT_WIDTH * 2 + 1 && height >= MIN_SLOT_HEIGHT
				: this.#width >= MIN_SLOT_WIDTH && height >= MIN_SLOT_HEIGHT * 2 + 1;
		const first = this.#slots[0];
		const second = this.#slots[1];
		if (!canSplit || !first || !second) {
			const id = this.focusedAgentId ?? first ?? second;
			return id ? [{ id, x: 0, y: CHROME_ROWS, width: this.#width, height }] : [];
		}
		if (this.#options.axis === "x") {
			const leftWidth = Math.floor((this.#width - 1) / 2);
			return [
				{ id: first, x: 0, y: CHROME_ROWS, width: leftWidth, height },
				{ id: second, x: leftWidth + 1, y: CHROME_ROWS, width: this.#width - leftWidth - 1, height },
			];
		}
		const topHeight = Math.floor((height - 1) / 2);
		return [
			{ id: first, x: 0, y: CHROME_ROWS, width: this.#width, height: topHeight },
			{ id: second, x: 0, y: CHROME_ROWS + topHeight + 1, width: this.#width, height: height - topHeight - 1 },
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "alt+left") || matchesKey(data, "alt+right")) {
			const ids = [...this.#viewers.keys()];
			if (ids.length < 2) return;
			const index = ids.indexOf(this.focusedAgentId ?? "");
			const delta = matchesKey(data, "alt+left") ? -1 : 1;
			this.focusAgent(ids[(index + delta + ids.length) % ids.length]!);
			return;
		}
		const id = this.focusedAgentId;
		if (id) this.#viewers.get(id)?.handleInput(data);
	}

	wantsAppViewportHover(): boolean {
		return this.#drag !== undefined || this.#frame.some(slot => this.#viewers.get(slot.id)?.wantsAppViewportHover());
	}

	clearAppViewportHover(): void {
		if (this.#hoveredId) this.#viewers.get(this.#hoveredId)?.clearAppViewportHover();
		this.#hoveredId = undefined;
	}

	wantsMouseCapture(): boolean {
		return this.#drag !== undefined;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		line = Math.floor(line);
		col = Math.floor(col);
		const drag = this.#drag;
		if (drag) {
			if (event.release) {
				this.#drag = undefined;
				const edge = this.#outsideEdge(line, col);
				if (edge && (drag.active || line !== drag.row || col !== drag.col)) this.#options.onDetach(drag.id, edge);
				this.#options.requestRender();
			} else if (event.motion) {
				drag.active ||= line !== drag.row || col !== drag.col;
			}
			return true;
		}
		if (event.motion && line < CHROME_ROWS) this.clearAppViewportHover();
		if (line === 0) {
			if (event.leftClick && col >= Math.max(0, this.#width - 3)) this.#options.onClose();
			return true;
		}
		if (line === 1) {
			if (event.wheel !== null) this.#pageTabs(event.wheel);
			if (event.leftClick) {
				const hit = this.#tabHits.find(zone => col >= zone.start && col < zone.end);
				if (hit?.id !== undefined) this.focusAgent(hit.id);
				else if (hit?.direction) this.#pageTabs(hit.direction);
			}
			return true;
		}
		const slot = this.#slotAt(line, col);
		if (event.motion && this.#hoveredId !== slot?.id) {
			this.clearAppViewportHover();
			this.#hoveredId = slot?.id;
		}
		if (!slot) return false;
		if (event.leftClick) this.focusAgent(slot.id);
		if (line === slot.y) {
			this.clearAppViewportHover();
			if (event.leftClick) {
				if (col >= slot.x + slot.width - 3) this.#options.onCloseAgent(slot.id);
				else this.#drag = { id: slot.id, row: line, col, active: false };
			}
			return true;
		}
		return this.#viewers.get(slot.id)?.routeMouse(event, line - slot.y - 1, col - slot.x) ?? false;
	}

	#outsideEdge(row: number, col: number): WorkspaceEdge | undefined {
		if (col < 0) return "left";
		if (col >= this.#width) return "right";
		if (row < 0) return "top";
		if (row >= this.#height) return "bottom";
		return undefined;
	}

	#slotAt(row: number, col: number): AgentSlot | undefined {
		return this.#frame.find(
			slot => row >= slot.y && row < slot.y + slot.height && col >= slot.x && col < slot.x + slot.width,
		);
	}

	setTextSelectionActive(active: boolean): void {
		if (!active) {
			if (this.#selectionId) this.#viewers.get(this.#selectionId)?.setTextSelectionActive(false);
			this.#selectionId = undefined;
			return;
		}
		this.#selectionId ??= this.focusedAgentId;
		if (this.#selectionId) this.#viewers.get(this.#selectionId)?.setTextSelectionActive(true);
	}

	setAppViewportTextSelectionActive(active: boolean, row?: number, col?: number): void {
		this.setTextSelectionActive(false);
		if (!active || row === undefined || col === undefined) return;
		const slot = this.#slotAt(row, col);
		if (!slot || row === slot.y) return;
		this.#selectionId = slot.id;
		this.setTextSelectionActive(true);
	}

	getAppViewportTextSelectionRect(row: number, col: number): AppViewportTextSelectionRect | undefined {
		const slot = this.#slotAt(row, col);
		if (!slot || row === slot.y) return undefined;
		const viewer = this.#viewers.get(slot.id)!;
		const localRow = row - slot.y - 1;
		const scrollable = viewer.getTextSelectionScrollOffset(localRow) !== undefined;
		let start = localRow;
		let end = localRow;
		while (start > 0 && (viewer.getTextSelectionScrollOffset(start - 1) !== undefined) === scrollable) start--;
		while (end < slot.height - 2 && (viewer.getTextSelectionScrollOffset(end + 1) !== undefined) === scrollable)
			end++;
		const left = Math.max(0, Math.min(viewer.getTextSelectionInset(localRow), slot.width - 1));
		const right = Math.max(0, Math.min(viewer.getTextSelectionRightInset(localRow), slot.width - left - 1));
		return { row: slot.y + 1 + start, col: slot.x + left, width: slot.width - left - right, height: end - start + 1 };
	}

	getAppViewportTextSelectionScrollOffset(row: number, col: number): number | undefined {
		const slot = this.#slotAt(row, col);
		return slot && row > slot.y
			? this.#viewers.get(slot.id)?.getTextSelectionScrollOffset(row - slot.y - 1)
			: undefined;
	}

	getAppViewportTextSelection(selection: TextSelectionRange): string | undefined {
		return this.getTextSelection(selection);
	}

	getTextSelection(selection: TextSelectionRange): string | undefined {
		const slot = this.#selectionId
			? this.#frame.find(candidate => candidate.id === this.#selectionId)
			: this.#slotAt(selection.start.row, selection.start.col);
		if (!slot) return undefined;
		if (!this.#selectionId && (selection.start.row <= slot.y || selection.end.row <= slot.y)) return undefined;
		if (
			selection.start.col < slot.x ||
			selection.end.col < slot.x ||
			selection.start.col >= slot.x + slot.width ||
			selection.end.col >= slot.x + slot.width
		)
			return undefined;
		if (!this.#selectionId && this.#slotAt(selection.end.row, selection.end.col)?.id !== slot.id) return undefined;
		return this.#viewers.get(slot.id)?.getTextSelection({
			start: { row: selection.start.row - slot.y - 1, col: selection.start.col - slot.x },
			end: { row: selection.end.row - slot.y - 1, col: selection.end.col - slot.x },
		});
	}

	#selectionSlot(row: number): AgentSlot | undefined {
		return this.#frame.find(
			slot =>
				row > slot.y &&
				row < slot.y + slot.height &&
				(this.#options.axis === "y" || slot.id === (this.#selectionId ?? this.focusedAgentId)),
		);
	}

	getTextSelectionInset(row: number): number {
		const slot = this.#selectionSlot(row);
		return slot ? slot.x + this.#viewers.get(slot.id)!.getTextSelectionInset(row - slot.y - 1) : this.#width;
	}

	getTextSelectionRightInset(row: number): number {
		const slot = this.#selectionSlot(row);
		return slot
			? this.#width - slot.x - slot.width + this.#viewers.get(slot.id)!.getTextSelectionRightInset(row - slot.y - 1)
			: 0;
	}

	getTextSelectionScrollOffset(row: number): number | undefined {
		const slot = this.#selectionSlot(row);
		return slot ? this.#viewers.get(slot.id)!.getTextSelectionScrollOffset(row - slot.y - 1) : undefined;
	}

	containsComponent(component: Component): boolean {
		for (const viewer of this.#viewers.values()) if (componentContains(viewer, component)) return true;
		return false;
	}

	render(width: number): readonly string[] {
		return this.#render(width);
	}

	renderTargeted(width: number, targets: readonly Component[]): readonly string[] {
		return targets.length > 0 && targets.every(target => this.containsComponent(target))
			? this.#render(width, targets)
			: this.render(width);
	}

	#render(width: number, targets?: readonly Component[]): readonly string[] {
		this.#width = Math.max(0, Math.trunc(width));
		const previous = this.#frame;
		this.#frame = this.#layout();
		for (const slot of previous) {
			if (this.#frame.some(current => current.id === slot.id)) continue;
			this.#viewers.get(slot.id)?.clearAppViewportHover();
			this.#cache.delete(slot.id);
			if (this.#selectionId === slot.id) this.setTextSelectionActive(false);
		}
		if (this.#height === 0 || this.#width === 0) return [];
		const lines = Array.from({ length: this.#height }, () => padding(this.#width));
		const close = this.#fit(theme.fg("muted", "[x]"), Math.min(3, this.#width));
		lines[0] =
			this.#fit(theme.fg("muted", `Agents ${this.size} · Alt+←/→ · drag out`), Math.max(0, this.#width - 3)) + close;
		if (this.#height > 1) lines[1] = this.#renderTabs();
		const rendered = this.#frame.map(slot => {
			const viewer = this.#viewers.get(slot.id)!;
			const focused = this.#focused && slot.id === this.focusedAgentId;
			const ownTargets = targets?.filter(target => componentContains(viewer, target));
			const cached = this.#cache.get(slot.id);
			if (
				targets &&
				ownTargets?.length === 0 &&
				cached?.width === slot.width &&
				cached.height === slot.height &&
				cached.focused === focused
			)
				return cached.lines;
			viewer.setViewportHeight(Math.max(0, slot.height - 1));
			const body = ownTargets?.length ? renderTargeted(viewer, slot.width, ownTargets) : viewer.render(slot.width);
			const header = viewer.renderWorkspaceHeader(Math.max(1, slot.width - 3), focused);
			const rows = [
				this.#fit(header, Math.max(0, slot.width - 3)) +
					this.#fit(theme.fg("muted", "[x]"), Math.min(3, slot.width)),
			];
			for (let row = 0; row < slot.height - 1; row++) rows.push(this.#fit(body[row] ?? "", slot.width));
			this.#cache.set(slot.id, { width: slot.width, height: slot.height, focused, lines: rows });
			return rows;
		});
		if (this.#options.axis === "x" && this.#frame.length === 2) {
			const left = this.#frame[0]!;
			for (let row = 0; row < left.height; row++)
				lines[left.y + row] = `${rendered[0]![row]}${theme.fg("dim", "│")}${rendered[1]![row]}`;
		} else {
			for (let index = 0; index < this.#frame.length; index++) {
				const slot = this.#frame[index]!;
				for (let row = 0; row < slot.height; row++) lines[slot.y + row] = rendered[index]![row]!;
			}
			if (this.#frame.length === 2) lines[this.#frame[1]!.y - 1] = theme.fg("dim", "─".repeat(this.#width));
		}
		return lines;
	}

	#fit(line: string, width: number): string {
		if (width <= 0) return "";
		const text = truncateToWidth(line, width);
		return (
			text +
			padding(Math.max(0, width - visibleWidth(text))) +
			(line.includes("\x1b") ? TERMINAL_STATE_TERMINATOR : "")
		);
	}

	#ensureTabVisible(id: string): void {
		if (this.#tabHits.some(hit => hit.id === id)) return;
		this.#tabOffset = Math.max(0, [...this.#viewers.keys()].indexOf(id));
	}

	#pageTabs(direction: -1 | 1): void {
		const count = this.size;
		if (count === 0) return;
		this.#tabOffset = (this.#tabOffset + direction + count) % count;
		this.#options.requestRender();
	}

	#renderTabs(): string {
		this.#tabHits = [];
		const ids = [...this.#viewers.keys()];
		if (ids.length === 0) return padding(this.#width);
		this.#tabOffset = Math.min(this.#tabOffset, ids.length - 1);
		// A fixed-height, paged strip avoids growing the dock chrome with the queue.
		const paged = ids.length > 1 && this.#width >= 9;
		let line = paged ? theme.fg("muted", " < ") : "";
		let col = paged ? 3 : 0;
		const end = this.#width - (paged ? 3 : 0);
		if (paged) this.#tabHits.push({ start: 0, end: 3, direction: -1 });
		const visible = this.visibleAgentIds;
		for (let index = this.#tabOffset; index < ids.length && col < end; index++) {
			const id = ids[index]!;
			const label = ` ${visible.includes(id) ? "●" : "○"} ${sanitizeStatusText(id)} `;
			const tabWidth = Math.min(24, visibleWidth(label), end - col);
			if (index > this.#tabOffset && tabWidth < Math.min(8, visibleWidth(label))) break;
			const text = this.#fit(label, tabWidth);
			line +=
				id === this.focusedAgentId ? theme.bg("selectedBg", theme.fg("accent", text)) : theme.fg("muted", text);
			this.#tabHits.push({ start: col, end: col + tabWidth, id });
			col += tabWidth;
		}
		line += padding(Math.max(0, end - col));
		if (paged) {
			line += theme.fg("muted", " > ");
			this.#tabHits.push({ start: end, end: this.#width, direction: 1 });
		}
		return this.#fit(line, this.#width);
	}

	invalidate(): void {
		this.#cache.clear();
		for (const viewer of this.#viewers.values()) viewer.invalidate();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#drag = undefined;
		this.setTextSelectionActive(false);
		this.clearAppViewportHover();
		for (const viewer of this.#viewers.values()) viewer.dispose();
		this.#viewers.clear();
		this.#cache.clear();
		this.#slots[0] = undefined;
		this.#slots[1] = undefined;
		this.#frame = [];
	}
}
