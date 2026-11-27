import { type KeyEvent, type ScrollRequest, signal } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "../../../config/keybindings/keybindings";
import { selectKeyId } from "../../../config/keybindings/matchers";

const SCROLL_KEYS: Readonly<Partial<Record<string, ScrollRequest["by"]>>> = {
	k: "line-up",
	up: "line-up",
	"shift+up": "line-up",
	j: "line-down",
	down: "line-down",
	"shift+down": "line-down",
	pageUp: "page-up",
	pageDown: "page-down",
	g: "start",
	home: "start",
	"shift+g": "end",
	end: "end",
};

export class NativePaneScroll {
	readonly request = signal<ScrollRequest | undefined>(undefined);

	constructor(
		private readonly supports: ((kind: string) => boolean) | undefined,
		private readonly keybindings: KeybindingsManager,
		private readonly showNotice: (message: string) => void,
	) {}

	handle(key: KeyEvent): boolean {
		if (!this.supports || key.kind === "release") return false;
		const by = SCROLL_KEYS[key.id] ?? SCROLL_KEYS[selectKeyId(key, this.keybindings)];
		if (!by) return false;
		if (!this.supports("scroll")) {
			this.showNotice("This terminal does not support keyboard transcript scrolling.");
			return true;
		}
		const steps = key.id === "shift+up" || key.id === "shift+down" ? 5 : 1;
		this.request.set({ by, n: (this.request.peek()?.n ?? 0) + steps });
		return true;
	}
}
