import { describe, expect, it } from "bun:test";
import { type Component, componentContains, Container, type TUI } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";

class HistoryBlock implements Component {
	ownershipChecks = 0;

	constructor(public rows: string[]) {}

	containsComponent(): boolean {
		this.ownershipChecks++;
		return false;
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	measureRows(): number {
		return this.rows.length;
	}

	render(): readonly string[] {
		return this.rows;
	}
}

describe("Container targeted ownership", () => {
	it("keeps sibling loader repaints independent of transcript history after ownership is known", () => {
		const root = new Container();
		const transcript = new TranscriptContainer();
		const history = Array.from({ length: 10_000 }, (_value, index) => new HistoryBlock([`history-${index}`]));
		for (const block of history) transcript.addChild(block);
		const footer = new Container();
		const ui = { requestComponentRender() {} };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"waiting",
			["."],
		);
		loader.stop();
		footer.addChild(loader);
		root.addChild(transcript);
		root.addChild(footer);
		const request = { rows: 6, offset: 0, followBottom: true };

		try {
			const initial = root.renderVirtualViewport(80, request);
			// Warm through the ownership seam used by workspace/pane wrappers.
			expect(componentContains(root, loader)).toBe(true);
			expect(history.reduce((total, block) => total + block.ownershipChecks, 0)).toBeLessThanOrEqual(history.length);
			for (const block of history) block.ownershipChecks = 0;

			for (let frame = 0; frame < 25; frame++) {
				loader.setMessage(`waiting-${frame}`);
				const updated = root.renderVirtualViewportTargeted(80, request, [loader]);
				expect(updated.estimatedTotalRows).toBe(initial.estimatedTotalRows);
				expect(updated.offset).toBe(initial.offset);
				expect(updated.lines.slice(0, -1)).toEqual(initial.lines.slice(0, -1));
				expect(updated.lines.at(-1)?.trim()).toBe(`. waiting-${frame}`);
			}
			expect(history.reduce((total, block) => total + block.ownershipChecks, 0)).toBe(0);
		} finally {
			root.dispose();
		}
	});

	it("routes a cached target to its new owner and updates viewport content and geometry", () => {
		const root = new Container();
		const left = new TranscriptContainer();
		const right = new TranscriptContainer();
		const moving = new HistoryBlock(["before"]);
		left.addChild(new HistoryBlock(["left"]));
		left.addChild(moving);
		right.addChild(new HistoryBlock(["right"]));
		root.addChild(left);
		root.addChild(right);
		const request = { rows: 20, offset: 0, followBottom: true };

		try {
			expect(root.renderVirtualViewportTargeted(80, request, [moving])).toEqual({
				lines: ["left", "", "before", "right"],
				estimatedTotalRows: 4,
				offset: 0,
			});
			left.removeChild(moving);
			right.addChild(moving);
			moving.rows = ["after", "extra"];
			expect(root.renderVirtualViewportTargeted(80, request, [moving])).toEqual({
				lines: ["left", "right", "", "after", "extra"],
				estimatedTotalRows: 5,
				offset: 0,
			});
			moving.rows = [...moving.rows, "another"];
			expect(root.renderVirtualViewportTargeted(80, request, [moving])).toEqual({
				lines: ["left", "right", "", "after", "extra", "another"],
				estimatedTotalRows: 6,
				offset: 0,
			});
			right.removeChild(moving);
			expect(componentContains(root, moving)).toBe(false);
			expect(root.renderVirtualViewportTargeted(80, request, [moving])).toEqual({
				lines: ["left", "right"],
				estimatedTotalRows: 2,
				offset: 0,
			});
		} finally {
			root.dispose();
		}
	});

	it("finds descendants added after a miss and rejects cached owners removed through public children", () => {
		const root = new Container();
		const owner = new Container();
		const target = new HistoryBlock(["target"]);
		root.addChild(owner);
		expect(componentContains(root, target)).toBe(false);
		owner.children.push(target);
		expect(componentContains(root, target)).toBe(true);
		root.children = [];
		expect(componentContains(root, target)).toBe(false);
		root.children.push(owner);
		expect(componentContains(root, target)).toBe(true);
		owner.children = [];
		expect(componentContains(root, target)).toBe(false);
	});

	it("searches public children when a component has no ownership seam", () => {
		const target = new HistoryBlock(["target"]);
		const wrapper = { children: [target], render: () => target.render() };
		const root = new Container();
		root.addChild(wrapper);
		expect(componentContains(root, target)).toBe(true);
		wrapper.children = [];
		expect(componentContains(root, target)).toBe(false);
	});
});
