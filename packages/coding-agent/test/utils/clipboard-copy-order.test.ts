import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Buffer } from "node:buffer";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as natives from "@oh-my-pi/pi-natives/clipboard";
import * as ptree from "@oh-my-pi/pi-utils/ptree";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const ENV_KEYS = ["TERMUX_VERSION", "LANG", "LC_ALL"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setPlatform(value: string): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Clipboard writes only consume the managed child's completion and exit state. */
function fakeProcess(exitCode: number, finish: () => Promise<void> = async () => {}): ptree.ChildProcess {
	let currentExitCode: number | null = null;
	return {
		get exitCode() {
			return currentExitCode;
		},
		async wait(): Promise<ptree.ExecResult> {
			await finish();
			currentExitCode = exitCode;
			if (exitCode !== 0) throw new ptree.NonZeroExitError(exitCode, "");
			return { stdout: "", stderr: "", exitCode, ok: true };
		},
		kill: () => {},
		proc: { kill: () => {} },
	} as unknown as ptree.ChildProcess;
}

type SpawnCall = { cmd: string[]; stdin: string; env: Record<string, string | undefined> | undefined };

/**
 * On macOS the in-process AppKit write logs
 * `-[NSPasteboard _setData:forType:index:usesPboardTypes:] returns false` to
 * stderr whenever it loses pasteboard ownership — at process teardown, or to
 * another app writing at the same moment. The copy is best-effort and the
 * failure is swallowed, but that line still lands in the user's terminal. So on
 * darwin the write goes through `pbcopy`, mirroring the read path's `pbpaste`.
 *
 * The platform and the child are both faked: the darwin branch has to be
 * exercised on the Linux test runner, and a real `pbcopy` would overwrite
 * whatever the developer has on the pasteboard.
 */
describe("copyToClipboard local backend order", () => {
	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		for (const key of ENV_KEYS) {
			const prior = savedEnv[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
	});

	function captureSpawns(calls: SpawnCall[], onPbcopy: () => ptree.ChildProcess) {
		return vi.spyOn(ptree, "spawn").mockImplementation((cmd, options) => {
			const stdin = options?.stdin;
			calls.push({
				cmd,
				stdin: stdin instanceof Uint8Array ? Buffer.from(stdin).toString() : "",
				env: options?.env,
			});
			if (cmd[0] === "pbcopy") return onPbcopy();
			throw new Error(`unexpected spawn: ${cmd.join(" ")}`);
		});
	}

	it("writes through pbcopy, never the AppKit path", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockResolvedValue(undefined);
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(0));

		await copyToClipboard("omp-clipboard-order-probe");

		expect(calls.map(call => call.cmd[0])).toEqual(["pbcopy"]);
		expect(calls[0]?.stdin).toBe("omp-clipboard-order-probe");
		expect(nativeCopy).not.toHaveBeenCalled();
	});

	it.each([
		["pbcopy", "newer", 0],
		["native header", String.raw`{\rtf1 latest}`, 0],
		["pbcopy after native fallback", "newer", 1],
	] as const)("keeps the latest %s copy after a slower earlier write", async (_backend, latest, firstExitCode) => {
		setPlatform("darwin");
		let clipboard = "";
		vi.spyOn(natives, "copyToClipboard").mockImplementation(async text => {
			clipboard = text;
		});
		const firstFinished = Promise.withResolvers<void>();
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => {
			const text = calls.at(-1)!.stdin;
			const exitCode = text === "older" ? firstExitCode : 0;
			const ready = text === "older" ? firstFinished.promise : Promise.resolve();
			return fakeProcess(exitCode, async () => {
				await ready;
				if (exitCode === 0) clipboard = text;
			});
		});

		const writes = [copyToClipboard("older"), copyToClipboard(latest)];
		// Let an unqueued second write finish before releasing the older child.
		await Bun.sleep(0);
		firstFinished.resolve();
		await Promise.all(writes);

		expect(clipboard).toBe(latest);
	});

	it("hands pbcopy a UTF-8 locale so non-ASCII text survives LANG=C", async () => {
		setPlatform("darwin");
		process.env.LANG = "C";
		process.env.LC_ALL = "C";
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockResolvedValue(undefined);
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(0));

		await copyToClipboard("привет — non-ASCII");

		expect(calls[0]?.stdin).toBe("привет — non-ASCII");
		expect(calls[0]?.env?.LANG).toBe("en_US.UTF-8");
		expect(calls[0]?.env?.LC_ALL).toBe("en_US.UTF-8");
		expect(nativeCopy).not.toHaveBeenCalled();
	});

	it("keeps PDF-header text off pbcopy, which would type it as a document", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockResolvedValue(undefined);
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(0));

		await copyToClipboard("%PDF-1.7\nnot really a pdf");

		expect(calls).toEqual([]);
		expect(nativeCopy).toHaveBeenCalledWith("%PDF-1.7\nnot really a pdf");
	});

	it("preserves literal RTF source instead of letting pbcopy interpret it as rich text", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockResolvedValue(undefined);
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(0));
		const text = String.raw`{\rtf1\ansi Literal \b bold\b0 text}`;

		await copyToClipboard(text);

		expect(calls.map(call => call.cmd[0])).toEqual([]);
		expect(nativeCopy).toHaveBeenCalledWith(text);
	});

	it("still reaches the native write when pbcopy is unavailable", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockResolvedValue(undefined);
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => {
			throw new Error("spawn pbcopy ENOENT");
		});

		await copyToClipboard("fallback probe");

		expect(calls.map(call => call.cmd[0])).toEqual(["pbcopy"]);
		expect(nativeCopy).toHaveBeenCalledWith("fallback probe");
	});

	it("falls back when pbcopy exits non-zero", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockResolvedValue(undefined);
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(1));

		await copyToClipboard("nonzero probe");

		expect(calls.map(call => call.cmd[0])).toEqual(["pbcopy"]);
		expect(nativeCopy).toHaveBeenCalledWith("nonzero probe");
	});
});
