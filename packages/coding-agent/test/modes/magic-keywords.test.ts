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
	it("is a self-contained system notice carrying the orchestration contract", () => {
		const notice = renderOrchestrateNotice({
			tools: ["read", "task", "edit", "write", "lsp", "bash", "todo"],
		});
		expect(notice.startsWith("<system-notice>")).toBe(true);
		expect(notice.endsWith("</system-notice>")).toBe(true);
		expect(notice).toContain("Own decomposition, delegation, integration, and verification");
		expect(notice).toContain("Dispatch independent assignments concurrently");
		expect(notice).toContain("Preserve explicit review and approval gates");
		expect(notice).toContain("through `task`");
		expect(notice).toContain("with `todo`");
		// The contract must not retain the slash-command input placeholder.
		expect(notice).not.toContain("$@");
	});

	it("does not direct the model to call task or todo when those tools are absent", () => {
		const notice = renderOrchestrateNotice({ tools: ["read"] });
		expect(notice).toContain("Delegate substantial independent work.");
		expect(notice).not.toContain("`task`");
		expect(notice).not.toContain("`todo`");
	});

	it.each(["edit", "write"])("does not prescribe a file mutation tool when only %s is available", tool => {
		const notice = renderOrchestrateNotice({ tools: ["read", tool] });
		expect(notice).toContain("Handle small, tightly coupled integration fixes directly");
		expect(notice).not.toContain("`edit`");
		expect(notice).not.toContain("`write`");
	});
});

describe("workflow notice", () => {
	const base = {
		taskBatch: true,
		scoutAvailable: true,
		evalTools: true,
		py: true,
		js: true,
		freshAgents: false,
		perCallModel: false,
	};

	it("defaults to workpools and hides eval-defined tools when disabled", () => {
		const enabled = renderWorkflowNotice(base);
		const disabled = renderWorkflowNotice({ ...base, evalTools: false });
		expect(enabled).toContain("Prefer `workpool()` for two or more independent items");
		expect(enabled).toContain("`@tool`");
		expect(enabled).toContain("tools=None");
		expect(enabled).toContain("tool(fn, { name, description, parameters })");
		expect(disabled).toContain("Prefer `workpool()` for two or more independent items");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
		expect(disabled).not.toContain("tool(fn, { name, description, parameters })");
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
		expect(pyOnly).toContain('`agent="default"` or `agent="slow"`');
		expect(pyOnly).not.toContain("```js");
		expect(pyOnly).not.toContain("raiseErrors");
		expect(pyOnly).not.toContain("JS:");

		expect(jsOnly).toContain("await workpool(");
		expect(jsOnly).toContain("schemaMode?");
		expect(jsOnly).toContain('`{ agent: "default" }` or `{ agent: "slow" }`');
		expect(jsOnly).not.toContain('`agent="default"`');
		expect(jsOnly).not.toContain("```python");
		expect(jsOnly).not.toContain("raise_errors");
		expect(jsOnly).not.toContain("@tool");
		expect(jsOnly).not.toContain("JS:");

		expect(both).toContain("```python");
		expect(both).toContain("```js");
		expect(both).toContain("JS: `await workpool(");
		expect(both).toContain('`agent="default"` or `agent="slow"` (JS: `{ agent: "default" }` or `{ agent: "slow" }`)');
		expect(both).toContain("raise_errors");
		expect(both).toContain("raiseErrors");
	});

	it("lists the per-call model option only when task.perCallModel admits it for eval", () => {
		const off = renderWorkflowNotice(base);
		const on = renderWorkflowNotice({ ...base, perCallModel: true });

		// agent() and workpool(), in both the Python and JS spellings.
		for (const [text, count] of [
			[off, 0],
			[on, 2],
		] as const) {
			expect(text.match(/model=None\)/g) ?? []).toHaveLength(count);
			expect(text.match(/, model \}\)/g) ?? []).toHaveLength(count);
		}
	});
});
