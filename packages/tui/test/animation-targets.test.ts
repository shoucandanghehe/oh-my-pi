import { describe, expect, it } from "bun:test";
import { type Component, Container, TUI, type VirtualViewportFrame } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { isAnimationOnlyRenderTarget, withAnimationOnlyRenderTargets } from "../src/render-targets";
import { previewWindowRows } from "../src/render/render-utils";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class AnimatedBlock implements Component {
	renderCount = 0;
	version = 0;
	rows: string[];

	constructor(rows: string[]) {
		this.rows = rows;
	}

	measureRows(): number {
		return this.rows.length;
	}

	getTranscriptBlockVersion(): number {
		return this.version;
	}

	render(): readonly string[] {
		this.renderCount++;
		return this.rows;
	}
}

function transcriptWithOffscreenAnimation() {
	const transcript = new TranscriptContainer();
	for (let index = 0; index < 20; index++) {
		const history = { render: () => [`history-${index}`], isTranscriptBlockFinalized: () => true };
		transcript.addChild(history);
	}
	const animated = new AnimatedBlock(["frame-0"]);
	transcript.addChild(animated);
	transcript.renderVirtualViewport(80, { rows: 5, offset: 0, followBottom: true });
	const request = { rows: 5, offset: 0, followBottom: false };
	const initial = transcript.renderVirtualViewport(80, request);
	animated.renderCount = 0;
	return { transcript, animated, request, initial };
}

describe("animation-only viewport invalidations", () => {
	it("skips cached offscreen animation work and shows the latest frame when scrolled into view", () => {
		const { transcript, animated, request, initial } = transcriptWithOffscreenAnimation();
		try {
			for (let frame = 1; frame <= 20; frame++) {
				animated.rows = [`frame-${frame}`];
				const updated = withAnimationOnlyRenderTargets(new Set([animated]), () =>
					transcript.renderVirtualViewportTargeted(80, request, [animated]),
				);
				expect(updated).toEqual(initial);
			}
			expect(animated.renderCount).toBe(0);
			const visible = withAnimationOnlyRenderTargets(new Set([animated]), () =>
				transcript.renderVirtualViewportTargeted(80, { ...request, followBottom: true }, [animated]),
			);
			expect(visible.lines).toContain("frame-20");
			expect(animated.renderCount).toBeGreaterThan(0);
		} finally {
			transcript.dispose();
		}
	});

	it("continues measuring offscreen content growth and invalidated geometry", () => {
		const { transcript, animated, request, initial } = transcriptWithOffscreenAnimation();
		try {
			animated.rows = ["new-content", "second-row", "third-row"];
			const content = transcript.renderVirtualViewportTargeted(80, request, [animated]);
			expect(content.estimatedTotalRows).toBe(initial.estimatedTotalRows + 2);
			expect(content.offset).toBe(initial.offset);
			expect(animated.renderCount).toBe(1);
			animated.rows = [...animated.rows, "versioned-growth"];
			animated.version++;
			const versioned = withAnimationOnlyRenderTargets(new Set([animated]), () =>
				transcript.renderVirtualViewportTargeted(80, request, [animated]),
			);
			expect(versioned.estimatedTotalRows).toBe(content.estimatedTotalRows + 1);
			animated.renderCount = 0;
			withAnimationOnlyRenderTargets(new Set([animated]), () =>
				transcript.renderVirtualViewportTargeted(60, request, [animated]),
			);
			expect(animated.renderCount).toBeGreaterThan(0);
		} finally {
			transcript.dispose();
		}
	});

	it("paints an animation brought into view by a coalesced sibling shrink", () => {
		const transcript = new TranscriptContainer();
		const animated = new AnimatedBlock(["frame-0"]);
		const shrinking = new AnimatedBlock(Array.from({ length: 20 }, (_value, index) => `tail-${index}`));
		transcript.addChild(animated);
		transcript.addChild(shrinking);
		try {
			transcript.renderVirtualViewport(80, { rows: 30, offset: 0, followBottom: true });
			const request = { rows: 5, offset: 0, followBottom: true };
			const before = transcript.renderVirtualViewport(80, request);
			expect(before.lines).not.toContain("frame-0");
			animated.rows = ["frame-1"];
			shrinking.rows = ["tail"];
			const after = withAnimationOnlyRenderTargets(new Set([animated]), () =>
				transcript.renderVirtualViewportTargeted(80, request, [animated, shrinking]),
			);
			expect(after.lines).toEqual(["frame-1", "", "tail"]);
		} finally {
			transcript.dispose();
		}
	});

	it("remeasures an offscreen preview after a height-only terminal resize", () => {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const transcript = new TranscriptContainer();
		class HeightDependentPreview extends AnimatedBlock {
			override measureRows(): number {
				return previewWindowRows();
			}

			override render(): readonly string[] {
				this.rows = Array.from({ length: previewWindowRows() }, (_value, index) => `preview-${index}`);
				return super.render();
			}
		}
		const preview = new HeightDependentPreview([]);
		for (let i = 0; i < 20; i++) transcript.addChild(new AnimatedBlock([`history-${i}`]));
		transcript.addChild(preview);
		try {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 30 });
			transcript.renderVirtualViewport(80, { rows: 5, offset: 0, followBottom: true });
			const request = { rows: 5, offset: 0, followBottom: false };
			const before = transcript.renderVirtualViewport(80, request);
			preview.renderCount = 0;
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
			const after = withAnimationOnlyRenderTargets(new Set([preview]), () =>
				transcript.renderVirtualViewportTargeted(80, request, [preview]),
			);
			expect(preview.renderCount).toBeGreaterThan(0);
			expect(after.estimatedTotalRows).toBe(before.estimatedTotalRows + 10);
		} finally {
			transcript.dispose();
			if (descriptor) Object.defineProperty(process.stdout, "rows", descriptor);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it.each([false, true])("keeps content changes from another descendant of an animated block (%s)", contentFirst => {
		const { transcript, animated, request } = transcriptWithOffscreenAnimation();
		const content = new AnimatedBlock(["content"]);
		const owner = new Container();
		owner.addChild(animated);
		owner.addChild(content);
		transcript.removeChild(animated);
		transcript.addChild(owner);
		try {
			transcript.renderVirtualViewport(80, { ...request, followBottom: true });
			const before = transcript.renderVirtualViewport(80, request);
			content.rows = ["content", "grown"];
			const targets = contentFirst ? [content, animated] : [animated, content];
			const after = withAnimationOnlyRenderTargets(new Set([animated]), () =>
				transcript.renderVirtualViewportTargeted(80, request, targets),
			);
			expect(after.estimatedTotalRows).toBe(before.estimatedTotalRows + 1);
		} finally {
			transcript.dispose();
		}
	});

	it.each(["content-first", "animation-first"])(
		"keeps content invalidation when a tick coalesces (%s)",
		async order => {
			const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
			Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
			const { transcript, animated, request, initial } = transcriptWithOffscreenAnimation();
			const terminal = new VirtualTerminal(81, 5);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
			let frame: VirtualViewportFrame = initial;
			tui.setAppViewportFrameProvider({
				renderAppViewportFrame: (viewport, targets) => {
					frame =
						targets.length > 0
							? transcript.renderVirtualViewportTargeted(viewport.columns, request, targets)
							: transcript.renderVirtualViewport(viewport.columns, request);
					return {
						viewport: frame.lines,
						estimatedTotalRows: frame.estimatedTotalRows,
						offset: frame.offset,
						stickyRows: 0,
						cursor: null,
						rowMap: [],
					};
				},
			});
			try {
				tui.start();
				await scheduler.settle(terminal);
				animated.renderCount = 0;
				animated.rows = ["frame-1"];
				tui.requestComponentRender(animated, { animationOnly: true });
				await scheduler.settle(terminal);
				expect(animated.renderCount).toBe(0);
				animated.rows = ["content-1", "content-2", "content-3"];
				if (order === "content-first") tui.requestComponentRender(animated);
				tui.requestComponentRender(animated, { animationOnly: true });
				if (order === "animation-first") tui.requestComponentRender(animated);
				await scheduler.settle(terminal);
				expect(animated.renderCount).toBe(1);
				expect(frame.estimatedTotalRows).toBe(initial.estimatedTotalRows + 2);
			} finally {
				tui.stop();
				transcript.dispose();
				if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
				else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
			}
		},
	);

	it("restores the caller's classification after a nested paint throws", () => {
		const outer = new AnimatedBlock(["outer"]);
		const inner = new AnimatedBlock(["inner"]);
		withAnimationOnlyRenderTargets(new Set([outer]), () => {
			expect(() =>
				withAnimationOnlyRenderTargets(new Set([inner]), () => {
					expect(isAnimationOnlyRenderTarget(inner)).toBe(true);
					expect(isAnimationOnlyRenderTarget(outer)).toBe(false);
					throw new Error("paint failed");
				}),
			).toThrow("paint failed");
			expect(isAnimationOnlyRenderTarget(outer)).toBe(true);
			expect(isAnimationOnlyRenderTarget(inner)).toBe(false);
		});
		expect(isAnimationOnlyRenderTarget(outer)).toBe(false);
	});
});
