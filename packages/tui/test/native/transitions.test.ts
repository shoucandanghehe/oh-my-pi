import { $ } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { onNativeRenderingChange } from "@oh-my-pi/pi-tui/native/state";
import type { Component, TUI } from "@oh-my-pi/pi-tui/tui";
import { TspHarness } from "./tsp-harness";

class BackendNote implements Component {
	constructor(readonly text: string) {}

	render(): readonly string[] {
		return [`rows: ${this.text}`];
	}

	describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("md") ? md(this.text) : null;
	}
}

let harness: TspHarness | undefined;
let unsubscribeRendering: (() => void) | undefined;
afterEach(() => {
	unsubscribeRendering?.();
	unsubscribeRendering = undefined;
	harness?.stop();
	harness = undefined;
});

/** A consumer that swaps its complete component tree using the actual renderer. */
function assemble(tui: TUI, nativeNote: BackendNote, transitions: boolean[]): () => void {
	const rowNote = new BackendNote("row assembly");
	const mount = (native: boolean): void => {
		tui.clear();
		tui.addChild(native ? nativeNote : rowNote);
	};
	mount(tui.nativeRendering);
	const unsubscribe = onNativeRenderingChange(native => {
		expect(tui.nativeRendering).toBe(native);
		transitions.push(native);
		mount(tui.nativeRendering);
	});
	unsubscribeRendering = unsubscribe;
	return unsubscribe;
}

describe("actual native renderer transitions", () => {
	it("notifies stop and resume, preserves semantic assembly, and supports unsubscribe", async () => {
		const note = new BackendNote("native assembly");
		const transitions: boolean[] = [];
		let unsubscribe!: () => void;
		harness = await TspHarness.start(
			tui => {
				unsubscribe = assemble(tui, note, transitions);
			},
			{ expected: true, manualProbe: true },
		);
		harness.terminal.answerProbe();
		harness.flush();
		harness.stop();
		harness.stop();
		expect(harness.tui.nativeRendering).toBe(false);
		expect(transitions).toEqual([true, false]);
		const resumedDoc = new TspDocument(harness.frames[0]!.sf);
		for (const frame of harness.frames) expect(resumedDoc.applyFrame(frame)).toEqual([]);
		resumedDoc.close();
		const nextFrame = harness.frames.length;
		harness.tui.start();
		harness.flush();
		expect(transitions).toEqual([true, false, true]);
		expect(resumedDoc.applyFrame(harness.frames[nextFrame]!)).toEqual([]);
		expect(resumedDoc.get(nativeComponentId(note))).toMatchObject({ k: "md", p: { text: "native assembly" } });
		expect(harness.byId(nativeComponentId(note))).toMatchObject({ k: "md", p: { text: "native assembly" } });
		expect(harness.errors).toEqual([]);
		unsubscribe();
		harness.stop();
		harness.stop();
		expect(transitions).toEqual([true, false, true]);
	});

	it("leaves the app viewport's alternate screen before opening native surfaces after deferred WSL startup", async () => {
		const script = `
			import { TspHarness } from ${JSON.stringify(new URL("./tsp-harness.ts", import.meta.url).href)};
			import { Text } from "@oh-my-pi/pi-tui/components/text";
			const h = await TspHarness.start(tui => {
				tui.addChild(new Text("preserved transcript"));
			}, { manualProbe: true, deferInput: true });
			const before = h.terminal.alternateScreenActive;
			h.tui.enableInput();
			h.terminal.answerProbe();
			h.flush();
			const result = {
				before,
				native: h.tui.nativeRendering,
				after: h.terminal.alternateScreenActive,
				transcript: h.find(node => node.k === "text")?.p?.spans.map(span => span.t).join(""),
				errors: h.errors,
			};
			h.stop();
			h.tui.start();
			h.terminal.answerProbe();
			h.flush();
			result.restarted = h.tui.nativeRendering && !h.terminal.alternateScreenActive;
			h.stop();
			console.log(JSON.stringify(result));
		`;
		const result = await $`${process.execPath} --eval ${script}`
			.cwd(import.meta.dir)
			.env({ ...Bun.env, PI_TUI_RENDER_BACKEND: "app-viewport" })
			.quiet()
			.nothrow();
		expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.text())).toEqual({
			before: true,
			native: true,
			after: false,
			transcript: "preserved transcript",
			errors: [],
			restarted: true,
		});
	});

	it("delivers native PgUp and SGR input to focus even with the app-viewport environment enabled", async () => {
		// Bun.env is a non-configurable data property, not a spyable getter. Keep the
		// real backend flag in a child process rather than mutating shared test env.
		const script = `
			import { TspHarness } from ${JSON.stringify(new URL("./tsp-harness.ts", import.meta.url).href)};
			const inputs = [];
			const h = await TspHarness.start(tui => {
				const focused = { render: () => ["focused"], handleInput: data => inputs.push(data) };
				tui.addChild(focused);
				tui.setFocus(focused);
			}, { expected: true, manualProbe: true });
			h.terminal.send("\\x1b[5~");
			h.terminal.send("\\x1b[<64;1;1M");
			h.flush();
			console.log(JSON.stringify({ native: h.tui.nativeRendering, inputs }));
			h.stop();
		`;
		const result = await $`${process.execPath} --eval ${script}`
			.cwd(import.meta.dir)
			.env({ ...Bun.env, PI_TUI_RENDER_BACKEND: "app-viewport" })
			.quiet()
			.nothrow();
		expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.text())).toEqual({ native: true, inputs: ["\x1b[5~", "\x1b[<64;1;1M"] });
	});
});
