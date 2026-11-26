import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createSurface, signal, type UiEvent, UiNode } from "@oh-my-pi/pi-tui";
import { encodeTspJson } from "@oh-my-pi/pi-tui/native/apc";
import { $which, isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { TSP_VERSION } from "@oh-my-pi/pi-wire";
import { $ } from "bun";
import { SplitLayout } from "../src/modes/native-workspace/split-layout";
import type { TernPaneControls } from "../src/modes/native-workspace/tern-panes";
import { NativeWorkspace } from "../src/modes/native-workspace/workspace";
import { quotePosixArgv } from "../src/utils/shell-quote";

interface ControlReply {
	ok: boolean;
	error?: string;
	focused?: { id: number };
	nodes?: { text?: string }[];
}

const tern = $which("tern");
const relay = path.resolve(import.meta.dir, "../src/modes/native-workspace/relay.ts");

function relayArgv(endpoint: string): string[] {
	const script = `import { runNativePaneRelay } from ${JSON.stringify(relay)}; await runNativePaneRelay(${JSON.stringify(endpoint)});`;
	return [process.execPath, "--eval", script];
}

test("closing during a split closes the late native block without mounting or focusing it", async () => {
	const splitting = Promise.withResolvers<void>();
	const split = Promise.withResolvers<{ block: number }>();
	const closed = Promise.withResolvers<number>();
	const client: TernPaneControls = {
		open() {
			splitting.resolve();
			return split.promise;
		},
		async splitPanes() {
			return [{ block: 1, columns: 120, rows: 40, shown: true }];
		},
		async focused() {
			return 1;
		},
		async focus() {
			throw new Error("The caller had already closed the pane");
		},
		async close(block) {
			closed.resolve(block);
		},
		async move() {},
		async balance() {},
	};
	const workspace = new NativeWorkspace(client, 1);
	const opening = workspace.open(
		"late",
		"Late",
		() => {
			throw new Error("The pane must not mount");
		},
		() => {},
	);
	await splitting.promise;
	workspace.close("late");
	split.resolve({ block: 17 });
	await expect(opening).rejects.toThrow("Native workspace view closed");
	expect(await closed.promise).toBe(17);
});

test("Tern lays out lanes by the main pane's physical aspect and combines the last two panes", () => {
	const portrait = new SplitLayout(1, { columns: 100, rows: 60 }, { w: 9, h: 18 });
	expect(portrait.next()).toEqual({ block: 1, dir: "down" });
	const landscape = new SplitLayout(1, { columns: 120, rows: 40 }, { w: 9, h: 18 });
	const placements = [];
	const moves = [];
	for (const block of [2, 3, 4]) {
		const placement = landscape.next();
		placements.push(placement);
		moves.push(...landscape.add(placement, block));
	}
	expect(placements).toEqual([
		{ block: 1, dir: "right" },
		{ block: 2, dir: "down" },
		{ block: 2, dir: "right" },
	]);
	expect(moves).toEqual([{ block: 3, target: 2, dir: "below" }]);
	landscape.remove(3);
	expect(landscape.reflow()).toEqual([{ block: 4, target: 2, dir: "below" }]);
});

test.skipIf(process.platform === "win32")(
	"bracketed paste from one real relay is intercepted there even when another pane is focused",
	async () => {
		const relays = new Map<number, { terminal: Bun.Terminal; exited: Promise<number> }>();
		let nextBlock = 1;
		let focused = 1;
		const hello = encodeTspJson("r", { r: "hello", v: TSP_VERSION, term: "tern", kinds: ["text"], cols: 80 });
		const client: TernPaneControls = {
			async open(endpoint) {
				let output = "";
				const terminal = new Bun.Terminal({
					data(terminal, bytes) {
						output += Buffer.from(bytes).toString("utf8");
						if (output.includes("\x1b_tsp;q;")) {
							terminal.write(hello);
							output = "";
						}
					},
				});
				const process = Bun.spawn(relayArgv(endpoint), { terminal, timeout: 10_000 });
				const block = ++nextBlock;
				relays.set(block, { terminal, exited: process.exited });
				return { block };
			},
			async splitPanes() {
				return [1, ...relays.keys()].map(block => ({ block, columns: 120, rows: 40, shown: true }));
			},
			async focused() {
				return focused;
			},
			async focus(block) {
				focused = block;
			},
			async close() {},
			async move() {},
			async balance() {},
		};
		const workspace = new NativeWorkspace(client, 1);
		const intercepted = Promise.withResolvers<{ key: string; text: string }>();
		const dispatched: string[] = [];
		try {
			for (const key of ["source", "focused beside it"]) {
				await workspace.open(
					key,
					key,
					() => {
						let node: UiNode;
						const surface = createSurface(() => ({
							dock: (node = new UiNode("text", { text: key, onPaste: () => dispatched.push(key) })),
						}));
						surface.focus(node!);
						return {
							surface,
							intercept(event) {
								if (event.type !== "paste") return false;
								intercepted.resolve({ key, text: event.paste.text });
								return true;
							},
						};
					},
					() => {},
				);
			}
			expect(await workspace.isFocused("focused beside it")).toBe(true);
			relays.get(2)!.terminal.write("\x1b[200~side-only clipboard\x1b[201~");
			expect(await intercepted.promise).toEqual({ key: "source", text: "side-only clipboard" });
			expect(dispatched).toEqual([]);
		} finally {
			workspace.dispose();
			for (const { terminal, exited } of relays.values()) {
				await exited;
				terminal.close();
			}
		}
	},
	20_000,
);

test.skipIf(!tern || process.platform === "win32")(
	"a real Tern relay keeps edits and resize in its own pane and tears down on close",
	() => observeHeadlessWorkspace(tern!),
	45_000,
);

async function observeHeadlessWorkspace(tern: string): Promise<void> {
	await using dir = await TempDir.create("@omp-native-workspace-");
	const socket = dir.join("control.sock");
	const home = dir.join("home");
	await fs.mkdir(home);
	const env = {
		PATH: Bun.env.PATH,
		LANG: "en_US.UTF-8",
		SHELL: "/bin/sh",
		HOME: home,
		TERN_CONFIG_DIR: dir.join("tern"),
	};
	const log = Bun.file(dir.join("tern.log"));
	const server = Bun.spawn([tern, "serve", "--control", socket, "--out", dir.path()], {
		cwd: dir.path(),
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: log,
		timeout: 60_000,
	});
	async function ctl(...args: string[]): Promise<ControlReply> {
		const result = await $`${tern} ctl --control ${socket} ${args}`.env(env).quiet();
		const reply = result.json() as ControlReply;
		if (!reply.ok) throw new Error(`${args.join(" ")}: ${reply.error}`);
		return reply;
	}
	async function visible(selector: string, text: string): Promise<void> {
		const deadline = performance.now() + 5_000;
		let nodes: ControlReply["nodes"];
		do {
			nodes = (await ctl("tree", selector)).nodes;
			if (nodes?.some(node => node.text === text)) return;
			await Bun.sleep(25);
		} while (performance.now() < deadline && server.exitCode === null);
		throw new Error(`Expected ${JSON.stringify(text)} under ${selector}; found ${JSON.stringify(nodes)}`);
	}
	const focusId = async () => (await ctl("state")).focused?.id;
	let workspace: NativeWorkspace | undefined;
	try {
		const deadline = performance.now() + 10_000;
		for (;;) {
			try {
				await fs.access(socket);
				break;
			} catch (error) {
				if (!isEnoent(error) || performance.now() >= deadline || server.exitCode !== null) throw error;
				await Bun.sleep(25);
			}
		}
		await ctl("size", "1200", "800", "1");
		await ctl("ready");
		const main = (await focusId())!;
		let child: number | undefined;
		// `tern serve` has no session daemon. Use its pane controls as the test adapter;
		// the PTY, relay and Surface Protocol on both sides are the production ones.
		const client: TernPaneControls = {
			async open(endpoint, placement) {
				expect(placement).toEqual({ block: main, dir: "right" });
				await ctl("split", placement.dir);
				await ctl("ready");
				child = await focusId();
				if (child === undefined || child === main) throw new Error("Tern did not focus the split pane");
				const command = `exec ${quotePosixArgv(relayArgv(endpoint))}`;
				await ctl("type", JSON.stringify(command));
				await ctl("key", "Enter");
				return { block: child };
			},
			async focus(block) {
				if ((await focusId()) !== block) await ctl("click", block === main ? "300" : "900", "500");
			},
			focused: focusId,
			async splitPanes() {
				return [{ block: main, columns: 120, rows: 40, shown: true }];
			},
			async move() {},
			async close(block) {
				if ((await focusId()) === block) await ctl("close");
			},
			async balance() {},
		};
		workspace = new NativeWorkspace(client, main);
		const closed = Promise.withResolvers<void>();
		const draft = signal("");
		const view = await workspace.open(
			"agent",
			"Side agent",
			() => {
				let editor: UiNode;
				const surface = createSurface(() => ({
					main: new UiNode("text", { text: "Private workspace transcript" }),
					dock: (editor = new UiNode("editor", {
						text: draft,
						onEdit: (event: Extract<UiEvent, { type: "edit" }>) => {
							draft.update(value => value.slice(0, event.from) + event.text + value.slice(event.to));
						},
					})),
				}));
				surface.focus(editor!);
				return { surface };
			},
			closed.resolve,
			true,
		);
		expect(await workspace.isFocused("agent")).toBe(false);
		expect(await focusId()).toBe(main);
		await visible(".sf-text", "Private workspace transcript");
		await workspace.open(
			"agent",
			"Side agent",
			() => {
				throw new Error("Already mounted");
			},
			() => {},
		);
		expect(await workspace.isFocused("agent")).toBe(true);
		await ctl("type", JSON.stringify("side draft"));
		await visible(".sf-editor", "side draft");
		expect(draft()).toBe("side draft");
		const before = view.driver.columns;
		const resized = Promise.withResolvers<number>();
		const off = view.driver.onResize(columns => {
			if (columns !== before) resized.resolve(columns);
		});
		await ctl("size", "900", "800", "1");
		expect(await resized.promise).toBeLessThan(before);
		expect(view.driver.columns).toBeLessThan(before);
		off();
		await ctl("close");
		await closed.promise;
		expect(workspace.get("agent")).toBeUndefined();
		expect(await focusId()).toBe(main);
	} finally {
		workspace?.dispose();
		if (server.exitCode === null) await ctl("quit").catch(() => server.kill());
		await server.exited;
	}
}
