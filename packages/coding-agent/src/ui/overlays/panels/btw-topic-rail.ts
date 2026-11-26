import { type AnsiWorkspaceRail, signal, UiNode } from "@oh-my-pi/pi-tui";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { padTo } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeDisplayLine } from "../../../extensibility/inventory/display-text";
import type { BtwThread } from "../../../session/btw-manager";

const SLIDE_FRAME_MS = 20;
const SLIDE_FRAMES = 6;
const LEAVE_GRACE_MS = 150;

interface RailOptions {
	rows(): number;
	threads(): readonly BtwThread[];
	selected(): string | undefined;
	blocked(): boolean;
	select(key: string): void;
	newThread(): void;
}

/** Preview changes only what is displayed; the manager is called solely on a click. */
export class BtwTopicRail implements AnsiWorkspaceRail {
	readonly preview = signal<string | undefined>(undefined);
	readonly #pinned = signal(false);
	readonly #fraction = signal(0);
	readonly #offset = signal(0);
	readonly #newHovered = signal(false);
	#disposed = false;
	#peeking = false;
	#slide: Timer | undefined;
	#leave: Timer | undefined;
	readonly node = new UiNode("canvas", { paint: (width: number) => this.#paint(width) });

	constructor(private readonly options: RailOptions) {}

	layout(columns: number): { width: number; inset: number } {
		if (columns < 2 || this.options.blocked()) return { width: 0, inset: 0 };
		const expanded = Math.min(Math.max(1, columns - 12), Math.max(14, Math.min(24, Math.floor(columns * 0.3))));
		const fraction = this.#fraction();
		const width = 1 + Math.round((expanded - 1) * fraction);
		// Opening a peek leaves the selected transcript in place. Once another topic is previewed,
		// its transcript and the existing draft need room beside the rail to stay readable.
		return { width, inset: (this.#pinned() && fraction === 1) || this.preview() !== undefined ? width : 1 };
	}

	pointer(mouse: MouseEvent, width: number): boolean {
		if (this.options.blocked()) return false;
		const { action, button, col, row } = mouse;
		const rows = this.options.rows();
		const handleDistance = Math.abs(row - this.#handleRow());
		if (action === "move") {
			if (!this.#pinned.peek() && this.options.threads().length && handleDistance <= 2 && col < 3) {
				this.#peek();
			}
			if (col < width) {
				clearTimeout(this.#leave);
				this.#leave = undefined;
				if (col > 0 && !this.#pinned.peek()) this.#peek();
				this.#newHovered.set(col > 0 && row === rows - 1);
				this.preview.set(col > 0 && row < rows - 1 ? this.options.threads()[this.#offset() + row]?.key : undefined);
				return true;
			}
			if (this.#peeking && col <= width + 2) {
				clearTimeout(this.#leave);
				this.#leave = undefined;
				return true;
			}
			this.leave();
		}
		if (action === "press" && button === "left" && col === 0 && handleDistance <= 1) {
			this.toggle();
			return true;
		}
		if (col >= width) {
			if (action === "press" && this.#peeking) this.dismiss();
			return false;
		}
		if (width > 1 && action === "press" && (button === "wheel-up" || button === "wheel-down")) {
			this.#setOffset(this.#offset() + (button === "wheel-up" ? -1 : 1));
			this.preview.set(row < rows - 1 ? this.options.threads()[this.#offset() + row]?.key : undefined);
		} else if (action === "press" && button === "left" && col > 0) {
			this.preview.set(undefined);
			if (row === rows - 1) this.options.newThread();
			else {
				const topic = this.options.threads()[this.#offset() + row];
				if (topic) this.options.select(topic.key);
			}
		}
		return true;
	}

	leave(): void {
		if (this.#disposed || this.#leave || !(this.#peeking || this.preview.peek() || this.#newHovered.peek())) return;
		this.#leave = setTimeout(() => this.clearHover(), LEAVE_GRACE_MS).unref();
	}

	toggle(): void {
		const pinned = !this.#pinned.peek();
		this.#pinned.set(pinned);
		this.clearHover();
		if (pinned) this.#animate(1);
	}

	dismiss(): boolean {
		const open = this.#pinned.peek() || this.#peeking || this.preview.peek() !== undefined;
		if (!open) return false;
		this.#pinned.set(false);
		this.clearHover();
		return true;
	}

	selectionChanged(key: string | undefined): void {
		this.preview.set(undefined);
		const index = this.options.threads().findIndex(thread => thread.key === key);
		const capacity = Math.max(1, this.options.rows() - 1);
		const offset = this.#offset();
		this.#setOffset(index < offset ? Math.max(0, index) : Math.max(offset, index - capacity + 1));
	}

	clearHover(): void {
		clearTimeout(this.#leave);
		this.#leave = undefined;
		this.#peeking = false;
		this.preview.set(undefined);
		this.#newHovered.set(false);
		if (!this.#pinned.peek()) this.#animate(0);
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#slide);
		clearTimeout(this.#leave);
	}

	#handleRow(): number {
		return Math.floor((this.options.rows() - 1) / 2);
	}

	#setOffset(offset: number): void {
		this.#offset.set(
			Math.max(0, Math.min(offset, this.options.threads().length - Math.max(1, this.options.rows() - 1))),
		);
	}

	#peek(): void {
		if (this.#peeking) return;
		this.#peeking = true;
		this.#animate(1);
	}

	#animate(target: number): void {
		clearInterval(this.#slide);
		const start = this.#fraction.peek();
		if (start === target) return;
		let frame = 0;
		this.#slide = setInterval(() => {
			const progress = ++frame / SLIDE_FRAMES;
			this.#fraction.set(progress >= 1 ? target : start + (target - start) * (1 - (1 - progress) ** 3));
			if (progress >= 1) clearInterval(this.#slide);
		}, SLIDE_FRAME_MS).unref();
	}

	#paint(width: number): readonly string[] {
		const theme = currentTheme();
		const rows = this.options.rows();
		const handle = this.#handleRow();
		const threads = this.options.threads();
		const selected = this.options.selected();
		const pinned = this.#pinned();
		return Array.from({ length: rows }, (_, row) => {
			const guide = row === handle ? theme.fg("accent", pinned ? "◀" : "▶") : theme.fg("dim", "│");
			if (width === 1) return guide;
			const topic = threads[this.#offset() + row];
			let line = "";
			if (row === rows - 1) {
				line = padTo(theme.fg("accent", " + New BTW"), width - 1);
				if (this.#newHovered()) line = theme.bg("selectedBg", line);
			} else if (topic) {
				const active = topic.key === selected;
				const preview = topic.key === this.preview();
				const glyph = topic.error ? "×" : topic.phase === "running" ? "●" : topic.unread ? "•" : "○";
				const tone = topic.error
					? "error"
					: topic.phase === "running"
						? "warning"
						: topic.unread
							? "accent"
							: "muted";
				const title = sanitizeDisplayLine(topic.title);
				const suffix = topic.unread ? ` · ${topic.unread}` : topic.draft ? " · draft" : "";
				line = padTo(`${active ? "▸" : preview ? "›" : " "}${theme.fg(tone, glyph)} ${title}${suffix}`, width - 1);
				if (active) line = theme.style("strong", line);
				if (preview) line = theme.bg("selectedBg", line);
			}
			return `${guide}${line}`;
		});
	}
}
