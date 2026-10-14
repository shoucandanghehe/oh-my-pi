import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { Shell } from "@oh-my-pi/pi-coding-agent/ui/shell/shell";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const TEXT_MIME = Buffer.from("text/plain").toString("base64");
let shell: Shell | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(async () => {
	await shell?.stop();
	shell?.surface.dispose();
	shell = undefined;
	resetSettingsForTest();
});

function packet(status: string, data = ""): string {
	return `\x1b]5522;type=read:status=${status}${data}\x1b\\`;
}

function listing(): string {
	return packet("OK") + packet("DATA", `:mime=${TEXT_MIME}`) + packet("DONE");
}

function delivery(text: string, read = 1): string {
	const id = `:id=paste-${read}`;
	return (
		packet("OK", id) +
		packet("DATA", `${id}:mime=${TEXT_MIME};${Buffer.from(text).toString("base64")}`) +
		packet("DONE", id)
	);
}

async function setup() {
	let interrupts = 0;
	const ctx = createInteractiveModeContext({ session: { prewarmModelConnection: () => {} } });
	ctx.hasActiveBtw = () => true;
	ctx.handleBtwEscape = () => {
		interrupts++;
		return true;
	};
	shell = ctx.shell;
	ctx.interceptInput = handler => ctx.shell.interceptInput(handler);
	ctx.addGlobalKeyHandler = handler => ctx.shell.addGlobalKeyHandler(handler);
	const term = memoryTerminal({ columns: 100, rows: 30 });
	ctx.shell.setHome(ctx.composer.field);
	await ctx.shell.start({ theme: currentTheme, driver: term.options, native: false });
	const input = new InputController(ctx, { readImage: async () => null, readText: async () => "" });
	input.setupKeyHandlers();
	return { term, ctx, interrupts: () => interrupts };
}

describe("enhanced paste order through the terminal driver", () => {
	it("inserts the clipboard text before fragmented IME input and later keys", async () => {
		const { term, ctx } = await setup();
		term.feed("prefix " + packet("OK"));
		term.feed("\x1b[0;;20013:");
		term.feed("25991ua" + packet("DATA", `:mime=${TEXT_MIME}`) + packet("DONE"));
		term.feed("b" + delivery("paste ") + "c");
		await Promise.resolve();
		expect(ctx.composer.text()).toBe("prefix paste 中文abc");
	});

	it("keeps the next paste and later keys when the terminal refuses the active read", async () => {
		const { term, ctx } = await setup();
		term.feed(listing() + "a" + listing() + "b" + packet("EPERM", ":id=paste-1"));
		await Promise.resolve();
		expect(ctx.composer.text()).toBe("");
		term.feed("c" + delivery("paste ", 2));
		await Promise.resolve();
		expect(ctx.composer.text()).toBe("paste abc");
	});

	it("discards a late read after Escape and accepts the next paste", async () => {
		const { term, ctx, interrupts } = await setup();
		term.feed(listing() + "a" + "\x1b[27u" + "b");
		term.feed(delivery("discarded "));
		await Promise.resolve();
		expect(interrupts()).toBe(1);
		expect(ctx.composer.text()).toBe("ab");
		term.feed(listing() + "c" + delivery("next ", 2));
		await Promise.resolve();
		expect(ctx.composer.text()).toBe("abnext c");
	});
});
