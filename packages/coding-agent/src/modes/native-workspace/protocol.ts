import type { InputEvent, TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";

export const NATIVE_PANE_WORKER_ARG = "__omp_worker_native_pane";

export interface NativePaneTerminalState {
	readonly columns: number;
	readonly rows: number;
	readonly capabilities: TerminalCapabilities;
}

export type NativePaneToHost =
	| { type: "ready"; state: NativePaneTerminalState }
	| { type: "resize"; columns: number; rows: number }
	| { type: "capabilities"; capabilities: TerminalCapabilities }
	| { type: "input"; event: InputEvent };

export type NativePaneToRelay = { type: "write"; data: string } | { type: "title"; title: string } | { type: "stop" };
