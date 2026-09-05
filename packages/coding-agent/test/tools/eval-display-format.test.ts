import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { EvalTool, evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { Text, WorkspaceLayout, WorkspaceModel } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

describe("eval renderer: display-only streaming formatting", () => {
	let theme: Theme;
	const source = "if (ready) {run();finish();}";

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("expands compact source in both pending and completed previews", () => {
		const pending = Bun.stripANSI(
			evalToolRenderer
				.renderCall({ language: "js", code: source }, { expanded: true, isPartial: true }, theme)
				.render(120)
				.join("\n"),
		);
		const details: EvalToolDetails = {
			language: "js",
			languages: ["js"],
			cells: [{ index: 0, code: source, language: "js", output: "", status: "complete" }],
		};
		const completed = Bun.stripANSI(
			evalToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: true, isPartial: false },
					theme,
				)
				.render(120)
				.join("\n"),
		);

		for (const rendered of [pending, completed]) {
			expect(rendered).toContain("run();");
			expect(rendered).toContain("finish();");
			expect(rendered).not.toContain("run();finish();");
		}
		expect(details.cells?.[0]?.code).toBe(source);
	});

	it("keeps a workspace sash fixed beside multiline display strings containing tabs", () => {
		const result = evalToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					language: "python",
					languages: ["python"],
					cells: [{ index: 0, code: "display(result)", language: "python", output: "", status: "complete" }],
					jsonOutputs: [
						{
							text: [
								"total_bytes=4136960 files=2",
								"4136960\t2102149\tsystemd-journal\t/var/log/journal",
								"0\t3510063\tpmlogger\t/var/tmp/check",
							].join("\n"),
						},
					],
				} satisfies EvalToolDetails,
			},
			{ expanded: false, isPartial: false },
			theme,
		);
		const model = WorkspaceModel.single("main");
		expect(model.splitPane("main", "side", "right")).toBe(true);
		const workspace = new WorkspaceLayout({
			model,
			height: () => 16,
			requestRender: () => {},
			panes: [
				{ paneId: "main", title: "Main", component: result, minWidth: 10, minHeight: 3 },
				{ paneId: "side", title: "Side", component: new Text("side", 0, 0), minWidth: 10, minHeight: 3 },
			],
		});
		const rendered = workspace.render(160);
		const terminal = new VirtualTerminal(160, rendered.length);
		terminal.write("\x1b[?7l");
		for (const [row, line] of rendered.entries()) {
			terminal.write(`\x1b[${row + 1};1H${line}`);
		}
		const sashCol = workspace.frame!.sashes[0]!.rect.x;
		const affected = terminal
			.getViewport()
			.filter(line => line.includes("systemd-journal") || line.includes("pmlogger"));
		expect(affected).toHaveLength(2);
		for (const line of affected) {
			expect(line[sashCol]).toBe("│");
		}
	});

	it("passes the original source to execution verbatim", async () => {
		let executed = "";
		const tool = new EvalTool(null, {
			proxyExecutor: async params => {
				executed = params.code;
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		});

		await tool.execute("call", { language: "js", code: source });

		expect(executed).toBe(source);
	});
});
