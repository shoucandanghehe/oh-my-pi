import type { TspMenuEntry } from "@oh-my-pi/pi-wire";
import type { SpotlightDetails } from "./spotlight";

/**
 * A transcript message a turn action names: its role and when it was sent (its `timestamp`, ms), which the
 * host resolves to the session entry on the current branch.
 */
export interface TurnMessage {
	readonly role: "user" | "assistant";
	readonly at: number;
}

/**
 * What a turn's hold menu runs on its message: `edit` rewinds past the prompt and puts it in the editor
 * (Edit & resend), `retry` rewinds past the prompt and sends it again, `rewind` opens the rewind selector on
 * the message, `fork` copies the session up to the message into a new one.
 */
export type TurnAct = "edit" | "retry" | "rewind" | "fork";

/** Commands a transcript's own host supports. Missing commands have no controls. */
export interface TranscriptActions {
	copy?: (text: string) => void | Promise<void>;
	retry?: () => void | Promise<void>;
	switchModel?: () => void | Promise<void>;
	rewind?: () => void | Promise<void>;
	turn?: (turn: TurnAct, message: TurnMessage) => void | Promise<void>;
	resume?: (path: string) => void | Promise<void>;
	spotlight?: (details: SpotlightDetails, reduced: string) => void | Promise<void>;
}

let actions: TranscriptActions | undefined;

/** Configure the interactive Main host. Detached transcripts provide their own actions. */
export function setTranscriptActions(next: TranscriptActions | undefined): void {
	actions = next;
}

export function getTranscriptActions(): TranscriptActions | undefined {
	return actions;
}

/** The hold-menu action names of each {@link TurnAct}. */
const TURN_ACTS: Readonly<Record<string, TurnAct>> = {
	"edit-turn": "edit",
	"retry-turn": "retry",
	"rewind-turn": "rewind",
	"fork-turn": "fork",
};

/**
 * A turn's `actions.hold`: what a long press on it offers on a phone, led by its copy entry (`copy`), then
 * Edit & resend (a prompt's only), Retry turn, Rewind to here… and Fork from here. A desktop ignores it, so
 * the hover toolbars stay its controls.
 */
export function turnHoldEntries(role: TurnMessage["role"], copy: TspMenuEntry): TspMenuEntry[] {
	return [
		copy,
		...(role === "user" ? [{ id: "edit-turn", label: "Edit & resend", icon: "edit", detail: "To composer" }] : []),
		{ id: "retry-turn", label: "Retry turn", icon: "refresh" },
		{ id: "rewind-turn", label: "Rewind to here…", icon: "rewind" },
		{ id: "fork-turn", label: "Fork from here", icon: "branch", detail: "New session" },
	];
}

/** Runs hold-menu action `act` (a {@link turnHoldEntries} id) on `message`; false when `act` is no turn action. */
export function runTurnAction(act: string, message: TurnMessage, host = getTranscriptActions()): boolean {
	const turn = TURN_ACTS[act];
	if (!turn) return false;
	void host?.turn?.(turn, message);
	return true;
}
