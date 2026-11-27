/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, it } from "bun:test";
import {
	createRoot,
	createSurface,
	effect,
	type Host,
	type HostOptions,
	settle,
	type MainScrollScope,
	signal,
	startHost,
	type Surface,
	type WorkspaceSurface,
} from "@oh-my-pi/pi-tui";
import { ALT_ENTER, ALT_LEAVE } from "@oh-my-pi/pi-tui/driver/output/ansi";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { type MemoryTerminal, memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
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
	options: Pick<
		HostOptions,
		"onAppViewportSelectionCopy" | "onAppViewportPasteRequest" | "onKey" | "ansiWorkspaceMainMinimum"
	> & {
		inline?: boolean;
		shell?: string;
		columns?: number;
		rows?: number;
		theme?: HostOptions["theme"];
	} = {},
): Promise<void> {
	const { inline, shell, columns = COLUMNS, rows = ROWS, theme, ...callbacks } = options;
	const term = KittyTerminal.createSync({ columns, rows, scrollback: 100 });
	if (shell) term.write(`${shell}\r\n`);
	const memory = memoryTerminal({
		columns,
		rows,
		env: inline ? {} : { PI_TUI_RENDER_BACKEND: "app-viewport" },
		onWrite: data => term.write(data),
	});
	const host = await startHost({
		...callbacks,
		surface,
		driver: memory.options,
		theme: theme ?? (() => PLAIN_THEME),
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
			expect(host.ansiWorkspace).toBeUndefined();
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
			const transcript = () => screen().map(row => row.replace(/[│█▽]$/u, "").trimEnd());
			expect(host.renderBackend).toBe("app-viewport");
			expect(surface.main().some(node => host.retired(node))).toBe(false);
			expect(transcript()).toEqual(["live4", "live5", "live6", "live7", "dock"]);
			expect(memory.output.join("")).toContain("\x1b[?1002h");
			await afterFrame(host, () => memory.feed("\x1b[<64;1;2M"));
			expect(transcript()).toEqual(["live1", "live2", "live3", "live4", "dock"]);
			await afterFrame(host, () => memory.feed("\x1b[1;3H\x1b[6~")); // Alt+Home, then PgDown in one read.
			expect(transcript()).toEqual(["02abc 03abc", "04abc 05abc", "06abc 07abc", "live0", "dock"]);
			await afterFrame(host, () => {
				prefix.set(["added", "old0", "old1"]);
				output.set([...output(), "live8"]);
			});
			expect(transcript()[0]).toBe("02abc 03abc");
			await afterFrame(host, () => {
				term.resize(6, ROWS);
				memory.resize(6, ROWS);
			});
			expect(transcript()).toEqual(["02abc", "03abc", "04abc", "05abc", "dock"]);
			await afterFrame(host, () => modal.set(true));
			expect(screen()[1]).not.toContain("03abc");
			await afterFrame(host, () => memory.feed("\x1b[1;3F\x1b[<65;1;2M")); // Alt+End and wheel under the layer.
			await afterFrame(host, () => modal.set(false));
			expect(transcript()).toEqual(["02abc", "03abc", "04abc", "05abc", "dock"]);
			await host.suspend(async () => {
				expect(term.isMainScreen).toBe(true);
				expect(screen()).toEqual(["shell", "", "", "", ""]);
			});
			expect(transcript()).toEqual(["02abc", "03abc", "04abc", "05abc", "dock"]);
			await afterFrame(host, () => memory.feed("\x1b[1;3F"));
			expect(transcript()).toEqual(["live5", "live6", "live7", "live8", "dock"]);
			await afterFrame(host, () => output.set([...output(), "live9"]));
			expect(transcript()).toEqual(["live6", "live7", "live8", "live9", "dock"]);
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

it("restores remounted documents' reading points without saving hover scroll", async () => {
	const scope = signal<MainScrollScope>({ key: "a" });
	const tail = signal(["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]);
	const surface = createSurface(() => ({
		mainScrollScope: scope,
		main: () =>
			scope().key === "a" ? (
				[
					<rows lines={["old0", "old1"]} />,
					<text>00abc 01abc 02abc 03abc 04abc 05abc 06abc 07abc</text>,
					<rows lines={tail} />,
				]
			) : (
				<rows lines={["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7"]} />
			),
		dock: <text>dock</text>,
	}));
	await withHost(surface, async ({ host, memory, term, screen }) => {
		expect(screen()[0]).toMatch(/^a4\b/);
		await afterFrame(host, () => memory.feed("\x1b[1;3H\x1b[6~")); // Alt+Home, then PgDown.
		expect(screen()[0]).toMatch(/^02abc 03abc/);

		await afterFrame(host, () => scope.set({ key: "b" }));
		expect(screen()[0]).toMatch(/^b4\b/);
		await afterFrame(host, () => memory.feed("\x1b[1;3H"));
		expect(screen()[0]).toMatch(/^b0\b/);

		await afterFrame(host, () => scope.set({ key: "a" }));
		expect(screen()[0]).toMatch(/^02abc 03abc/);
		await afterFrame(host, () => scope.set({ key: "b", preview: true }));
		expect(screen()[0]).toMatch(/^b0\b/);
		await afterFrame(host, () => memory.feed("\x1b[6~"));
		expect(screen()[0]).not.toMatch(/^b0\b/);

		await afterFrame(host, () => {
			term.resize(6, ROWS);
			memory.resize(6, ROWS);
			tail.set([...tail(), "a8"]);
		});
		await afterFrame(host, () => scope.set({ key: "a" }));
		expect(screen()[0]).toMatch(/^02abc/);
		await afterFrame(host, () => scope.set({ key: "b" }));
		expect(screen()[0]).toMatch(/^b0\b/);
	});
});

it("shows the tail before refining distant history, also after a width resize", async () => {
	const count = 512;
	const painted = new Map<number, number[]>();
	const surface = createSurface(() => ({
		main: Array.from({ length: count }, (_, i) => (
			<canvas
				key={`${i}`}
				paint={width => {
					let calls = painted.get(width);
					if (!calls) painted.set(width, (calls = []));
					calls.push(i);
					return [`block${i}`];
				}}
			/>
		)),
		dock: <text>dock</text>,
	}));
	await withHost(surface, async ({ host, memory, term, screen }) => {
		const tail = ["block508", "block509", "block510", "block511"];
		const visibleTranscript = () =>
			screen()
				.slice(0, 4)
				.map(row => row.split(" ")[0]);
		const initial = [...painted.values()][0]!;
		expect(visibleTranscript()).toEqual(tail);
		expect(initial).not.toContain(0);
		expect(initial.length).toBeLessThan(count / 8);
		const first = initial.length;
		await afterFrame(host, () => {}); // Continuation requested by the viewport, not by an input event.
		expect(initial.length).toBeGreaterThan(first);
		expect(initial.length - first).toBeLessThan(count / 8);
		expect(initial.filter(index => index === 511)).toEqual([511]); // Same-width cached tail.
		expect(visibleTranscript()).toEqual(tail);
		await afterFrame(host, () => {
			term.resize(20, ROWS);
			memory.resize(20, ROWS);
		});
		const resized = [...painted.values()].at(-1)!;
		expect(resized).not.toBe(initial);
		expect(resized).not.toContain(0);
		expect(resized.length).toBeLessThan(count / 8);
		expect(visibleTranscript()).toEqual(tail);
	});
});

it("drags the transcript thumb across content and returns to a live tail from the rail", async () => {
	const lines = signal(Array.from({ length: 16 }, (_, i) => `item${i}`));
	const surface = createSurface(() => ({
		main: <rows lines={lines} />,
		dock: <text>dock</text>,
	}));
	await withHost(surface, async ({ host, memory, screen }) => {
		expect(screen()[0]).toMatch(/^item12\b/);
		expect(screen()[3]).toMatch(/█$/u);
		await afterFrame(host, () => memory.feed("\x1b[<0;12;4M"));
		expect(screen()[0]).toMatch(/^item12\b/);
		await afterFrame(host, () => memory.feed("\x1b[<32;2;2M\x1b[<0;2;2m"));
		expect(screen()[0]).toMatch(/^item4\b/);
		expect(screen()[3]).toMatch(/▽$/u);
		await afterFrame(host, () => lines.set([...lines(), "item16"]));
		expect(screen()[0]).toMatch(/^item4\b/);
		await afterFrame(host, () => memory.feed("\x1b[<0;12;4M\x1b[<0;12;4m"));
		expect(screen()[3]).toMatch(/^item16\s+█$/u);
		await afterFrame(host, () => lines.set([...lines(), "item17"]));
		expect(screen()[3]).toMatch(/^item17\s+█$/u);
		expect(screen()[4]).toBe("dock");
	});
});

it("keeps the selected text across a transcript rewrap", async () => {
	const copied: string[] = [];
	const surface = createSurface(() => ({
		main: <text>alpha bravo ch x</text>,
		dock: <text>dock</text>,
	}));
	await withHost(
		surface,
		async ({ host, memory, term, screen }) => {
			await afterFrame(host, () => memory.feed("\x1b[<0;7;1M\x1b[<32;11;1M\x1b[<0;11;1m"));
			memory.feed("\x03");
			expect(copied).toEqual(["bravo"]);
			await afterFrame(host, () => {
				term.resize(7, ROWS);
				memory.resize(7, ROWS);
			});
			expect(screen()[1]).toBe("bravo");
			memory.feed("\x03");
			expect(copied).toEqual(["bravo", "bravo"]);
		},
		{ onAppViewportSelectionCopy: text => copied.push(text) },
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

/** Feed the SGR reports the ANSI driver actually gets, using screen cells. */
function selectCells(memory: MemoryTerminal, start: [number, number], end: [number, number]): void {
	const [x, y] = start;
	const [u, v] = end;
	memory.feed(`\x1b[<0;${x};${y}M\x1b[<32;${u};${v}M\x1b[<0;${u};${v}m`);
}

it("copies a transcript selection before a focused editor's clear/stop binding", async () => {
	const copied: string[] = [];
	const draft = signal("keep my draft");
	let clears = 0;
	const surface = createSurface(() => ({
		main: <text>copy this transcript</text>,
		dock: (
			<editor
				text={draft}
				onKey={key => {
					if (key.id !== "ctrl+c") return false;
					clears++;
					draft.set("");
					return true;
				}}
			/>
		),
	}));
	surface.focus(surface.dock()[0]!);
	await withHost(
		surface,
		async ({ host, memory, screen }) => {
			await afterFrame(host, () => selectCells(memory, [1, 1], [9, 1]));
			memory.feed("\x03");
			expect(copied).toEqual(["copy this"]);
			expect(clears).toBe(0);
			expect(screen().at(-1)).toContain("keep my draft");
			await afterFrame(host, () => memory.feed("\x1b[<0;1;1M\x1b[<0;1;1m"));
			await afterFrame(host, () => memory.feed("\x03"));
			expect(clears).toBe(1);
			expect(screen().at(-1)).not.toContain("keep my draft");
		},
		{ columns: 32, onAppViewportSelectionCopy: text => copied.push(text) },
	);
});

it("copies exact text through word wraps and mid-word wraps, preserving hard line breaks", async () => {
	const copied: string[] = [];
	const text = "alpha   bravo\nabcdefghijklmnop\nlast";
	const surface = createSurface(() => ({
		main: (
			<col>
				<text text={text} />
			</col>
		),
	}));
	await withHost(
		surface,
		async ({ host, memory, screen }) => {
			expect(screen()[0]).toBe("alpha");
			expect(screen()[1]).toBe("bravo");
			await afterFrame(host, () => selectCells(memory, [1, 1], [4, 5]));
			memory.feed("\x03");
			expect(copied).toEqual([text]);
		},
		{ onAppViewportSelectionCopy: text => copied.push(text) },
	);
});

it("does not copy a repeated Markdown quote border at a soft wrap", async () => {
	const copied: string[] = [];
	const surface = createSurface(() => ({ main: <md text="> alpha **bravo**" /> }));
	await withHost(
		surface,
		async ({ host, memory, screen }) => {
			expect(screen()[0]).toContain("alpha");
			expect(screen()[1]).toContain("bravo");
			await afterFrame(host, () => selectCells(memory, [3, 1], [7, 2]));
			memory.feed("\x03");
			expect(copied).toEqual(["alpha bravo"]);
		},
		{ onAppViewportSelectionCopy: text => copied.push(text) },
	);
});

it("double-clicks words, paths and URLs, then triple-clicks the full displayed row", async () => {
	const copied: string[] = [];
	const lines = ["alpha beta gamma", "open /tmp/foo-bar_baz.ts:42 now", "visit https://example.com/a-b?x=1#top now"];
	const surface = createSurface(() => ({ main: <rows lines={lines} /> }));
	await withHost(
		surface,
		async ({ memory }) => {
			const click = (col: number, row: number, count: number) =>
				memory.feed(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`.repeat(count));
			click(8, 1, 2);
			memory.feed("\x03");
			click(8, 1, 1);
			memory.feed("\x03");
			click(12, 2, 2);
			memory.feed("\x03");
			click(17, 3, 2);
			memory.feed("\x03");
			expect(copied).toEqual(["beta", lines[0]!, "/tmp/foo-bar_baz.ts:42", "https://example.com/a-b?x=1#top"]);
		},
		{ columns: 50, onAppViewportSelectionCopy: text => copied.push(text) },
	);
});

it("copies a styled status segment and keeps a held editor selection in place while main streams", async () => {
	const copied: string[] = [];
	const stream = signal(["row0", "row1", "row2", "row3"]);
	const surface = createSurface(() => ({
		main: <rows lines={stream} />,
		dock: [<rows lines={["\x1b[34m model \x1b[0m\x1b[32m path \x1b[0m"]} />, <editor text="hello world input" />],
	}));
	surface.focus(surface.dock()[1]!);
	await withHost(
		surface,
		async ({ host, memory, screen }) => {
			await afterFrame(host, () => selectCells(memory, [2, 4], [8, 4]));
			memory.feed("\x03");
			expect(copied).toEqual(["model  "]);
			await afterFrame(host, () => memory.feed("\x1b[<0;1;5M\x1b[<32;6;5M"));
			await afterFrame(host, () => stream.set([...stream(), "row4", "row5"]));
			expect(screen()[0]).toMatch(/^row3/);
			await afterFrame(host, () => memory.feed("\x1b[<32;11;5M\x1b[<0;11;5m"));
			memory.feed("\x03");
			expect(copied).toEqual(["model  ", "hello world"]);
		},
		{ columns: 25, onAppViewportSelectionCopy: text => copied.push(text) },
	);
});

it("does not start a dock selection from a mouse press claimed by a widget", async () => {
	const copied: string[] = [];
	const selected: string[] = [];
	defineRolePainter("canvas", "test.app-viewport-dock-hit", node => ({
		rows: ["action text"],
		hits: [{ node, item: "action", row: 0, col: 0, width: 6, height: 1 }],
	}));
	const surface = createSurface(() => ({
		dock: <canvas role="test.app-viewport-dock-hit" paint={() => []} onSelect={item => selected.push(item)} />,
	}));
	await withHost(
		surface,
		async ({ host, memory }) => {
			await afterFrame(host, () => selectCells(memory, [1, 5], [11, 5]));
			memory.feed("\x03");
			expect(selected).toEqual(["action"]);
			expect(copied).toEqual([]);
		},
		{ onAppViewportSelectionCopy: text => copied.push(text) },
	);
});

it("continues to scroll and extend a transcript selection without further mouse motion", async () => {
	const copied: string[] = [];
	const lines = Array.from({ length: 20 }, (_, i) => `row-${i}`);
	const surface = createSurface(() => ({ main: <rows lines={lines} />, dock: <text>dock</text> }));
	await withHost(
		surface,
		async ({ host, memory, screen }) => {
			expect(screen()[0]).toMatch(/^row-16\b/);
			const { promise, resolve } = Promise.withResolvers<void>();
			const off = host.onFrame(() => {
				if (!screen()[0]?.match(/^row-13\b/)) return;
				memory.feed("\x1b[<0;1;1m\x03");
				resolve();
			});
			try {
				// One drag report, but the selection extends three rows beyond the initial viewport.
				memory.feed("\x1b[<0;6;3M\x1b[<32;1;1M");
				await promise;
			} finally {
				off();
			}
			expect(copied).toEqual([lines.slice(13, 19).join("\n")]);
		},
		{ columns: 25, onAppViewportSelectionCopy: text => copied.push(text) },
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

it("composes a recursive workspace, scopes scrolling and attachments, and closes locally", async () => {
	const pasted: string[] = [];
	const edits: string[] = [];
	const disposed: string[] = [];
	const main = createSurface(() => ({
		main: <rows lines={Array.from({ length: 12 }, (_, i) => `main${i}`)} />,
		dock: (
			<editor
				text=""
				onPaste={paste => {
					pasted.push(`main:${paste.text}`);
					return true;
				}}
			/>
		),
	}));
	main.focus(main.dock()[0]!);
	const sizes: Record<string, number> = {};
	const create =
		(name: string) =>
		(_close: () => void, rows: () => number): WorkspaceSurface => {
			const dock = signal(`${name} dock`);
			const surface = createSurface(() => ({
				main: <rows lines={Array.from({ length: 12 }, (_, i) => `${name}${i}`)} />,
				dock: (
					<editor
						text={dock}
						onEdit={edit => {
							if (edit.type === "edit") {
								edits.push(name);
								dock.set(dock().slice(0, edit.from) + edit.text + dock().slice(edit.to));
							}
						}}
						onPaste={paste => {
							pasted.push(`${name}:${paste.text}`);
							return true;
						}}
					/>
				),
			}));
			surface.focus(surface.dock()[0]!);
			const stopMeasuring = createRoot(dispose => {
				effect(() => {
					sizes[name] = rows();
				});
				return dispose;
			});
			return {
				surface,
				intercept(event) {
					if (event.type !== "key" || event.key.id !== "q") return false;
					edits.push(`${name}:intercept`);
					return true;
				},
				dispose() {
					stopMeasuring();
					disposed.push(name);
				},
			};
		};
	await withHost(
		main,
		async ({ host, memory, screen, term }) => {
			const workspace = host.ansiWorkspace!;
			await afterFrame(host, () => {
				expect(workspace.open("b", create("b"), { target: "main", edge: "right", label: "Agent B" })).toBe(true);
				expect(
					workspace.open("c", create("c"), { target: "b", edge: "bottom", label: "Agent C", focus: false }),
				).toBe(true);
			});
			expect(workspace.active()).toBe("b");
			expect(sizes).toEqual({ b: 4, c: 4 });
			expect(screen()[0]).toMatch(/Main\s+│› Agent B/);
			expect(screen()[1]).toMatch(/^main3\s+[│█]│b9/);
			expect(screen()[4]).toContain("b dock");
			expect(screen()[6]).toContain("Agent C");
			expect(screen()[10]).toContain("c dock");
			expect(term.cursor.y).toBe(4);
			await afterFrame(host, () => memory.feed("\x1b[<64;43;8M")); // Wheel in C, while B is active.
			expect(screen()[7]).toMatch(/│c6\s+[│█▽]$/u);
			expect(screen()[1]).toMatch(/│b9\s+[│█]$/u);
			expect(workspace.active()).toBe("b");
			memory.feed("qX\x1b[200~pasted\x1b[201~");
			expect(edits).toEqual(["b:intercept", "b"]);
			expect(pasted).toEqual(["b:pasted"]);
			// Click C's title and route an app-recovered paste (e.g. an attachment marker).
			await afterFrame(host, () => memory.feed("\x1b[<0;43;7M\x1b[<0;43;7m"));
			host.dispatch({ type: "paste", paste: { text: "attachment" } });
			expect(pasted).toEqual(["b:pasted", "c:attachment"]);
			expect(term.cursor.y).toBe(10);
			await afterFrame(host, () => memory.feed("\x1b[1;4H")); // Alt+Shift+Home returns to Main only.
			expect(workspace.active()).toBe("main");
			expect(disposed).toEqual([]);
			memory.feed("\x1b[200~main paste\x1b[201~");
			expect(pasted).toEqual(["b:pasted", "c:attachment", "main:main paste"]);
			expect(workspace.focus("b")).toBe(true);
			// Close C using its own header without dismantling B or the shared screen.
			await afterFrame(host, () => memory.feed("\x1b[<0;77;7M"));
			expect(workspace.active()).toBe("b");
			expect(disposed).toEqual(["c"]);
			expect(screen().join("\n")).not.toContain("Agent C");
			expect(screen()[10]).toContain("b dock");
			expect(sizes.b).toBe(10);
			expect(memory.output.join("").split(ALT_ENTER)).toHaveLength(2);
			await host.stop();
			expect(disposed).toEqual(["c", "b"]);
		},
		{ columns: 77, rows: 11 },
	);
});

it("clamps sash drags and parks panes through a too-small resize without losing the active input target", async () => {
	const main = createSurface(() => ({ main: <text>main body</text> }));
	let released = 0;
	let measure: (() => number) | undefined;
	await withHost(
		main,
		async ({ host, memory, screen, term }) => {
			const workspace = host.ansiWorkspace!;
			await afterFrame(host, () => {
				expect(
					workspace.open(
						"side",
						(_, rows) => {
							measure = rows;
							return {
								surface: createSurface(() => ({ main: <text>side body</text> })),
								dispose: () => released++,
							};
						},
						{ minWidth: 22 },
					),
				).toBe(true);
			});
			expect(screen()[0]!.indexOf("│")).toBe(42);
			await afterFrame(host, () => memory.feed("\x1b[<0;43;2M\x1b[<32;76;2M\x1b[<0;76;2m"));
			expect(screen()[0]!.indexOf("│")).toBe(54); // Leave the right pane's 22-column minimum.
			await afterFrame(host, () => {
				term.resize(24, 8);
				memory.resize(24, 8);
			});
			expect(workspace.active()).toBe("main");
			expect(measure?.()).toBe(0);
			expect(screen()[0]).toBe("main body");
			expect(released).toBe(0);
			expect(
				workspace.open(
					"overflow",
					() => {
						throw new Error("must not mount");
					},
					{ edge: "right" },
				),
			).toBe(false);
			await afterFrame(host, () => {
				term.resize(77, 11);
				memory.resize(77, 11);
			});
			expect(workspace.active()).toBe("main");
			expect(measure?.()).toBe(10);
			expect(screen()[0]!.indexOf("│")).toBe(54);
			expect(screen()[1]).toContain("side body");
		},
		{ columns: 77, rows: 11, ansiWorkspaceMainMinimum: { minWidth: 42 } },
	);
	expect(released).toBe(1);
});

it("previews and redocks a dragged pane without remounting it", async () => {
	const theme = loadThemeSync("dark");
	const surface = createSurface(() => ({ main: <text>main body</text> }));
	const body = signal("side before");
	let released = 0;
	await withHost(
		surface,
		async ({ host, memory, screen }) => {
			const workspace = host.ansiWorkspace!;
			await afterFrame(host, () => {
				expect(
					workspace.open(
						"side",
						() => ({
							surface: createSurface(() => ({ main: <text text={body} /> })),
							intercept: event => event.type === "key" && event.key.id === "escape",
							dispose: () => released++,
						}),
						{ label: "Side" },
					),
				).toBe(true);
			});
			expect(screen()[1]).toMatch(/^main body\s+│side before$/);
			const written = memory.output.length;
			await afterFrame(host, () => memory.feed("\x1b[<0;41;1M\x1b[<32;2;5M"));
			expect(screen()[0]).toMatch(/^┏━+┓ +│› Side/);
			expect(screen()[1]).toMatch(/^┃side before +┃ +│side before$/);
			const preview = memory.output.slice(written).join("");
			expect(preview).toContain(`${theme.fgSgr("accent")}┏`);
			expect(preview).toContain(`${theme.fgSgr("muted")}side before`);
			await afterFrame(host, () => body.set("side after"));
			expect(screen()[1]).toMatch(/^┃side before +┃ +│side after$/);
			await afterFrame(host, () => memory.feed("\x1b[27u"));
			expect(screen()[1]).toMatch(/^main body\s+│side after$/);
			await afterFrame(host, () => memory.feed("\x1b[<0;41;1M\x1b[<32;2;5M"));
			await afterFrame(host, () => memory.feed("\x1b[<0;2;5m"));
			expect(screen()[0]).toMatch(/^› Side.*│  Main$/);
			expect(screen()[1]).toMatch(/^side after\s+│main body$/);
			expect(workspace.active()).toBe("side");
			expect(released).toBe(0);
		},
		{ columns: 77, rows: 11, theme: () => theme },
	);
	expect(released).toBe(1);
});

it("reflows only automatic splits that fit a grid, keeping mounted editors and focus", async () => {
	const main = createSurface(() => ({ main: <text>Main body</text> }));
	const mounted: string[] = [];
	const disposed: string[] = [];
	const initialRows: Record<string, number> = {};
	const create =
		(name: string) =>
		(_close: () => void, rows: () => number): WorkspaceSurface => {
			mounted.push(name);
			initialRows[name] = rows();
			const draft = signal("");
			const surface = createSurface(() => ({
				main: <text text={`${name} body`} />,
				dock:
					name === "b" ? (
						<editor
							text={draft}
							onEdit={edit => {
								if (edit.type === "edit") {
									draft.set(draft().slice(0, edit.from) + edit.text + draft().slice(edit.to));
								}
							}}
						/>
					) : null,
			}));
			if (name === "b") surface.focus(surface.dock()[0]!);
			return { surface, dispose: () => disposed.push(name) };
		};
	await withHost(
		main,
		async ({ host, memory, screen }) => {
			const workspace = host.ansiWorkspace!;
			await afterFrame(host, () => {
				expect(workspace.open("b", create("b"), { target: "main", edge: "right" })).toBe(true);
				expect(workspace.open("c", create("c"), { target: "b", edge: "bottom", focus: false })).toBe(true);
			});
			await afterFrame(host, () => memory.feed("draft"));
			const initial = screen().join("\n");
			expect(initial).toContain("Main body");
			expect(initial).toContain("c body");
			expect(initial).toContain("draft");

			const before = screen();
			expect(workspace.open("d", create("d"), { target: "main", minHeight: 6 })).toBe(false);
			expect(mounted).toEqual(["b", "c"]);
			expect(screen()).toEqual(before);

			// Main and D each need 6 rows, so neither can share the left column of the
			// original tree. The right column is also full. Pair them with B and C instead.
			await afterFrame(host, () => {
				expect(workspace.open("d", create("d"), { minHeight: 6, focus: false })).toBe(true);
			});
			expect(mounted).toEqual(["b", "c", "d"]);
			expect(initialRows.d).toBe(5);
			expect(disposed).toEqual([]);
			expect(workspace.active()).toBe("b");
			const reflowed = screen().join("\n");
			for (const text of ["Main body", "b body", "c body", "d body", "draft"]) expect(reflowed).toContain(text);

			await afterFrame(host, () => memory.feed("X"));
			expect(screen().join("\n")).toContain("draftX");
			const grid = screen();
			await afterFrame(host, () => {
				expect(workspace.open("e", create("e"))).toBe(false);
				memory.feed("\x1b[24~"); // A no-op F12 still requests a frame.
			});
			expect(mounted).toEqual(["b", "c", "d"]);
			expect(workspace.active()).toBe("b");
			expect(screen()).toEqual(grid);
		},
		{ columns: 37, rows: 11, ansiWorkspaceMainMinimum: { minHeight: 6 } },
	);
	expect(disposed).toEqual(["b", "c", "d"]);
});
