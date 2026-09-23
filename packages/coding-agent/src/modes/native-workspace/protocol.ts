import type { TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";

export interface NativePaneTerminalState {
	columns: number;
	rows: number;
	kittyProtocolActive: boolean;
	kittyEnableSequence: string | null;
	keyboardEnhancementEnterSequence: string | null;
	keyboardEnhancementExitSequence: string | null;
	hostOwnsGridOnResize: boolean;
	appearance?: TerminalAppearance;
}

export type NativePaneToHost =
	| { type: "state"; state: NativePaneTerminalState }
	| { type: "hello"; hello: TspHello | null }
	| { type: "input"; data: string }
	| { type: "appearance"; appearance: TerminalAppearance; token?: TerminalAppearanceRequestToken };

export type NativePaneToRelay =
	| { type: "write"; data: string }
	| { type: "stop" }
	| { type: "move"; lines: number }
	| { type: "hide-cursor"; force?: boolean }
	| { type: "show-cursor"; force?: boolean }
	| { type: "clear-line" }
	| { type: "clear-from-cursor" }
	| { type: "clear-screen" }
	| { type: "title"; title: string }
	| { type: "progress"; active: boolean }
	| { type: "refresh-appearance"; token?: TerminalAppearanceRequestToken };
