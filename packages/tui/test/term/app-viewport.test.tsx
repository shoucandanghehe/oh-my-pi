/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, it } from "bun:test";
import { createSurface, type Host, type HostOptions, settle, signal, startHost, type Surface } from "@oh-my-pi/pi-tui";
import { ALT_ENTER, ALT_LEAVE } from "@oh-my-pi/pi-tui/driver/output/ansi";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { type MemoryTerminal, memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { KittyTerminal } from "kitty-vt-wasm";

const COLUMNS = 12;
const ROWS = 5;

interface RunningHost {
	readonly host: Host;
	readonly term: KittyTerminal;
	readonly memory: MemoryTerminal;
	readonly screen: () => string[];
}

async function withHost(
	surface: Surface,
	use: (running: RunningHost) => Promise<void>,
	options: Pick<HostOptions, "onAppViewportSelectionCopy" | "onAppViewportPasteRequest" | "onKey"> & {
		inline?: boolean;
		shell?: string;
	} = {},
): Promise<void> {
	const { inline, shell, ...callbacks } = options;
	const term = KittyTerminal.createSync({ columns: COLUMNS, rows: ROWS, scrollback: 100 });
	if (shell) term.write(`${shell}\r\n`);
	const memory = memoryTerminal({
		columns: COLUMNS,
		rows: ROWS,
		env: inline ? {} : { PI_TUI_RENDER_BACKEND: "app-viewport" },
		onWrite: data => term.write(data),
	});
	const host = await startHost({
		...callbacks,
		surface,
		driver: memory.options,
		theme: () => PLAIN_THEME,
		separator: () => 0,
		native: false,
	});
	try {
		await use({
			host,
			term,
			memory,
			screen: () => Array.from({ length: term.rows }, (_, row) => term.line(row).trimEnd()),
		});
	} finally {
		await host.stop();
		surface.dispose();
	}
}

function afterFrame(host: Host, change: () => void): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const off = host.onFrame(() => {
		off();
		resolve();
	});
	change();
	return promise;
}

it("uses the terminal's scrollback by default", async () => {
	const surface = createSurface(() => ({
		main: <rows lines={["one", "two", "three", "four", "five", "six"]} />,
		dock: <text>dock</text>,
	}));
	const node = surface.main()[0]!;
	settle(node);
	await withHost(
		surface,
		async ({ host, memory, term, screen }) => {
			expect(host.renderBackend).toBe("inline");
			expect(host.retired(node)).toBe(true);
			expect(term.scrollbackLine(0)?.trimEnd()).toBe("one");
			expect(screen()).toEqual(["three", "four", "five", "six", "dock"]);
			await host.stop();
			expect(memory.output.join("")).not.toContain(ALT_ENTER);
		},
		{ inline: true },
	);
});

it("scrolls only main, anchoring to the same text through upstream growth and rewrap", async () => {
	const prefix = signal(["old0", "old1"]);
	const output = signal(["live0", "live1", "live2", "live3", "live4", "live5", "live6", "live7"]);
	const modal = signal(false);
	const surface = createSurface(() => ({
		main: [
			<rows key="prefix" lines={prefix} />,
			<text key="wrapping">00abc 01abc 02abc 03abc 04abc 05abc 06abc 07abc</text>,
			<rows key="output" lines={output} />,
		],
		dock: <text>dock</text>,
		layer: () =>
			modal() ? (
				<overlay size="full" modal>
					<text>modal</text>
				</overlay>
			) : null,
	}));
	for (const node of surface.main().slice(0, 2)) settle(node);
	await withHost(
		surface,
		async ({ host, memory, term, screen }) => {
			expect(host.renderBackend).toBe("app-viewport");
			expect(surface.main().some(node => host.retired(node))).toBe(false);
			expect(screen()).toEqual(["live4", "live5", "live6", "live7", "dock"]);
			expect(memory.output.join("")).toContain("\x1b[?1002h");
			await afterFrame(host, () => memory.feed("\x1b[<64;1;2M"));
			expect(screen()).toEqual(["live1", "live2", "live3", "live4", "dock"]);
			await afterFrame(host, () => memory.feed("\x1b[1;3H\x1b[6~")); // Alt+Home, then PgDown in one read.
			expect(screen()).toEqual(["02abc 03abc", "04abc 05abc", "06abc 07abc", "live0", "dock"]);
			await afterFrame(host, () => {
				prefix.set(["added", "old0", "old1"]);
				output.set([...output(), "live8"]);
			});
			expect(screen()[0]).toBe("02abc 03abc");
			await afterFrame(host, () => {
				term.resize(6, ROWS);
				memory.resize(6, ROWS);
			});
			expect(screen()).toEqual(["02abc", "03abc", "04abc", "05abc", "dock"]);
			await afterFrame(host, () => modal.set(true));
			expect(screen()[1]).not.toContain("03abc");
			await afterFrame(host, () => memory.feed("\x1b[1;3F\x1b[<65;1;2M")); // Alt+End and wheel under the layer.
			await afterFrame(host, () => modal.set(false));
			expect(screen()).toEqual(["02abc", "03abc", "04abc", "05abc", "dock"]);
			await host.suspend(async () => {
				expect(term.isMainScreen).toBe(true);
				expect(screen()).toEqual(["shell", "", "", "", ""]);
			});
			expect(screen()).toEqual(["02abc", "03abc", "04abc", "05abc", "dock"]);
			await afterFrame(host, () => memory.feed("\x1b[1;3F"));
			expect(screen()).toEqual(["live5", "live6", "live7", "live8", "dock"]);
			await afterFrame(host, () => output.set([...output(), "live9"]));
			expect(screen()).toEqual(["live6", "live7", "live8", "live9", "dock"]);
			await host.stop();
			const outputBytes = memory.output.join("");
			expect(outputBytes.split(ALT_ENTER)).toHaveLength(3);
			expect(outputBytes.split(ALT_LEAVE)).toHaveLength(3);
			expect(term.scrollbackLength).toBe(0);
			expect(screen()).toEqual(["shell", "", "", "", ""]);
		},
		{ shell: "shell" },
	);
});

it("copies wide styled transcript text without the dock and requests paste only without a selection", async () => {
	const selected: string[] = [];
	let pastes = 0;
	const unhandled: string[] = [];
	const surface = createSurface(() => ({
		main: <rows lines={["a\x1b[31m界\x1b[0mb", "second"]} />,
		dock: <text>dock</text>,
	}));
	await withHost(
		surface,
		async ({ host, memory }) => {
			const before = memory.output.length;
			// Start on the second cell of 界, then drag to the third cell of the next row.
			await afterFrame(host, () => memory.feed("\x1b[<0;3;1M\x1b[<32;3;2M\x1b[<0;3;2m"));
			expect(memory.output.slice(before).join("")).toContain("\x1b[7m界b");
			memory.feed("\x03");
			expect(selected).toEqual(["界b\nsec"]);
			memory.feed("\x1b[<2;1;1M\x1b[<2;1;1M");
			expect(selected).toEqual(["界b\nsec", "界b\nsec"]);
			expect(pastes).toBe(1);
			memory.feed("\x03");
			expect(unhandled).toEqual(["ctrl+c"]);
		},
		{
			onAppViewportSelectionCopy: text => selected.push(text),
			onAppViewportPasteRequest: () => pastes++,
			onKey: key => {
				unhandled.push(key.id);
				return true;
			},
		},
	);
});

it("blocks clicks through a floating sheet without disabling uncovered main hits", async () => {
	const clicked: string[] = [];
	defineRolePainter("canvas", "test.app-viewport-hits", (node, cx) => {
		const rows = ["one", "two", "three", "four", "five", "six"];
		return {
			rows,
			hits: rows.map((item, row) => ({ node, item, row, col: 0, width: cx.width, height: 1 })),
		};
	});
	const surface = createSurface(() => ({
		main: <canvas role="test.app-viewport-hits" paint={() => []} onSelect={item => clicked.push(item)} />,
		dock: <text>dock</text>,
		layer: (
			<overlay anchor="top" size="sm">
				<text>ok</text>
			</overlay>
		),
	}));
	await withHost(surface, async ({ memory, screen }) => {
		expect(screen()[1]).toContain("ok");
		memory.feed("\x1b[<0;5;2M"); // Covered by the sheet; no widget owns the cell.
		memory.feed("\x1b[<0;1;2M"); // Same row to the left of the sheet.
		memory.feed("\x1b[<0;1;5M"); // In the dock, not in the still-mapped main block.
		expect(clicked).toEqual(["four"]);
	});
});
