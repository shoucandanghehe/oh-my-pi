import type { KeyEvent, TranscriptControls } from "@oh-my-pi/pi-tui";
import type { SelectionMotion, TranscriptScroll } from "@oh-my-pi/pi-tui/term/backend";
import type { Keybinding } from "../../config/keybindings/app-keybindings";
import type { KeybindingsManager } from "../../config/keybindings/keybindings";

const SCROLL_KEYS: readonly (readonly [Keybinding, TranscriptScroll])[] = [
	["app.transcript.pageUp", "page-up"],
	["app.transcript.pageDown", "page-down"],
	["app.transcript.halfPageUp", "half-up"],
	["app.transcript.halfPageDown", "half-down"],
	["app.transcript.previousPrompt", "previous-prompt"],
	["app.transcript.nextPrompt", "next-prompt"],
	["app.transcript.lineUp", "line-up"],
	["app.transcript.lineDown", "line-down"],
	["app.transcript.top", "start"],
	["app.transcript.bottom", "end"],
];

const SELECTION_KEYS: readonly (readonly [Keybinding, SelectionMotion])[] = [
	["app.transcript.selectLeft", "left"],
	["app.transcript.selectRight", "right"],
	["app.transcript.selectUp", "up"],
	["app.transcript.selectDown", "down"],
	["app.transcript.selectLineStart", "line-start"],
	["app.transcript.selectLineEnd", "line-end"],
	["app.transcript.clearSelection", "clear"],
];

/** Bind one composer to its own fullscreen transcript without stealing submit or unhandled keys. */
export function handleTranscriptKey(
	key: KeyEvent,
	bindings: KeybindingsManager,
	transcript: TranscriptControls | undefined,
): boolean {
	if (!transcript || key.kind === "release") return false;
	if (bindings.matches(key, "tui.input.submit")) {
		transcript.scroll("end");
		return false;
	}
	if (bindings.matches(key, "app.transcript.search")) return transcript.openSearch();
	if (bindings.matches(key, "app.transcript.copySelection")) return transcript.copySelection();
	const by = SCROLL_KEYS.find(([action]) => bindings.matches(key, action))?.[1];
	if (by !== undefined) return transcript.scroll(by);
	const motion = SELECTION_KEYS.find(([action]) => bindings.matches(key, action))?.[1];
	return motion !== undefined && transcript.extendSelection(motion);
}
