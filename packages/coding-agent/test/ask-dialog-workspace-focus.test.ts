import { afterEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogSubmitResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AskDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/ask-dialog";
import { MainSessionPane } from "@oh-my-pi/pi-coding-agent/modes/components/main-session-pane";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container, setKeybindings, TUI, WorkspaceLayout, WorkspaceModel } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
const darkTheme = await getThemeByName("dark");

afterEach(() => {
	if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
	else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
});

// Regression: in the app-viewport workspace, a left click anywhere inside the
// Main pane calls WorkspaceLayout.focusPane("main"), whose focus target used to
// be the editor captured at construction. While an ask dialog occupied the
// editor slot, the click silently moved keyboard focus to the detached editor,
// so the dialog stopped responding to ↑/↓/Enter. The pane's focus target must
// resolve to the editor slot's *current* occupant.
describe("ask dialog focus in app-viewport workspace", () => {
	it("keeps arrow keys working after a click into the main pane", async () => {
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		const term = new VirtualTerminal(100, 30);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });

		const scrollRoot = new Container();
		const stickyRoot = new Container();
		const editorContainer = new Container();
		stickyRoot.addChild(editorContainer);
		const mainPane = new MainSessionPane({
			scrollRoot,
			stickyRoot,
			requestRender: () => tui.requestRender(),
		});
		const editor = new Container(); // stand-in for the real editor focus target
		const workspace = new WorkspaceLayout({
			model: WorkspaceModel.single("main"),
			panes: [
				{
					paneId: "main",
					title: "Main",
					component: mainPane,
					// Mirrors InteractiveMode's wiring: resolve to the editor
					// slot's current occupant, not a captured component.
					focusTarget: () => editorContainer.children[0] ?? editor,
					scroll: "component",
					minWidth: 40,
					minHeight: 8,
				},
			],
			height: () => term.rows,
			requestRender: () => tui.requestRender(),
			focus: component => tui.setFocus(component),
		});
		tui.addChild(workspace);

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }, { label: "Option C" }],
			},
		];
		let submitted: ExtensionAskDialogSubmitResult | undefined;
		const dialog = new AskDialogComponent(questions, {
			onSubmit: result => {
				submitted = result;
			},
			onCancel: () => {},
			onPrompt: () => Promise.resolve(undefined),
		});
		editorContainer.addChild(dialog);
		try {
			tui.start();
			await scheduler.drain(term);
			tui.setFocus(dialog);
			// Click into the middle of the main pane (1-based SGR coordinates).
			term.sendInput("\x1b[<0;10;15M");
			term.sendInput("\x1b[<0;10;15m");
			await scheduler.drain(term);
			term.sendInput("\x1b[B");
			await scheduler.drain(term);
			term.sendInput("\r");
			await scheduler.drain(term);
			expect(submitted?.results[0]?.selectedOptions).toEqual(["Option B"]);
		} finally {
			tui.stop();
		}
	});
});
