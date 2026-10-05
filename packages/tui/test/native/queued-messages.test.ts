import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { QueuedMessagesBand } from "@oh-my-pi/pi-tui/prompt/queued-messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container } from "@oh-my-pi/pi-tui/tui";
import { TspHarness } from "./tsp-harness";

beforeAll(() => initTheme());
let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

describe("native queued-message actions", () => {
	it("routes an escaped pill id through the backend and ignores old controls after queue replacement", async () => {
		const selected: Array<{ group: number; index: number }> = [];
		const band = new QueuedMessagesBand(
			[
				{ label: "Steering", messages: ["live", "pending"], liveSteered: 1 },
				{ label: "After yield", messages: ["follow-up"] },
			],
			"alt+up",
			(group, index) => selected.push({ group, index }),
		);
		const container = new Container();
		container.addChild(band);
		harness = await TspHarness.start(tui => tui.addChild(container));
		const h = harness;
		const sf = h.terminal.surface!;
		const liveId = `${nativeComponentId(band)}.Steering%2F0/edit`;
		const pendingId = `${nativeComponentId(band)}.Steering%2F1/edit`;
		const followUpId = `${nativeComponentId(band)}.After yield%2F0/edit`;
		if (!h.byId(liveId) || !h.byId(pendingId) || !h.byId(followUpId))
			throw new Error("queue edit controls were not rendered");
		h.event({ ev: "action", sf, id: liveId, act: "queue.edit" });
		h.event({ ev: "action", sf, id: pendingId, act: "queue.edit" });
		h.event({ ev: "action", sf, id: followUpId, act: "queue.edit" });
		expect(selected).toEqual([
			{ group: 0, index: 0 },
			{ group: 0, index: 1 },
			{ group: 1, index: 0 },
		]);

		const replacement = new QueuedMessagesBand(
			[{ label: "Steering", messages: ["remaining"] }],
			"alt+up",
			(group, index) => selected.push({ group, index }),
		);
		container.disposeChildren();
		container.addChild(replacement);
		await h.render();
		h.event({ ev: "action", sf, id: liveId, act: "queue.edit" });
		expect(selected).toHaveLength(3);
		h.event({ ev: "action", sf, id: `${nativeComponentId(replacement)}.Steering%2F0/edit`, act: "queue.edit" });
		expect(selected).toEqual([
			{ group: 0, index: 0 },
			{ group: 0, index: 1 },
			{ group: 1, index: 0 },
			{ group: 0, index: 0 },
		]);
	});
});
