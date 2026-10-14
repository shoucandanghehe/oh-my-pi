import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EnhancedPasteController } from "@oh-my-pi/pi-coding-agent/utils/enhanced-paste";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const PASTE_EVENT =
	"\x1b]5522;type=read:status=OK:pw=ODliYWNiNGQ3NmFjMWQ3Nw==\x1b\\" +
	"\x1b]5522;type=read:status=DATA:mime=Lg==:pw=ODliYWNiNGQ3NmFjMWQ3Nw==;dGV4dC9wbGFpbgo=\x1b\\" +
	"\x1b]5522;type=read:status=DONE:pw=ODliYWNiNGQ3NmFjMWQ3Nw==\x1b\\";

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else delete (target as Record<string, unknown>)[key];
}

describe("Enhanced paste shutdown", () => {
	let previousHeadless: boolean;
	let stdinIsTty: PropertyDescriptor | undefined;
	let stdoutIsTty: PropertyDescriptor | undefined;
	let stdinSetRawMode: PropertyDescriptor | undefined;
	let terminal: ProcessTerminal | undefined;

	beforeEach(() => {
		stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		previousHeadless = setTerminalHeadless(false);
		vi.useFakeTimers();
	});

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", stdinIsTty);
		restoreProperty(process.stdout, "isTTY", stdoutIsTty);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawMode);
	});

	it("disables enhanced paste before draining so delayed MIME listings do not reach the shell", async () => {
		const shellInput: string[] = [];
		const writes: string[] = [];
		const pastedText: string[] = [];
		let pasteMode = false;
		let reading = false;
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => {
			reading = true;
			return process.stdin;
		});
		vi.spyOn(process.stdin, "pause").mockImplementation(() => {
			reading = false;
			return process.stdin;
		});
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			const data = chunk.toString();
			writes.push(data);
			if (data.includes("\x1b[?5522h")) pasteMode = true;
			if (data.includes("\x1b[?5522l")) pasteMode = false;
			return true;
		});

		terminal = new ProcessTerminal({ conpty: false });
		const controller = new EnhancedPasteController({
			write: data => terminal!.write(data),
			pasteText: text => pastedText.push(text),
			pasteImage: () => {
				throw new Error("unexpected image paste");
			},
			showStatus: message => pastedText.push(`status:${message}`),
		});
		terminal.start(
			data => controller.handleInput(data),
			() => {},
		);
		controller.enable();

		// A paste action races shutdown; transport latency puts its unsolicited
		// listing after the existing 50 ms idle drain if notifications stay on.
		setTimeout(() => {
			if (!pasteMode) return;
			setTimeout(() => {
				if (reading) process.stdin.emit("data", PASTE_EVENT);
				else shellInput.push(PASTE_EVENT);
			}, 40);
		}, 20);

		const draining = terminal.drainInput();
		// A listing already queued before the mode reset arrives during drain.
		// Its OK/DATA/DONE must not cause a new clipboard read or editor paste.
		process.stdin.emit("data", PASTE_EVENT);
		vi.advanceTimersByTime(50);
		await draining;
		terminal.stop();
		vi.advanceTimersByTime(10);

		expect(shellInput).toEqual([]);
		expect(writes.filter(data => data.startsWith("\x1b]5522;type=read"))).toEqual([]);
		expect(pastedText).toEqual([]);
	});
});
