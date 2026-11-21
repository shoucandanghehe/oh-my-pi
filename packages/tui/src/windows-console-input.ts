import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";

export const WINDOWS_CONSOLE_INPUT_WORKER_ARG = "__omp_worker_windows_console_input";

const IDLE = 0;
const READING = 1;
const STOPPING = 2;
const STOPPED = 3;

interface ConsoleReaderData {
	stopEvent: Pointer | bigint;
	state: Int32Array<SharedArrayBuffer>;
}

/** The console queue has one reader until stop returns. */
export function startWindowsConsoleInput(
	onData: (data: string) => void,
	onResize: () => void,
	onError: (error: Error) => void,
): () => void {
	const library = dlopen("kernel32.dll", {
		CreateEventW: { args: [FFIType.ptr, FFIType.bool, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
		SetEvent: { args: [FFIType.ptr], returns: FFIType.bool },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
	});
	const { CreateEventW, SetEvent, CloseHandle } = library.symbols;
	const stopEvent = CreateEventW(null, true, false, null);
	if (!stopEvent) {
		library.close();
		throw new Error("CreateEventW failed for console input");
	}
	const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
	const data: ConsoleReaderData = { stopEvent, state };
	const host = workerHostEntry();
	let worker: Worker;
	try {
		worker = host
			? new Worker(host, { argv: [WINDOWS_CONSOLE_INPUT_WORKER_ARG], workerData: data })
			: new Worker(new URL("./windows-console-input-worker.ts", import.meta.url), { workerData: data });
	} catch (error) {
		CloseHandle(stopEvent);
		library.close();
		throw error;
	}
	let stopped = false;
	worker.on("message", (message: string | null) => {
		if (stopped) return;
		if (message === null) onResize();
		else onData(message);
	});
	worker.on("error", error => {
		if (!stopped) onError(error instanceof Error ? error : new Error(String(error)));
	});
	worker.on("exit", code => {
		if (!stopped) onError(new Error(`Windows console reader exited (${code})`));
	});
	return () => {
		stopped = true;
		// If stop wins during startup, the worker never touches the console or
		// the event. Otherwise wait for the last read before returning stdin.
		if (Atomics.exchange(state, 0, STOPPING) === READING) {
			SetEvent(stopEvent);
			Atomics.wait(state, 0, STOPPING);
		}
		CloseHandle(stopEvent);
		library.close();
		worker.unref();
	};
}

// INPUT_RECORD is 20 bytes on Windows x64 and arm64. KEY_EVENT_RECORD
// starts at byte 4; use UTF-16 because the Windows narrow API uses a code page.
const RECORD_SIZE = 20;
const BATCH_SIZE = 4096;
const KEY_EVENT = 0x0001;
const WINDOW_BUFFER_SIZE_EVENT = 0x0004;
const ALT = 0x0003;
const LEFT_ALT = 0x0002;
const CTRL = 0x000c;
const SHIFT = 0x0010;
const ENHANCED_KEY = 0x0100;
const VK_MENU = 0x12;

// Older console hosts can still supply UnicodeChar=0 for navigation and
// function keys. Preserve the raw TTY mappings used by libuv's get_vt100_fn_key.
const NAVIGATION_KEYS: Readonly<Record<number, string>> = {
	0x0c: "G",
	0x21: "5~",
	0x22: "6~",
	0x23: "4~",
	0x24: "1~",
	0x25: "D",
	0x26: "A",
	0x27: "C",
	0x28: "B",
	0x2d: "2~",
	0x2e: "3~",
	0x60: "2~",
	0x61: "4~",
	0x62: "B",
	0x63: "6~",
	0x64: "D",
	0x65: "G",
	0x66: "C",
	0x67: "A",
	0x68: "1~",
	0x69: "5~",
	0x6e: "3~",
};
const SHIFTED_FUNCTION_KEYS = [23, 24, 25, 26, 28, 29, 31, 32, 33, 34];
const FUNCTION_KEYS = [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24];

function legacyVirtualKey(key: number, modifiers: number): string {
	const alt = modifiers & ALT ? "\x1b" : "";
	const shift = (modifiers & SHIFT) !== 0;
	const ctrl = (modifiers & CTRL) !== 0;
	const navigation = NAVIGATION_KEYS[key];
	if (navigation) {
		const parameter = (shift ? 1 : 0) + (ctrl ? 4 : 0);
		if (!parameter) return `${alt}\x1b[${navigation}`;
		const code = navigation.length === 1 ? "1" : navigation.slice(0, -1);
		return `${alt}\x1b[${code};${1 + parameter}${navigation.at(-1)}`;
	}
	const fn = key - 0x70;
	const normal = FUNCTION_KEYS[fn];
	if (normal === undefined) return "";
	if (!shift && !ctrl && fn < 5) return `${alt}\x1b[[${String.fromCharCode(65 + fn)}`;
	const code = shift ? (SHIFTED_FUNCTION_KEYS[fn] ?? normal) : normal;
	const suffix = fn >= 10 && shift ? (ctrl ? "@" : "$") : ctrl ? "^" : "~";
	return `${alt}\x1b[${code}${suffix}`;
}

export function runWindowsConsoleInputWorker(): void {
	const port = parentPort;
	if (!port) throw new Error("Windows console input requires a worker thread");
	const { stopEvent, state } = workerData as ConsoleReaderData;
	if (Atomics.compareExchange(state, 0, IDLE, READING) !== IDLE) return;
	try {
		const library = dlopen("kernel32.dll", {
			GetStdHandle: { args: [FFIType.u32], returns: FFIType.ptr },
			WaitForMultipleObjects: { args: [FFIType.u32, FFIType.ptr, FFIType.bool, FFIType.u32], returns: FFIType.u32 },
			ReadConsoleInputW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
		});
		try {
			const { GetStdHandle, WaitForMultipleObjects, ReadConsoleInputW } = library.symbols;
			const input = GetStdHandle(0xfffffff6); // STD_INPUT_HANDLE (-10)
			if (!input) throw new Error("Missing Windows console input handle");
			// The stop event comes first, so shutdown wins when both are ready.
			const handles = new BigUint64Array([BigInt(stopEvent), BigInt(input)]);
			const records = new DataView(new ArrayBuffer(RECORD_SIZE * BATCH_SIZE));
			const count = new Uint32Array(1);
			let highSurrogate = "";
			for (;;) {
				const ready = WaitForMultipleObjects(handles.length, ptr(handles), false, 0xffffffff);
				if (ready === 0) return;
				if (ready !== 1) throw new Error(`Waiting for Windows console input failed (${ready})`);
				if (!ReadConsoleInputW(input, ptr(records), BATCH_SIZE, ptr(count))) {
					throw new Error("ReadConsoleInputW failed");
				}
				let text = "";
				let resized = false;
				for (let offset = 0; offset < count[0]! * RECORD_SIZE; offset += RECORD_SIZE) {
					const event = records.getUint16(offset, true);
					if (event === WINDOW_BUFFER_SIZE_EVENT) resized = true;
					if (event !== KEY_EVENT) continue;
					const down = records.getInt32(offset + 4, true) !== 0;
					const repeat = records.getUint16(offset + 8, true);
					const key = records.getUint16(offset + 10, true);
					const unit = records.getUint16(offset + 14, true);
					const modifiers = records.getUint32(offset + 16, true);
					if (!down && !(key === VK_MENU && unit)) continue;
					// Ignore Alt+numpad composition steps, then keep the final Alt-up character.
					if (
						modifiers & LEFT_ALT &&
						!(modifiers & ENHANCED_KEY) &&
						(key === 0x0c || key === 0x2d || (key >= 0x21 && key <= 0x28) || (key >= 0x60 && key <= 0x69))
					)
						continue;
					if (unit >= 0xd800 && unit < 0xdc00) {
						highSurrogate = String.fromCharCode(unit);
						continue;
					}
					let sequence: string;
					if (unit) {
						const prefix = down && modifiers & ALT && !(modifiers & CTRL) ? "\x1b" : "";
						sequence = prefix + highSurrogate + String.fromCharCode(unit);
						highSurrogate = "";
					} else {
						sequence = legacyVirtualKey(key, modifiers);
					}
					text += sequence.repeat(repeat);
					if (text.length >= BATCH_SIZE) {
						port.postMessage(text);
						text = "";
					}
				}
				if (text) port.postMessage(text);
				if (resized) port.postMessage(null);
			}
		} finally {
			library.close();
		}
	} finally {
		Atomics.store(state, 0, STOPPED);
		Atomics.notify(state, 0);
	}
}
