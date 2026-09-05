import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { Settings, settings } from "../../../src/config/settings";
import { renderMCPResult } from "../../../src/mcp/render";
import type { MCPToolDetails } from "../../../src/mcp/tool-bridge";
import { ToolExecutionComponent, type ToolExecutionUi } from "../../../src/modes/components/tool-execution";
import { getThemeByName, setThemeInstance, theme } from "../../../src/modes/theme/theme";

class BoldTypeErrorComponent implements Component {
	render(_width: number): readonly string[] {
		throw new TypeError("th.bold is not a function");
	}
}

function visibleText(lines: readonly string[]): string {
	let text = lines.join("\n");
	text = text.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "");
	text = text.replace(/\x1b\[[0-9;]*m/g, "");
	return text;
}

describe("ToolExecutionComponent custom renderer failures", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		settings.set("mcp.renderMarkdownResults", true);
	});

	it("falls back to the custom tool label when a renderCall child component throws during render", () => {
		const tool: AgentTool = {
			name: "graphify_graph",
			label: "Graphify Graph",
			description: "renders a graph",
			parameters: { type: "object", additionalProperties: true },
			renderCall() {
				return new BoldTypeErrorComponent();
			},
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"graphify_graph",
			{},
			{ showImages: false },
			tool,
			ui,
			process.cwd(),
		);
		let text = "";

		expect(() => {
			text = visibleText(component.render(80));
		}).not.toThrow();
		expect(text).toContain("Graphify Graph");
	});

	it("preserves raw result text when a renderResult child component throws during render", () => {
		const rawResultText = "raw result survives child renderer failure";
		const tool: AgentTool = {
			name: "crashy_result_renderer",
			label: "Crashy Result Renderer",
			description: "renders result output",
			parameters: { type: "object", additionalProperties: true },
			renderCall() {
				return new Text(theme.fg("toolTitle", theme.bold("Crashy Result Renderer")), 0, 0);
			},
			renderResult() {
				return new BoldTypeErrorComponent();
			},
			async execute() {
				return { content: [{ type: "text", text: rawResultText }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"crashy_result_renderer",
			{},
			{ showImages: false },
			tool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: rawResultText }] }, false);
		let text = "";

		expect(() => {
			text = visibleText(component.render(80));
		}).not.toThrow();
		expect(text).toContain(rawResultText);
	});

	it("renders a same-named extension tool result with the generic renderer", () => {
		const resultText = "recalled postgres memory";
		const tool: AgentTool = {
			name: "recall",
			label: "Extension Recall",
			description: "recalls external memory",
			parameters: { type: "object", additionalProperties: true },
			async execute() {
				return { content: [{ type: "text", text: resultText }] };
			},
		};
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = new ToolExecutionComponent(
			"recall",
			{ query: "project context" },
			{ showImages: false, useBuiltInRenderer: false },
			tool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: resultText }] }, false);

		const rendered = visibleText(component.render(80));
		expect(rendered).toContain(resultText);
		expect(rendered).not.toContain("no matches");
	});
});

describe("MCP result Markdown rendering", () => {
	const details: MCPToolDetails = {
		serverName: "context-mode",
		mcpToolName: "ctx_search",
	};
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		settings.set("mcp.renderMarkdownResults", true);
	});

	it("renders inline Markdown by default", () => {
		const component = renderMCPResult(
			{ content: [{ type: "text", text: "**bold result** and `code`" }], details },
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = visibleText(component.render(80));

		expect(rendered).toContain("bold result and code");
		expect(rendered).not.toContain("**bold result**");
		expect(rendered).not.toContain("`code`");
	});

	it("keeps Markdown syntax literal when the setting is disabled", () => {
		settings.set("mcp.renderMarkdownResults", false);
		const component = renderMCPResult(
			{ content: [{ type: "text", text: "**bold result**" }], details },
			{ expanded: true, isPartial: false },
			theme,
		);

		expect(visibleText(component.render(80))).toContain("**bold result**");
	});

	it("preserves structured JSON rendering when Markdown is enabled", () => {
		settings.set("mcp.renderMarkdownResults", true);
		const component = renderMCPResult(
			{ content: [{ type: "text", text: '{"status":"**ok**"}' }], details },
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = visibleText(component.render(80));

		expect(rendered).toContain("status");
		expect(rendered).toContain("**ok**");
	});
});

describe("ToolExecutionComponent render memoization", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	function memoTestComponent(ui: ToolExecutionUi): ToolExecutionComponent {
		const tool: AgentTool = {
			name: "memo_test_tool",
			label: "Memo Test Tool",
			description: "renders stable output",
			parameters: { type: "object", additionalProperties: true },
			renderCall() {
				return new Text(theme.fg("toolTitle", theme.bold("Memo Test Tool")), 0, 0);
			},
			renderResult(result) {
				const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
				return new Text(theme.fg("toolOutput", text), 0, 0);
			},
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const component = new ToolExecutionComponent(
			"memo_test_tool",
			{},
			{ showImages: false },
			tool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "settled output" }] }, false);
		return component;
	}

	it("returns a stable reference across settled renders so parent composes skip the block", () => {
		const ui: ToolExecutionUi = {
			requestRender() {},
			requestComponentRender(_component: Component) {},
			resetDisplay() {},
		};
		const component = memoTestComponent(ui);
		const first = component.render(80);

		// Settled blocks dominate compose cost on long transcripts; the engine's
		// reference-equality contract lets TranscriptContainer/Container reuse
		// rows without re-walking the block's subtree.
		expect(component.render(80)).toBe(first);
		expect(component.render(80)).toBe(first);

		// Width is part of the memo key.
		const narrow = component.render(40);
		expect(narrow).not.toBe(first);
		expect(component.render(40)).toBe(narrow);

		// Expanded state rebuilds the display.
		component.setExpanded(true);
		const expanded = component.render(80);
		expect(expanded).not.toBe(first);
		expect(component.render(80)).toBe(expanded);

		// invalidate() must force a fresh render of identical content.
		component.invalidate();
		const afterInvalidate = component.render(80);
		expect(afterInvalidate).not.toBe(expanded);
		expect(visibleText(afterInvalidate)).toEqual(visibleText(expanded));

		// A new result bumps the display key.
		component.updateResult({ content: [{ type: "text", text: "updated output" }] }, false);
		const afterUpdate = component.render(80);
		expect(afterUpdate).not.toBe(afterInvalidate);
		expect(visibleText(afterUpdate)).toContain("updated output");
	});
});
