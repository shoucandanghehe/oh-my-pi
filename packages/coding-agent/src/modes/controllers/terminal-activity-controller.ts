import type { TerminalTitleState } from "../../utils/title-generator";

type ActiveTerminalTitleState = Exclude<TerminalTitleState, "idle">;

/**
 * Aggregates concurrent terminal activity owners into the process-wide progress
 * indicator and title state. Owners release independently, so one completed
 * operation cannot make another in-flight operation look idle.
 */
export class TerminalActivityController {
	#activities = new Map<object, ActiveTerminalTitleState>();
	#progressActive = false;
	#titleState: TerminalTitleState = "idle";

	constructor(
		private readonly output: {
			isProgressEnabled(): boolean;
			setProgress(active: boolean): void;
			setTitleState(state: TerminalTitleState): void;
		},
	) {}

	set(owner: object, state: ActiveTerminalTitleState): void {
		if (this.#activities.get(owner) === state) return;
		this.#activities.set(owner, state);
		this.#sync();
	}

	release(owner: object): void {
		if (!this.#activities.delete(owner)) return;
		this.#sync();
	}

	#sync(): void {
		const active = this.#activities.size > 0;
		if (active && !this.#progressActive && this.output.isProgressEnabled()) {
			this.output.setProgress(true);
			this.#progressActive = true;
		} else if (!active && this.#progressActive) {
			this.output.setProgress(false);
			this.#progressActive = false;
		}

		let titleState: TerminalTitleState = active ? "working" : "idle";
		for (const state of this.#activities.values()) {
			if (state === "attention") {
				titleState = "attention";
				break;
			}
		}
		if (titleState === this.#titleState) return;
		this.output.setTitleState(titleState);
		this.#titleState = titleState;
	}
}
