import { describe, expect, it, vi } from "bun:test";
import { TerminalActivityController } from "@oh-my-pi/pi-coding-agent/modes/controllers/terminal-activity-controller";

describe("TerminalActivityController", () => {
	it("prioritizes attention without ending progress owned by concurrent work", () => {
		const setProgress = vi.fn();
		const setTitleState = vi.fn();
		const controller = new TerminalActivityController({
			isProgressEnabled: () => true,
			setProgress,
			setTitleState,
		});
		const workingOwner = {};
		const attentionOwner = {};

		controller.set(workingOwner, "working");
		controller.set(attentionOwner, "attention");
		controller.release(attentionOwner);
		controller.release(workingOwner);

		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false]);
		expect(setTitleState.mock.calls.map(call => call[0])).toEqual(["working", "attention", "working", "idle"]);
	});
});
