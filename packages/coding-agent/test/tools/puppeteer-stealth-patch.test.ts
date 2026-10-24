import { describe, expect, it } from "bun:test";
import { runInNewContext } from "node:vm";
import fontsScript from "../../src/tools/puppeteer/07_stealth_fonts.txt" with { type: "text" };
import {
	debugCatchError,
	debugError,
	getSourcePuppeteerURLIfAvailable,
	withSourcePuppeteerURLIfNone,
} from "puppeteer-core/lib/puppeteer/common/util.js";

describe("Puppeteer stealth patch", () => {
	it("keeps CDP failures non-throwing when Puppeteer debug logging is disabled", () => {
		expect(debugError).toBeUndefined();
		expect(() => debugCatchError(new Error("CDP world acquisition failed"))).not.toThrow();
	});

	it("keeps source attribution usable when compiled binaries expose one stack frame", () => {
		const stackTraceLimit = Error.stackTraceLimit;
		Error.stackTraceLimit = 1;
		try {
			const tagged = withSourcePuppeteerURLIfNone("queryAll", () => 1);
			const sourceUrl = getSourcePuppeteerURLIfAvailable(tagged);

			expect(String(sourceUrl)).toStartWith("pptr:queryAll;");
			expect(sourceUrl?.siteString).not.toBe("");
		} finally {
			Error.stackTraceLimit = stackTraceLimit;
		}
	});

	it("adds canvas text noise once even when getContext repeatedly returns the same context", () => {
		const draws: unknown[][] = [];
		let randomCalls = 0;
		class CanvasRenderingContext2D {
			fillText(...args: unknown[]) {
				draws.push(args);
			}
		}
		class HTMLCanvasElement {
			#context = new CanvasRenderingContext2D();
			getContext(_type: "2d") {
				return this.#context;
			}
		}
		runInNewContext(fontsScript, {
			window: {},
			CanvasRenderingContext2D,
			HTMLCanvasElement,
			Math_random: () => {
				randomCalls++;
				return 0.75;
			},
			patchToString: () => {},
		});
		const canvas = new HTMLCanvasElement();
		const context = canvas.getContext("2d");
		const fillText = context.fillText;
		for (let i = 0; i < 20_000; i++) canvas.getContext("2d");
		context.fillText("hello", 10, 20, 80);
		expect(context.fillText).toBe(fillText);
		expect(randomCalls).toBe(2);
		expect(draws).toEqual([["hello", 10.005, 20.005, 80]]);
	});
});
