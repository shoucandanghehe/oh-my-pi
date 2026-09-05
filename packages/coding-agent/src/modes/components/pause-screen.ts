/**
 * Fullscreen `/pause` screen.
 *
 * `/pause` engages the process-global {@link agentPauseGate}, freezing every
 * agent loop in the process (main agent, in-process subagents, advisor) before
 * its next model call — nothing is aborted, so a later resume continues exactly
 * where each loop parked. The screen shows PAUSING until every active loop has
 * reached that barrier (`ready`), then PAUSED and allows a durable process exit.
 *
 * Keys:
 * - esc / enter / space / ctrl+c — resume in-process (releases the gate)
 * - q — only when ready: write `agents_paused`, dispose with pausedExit, quit
 *
 * Use case: freeze a busy session, hand-edit the repo, resume — or exit and
 * later `omp --resume` then `/continue` to restart from the durable tail.
 */
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatDuration } from "../../slash-commands/helpers/format";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";

/**
 * Slice of `InteractiveModeContext` the pause screen drives. Narrow so tests
 * can exercise the full engage → hold → release lifecycle without a real TUI.
 */
export interface PauseScreenHost {
	ui: {
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
		setFocus(component: Component): void;
		requestRender(): void;
		readonly terminal: { readonly rows: number };
	};
	showStatus(message: string, options?: { dim?: boolean }): void;
	readonly sessionName?: string;
	/** Durable session owner for barrier exit. */
	session: {
		disposeForPausedExit(): Promise<void>;
	};
	/** Optional: process quit after durable pause exit. Defaults to no-op. */
	quitAfterPausedExit?: () => Promise<void> | void;
}

/** Refresh cadence for the live "paused for" / barrier clock. */
const TICK_MS = 250;

/** Pause-bar glyph geometry (rows × columns of full blocks per bar). */
const BAR_ROWS = 7;
const BAR_WIDTH = 5;
const BAR_GAP = 4;

/** Below either bound the full scene cannot breathe; drop to the compact card. */
const MIN_FULL_WIDTH = 64;
const MIN_FULL_HEIGHT = 18;

const TITLE_PAUSED = "P A U S E D";
const TITLE_PAUSING = "P A U S I N G";
const BODY_LINES = [
	"Main agent, subagents, and advisor hold before the next model call.",
	"In-flight tools finish; nothing new starts until you resume or exit.",
] as const;

export type PauseScreenOutcome = "resumed" | "exited";

function centerLine(line: string, width: number): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	return pad > 0 ? " ".repeat(pad) + line : line;
}

/** Live hold clock, seconds-precise: `0:07`, `12:34`, `1:02:03`. */
function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface PauseScreenRenderState {
	elapsedMs: number;
	sessionName?: string;
	activeLoops: number;
	parkedLoops: number;
	ready: boolean;
}

/**
 * Paint the pause scene as exactly `height` rows, vertically centered.
 * Exported for tests.
 */
export function renderPauseScreen(width: number, height: number, state: PauseScreenRenderState): string[] {
	const compact = width < MIN_FULL_WIDTH || height < MIN_FULL_HEIGHT;
	const content: string[] = [];
	const title = state.ready ? TITLE_PAUSED : TITLE_PAUSING;
	const barrierLabel =
		state.activeLoops === 0
			? "no active agent loops — ready"
			: state.ready
				? `paused · all ${state.activeLoops} loop${state.activeLoops === 1 ? "" : "s"} at model boundary`
				: `pausing · ${state.parkedLoops}/${state.activeLoops} at model boundary`;
	const resumeHint = state.ready
		? "esc · enter · space — resume   q — exit paused (resume later with /continue)"
		: "esc · enter · space — resume   (exit when all loops park)";

	if (compact) {
		if (state.sessionName) {
			content.push(centerLine(theme.bold(state.sessionName), width));
			content.push("");
		}
		content.push(centerLine(theme.bold(theme.fg("accent", `▌▌ ${title}`)), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(state.elapsedMs)}`), width));
		content.push(centerLine(theme.fg(state.ready ? "success" : "warning", barrierLabel), width));
		content.push(centerLine(theme.fg("dim", state.ready ? "esc resume · q exit" : "esc to resume"), width));
	} else {
		if (state.sessionName) {
			content.push(centerLine(theme.bold(state.sessionName), width));
			content.push("");
			content.push("");
		}
		const bar = "█".repeat(BAR_WIDTH);
		const glyphRow = `${bar}${" ".repeat(BAR_GAP)}${bar}`;
		for (let i = 0; i < BAR_ROWS; i++) {
			content.push(centerLine(theme.fg("accent", glyphRow), width));
		}
		content.push("");
		content.push(centerLine(theme.bold(theme.fg("accent", title)), width));
		content.push("");
		for (const line of BODY_LINES) {
			content.push(centerLine(theme.fg("muted", line), width));
		}
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(state.elapsedMs)}`), width));
		content.push(centerLine(theme.fg(state.ready ? "success" : "warning", barrierLabel), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", resumeHint), width));
	}

	const topPad = Math.max(0, Math.floor((height - content.length) / 2));
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const lines: string[] = new Array(topPad).fill("");
	lines.push(...content);
	while (lines.length < height) lines.push("");
	return lines.slice(0, Math.max(1, height));
}

/** Fullscreen overlay component; resolves {@link run} when a resume/exit key lands. */
export class PauseScreenComponent implements Component, OverlayFocusOwner {
	#timer: NodeJS.Timeout | undefined;
	#done = Promise.withResolvers<PauseScreenOutcome>();
	#disposed = false;
	#startedAt = Date.now();
	#outcome: PauseScreenOutcome | undefined;
	#unsubWaiters: (() => void) | undefined;

	constructor(readonly host: PauseScreenHost) {}

	/** Start the clock; resolves once the user asks to resume or exit paused. */
	run(): Promise<PauseScreenOutcome> {
		this.#startedAt = agentPauseGate.pausedAt ?? Date.now();
		this.#timer ??= setInterval(() => {
			if (!this.#disposed) this.host.ui.requestRender();
		}, TICK_MS);
		this.#unsubWaiters = agentPauseGate.onWaitersChange(() => {
			if (!this.#disposed) this.host.ui.requestRender();
		});
		this.host.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		this.#unsubWaiters?.();
		this.#unsubWaiters = undefined;
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	handleInput(data: string): void {
		if (this.#disposed || this.#outcome) return;

		// Durable exit only after every active loop has parked at the model boundary.
		if (matchesKey(data, "q")) {
			if (!agentPauseGate.ready) {
				this.host.showStatus("Still waiting for all agents to reach the model boundary…", { dim: true });
				return;
			}
			this.#outcome = "exited";
			this.#done.resolve("exited");
			return;
		}

		// Every other dismissal path resumes — including ctrl+c, which must never
		// double as "abort agents" while the whole point of the screen is that
		// nothing gets lost.
		if (
			matchesAppInterrupt(data) ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			matchesKey(data, "space") ||
			matchesKey(data, "ctrl+c")
		) {
			this.#outcome = "resumed";
			this.#done.resolve("resumed");
		}
	}

	render(width: number): readonly string[] {
		const elapsed = Date.now() - this.#startedAt;
		return renderPauseScreen(Math.max(1, width), Math.max(1, this.host.ui.terminal.rows), {
			elapsedMs: elapsed,
			sessionName: this.host.sessionName,
			activeLoops: agentPauseGate.activeLoopCount,
			parkedLoops: agentPauseGate.modelWaiterCount,
			ready: agentPauseGate.ready,
		});
	}
}

/**
 * Engage the global pause gate and hold the fullscreen pause screen until the
 * user resumes or exits while paused. No-op when the gate is already engaged.
 * On resume, always releases the gate on the way out (including teardown throws)
 * — a leaked pause would freeze every agent in the process with no UI left to
 * release it. On exit, the gate is released only after the session owner has
 * persisted and silently ended every parked loop.
 */
export async function runPauseScreen(host: PauseScreenHost): Promise<PauseScreenOutcome | undefined> {
	if (!agentPauseGate.pause()) return undefined;
	const component = new PauseScreenComponent(host);
	const overlay = host.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	let outcome: PauseScreenOutcome = "resumed";
	try {
		host.ui.setFocus(component);
		outcome = await component.run();
	} finally {
		component.dispose();
		host.ui.setFocus(component);
		overlay.hide();
	}

	if (outcome === "exited") {
		try {
			await host.session.disposeForPausedExit();
			await host.quitAfterPausedExit?.();
		} finally {
			// Loops were aborted with PAUSE_SHUTDOWN_ABORT_REASON; release the gate
			// so any stray waiter does not outlive the process.
			agentPauseGate.resume();
		}
		return "exited";
	}

	const heldMs = agentPauseGate.resume();
	if (heldMs !== undefined) {
		host.showStatus(`Resumed after ${formatDuration(heldMs)} — agents are running again.`);
	}
	return "resumed";
}
