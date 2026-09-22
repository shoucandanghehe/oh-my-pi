import { describe, expect, it } from "bun:test";
import {
	MAGIC_KEYWORDS,
	renderOrchestrateNotice,
	renderWorkflowNotice,
} from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";

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
	const base = { taskBatch: true, scoutAvailable: true, evalTools: true, py: true, js: true, freshAgents: false };

	it("hides eval-defined tool APIs when they are unavailable", () => {
		const enabled = renderWorkflowNotice(base);
		const disabled = renderWorkflowNotice({ ...base, evalTools: false });
		expect(enabled).toContain("`@tool`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});

	it("describes the pool dispatch mode the session will actually use", () => {
		const reused = renderWorkflowNotice(base);
		const fresh = renderWorkflowNotice({ ...base, freshAgents: true });
		expect(reused).toContain("keep-alive workers");
		expect(fresh).toContain("single-item agents");
		expect(fresh).not.toContain("keep-alive");
		expect(reused).not.toContain("single-item");
	});

	it("shows only the active eval runtime's call forms", () => {
		const pyOnly = renderWorkflowNotice({ ...base, js: false });
		const jsOnly = renderWorkflowNotice({ ...base, py: false });
		const both = renderWorkflowNotice(base);

		expect(pyOnly).toContain("schema_mode=None");
		expect(pyOnly).not.toContain("```js");
		expect(pyOnly).not.toContain("raiseErrors");
		expect(pyOnly).not.toContain("JS:");

		expect(jsOnly).toContain("await workpool(");
		expect(jsOnly).toContain("schemaMode?");
		expect(jsOnly).not.toContain("```python");
		expect(jsOnly).not.toContain("raise_errors");
		expect(jsOnly).not.toContain("@tool");
		expect(jsOnly).not.toContain("JS:");

		expect(both).toContain("```python");
		expect(both).toContain("```js");
		expect(both).toContain("JS: `await workpool(");
		expect(both).toContain("raise_errors");
		expect(both).toContain("raiseErrors");
	});
});
