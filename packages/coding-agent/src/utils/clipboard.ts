import {
	type ClipboardImage,
	copyToClipboard as nativeCopyToClipboard,
	readImageFromClipboard as nativeReadImageFromClipboard,
	readTextFromClipboard as nativeReadTextFromClipboard,
} from "@oh-my-pi/pi-natives/clipboard";
import { writeTerminalSequence } from "@oh-my-pi/pi-tui/terminal";
import { isWsl } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils/mime";
import * as ptree from "@oh-my-pi/pi-utils/ptree";
import MAC_FILE_URL_SCRIPT from "./mac-file-urls.applescript" with { type: "text" };

type SpawnCaptureOptions = { input?: string; timeoutMs?: number; env?: Record<string, string | undefined> };

/**
 * Capture clipboard output with a deadline independent of process exit and EOF.
 * WSL interop and inherited pipes can remain open after a kill; never wait for
 * them to acknowledge cancellation before reporting the timeout. Process-tree
 * cleanup is delegated to the shared manager, with a hard-kill fallback for
 * bridges the native process enumerator cannot see.
 */
async function spawnCapture(cmd: string[], options: SpawnCaptureOptions & { encoding: "bytes" }): Promise<Uint8Array>;
async function spawnCapture(cmd: string[], options?: SpawnCaptureOptions): Promise<string>;
async function spawnCapture(
	cmd: string[],
	options: SpawnCaptureOptions & { encoding?: "bytes" } = {},
): Promise<string | Uint8Array> {
	const timeoutMs = options.timeoutMs ?? 2000;
	const child = ptree.spawn(cmd, {
		detached: true,
		timeout: timeoutMs,
		stdin: options.input !== undefined ? Buffer.from(options.input) : "ignore",
		...(options.env ? { env: options.env } : {}),
	});
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		const error = new ptree.TimeoutError(timeoutMs, "");
		deadline.reject(error);
		child.kill(error, -1);
		try {
			child.proc.kill("SIGKILL");
		} catch {
			// The managed process-tree kill may have already reaped the root.
		}
	}, timeoutMs);
	try {
		const capture = async () => {
			const bytes = options.encoding === "bytes" ? await child.bytes() : undefined;
			const result = await child.wait();
			return bytes ?? result.stdout;
		};
		const stdout = await Promise.race([capture(), deadline.promise]);
		return stdout;
	} catch (error) {
		if (error instanceof ptree.TimeoutError) throw new Error(`${cmd[0]} timed out after ${timeoutMs}ms`);
		if (error instanceof ptree.Exception) throw new Error(`${cmd[0]} exited with code ${error.exitCode}`);
		throw error;
	} finally {
		clearTimeout(timer);
		// Do not await bridge termination: the deadline also bounds unresponsive
		// WSL process handles and cancellation of inherited pipes.
		if (child.exitCode === null) child.kill();
	}
}

function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * True when `pbcopy(1)` would type this text as a document instead of as text:
 * it sniffs the leading bytes and puts input opening with a PDF (`%PDF-`),
 * EPS (`%!PS`), or RTF (`{\rtf`) header on the pasteboard as that data type.
 * A code block or diff whose first line is such a header must not go through it,
 * or a plain-text paste target receives document data — or nothing.
 */
function isPasteboardTypedByHeader(text: string): boolean {
	return text.startsWith("%PDF-") || text.startsWith("%!PS") || text.startsWith("{\\rtf");
}

/**
 * Read file paths from the macOS pasteboard's `public.file-url` representation.
 *
 * Used to reach the Finder `Cmd+C` pasteboard (which exposes only file URLs,
 * no plain text or raw image bytes) so an image-file clipboard can be attached
 * via {@link handleImagePathPaste} instead of falling through to "Clipboard is
 * empty". Returns an empty array on non-darwin platforms, when AppleScript is
 * unavailable, or when the pasteboard holds no file URLs.
 */
export async function readMacFileUrlsFromClipboard(): Promise<string[]> {
	if (process.platform !== "darwin") return [];
	try {
		const stdout = await spawnCapture(["osascript", "-"], { input: MAC_FILE_URL_SCRIPT });
		return stdout
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch (error) {
		logger.warn("clipboard: failed to read macOS file URLs", { error: String(error) });
		return [];
	}
}

let pendingClipboardWrite: Promise<void> = Promise.resolve();

/**
 * Copy text to the system clipboard.
 *
 * Emits OSC 52 first when running in a real terminal (works over SSH/mosh),
 * then attempts platform clipboard copy as best-effort for local sessions.
 * Clipboard daemons and host interop must never run on the render thread.
 *
 * The OSC 52 goes through `writeTerminalSequence`, so it cannot tear a TUI
 * frame; from a worker thread it is skipped and only the native copy runs.
 *
 * @param text - UTF-8 text to place on the clipboard.
 */
export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) writeTerminalSequence(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);

	// Moving native writes off-thread must not let an older copy finish last.
	const previous = pendingClipboardWrite;
	const completed = Promise.withResolvers<void>();
	pendingClipboardWrite = completed.promise;
	await previous;
	try {
		if (process.env.TERMUX_VERSION) {
			try {
				await spawnCapture(["termux-clipboard-set"], { input: text, timeoutMs: 5000 });
				return;
			} catch {
				// Fall through to native
			}
		}
		if (isWsl()) {
			try {
				await spawnCapture(
					["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-Command", POWERSHELL_COPY_SCRIPT],
					{ input: text, timeoutMs: POWERSHELL_TIMEOUT_MS },
				);
				return;
			} catch (error) {
				logger.warn("clipboard: Windows clipboard copy failed", { error: String(error) });
			}
		}
		// pbcopy avoids AppKit ownership errors; document headers require the
		// native path, and the subprocess must decode input as UTF-8.
		if (process.platform === "darwin" && !isPasteboardTypedByHeader(text)) {
			try {
				await spawnCapture(["pbcopy"], {
					input: text,
					timeoutMs: 5000,
					env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
				});
				return;
			} catch {
				// Fall through to native.
			}
		}
		await nativeCopyToClipboard(text);
	} catch (error) {
		logger.warn("clipboard: clipboard copy failed", { error: String(error) });
	} finally {
		completed.resolve();
	}
}

const POWERSHELL_TIMEOUT_MS = 8000;

const POWERSHELL_COPY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$text = [Console]::In.ReadToEnd()
if ($text.Length -eq 0) {
	[System.Windows.Forms.Clipboard]::Clear()
} else {
	[System.Windows.Forms.Clipboard]::SetText($text)
}
`;

export interface ClipboardContent {
	image: ClipboardImage | null;
	text: string;
	/** Finder file paths; empty on platforms without a file-URL reader. */
	fileUrls: string[];
}

// One STA startup and one data object for both representations. A successful
// empty envelope is authoritative, unlike a failed/missing host bridge.
const POWERSHELL_CONTENT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$image = $null
$text = ''
if ($null -ne $data) {
	$img = $data.GetData([System.Windows.Forms.DataFormats]::Bitmap, $true)
	if ($null -ne $img) {
		$ms = New-Object System.IO.MemoryStream
		try {
			$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
			$image = [Convert]::ToBase64String($ms.ToArray())
		} finally {
			$ms.Dispose()
			$img.Dispose()
		}
	}
	$text = [string]$data.GetData([System.Windows.Forms.DataFormats]::UnicodeText, $true)
}
[Console]::Out.Write((@{ image = $image; text = $text } | ConvertTo-Json -Compress))
`;

async function readContentViaPowerShell(): Promise<ClipboardContent | null> {
	try {
		const stdout = await spawnCapture(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-Command", POWERSHELL_CONTENT_SCRIPT],
			{ timeoutMs: POWERSHELL_TIMEOUT_MS },
		);
		let value: unknown;
		try {
			value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
		} catch {
			// JSON parse errors may include clipboard text. Never log the payload.
			throw new Error("Invalid clipboard response from PowerShell");
		}
		if (
			typeof value !== "object" ||
			value === null ||
			!("image" in value) ||
			!("text" in value) ||
			(value.image !== null && typeof value.image !== "string") ||
			typeof value.text !== "string"
		) {
			throw new Error("Invalid clipboard response from PowerShell");
		}
		return {
			image: value.image ? { data: Buffer.from(value.image, "base64"), mimeType: "image/png" } : null,
			text: value.text.replaceAll("\r\n", "\n"),
			fileUrls: [],
		};
	} catch (error) {
		logger.warn("clipboard: Windows clipboard read failed", { error: String(error) });
		return null;
	}
}

// PowerShell one-liner that emits the clipboard text verbatim on stdout, or
// nothing when the clipboard holds no text. `[Console]::Out.Write` avoids the
// trailing newline Write-Output would add; output encoding is forced to UTF-8
// so non-ASCII text survives the interop boundary regardless of console
// codepage.
const POWERSHELL_TEXT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write([string](Get-Clipboard -Raw))
`;

/**
 * Read clipboard text through Windows PowerShell — native win32 or the WSL
 * host over interop.
 *
 * Forcing UTF-8 output encoding keeps non-ASCII text intact regardless of
 * the console codepage. Text-only callers need not transfer image bytes.
 *
 * Returns null when the bridge fails (WSL callers fall through to
 * wl-paste/xclip); an empty string is a successful "no text" read.
 */
async function readTextViaPowerShell(): Promise<string | null> {
	try {
		const stdout = await spawnCapture(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_TEXT_SCRIPT],
			{ timeoutMs: POWERSHELL_TIMEOUT_MS },
		);
		return stdout.replaceAll("\r\n", "\n");
	} catch (error) {
		logger.warn("clipboard: Windows clipboard text read failed", { error: String(error) });
		return null;
	}
}

async function readTextFromX11Clipboard(): Promise<string> {
	try {
		return await spawnCapture(["xclip", "-selection", "clipboard", "-o"]);
	} catch {
		return await spawnCapture(["xsel", "--clipboard", "--output"]);
	}
}

/**
 * Read an image from the system clipboard.
 *
 * Returns null on Termux (no image clipboard support) or when no display
 * server is available (headless/SSH without forwarding). Native Windows trusts
 * the native reader's "no image" answer — it returns null only when no bitmap
 * format is on the clipboard, and throws when one is present but undecodable —
 * so `powershell.exe` starts only after a throw and a text-only clipboard never
 * waits on a cold PowerShell start. WSL reaches the host clipboard through
 * `powershell.exe`.
 *
 * @returns A supported image payload or null when no image is available.
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	if (process.env.TERMUX_VERSION) {
		return null;
	}

	if (isWsl()) {
		const content = await readContentViaPowerShell();
		if (content !== null) return content.image;
		// Only a failed bridge permits falling back to the Linux clipboard.
	}

	if (process.platform === "win32") {
		try {
			return (await nativeReadImageFromClipboard()) ?? null;
		} catch (err) {
			logger.warn("clipboard: native Windows image read failed", { error: String(err) });
			return (await readContentViaPowerShell())?.image ?? null;
		}
	}

	return await readLocalImageFromClipboard();
}

async function readLocalImageFromClipboard(): Promise<ClipboardImage | null> {
	if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
		try {
			const offeredMimeTypes = new Set((await spawnCapture(["wl-paste", "--list-types"])).split(/\r?\n/));
			for (const mimeType of SUPPORTED_IMAGE_MIME_TYPES) {
				if (!offeredMimeTypes.has(mimeType)) continue;
				const data = await spawnCapture(["wl-paste", "--type", mimeType], { encoding: "bytes" });
				if (data.byteLength > 0) return { data, mimeType };
			}
		} catch {
			// Fall through when wl-clipboard is absent or no advertised image payload can be read.
		}
	}

	if (!hasDisplay()) {
		return null;
	}

	try {
		return (await nativeReadImageFromClipboard()) ?? null;
	} catch (error) {
		// Some selection owners make the native image read throw instead of
		// reporting "no image" — e.g. an xclip-written text-only selection
		// (arboard: "Unknown error ... incorrect type received from clipboard").
		// Treat a failed image read as "no image" so the caller's smart-paste
		// text fallback still delivers the clipboard content.
		logger.warn("clipboard: failed to read clipboard image", { error: String(error) });
		return null;
	}
}

/**
 * Read plain text from the system clipboard.
 *
 * Native Windows reads through the native addon and only falls back to
 * `powershell.exe` when that read throws.
 */
export async function readTextFromClipboard(): Promise<string> {
	try {
		const p = process.platform;
		if (p === "darwin") {
			return await spawnCapture(["pbpaste"]);
		}
		if (p === "win32") {
			try {
				return ((await nativeReadTextFromClipboard()) ?? "").replaceAll("\r\n", "\n");
			} catch (err) {
				logger.warn("clipboard: native Windows text read failed", { error: String(err) });
				return (await readTextViaPowerShell()) ?? "";
			}
		}
		if (process.env.TERMUX_VERSION) {
			return await spawnCapture(["termux-clipboard-get"]);
		}
		if (isWsl()) {
			const text = await readTextViaPowerShell();
			if (text !== null) return text;
			// Bridge failed — fall through to the wl-paste/xclip paths below.
		}
		return await readLocalTextFromClipboard();
	} catch (error) {
		logger.warn("clipboard: failed to read clipboard text", { error: String(error) });
	}
	return "";
}

async function readLocalTextFromClipboard(): Promise<string> {
	try {
		const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
		const hasX11Display = Boolean(process.env.DISPLAY);
		if (hasWaylandDisplay) {
			try {
				return await spawnCapture(["wl-paste", "--type", "text", "--no-newline"]);
			} catch {
				if (hasX11Display) {
					return await readTextFromX11Clipboard();
				}
			}
		} else if (hasX11Display) {
			return await readTextFromX11Clipboard();
		}
	} catch (error) {
		logger.warn("clipboard: failed to read clipboard text", { error: String(error) });
	}
	return "";
}

/**
 * Read smart-paste representations with one WSL PowerShell invocation.
 * A successful empty host clipboard never probes Linux. If the host bridge
 * fails, local readers remain available without retrying PowerShell.
 */
export async function readClipboardContent(): Promise<ClipboardContent> {
	if (!process.env.TERMUX_VERSION && isWsl()) {
		const content = await readContentViaPowerShell();
		if (content !== null) return content;
		const [image, text] = await Promise.all([
			readLocalImageFromClipboard(),
			readLocalTextFromClipboard(),
		]);
		return { image, text, fileUrls: [] };
	}
	const [image, text, fileUrls] = await Promise.all([
		readImageFromClipboard(),
		readTextFromClipboard(),
		readMacFileUrlsFromClipboard(),
	]);
	return { image, text, fileUrls };
}
