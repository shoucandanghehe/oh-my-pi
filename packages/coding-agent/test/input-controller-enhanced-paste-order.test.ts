import { afterEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { TSP_KINDS } from "@oh-my-pi/pi-wire";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "../../tui/test/process-terminal-render-harness";
import { defaultEditorTheme } from "../../tui/test/test-themes";

const TEXT_MIME = Buffer.from("text/plain").toString("base64");
let harness: ProcessTerminalRenderHarness | undefined;
let envBefore: Record<string, string | undefined> | undefined;

afterEach(() => {
	harness?.dispose();
	harness = undefined;
	for (const [key, value] of Object.entries(envBefore ?? {})) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	envBefore = undefined;
	vi.restoreAllMocks();
});

function packet(status: string, data = ""): string {
	return `\x1b]5522;type=read:status=${status}${data}\x1b\\`;
}

function readReply(status: string, data = "", read = 1): string {
	return packet(status, `:id=paste-${read}${data}`);
}

function feed(...chunks: string[]): void {
	for (const chunk of chunks) process.stdin.emit("data", chunk);
}

function setup(readText: () => Promise<string> = async () => ""): { editor: CustomEditor; statuses: string[] } {
	const keys = ["PI_TUI_NATIVE", "TERM_PROGRAM", "TMUX", "TMUX_PANE", "STY", "ZELLIJ"];
	envBefore = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
	Bun.env.PI_TUI_NATIVE = "1";
	Bun.env.TERM_PROGRAM = "tern";
	for (const key of ["TMUX", "TMUX_PANE", "STY", "ZELLIJ"]) delete Bun.env[key];
	harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: false });
	const editor = new CustomEditor(defaultEditorTheme);
	const ui = harness.tui;
	const statuses: string[] = [];
	ui.addChild(editor);
	ui.setFocus(editor);
	ui.enableScopedInputRender(editor);
	const ctx = {
		editor,
		ui,
		keybindings: new KeybindingsManager(),
		session: { extensionRunner: undefined },
		viewSession: { prewarmModelConnection: () => {} },
		isBashMode: false,
		isPythonMode: false,
		dictationSpaceHold: () => undefined,
		handlesBtwOpenThreadKey: () => false,
		handlesBtwBranchKey: () => false,
		handlesBtwCopyKey: () => false,
		showStatus: (message: string) => statuses.push(message),
	} as unknown as InteractiveModeContext;
	new InputController(ctx, { readImage: async () => null, readText }).setupKeyHandlers();
	feed(
		"\x1b[?0u",
		`\x1b_tsp;r;${JSON.stringify({ r: "hello", v: 1, term: "tern", kinds: TSP_KINDS, credits: 3 })}\x1b\\`,
	);
	ui.renderNow();
	expect(ui.nativeRendering).toBe(true);
	return { editor, statuses };
}

describe("clipboard paste input order in the native composer", () => {
	it("inserts the paste before an IME commit and keys typed during the clipboard round trip", async () => {
		const { editor } = setup();
		feed("prefix ", packet("OK"));
		// An IME commit is one Kitty text event, fragmented by the PTY read boundary.
		feed("\x1b[0;;20013:", "25991u", "a");
		feed(packet("DATA", `:mime=${TEXT_MIME}`), packet("DONE"));
		feed("b", readReply("OK"), readReply("DATA", `:mime=${TEXT_MIME};${Buffer.from("paste ").toString("base64")}`));
		feed("c", readReply("DONE").slice(0, -1), "\\d");
		await Promise.resolve();
		expect(editor.getText()).toBe("prefix paste 中文abcd");
	});

	it("keeps the next paste and later keys when the terminal refuses the active clipboard read", async () => {
		const { editor, statuses } = setup();
		feed(packet("OK", ":pw=Zmlyc3Q="), "a", packet("DATA", `:mime=${TEXT_MIME}`), packet("DONE"));
		feed(packet("OK", ":pw=c2Vjb25k"), "b", packet("DATA", `:mime=${TEXT_MIME}`), packet("DONE"));
		feed(readReply("EPERM"));
		expect(editor.getText()).toBe("");
		feed("c", readReply("OK", "", 2));
		feed(readReply("DATA", `:mime=${TEXT_MIME};${Buffer.from("paste ").toString("base64")}`, 2));
		feed(readReply("DONE", "", 2));
		await Promise.resolve();
		expect(editor.getText()).toBe("paste abc");
		expect(statuses).toEqual(["Enhanced paste failed: EPERM"]);
	});

	it("releases the later keys when the clipboard advertises no supported content", async () => {
		const { editor, statuses } = setup();
		feed(packet("OK"), "a", packet("DATA", `:mime=${Buffer.from("text/html").toString("base64")}`));
		feed("b", packet("DONE"), "c");
		await Promise.resolve();
		expect(editor.getText()).toBe("abc");
		expect(statuses).toEqual(["Clipboard paste has no supported text or image data"]);
	});

	it("inserts raw clipboard text before a following IME commit and typed keys", async () => {
		const clipboard = Promise.withResolvers<string>();
		const { editor } = setup(() => clipboard.promise);
		editor.setActionKeys("app.clipboard.pasteTextRaw", ["ctrl+shift+v"]);
		feed("prefix ", "\x1b[118;6u", "\x1b[0;;20013:25991u", "abc");
		clipboard.resolve("paste ");
		await clipboard.promise;
		await Promise.resolve();
		expect(editor.getText()).toBe("prefix paste 中文abc");
	});

	it.each(["\x1b[27u", "\x03"])(
		"keeps %j interruptible if the read never finishes, discards late data and accepts the next paste",
		async interrupt => {
			const { editor } = setup();
			const interrupted = vi.fn();
			editor.onEscape = interrupted;
			editor.onClear = interrupted;
			feed(packet("OK"), "a", packet("DATA", `:mime=${TEXT_MIME}`), packet("DONE"), "b");
			feed(packet("OK"), packet("DATA", `:mime=${TEXT_MIME}`), packet("DONE"));
			feed(interrupt, "c");
			expect(interrupted).toHaveBeenCalledTimes(1);
			expect(editor.getText()).toBe("abc");

			feed(readReply("OK"), readReply("DATA", `:mime=${TEXT_MIME};${Buffer.from("cancelled ").toString("base64")}`));
			feed(readReply("DONE"));
			expect(editor.getText()).toBe("abc");

			feed(packet("OK"), packet("DATA", `:mime=${TEXT_MIME}`), packet("DONE"), readReply("OK", "", 2));
			feed(
				readReply("DATA", `:mime=${TEXT_MIME};${Buffer.from("next ").toString("base64")}`, 2),
				"d",
				readReply("DONE", "", 2),
			);
			await Promise.resolve();
			expect(editor.getText()).toBe("abcnext d");
		},
	);
});
