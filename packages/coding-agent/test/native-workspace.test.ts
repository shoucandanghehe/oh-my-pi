import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "../../tui/test/native/tsp-harness";
import { NativePaneHarness } from "./helpers/native-pane-harness";
import type { TernSplitResult } from "../src/tools/browser/tern/panes";
import { smokeTestNativePaneRelay } from "../src/modes/native-workspace/smoke";

beforeAll(async () => {
	await initTheme(false);
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

describe("Main-owned Tern workspace panes", () => {
	it("runs the real CLI relay with terminal output and graceful shutdown from a marked test host", async () => {
		const previous = Bun.env.PI_TEST_RUNTIME;
		try {
			Bun.env.PI_TEST_RUNTIME = "1";
			await smokeTestNativePaneRelay();
		} finally {
			if (previous === undefined) delete Bun.env.PI_TEST_RUNTIME;
			else Bun.env.PI_TEST_RUNTIME = previous;
		}
	}, 30_000);

	for (const preserveFocus of [false, true]) {
		it(
			preserveFocus
				? "stacks concurrent automatic panes without stealing Main focus or crossing their input"
				: "stacks concurrent focused panes into separate live documents with their own input",
			async () => {
				const native = new NativePaneHarness();
				cleanups.push(() => native.dispose());
				const submissions = new Map<string, string>();
				await Promise.all(
					["first", "second"].map(key =>
						native.workspace.open(
							key,
							key,
							() => {
								const editor = new CustomEditor(getEditorTheme());
								editor.onSubmit = text => {
									submissions.set(key, text);
								};
								return editor;
							},
							() => {},
							preserveFocus,
						),
					),
				);
				// Tern's external split contract: only the first pane uses Main/right.
				expect(native.placements).toEqual([undefined, { block: 2, dir: "down" }]);
				expect(native.focused).toBe(preserveFocus ? 1 : 3);
				await native.until(() => [2, 3].every(block => native.nodes(block).some(node => node.k === "editor")));
				native.terminals.get(2)!.send("first draft");
				native.terminals.get(3)!.send("second draft");
				await native.until(
					() =>
						native.nodes(2).some(node => node.k === "editor" && node.p?.text === "first draft") &&
						native.nodes(3).some(node => node.k === "editor" && node.p?.text === "second draft"),
				);
				native.terminals.get(2)!.send("\r");
				native.terminals.get(3)!.send("\r");
				await native.until(() => submissions.size === 2);
				expect(submissions.get("first")).toBe("first draft");
				expect(submissions.get("second")).toBe("second draft");
				for (const block of [2, 3]) expect(native.terminals.get(block)!.errors).toEqual([]);
			},
		);
	}

	it("opens an inline conversation with a flowing transcript and dock without taking Main focus", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const editor = new CustomEditor(getEditorTheme());
		const transcript = new Text("Independent transcript");
		const card = new Text("Overlay-only card");
		const component: Component & { focused: boolean } = {
			focused: false,
			render: width => card.render(width),
			describe: () => node("col", {}, [card]),
			describeSurface() {
				// Surface components may use instance state; forwarding must retain the receiver.
				return { main: [transcript], dock: this.focused ? [] : [editor] };
			},
			handleInput: data => editor.handleInput(data),
		};
		const view = await native.workspace.open(
			"surface",
			"Surface",
			() => component,
			() => {},
			true,
		);
		await native.until(() => native.nodes(2).some(node => node.k === "editor"));
		const region = (name: string) => native.nodes(2).find(node => node.id === name);
		expect(JSON.stringify(region("main"))).toContain("Independent transcript");
		expect(JSON.stringify(region("main"))).not.toContain("Overlay-only card");
		expect(JSON.stringify(region("main"))).not.toContain('"k":"editor"');
		expect(JSON.stringify(region("dock"))).toContain('"k":"editor"');
		expect(component.focused).toBe(false);
		expect(native.focused).toBe(1);
		expect(native.terminals.get(2)!.log.find(message => message.verb === "o")?.body).toMatchObject({
			mode: "inline",
		});
		const terminal = native.terminals.get(2)!;
		const transcriptId = region("main")?.c?.[0]?.id;
		const previousFrames = terminal.frames.length;
		transcript.setText("Independent transcript\nStreamed tail");
		view.ui.requestComponentRender(transcript);
		await native.until(() => JSON.stringify(region("main")).includes("Streamed tail"));
		expect(region("main")?.c?.[0]?.id).toBe(transcriptId);
		expect(terminal.log.filter(message => message.verb === "o")).toHaveLength(1);
		expect(
			terminal.frames
				.slice(previousFrames)
				.flatMap(frame => frame.ops)
				.filter(op => op[0] === "scroll"),
		).toEqual([]);
		native.terminals.get(2)!.send("surface draft");
		await native.until(() => native.nodes(2).some(node => node.k === "editor" && node.p?.text === "surface draft"));
		expect(view.ui.nativeRendering).toBe(true);
		expect(native.terminals.get(2)!.errors).toEqual([]);
	});

	it("places the next pane while an allocated sibling is still waiting for its relay", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		vi.spyOn(native.workspace.client, "open").mockResolvedValueOnce({ session: 1, tab: 1, block: 999 });
		vi.spyOn(native.workspace.client, "isSplitPane").mockImplementation(
			async block => block === 999 || native.terminals.has(block),
		);
		const waiting = native.workspace
			.open(
				"waiting",
				"Waiting",
				() => new Text("Not connected"),
				() => {},
			)
			.catch(error => error);
		const view = await native.workspace.open(
			"next",
			"Next",
			() => new CustomEditor(getEditorTheme()),
			() => {},
		);
		// Waiting for TSP readiness must not hold Tern's placement transaction.
		expect(native.placements).toEqual([{ block: 999, dir: "down" }]);
		await native.until(() => native.nodes(2).some(node => node.k === "editor"));
		expect(view.ui.nativeRendering).toBe(true);
		native.workspace.close("waiting");
		expect(await waiting).toBeInstanceOf(Error);
	});

	it("opens BTW beside an attached pane without discarding a live detached agent", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const create = () => new CustomEditor(getEditorTheme());
		await native.workspace.open("parked", "Parked agent", create, () => {});
		native.terminals.get(2)!.send("retained draft");
		await native.until(() => native.nodes(2).some(node => node.k === "editor" && node.p?.text === "retained draft"));
		vi.spyOn(native.workspace.client, "isSplitPane").mockImplementation(async block => block !== 2);
		await native.workspace.open("btw", "BTW", create, () => {});
		await native.workspace.open("next", "Next", create, () => {});
		expect(native.placements).toEqual([undefined, undefined, { block: 3, dir: "down" }]);
		await native.until(() => [3, 4].every(block => native.nodes(block).some(node => node.k === "editor")));
		expect(native.nodes(2).some(node => node.k === "editor" && node.p?.text === "retained draft")).toBe(true);
		for (const block of [2, 3, 4]) expect(native.terminals.get(block)!.errors).toEqual([]);
	});

	it("keeps a reopened view alive when a cancelled launch returns late", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const launched = Promise.withResolvers<TernSplitResult>();
		vi.spyOn(native.workspace.client, "open").mockImplementationOnce(async () => launched.promise);
		const create = () => new CustomEditor(getEditorTheme());
		const old = native.workspace.open("side", "Side", create, () => {}).catch(error => error);
		native.workspace.close("side");
		await native.workspace.open("side", "Side", create, () => {});
		const block = native.focused;
		launched.resolve({ session: 1, tab: 1, block: 999 });
		expect(await old).toBeInstanceOf(Error);
		await native.until(() => native.nodes(block).some(node => node.k === "editor"));
		native.terminals.get(block)!.send("new view");
		await native.until(() => native.nodes(block).some(node => node.k === "editor" && node.p?.text === "new view"));
		expect(native.workspace.has("side")).toBe(true);
	});

	it("routes side input to its owner and keeps Main native when the side relay closes", async () => {
		const main = await TspHarness.start(ui => ui.addChild(new Text("Main transcript")));
		cleanups.push(async () => {
			main.stop();
		});
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		let submitted: string | undefined;
		await native.workspace.open(
			"side",
			"Side",
			() => {
				const editor = new CustomEditor(getEditorTheme());
				editor.onSubmit = text => {
					submitted = text;
				};
				return editor;
			},
			() => {},
		);
		const block = native.focused;
		await native.until(() => native.nodes(block).some(node => node.k === "editor"));
		native.terminals.get(block)!.send("side input");
		native.terminals.get(block)!.send("\r");
		await native.until(() => submitted !== undefined);
		expect(submitted).toBe("side input");
		expect(JSON.stringify(main.region("main"))).toContain("Main transcript");
		native.workspace.close("side");
		await native.until(() => native.terminals.get(block)!.surface === undefined);
		expect(main.tui.nativeRendering).toBe(true);
		expect(isNativeRendering()).toBe(true);
		expect(main.errors).toEqual([]);
	});

	it("does not let the old relay disconnect retire a reopened view with the same key", async () => {
		const native = new NativePaneHarness();
		cleanups.push(() => native.dispose());
		const create = () => new CustomEditor(getEditorTheme());
		await native.workspace.open("side", "Side", create, () => {});
		const oldBlock = native.focused;
		await native.until(() => native.nodes(oldBlock).some(node => node.k === "editor"));
		native.workspace.close("side");
		await native.workspace.open("side", "Side", create, () => {});
		const block = native.focused;
		await native.until(
			() =>
				native.terminals.get(oldBlock)!.surface === undefined &&
				native.nodes(block).some(node => node.k === "editor"),
		);
		native.terminals.get(block)!.send("reopened draft");
		await native.until(() =>
			native.nodes(block).some(node => node.k === "editor" && node.p?.text === "reopened draft"),
		);
		expect(native.workspace.get("side")!.ui.nativeRendering).toBe(true);
		expect(native.terminals.get(block)!.errors).toEqual([]);
	});
});
