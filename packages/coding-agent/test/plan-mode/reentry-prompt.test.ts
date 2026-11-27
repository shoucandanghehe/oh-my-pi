import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeActivePrompt from "../../src/prompts/system/plan-mode-active.md" with { type: "text" };

const BASE = {
	planFilePath: "local://old-feature-plan.md",
	askToolName: "ask",
	writeToolName: "write",
	editToolName: "edit",
	isHashlineEditMode: false,
	iterative: false,
	askAvailable: true,
	taskAvailable: true,
	scoutAvailable: true,
	reentry: false,
	planExists: true,
} as const;

type Overrides = Partial<Record<keyof typeof BASE, boolean | string>>;

function render(overrides: Overrides = {}): string {
	return prompt.render(planModeActivePrompt, { ...BASE, ...overrides });
}

describe("plan-mode re-entry prompt", () => {
	it("only emits the Re-entry section when re-entering", () => {
		expect(render({ reentry: false })).not.toContain("## Re-entry");
		expect(render({ reentry: true })).toContain("## Re-entry");
	});
});

describe("plan-mode-active tool availability", () => {
	it("asks only about material unresolved decisions when ask is available", () => {
		const withoutAsk = render({ askAvailable: false, iterative: true });
		expect(withoutAsk).not.toContain("use `ask`");

		const withAsk = render({ askAvailable: true, iterative: true });
		expect(withAsk).toContain(
			"use `ask` when missing information affects correctness, scope, compatibility, or risk",
		);
		expect(withAsk).toContain("use `ask` for material unresolved decisions; resolve routine choices from context");
		expect(withAsk).not.toContain("record the missing decision and a recommendation");
	});

	it("records unresolved decisions instead of assuming approval when ask is unavailable", () => {
		const iterativeWithoutAsk = render({ askAvailable: false, iterative: true });
		expect(iterativeWithoutAsk).toContain("record the missing decision and a recommendation");
		expect(iterativeWithoutAsk).toContain(
			"record unresolved decisions and recommendations; proceed only where the missing answer is not required",
		);

		const parallelWithoutAsk = render({ askAvailable: false, iterative: false });
		const dependency = "record any required decision as a dependency, not an assumed approval";
		expect(parallelWithoutAsk).toContain(dependency);
		expect(render({ askAvailable: true, iterative: false })).not.toContain(dependency);
	});

	it("omits scout-via-task dispatch when the task tool is unavailable", () => {
		const withoutTask = render({ taskAvailable: false, scoutAvailable: true });
		expect(withoutTask).not.toContain("(via `task`)");

		const withTask = render({ taskAvailable: true, scoutAvailable: true });
		expect(withTask).toContain("(via `task`)");
	});
});
