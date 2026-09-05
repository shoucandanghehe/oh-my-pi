import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import {
	PauseScreenComponent,
	type PauseScreenHost,
	renderPauseScreen,
	runPauseScreen,
} from "../../../src/modes/components/pause-screen";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

// Strip SGR colors so assertions see visible text only.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

interface FakeHost {
	host: PauseScreenHost;
	shown: Component[];
	statuses: string[];
	hiddenCount(): number;
	pausedExitCount(): number;
}

function makeHost(rows = 24): FakeHost {
	const shown: Component[] = [];
	const statuses: string[] = [];
	let pausedExits = 0;
	let hidden = 0;
	const host: PauseScreenHost = {
		ui: {
			showOverlay(component) {
				shown.push(component);
				return {
					hide() {
						hidden++;
					},
				} as never;
			},
			setFocus() {},
			requestRender() {},
			terminal: { rows },
		},
		showStatus(message) {
			statuses.push(message);
		},
		session: {
			async disposeForPausedExit() {
				pausedExits++;
			},
		},
	};
	return { host, shown, statuses, hiddenCount: () => hidden, pausedExitCount: () => pausedExits };
}

describe("pause screen", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	describe("renderPauseScreen", () => {
		it("shows PAUSED when ready with exit hint", () => {
			const lines = renderPauseScreen(80, 24, {
				elapsedMs: 65_000,
				activeLoops: 2,
				parkedLoops: 2,
				ready: true,
			});
			expect(lines.length).toBe(24);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("P A U S E D");
			expect(text).toContain("Main agent, subagents, and advisor");
			expect(text).toContain("paused for 1:05");
			expect(text).toContain("paused · all 2 loops at model boundary");
			expect(text).toContain("esc · enter · space — resume");
			expect(text).toContain("q — exit paused");
			expect(text).toContain("█".repeat(5));
		});

		it("shows PAUSING while waiting for the barrier", () => {
			const lines = renderPauseScreen(40, 10, {
				elapsedMs: 3_000,
				activeLoops: 1,
				parkedLoops: 0,
				ready: false,
			});
			expect(lines.length).toBe(10);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("▌▌ P A U S I N G");
			expect(text).toContain("paused for 0:03");
			expect(text).toContain("pausing · 0/1 at model boundary");
			expect(text).toContain("esc to resume");
			expect(text).not.toContain("█".repeat(5));
		});

		it("rolls the clock into hours past 60 minutes", () => {
			const text = renderPauseScreen(80, 24, {
				elapsedMs: 3_725_000,
				activeLoops: 0,
				parkedLoops: 0,
				ready: true,
			})
				.map(stripAnsi)
				.join("\n");
			expect(text).toContain("paused for 1:02:05");
		});

		it("displays the session name when provided in full mode", () => {
			const lines = renderPauseScreen(80, 24, {
				elapsedMs: 65_000,
				sessionName: "My Awesome Session",
				activeLoops: 0,
				parkedLoops: 0,
				ready: true,
			});
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("My Awesome Session");
			expect(text).toContain("P A U S E D");
		});

		it("displays the session name when provided in compact mode", () => {
			const lines = renderPauseScreen(40, 10, {
				elapsedMs: 3_000,
				sessionName: "Compact Session Title",
				activeLoops: 0,
				parkedLoops: 0,
				ready: true,
			});
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("Compact Session Title");
			expect(text).toContain("▌▌ P A U S E D");
		});
	});

	describe("runPauseScreen", () => {
		it("engages the gate for the screen's lifetime and releases it on escape", async () => {
			const { host, shown, statuses, hiddenCount } = makeHost();
			expect(agentPauseGate.paused).toBe(false);

			const run = runPauseScreen(host);
			await Bun.sleep(1);
			expect(agentPauseGate.paused).toBe(true);
			expect(shown.length).toBe(1);

			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x1b"); // escape → resume
			}
			await run;

			expect(agentPauseGate.paused).toBe(false);
			expect(hiddenCount()).toBe(1);
			expect(statuses.some(message => message.includes("Resumed after"))).toBe(true);
		});

		it("treats ctrl+c as resume, never as abort-and-stay-paused", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host);
			await Bun.sleep(1);

			const component = shown[0];
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x03"); // ctrl+c
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});

		it("is a no-op when the gate is already engaged elsewhere", async () => {
			agentPauseGate.pause();
			const { host, shown } = makeHost();
			await runPauseScreen(host); // must resolve immediately, not park
			expect(shown.length).toBe(0);
			expect(agentPauseGate.paused).toBe(true); // foreign pause not stolen
		});

		it("exits paused only when the barrier is ready", async () => {
			const { host, shown, pausedExitCount, statuses } = makeHost();
			const run = runPauseScreen(host);
			await Bun.sleep(1);

			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (!(component instanceof PauseScreenComponent)) throw new Error("expected PauseScreenComponent");

			// No active loops → ready immediately; q should exit paused.
			expect(agentPauseGate.ready).toBe(true);
			component.handleInput("q");
			const outcome = await run;
			expect(outcome).toBe("exited");
			expect(pausedExitCount()).toBe(1);
			expect(agentPauseGate.paused).toBe(false);
			expect(statuses.some(message => message.includes("Resumed after"))).toBe(false);
		});
	});
});
