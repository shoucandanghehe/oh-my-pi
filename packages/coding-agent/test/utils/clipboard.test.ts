import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	copyToClipboard,
	readClipboardContent,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as native from "@oh-my-pi/pi-natives/clipboard";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = { cmd: string[]; options: SpawnOptions };
type SpawnOutput = string | Uint8Array;
type SpawnOutputSource = SpawnOutput | SpawnOutput[] | ((cmd: string[]) => SpawnOutput);
function streamOf(body: SpawnOutput): ReadableStream<Uint8Array> {
	const stream = new Response(body).body;
	if (!stream) throw new Error("Failed to create response stream.");
	return stream;
}

function fakeProcess(stdout: SpawnOutput, exitCode = 0): Subprocess {
	return {
		pid: 2_147_483_647,
		stdout: streamOf(stdout),
		stderr: streamOf(""),
		exitCode,
		exited: Promise.resolve(exitCode),
		kill: () => true,
	} as unknown as Subprocess;
}

function spySpawn(calls: SpawnCall[], stdout: SpawnOutputSource, exitCode: number | number[] = 0) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		const output =
			typeof stdout === "function" ? stdout(cmd) : Array.isArray(stdout) ? (stdout[calls.length - 1] ?? "") : stdout;
		const code = Array.isArray(exitCode) ? (exitCode[calls.length - 1] ?? 0) : exitCode;
		return fakeProcess(output, code);
	}
	return vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

const ENV_KEYS = ["WSL_DISTRO_NAME", "WSL_INTEROP", "DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = savedEnv[key];
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
	restorePlatform();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// 1x1 red PNG; round-tripped through PowerShell as base64 in the real flow.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("readImageFromClipboard on WSL", () => {
	it("decodes the PowerShell base64 payload without touching the native bridge", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu-24.04";
		process.env.WAYLAND_DISPLAY = "wayland-0";

		const calls: SpawnCall[] = [];
		spySpawn(calls, JSON.stringify({ image: RED_1X1_PNG_BASE64, text: "" }));
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		const image = await readImageFromClipboard();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd[0]).toBe("powershell.exe");
		expect(calls[0]?.cmd).toContain("-NoProfile");
		expect(image).not.toBeNull();
		expect(image?.mimeType).toBe("image/png");
		// PNG magic bytes — proves we actually base64-decoded the payload.
		expect(Array.from(image!.data.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("does not fall back to a stale Linux image after an authoritative empty Windows clipboard", async () => {
		setPlatform("linux");
		process.env.WSL_INTEROP = "/run/WSL/1_interop";
		process.env.WAYLAND_DISPLAY = "wayland-0";

		const calls: SpawnCall[] = [];
		spySpawn(calls, JSON.stringify({ image: null, text: "" }));
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue({
			data: Uint8Array.of(1),
			mimeType: "image/png",
		});

		const image = await readImageFromClipboard();

		expect(image).toBeNull();
		expect(calls).toHaveLength(1);
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("falls back to the native bridge when PowerShell exits non-zero (with display)", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		process.env.DISPLAY = ":0";

		spySpawn([], "noise", 1);
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		await readImageFromClipboard();
		expect(nativeSpy).toHaveBeenCalledTimes(1);
	});

	it("returns null without invoking arboard on headless WSL when PowerShell yields nothing", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		// No DISPLAY / WAYLAND_DISPLAY — arboard would reject, so we must short-circuit.

		spySpawn([], JSON.stringify({ image: null, text: "" }));
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		expect(await readImageFromClipboard()).toBeNull();
		expect(nativeSpy).not.toHaveBeenCalled();
	});
});

describe("readImageFromClipboard dispatch", () => {
	it("returns null on linux without a display server and never spawns PowerShell", async () => {
		setPlatform("linux");
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		expect(await readImageFromClipboard()).toBeNull();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("uses the PowerShell bridge on native Windows when arboard has no image payload", async () => {
		setPlatform("win32");
		const calls: SpawnCall[] = [];
		spySpawn(calls, JSON.stringify({ image: RED_1X1_PNG_BASE64, text: "" }));
		vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		const image = await readImageFromClipboard();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd[0]).toBe("powershell.exe");
		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image!.data.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(calls[0]?.cmd).toContain("-Sta");
	});

	it("falls back to PowerShell when native Windows image conversion fails", async () => {
		setPlatform("win32");
		const calls: SpawnCall[] = [];
		spySpawn(calls, JSON.stringify({ image: RED_1X1_PNG_BASE64, text: "" }));
		vi.spyOn(native, "readImageFromClipboard").mockRejectedValue(
			new Error("The clipboard image could not be converted to the appropriate format."),
		);

		const image = await readImageFromClipboard();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd[0]).toBe("powershell.exe");
		expect(calls[0]?.cmd).toContain("-Sta");
		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image!.data.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	});

	it("delegates straight to the native bridge on non-WSL linux with a display", async () => {
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		await readImageFromClipboard();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).toHaveBeenCalledTimes(1);
	});

	it("treats a throwing native image read as no image on linux with a display", async () => {
		// Regression: an xclip-written text-only selection makes arboard's
		// image read throw ("Unknown error ... incorrect type received from
		// clipboard") instead of reporting no image. readImageFromClipboard
		// must not propagate that — the smart-paste text fallback depends on
		// a null return.
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		vi.spyOn(native, "readImageFromClipboard").mockRejectedValue(
			new Error("Unknown error while interacting with the clipboard: incorrect type received from clipboard"),
		);

		expect(await readImageFromClipboard()).toBeNull();
	});

	it.each(["image/png", "image/jpeg", "image/gif", "image/webp"] as const)(
		"reads %s bytes through wl-paste before the native bridge on Wayland-only Linux",
		async mimeType => {
			setPlatform("linux");
			process.env.WAYLAND_DISPLAY = "wayland-0";
			const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
			const calls: SpawnCall[] = [];
			spySpawn(calls, [`text/plain\n${mimeType}\n`, data]);
			const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

			const image = await readImageFromClipboard();

			expect(calls).toHaveLength(2);
			expect(calls[0]?.cmd).toEqual(["wl-paste", "--list-types"]);
			expect(calls[1]?.cmd).toEqual(["wl-paste", "--type", mimeType]);
			expect(image).toEqual({ data, mimeType });
			expect(nativeSpy).not.toHaveBeenCalled();
		},
	);

	it("returns null on Termux without spawning anything", async () => {
		setPlatform("linux");
		process.env.TERMUX_VERSION = "0.118";
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		expect(await readImageFromClipboard()).toBeNull();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).not.toHaveBeenCalled();
	});
});

describe("readMacFileUrlsFromClipboard", () => {
	it("returns an empty list on non-darwin platforms without spawning osascript", async () => {
		setPlatform("linux");
		const spawnSpy = vi.spyOn(Bun, "spawn");

		expect(await readMacFileUrlsFromClipboard()).toEqual([]);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("splits osascript output into one path per non-empty line on darwin", async () => {
		setPlatform("darwin");
		const calls: SpawnCall[] = [];
		spySpawn(calls, "/Users/me/Pictures/photo.png\n/Users/me/Pictures/clip.jpg\n\n");

		const paths = await readMacFileUrlsFromClipboard();

		expect(paths).toEqual(["/Users/me/Pictures/photo.png", "/Users/me/Pictures/clip.jpg"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["osascript", "-"]);
		// AppleScript payload is piped as stdin; the fix uses Bun.spawn with a
		// Buffer so the child receives it without blocking the event loop.
		const stdin = calls[0]?.options.stdin;
		expect(Buffer.isBuffer(stdin)).toBe(true);
		expect((stdin as Buffer).toString("utf8")).toContain("«class furl»");
	});

	it("returns an empty list when osascript exits non-zero (e.g. binary missing)", async () => {
		setPlatform("darwin");
		spySpawn([], "", 127);

		expect(await readMacFileUrlsFromClipboard()).toEqual([]);
	});
});

describe("readTextFromClipboard", () => {
	it("falls back to xsel when xclip is unavailable on X11", async () => {
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, ["", "from xsel"], [1, 0]);

		expect(await readTextFromClipboard()).toBe("from xsel");
		expect(calls.map(call => call.cmd)).toEqual([
			["xclip", "-selection", "clipboard", "-o"],
			["xsel", "--clipboard", "--output"],
		]);
	});

	it("uses the xsel fallback when wl-paste fails in a mixed Wayland/X11 session", async () => {
		setPlatform("linux");
		process.env.WAYLAND_DISPLAY = "wayland-0";
		process.env.DISPLAY = ":0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, ["", "", "from xsel"], [1, 1, 0]);

		expect(await readTextFromClipboard()).toBe("from xsel");
		expect(calls.map(call => call.cmd)).toEqual([
			["wl-paste", "--type", "text", "--no-newline"],
			["xclip", "-selection", "clipboard", "-o"],
			["xsel", "--clipboard", "--output"],
		]);
	});

	it("requests UTF-8-capable text instead of the first Wayland MIME offer", async () => {
		setPlatform("linux");
		process.env.WAYLAND_DISPLAY = "wayland-0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, cmd => (cmd.includes("text") ? "已提交75个样本" : "<strong>formatted text</strong>"));

		expect(await readTextFromClipboard()).toBe("已提交75个样本");
		expect(calls.map(call => call.cmd)).toEqual([["wl-paste", "--type", "text", "--no-newline"]]);
	});

	it("returns pbpaste stdout on darwin without touching execSync", async () => {
		setPlatform("darwin");
		const calls: SpawnCall[] = [];
		spySpawn(calls, "hello from pbpaste");

		expect(await readTextFromClipboard()).toBe("hello from pbpaste");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["pbpaste"]);
	});

	it("returns an empty string when the subprocess exits non-zero", async () => {
		setPlatform("darwin");
		spySpawn([], "", 1);

		expect(await readTextFromClipboard()).toBe("");
	});

	it("keeps the event loop responsive while the clipboard tool runs (#4235)", async () => {
		setPlatform("darwin");

		// Simulate a slow pbpaste: its stdout stream only emits after a real
		// setTimeout, so the event loop must be free during the read. Under the
		// pre-fix execSync path, this would spin the child synchronously and
		// starve every setInterval tick.
		const DELAY_MS = 80;
		const slowProc = {
			pid: 2_147_483_647,
			stdout: new ReadableStream<Uint8Array>({
				async start(controller) {
					await Bun.sleep(DELAY_MS);
					controller.enqueue(new TextEncoder().encode("payload"));
					controller.close();
				},
			}),
			stderr: streamOf(""),
			exitCode: 0,
			exited: (async () => {
				await Bun.sleep(DELAY_MS);
				return 0;
			})(),
			kill: () => true,
		} as unknown as Subprocess;
		vi.spyOn(Bun, "spawn").mockReturnValue(slowProc);

		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 10);
		try {
			const text = await readTextFromClipboard();
			expect(text).toBe("payload");
		} finally {
			clearInterval(timer);
		}
		// If the read blocked the loop, ticks would stay at 0. A yielding
		// implementation must turn the loop to resolve the 80ms sleep, which
		// fires the expired interval at least once — even under heavy parallel
		// test load, where wall-clock tick counts are unreliable.
		expect(ticks).toBeGreaterThanOrEqual(1);
	});
});

describe("readClipboardContent", () => {
	it("reads image and Unicode text through one WSL host invocation", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		process.env.WAYLAND_DISPLAY = "wayland-0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, JSON.stringify({ image: RED_1X1_PNG_BASE64, text: "截图\r\n第二行" }));
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		const content = await readClipboardContent();

		expect(content.text).toBe("截图\n第二行");
		expect(Array.from(content.image!.data.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(calls).toHaveLength(1);
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("does not replace a successful empty host clipboard with stale Linux content", async () => {
		setPlatform("linux");
		process.env.WSL_INTEROP = "/run/WSL/1_interop";
		process.env.DISPLAY = ":0";
		process.env.WAYLAND_DISPLAY = "wayland-0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, cmd => (cmd[0] === "powershell.exe" ? '{"image":null,"text":""}' : "stale text"));
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue({
			data: Uint8Array.of(1),
			mimeType: "image/png",
		});

		expect(await readClipboardContent()).toEqual({ image: null, text: "", fileUrls: [] });
		expect(calls).toHaveLength(1);
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("tries the local clipboard only after a failed bridge, without launching PowerShell twice", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		process.env.DISPLAY = ":0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, ["", "local text"], [1, 0]);
		vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		expect(await readClipboardContent()).toEqual({ image: null, text: "local text", fileUrls: [] });
		expect(calls.map(call => call.cmd[0])).toEqual(["powershell.exe", "xclip"]);
	});

	it("does not log clipboard payloads when the host envelope is malformed", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		spySpawn([], "private clipboard contents: malformed JSON");
		const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});

		expect(await readClipboardContent()).toEqual({ image: null, text: "", fileUrls: [] });
		expect(warnings).toHaveBeenCalled();
		expect(JSON.stringify(warnings.mock.calls)).not.toContain("private clipboard contents");
	});
});

describe("clipboard subprocess deadlines", () => {
	it.each(["unreaped process", "inherited stdout"] as const)(
		"returns at the deadline even with %s and cancellation that never settles",
		async mode => {
			setPlatform("darwin");
			vi.useFakeTimers();
			const pending = Promise.withResolvers<number>();
			const cancellation = Promise.withResolvers<void>();
			const proc = {
				pid: 2_147_483_647,
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("partial clipboard data"));
					},
					cancel: () => cancellation.promise,
				}),
				stderr: streamOf(""),
				exitCode: mode === "inherited stdout" ? 0 : null,
				exited: mode === "inherited stdout" ? Promise.resolve(0) : pending.promise,
				kill: () => true,
			} as unknown as Subprocess;
			vi.spyOn(Bun, "spawn").mockReturnValue(proc);
			const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
			try {
				// Partial output must not be mistaken for successful clipboard text.
				const read = readTextFromClipboard();
				vi.advanceTimersByTime(2000);
				expect(await read).toBe("");
				expect(JSON.stringify(warnings.mock.calls)).toContain("timed out");
			} finally {
				cancellation.resolve();
				pending.resolve(0);
			}
		},
	);
});

function discardStdout(
	_chunk: string | Uint8Array,
	encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
	callback?: (err?: Error | null) => void,
): boolean {
	const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
	done?.();
	return true;
}

describe("copyToClipboard", () => {
	it("writes WSL host text over stdin without invoking the blocking native clipboard", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		const text = "中文\n'quoted' $text";
		const calls: SpawnCall[] = [];
		spySpawn(calls, "");
		const nativeSpy = vi.spyOn(native, "copyToClipboard");
		vi.spyOn(process.stdout, "write").mockImplementation(discardStdout);

		await copyToClipboard(text);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd[0]).toBe("powershell.exe");
		expect(calls[0]?.options.stdin).toEqual(Buffer.from(text));
		expect(calls[0]?.cmd.join(" ")).not.toContain(text);
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("uses pbcopy rather than running AppKit clipboard writes on the render thread", async () => {
		setPlatform("darwin");
		const calls: SpawnCall[] = [];
		spySpawn(calls, "");
		const nativeSpy = vi.spyOn(native, "copyToClipboard");
		vi.spyOn(process.stdout, "write").mockImplementation(discardStdout);

		await copyToClipboard("copied text");

		expect(calls.map(call => call.cmd)).toEqual([["pbcopy"]]);
		expect(calls[0]?.options.stdin).toEqual(Buffer.from("copied text"));
		expect(nativeSpy).not.toHaveBeenCalled();
	});
});

it("keeps the most recent copy when an earlier native write is slow", async () => {
	setPlatform("linux");
	process.env.DISPLAY = ":0";
	const firstWrite = Promise.withResolvers<void>();
	const firstStarted = Promise.withResolvers<void>();
	let clipboardText = "";
	vi.spyOn(native, "copyToClipboard").mockImplementation(async text => {
		if (text === "first") {
			firstStarted.resolve();
			await firstWrite.promise;
		}
		clipboardText = text;
	});
	vi.spyOn(process.stdout, "write").mockImplementation(discardStdout);
	const first = copyToClipboard("first");
	const second = copyToClipboard("second");
	try {
		await firstStarted.promise;
	} finally {
		firstWrite.resolve();
	}
	await Promise.all([first, second]);
	expect(clipboardText).toBe("second");
});
