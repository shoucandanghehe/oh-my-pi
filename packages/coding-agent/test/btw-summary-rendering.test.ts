import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { createBtwSummaryMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { TUI } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { TspHarness } from "../../tui/test/native/tsp-harness";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
	setNativeRendering(false);
});

function summaryMessage() {
	return createBtwSummaryMessage([
		{
			threadKey: "private-thread-alpha",
			threadTitle: "\x1b[31mCache\x1b[0m &\tlatency\n",
			summary: "Fixed **cache invalidation**.\n\n- Keep `a < b` intact.",
		},
		{
			threadKey: "private-thread-beta",
			threadTitle: "Approval <review>",
			summary: "## Decision\nWait for explicit approval.",
		},
	]);
}

function mount(mode: "live" | "session replay" | "transcript replay", message: CustomMessage, ui: TUI) {
	if (mode === "transcript replay") {
		const builder = new ChatTranscriptBuilder({ ui, cwd: process.cwd(), requestRender() {} });
		builder.rebuild([
			{
				type: "message",
				id: "summary-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: JSON.parse(JSON.stringify(message)),
			},
		]);
		return builder.container;
	}
	const ctx = createInteractiveModeContext({ ui });
	const helpers = new UiHelpers(ctx);
	if (mode === "live") {
		helpers.addMessageToChat(message);
	} else {
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
		helpers.renderSessionContext({ messages: [JSON.parse(JSON.stringify(message))] } as SessionContext);
	}
	return ctx.chatContainer;
}

const MODES = ["live", "session replay", "transcript replay"] as const;

describe("BTW summary source cards", () => {
	it.each([...MODES])("renders all sources and Markdown without model protocol in %s", mode => {
		const message = summaryMessage();
		const original = JSON.stringify(message);
		const container = mount(mode, message, new TUI(new VirtualTerminal(120, 40)));
		const output = Bun.stripANSI(container.render(120).join("\n"));
		expect(output).toContain("From BTW · Cache & latency");
		expect(output).toContain("cache invalidation");
		expect(output).toContain("a < b");
		expect(output).toContain("From BTW · Approval <review>");
		expect(output).toContain("Decision");
		expect(output).toContain("Wait for explicit approval.");
		for (const internal of [
			"btw:summary",
			"private-thread-",
			"thread-key",
			"<btw",
			"<summary",
			"<guidance",
			"&lt;",
			"**",
		]) {
			expect(output).not.toContain(internal);
		}
		expect(JSON.stringify(message)).toBe(original);
		container.dispose();
	});

	it.each([...MODES])("sends source titles and unescaped Markdown to the native surface in %s", async mode => {
		const message = summaryMessage();
		harness = await TspHarness.start();
		harness.tui.addChild(mount(mode, message, harness.tui));
		await harness.render();
		const cards = harness.findAll(node => node.k === "card" && node.p?.role === "omp.custom.btw-summary");
		expect(
			cards.map(node => {
				const head = node.k === "card" ? node.p?.head : undefined;
				return typeof head === "string" ? head : head?.map(part => part.t).join("");
			}),
		).toEqual(["From BTW · Cache & latency", "From BTW · Approval <review>"]);
		expect(
			harness.findAll(node => node.k === "md").map(node => (node.k === "md" ? node.p?.text : undefined)),
		).toEqual([
			"Fixed **cache invalidation**.\n\n- Keep `a < b` intact.",
			"## Decision\nWait for explicit approval.",
		]);
		const displayed = JSON.stringify(harness.doc());
		for (const internal of ["btw:summary", "private-thread-", "thread-key", "<btw", "<summary", "<guidance"]) {
			expect(displayed).not.toContain(internal);
		}
		expect(harness.errors).toEqual([]);
	});

	it.each([...MODES])("keeps legacy content observable rather than guessing XML facts in %s", mode => {
		const message = summaryMessage();
		delete (message as CustomMessage).details;
		message.content = '<summary thread-key="legacy-private-key">Legacy observable content</summary>';
		const container = mount(mode, message, new TUI(new VirtualTerminal(120, 40)));
		const output = Bun.stripANSI(container.render(120).join("\n"));
		expect(output).toContain("btw:summary");
		expect(output).toContain("legacy-private-key");
		expect(output).toContain("Legacy observable content");
		expect(output).not.toContain("BTW · Cache & latency");
		container.dispose();
	});

	it("uses the source cards when an extension renderer throws or declines", () => {
		for (const renderer of [
			() => undefined,
			() => {
				throw new Error("renderer failed");
			},
		]) {
			const component = new CustomMessageComponent(summaryMessage(), renderer);
			const output = Bun.stripANSI(component.render(120).join("\n"));
			expect(output).toContain("From BTW · Cache & latency");
			expect(output).toContain("From BTW · Approval <review>");
			expect(output).not.toContain("btw:summary");
			component.dispose();
		}
	});
});
