import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Text } from "@oh-my-pi/pi-tui";
import * as themeState from "../src/theme/theme";

const components: ToolExecutionComponent[] = [];
let epoch = 10_000;

beforeAll(async () => {
	await themeState.initTheme(false);
});

afterEach(() => {
	for (const component of components) component.stopAnimation();
	components.length = 0;
	vi.restoreAllMocks();
});

function probe(frames: readonly string[], tool?: AgentTool) {
	vi.spyOn(themeState, "getThemeEpoch").mockReturnValue(++epoch);
	vi.spyOn(themeState.theme, "getSpinnerFrames").mockReturnValue([...frames]);
	const requestComponentRender = vi.fn();
	const ui = { requestRender() {}, requestComponentRender, resetDisplay() {} };
	const component = new ToolExecutionComponent("test_spinner", {}, {}, tool, ui);
	components.push(component);
	requestComponentRender.mockClear();
	return { component, requestComponentRender };
}

describe("tool spinner invalidation", () => {
	it("marks a fixed-width stock spinner as paint-only", () => {
		const { component, requestComponentRender } = probe(["a", "b"]);
		component.tickSpinner(1);
		expect(requestComponentRender).toHaveBeenCalledWith(component, { animationOnly: true });
	});

	it.each([{ frames: ["a", "long"] }, { frames: ["a", "b\n"] }, { frames: ["a", "\x1b[2J"] }])(
		"preserves layout invalidation for custom frames %j",
		({ frames }) => {
			const { component, requestComponentRender } = probe(frames);
			component.tickSpinner(1);
			expect(requestComponentRender).toHaveBeenCalledWith(component);
		},
	);

	it("does not assume a custom renderer keeps its layout while animating", () => {
		const tool = {
			name: "test_spinner",
			renderCall: (_args: unknown, options: { spinnerFrame?: number }) =>
				new Text(options.spinnerFrame === 1 ? "one\ntwo" : "one", 0, 0),
		} as unknown as AgentTool;
		const { component, requestComponentRender } = probe(["a", "b"], tool);
		component.tickSpinner(1);
		expect(requestComponentRender).toHaveBeenCalledWith(component);
	});
});
