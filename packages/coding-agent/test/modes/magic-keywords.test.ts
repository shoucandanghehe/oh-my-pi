import { describe, expect, it } from "bun:test";
import {
	MAGIC_KEYWORDS,
	renderOrchestrateNotice,
	renderWorkflowNotice,
} from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { clearBundledCommandsCache, loadBundledCommands } from "@oh-my-pi/pi-coding-agent/task/commands";

describe("magic keyword registry", () => {
	it("keeps ids and words unique so notice types and settings keys cannot collide", () => {
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.id)).size).toBe(MAGIC_KEYWORDS.length);
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.word)).size).toBe(MAGIC_KEYWORDS.length);
	});
});

describe("orchestrate notice", () => {
	it("only references task and todo when those tools are available", () => {
		const enabled = renderOrchestrateNotice({ tools: ["read", "task", "todo"] });
		expect(enabled).toContain("`task`");
		expect(enabled).toContain("`todo`");

		const disabled = renderOrchestrateNotice({ tools: ["read"] });
		expect(disabled).not.toContain("`task`");
		expect(disabled).not.toContain("`todo`");
	});
});

describe("workflow notice", () => {
	it("hides eval-defined tool APIs when they are unavailable", () => {
		const enabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true });
		const disabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: false });
		expect(enabled).toContain("`@tool`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});
});

describe("orchestrate slash command removal", () => {
	it("is no longer bundled as a slash command", () => {
		clearBundledCommandsCache();
		const names = loadBundledCommands().map(command => command.name);
		expect(names).not.toContain("orchestrate");
		expect(names).toContain("init");
	});
});
