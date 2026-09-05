import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BtwConversationPane,
	type BtwThreadView,
} from "@oh-my-pi/pi-coding-agent/modes/components/btw-conversation-pane";
import { BtwPanelComponent } from "@oh-my-pi/pi-coding-agent/modes/components/btw-panel";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type {
	BtwPromotionLifecycle,
	BtwPromotionRequest,
	BtwThreadEvent,
} from "@oh-my-pi/pi-coding-agent/session/btw-thread";
import {
	EphemeralConversation,
	type EphemeralConversationCheckpoint,
} from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { Container, replaceTabs, type SgrMouseEvent, sliceByColumn, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface RunEphemeralTurnArgs {
	promptText: string;
	onTextDelta?: (delta: string) => void;
	signal?: AbortSignal;
}

interface RunEphemeralTurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
}

function makeFakeSession(
	runEphemeralTurn: (args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>,
): InteractiveModeContext["session"] {
	return {
		sessionId: "session-1",
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		isStreaming: false,
		runEphemeralTurn,
	} as unknown as InteractiveModeContext["session"];
}

function makeCtx(session: InteractiveModeContext["session"], btwContainer = new Container()): InteractiveModeContext {
	let leafId: string | null = "leaf-1";
	let sessionId = "session-1";
	return {
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
		terminalActivity: { set: vi.fn(), release: vi.fn() },
		btwContainer,
		session,
		statusLine: {
			createPeer: () => ({ getTopBorder: () => ({ content: " MAIN STATUS ", width: 13 }), dispose: () => {} }),
		},
		sessionManager: {
			getLeafId: () => leafId,
			getSessionId: () => sessionId,
			getEntry: (id: string) => (id === leafId ? {} : undefined),
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleBtwBranch: vi.fn(async () => {}),
		setTestLeafId(nextLeafId: string | null) {
			leafId = nextLeafId;
		},
		setTestSessionId(nextSessionId: string) {
			sessionId = nextSessionId;
		},
	} as unknown as InteractiveModeContext & {
		setTestLeafId(nextLeafId: string | null): void;
		setTestSessionId(nextSessionId: string): void;
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
afterAll(() => {
	resetSettingsForTest();
});

beforeAll(async () => {
	await initTheme();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});
async function drainBtwRequest(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("BtwPanelComponent", () => {
	it("is branchable only after a complete non-empty answer", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Question?", tui: ui });

		expect(panel.isBranchable()).toBe(false);
		panel.setAnswer("   ");
		panel.markComplete();
		expect(panel.isBranchable()).toBe(false);
		panel.setAnswer("Answer");
		expect(panel.isBranchable()).toBe(true);
	});

	it("advertises copy and branch actions after a complete non-empty answer", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Question?", tui: ui });

		panel.setAnswer("Answer");
		panel.markComplete();

		const rendered = Bun.stripANSI(panel.render(120).join("\n"));
		expect(rendered).toContain("c copy");
		expect(rendered).toContain("b branch to chat");
		expect(rendered).toContain("Esc dismiss");
	});

	it("hides the branch action when the controller rejects the current leaf", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Question?", tui: ui, canBranch: () => false });

		panel.setAnswer("Answer");
		panel.markComplete();

		const rendered = Bun.stripANSI(panel.render(120).join("\n"));
		expect(rendered).toContain("c copy");
		expect(rendered).not.toContain("b branch to chat");
	});
	it("advertises Continue when the QuickAsk can become a durable side thread", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Question?", tui: ui, continueToThread: true });
		panel.setAnswer("Answer");
		panel.markComplete();

		expect(Bun.stripANSI(panel.render(120).join("\n"))).toContain("Enter continue");
	});
});

describe("BtwConversationPane", () => {
	it("selects a hover-previewed thread without pinning the rail open", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const ui = { requestRender, requestComponentRender: vi.fn() } as unknown as TUI;
		const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
		const threads: BtwThreadView[] = [
			{
				key: "alpha",
				title: "Alpha",
				phase: "ready",
				model,
				error: undefined,
				draft: "",
				unread: 0,
				request: undefined,
				turns: [
					{
						input: "Alpha question",
						replyText:
							"Alpha answer\n\n| 阶段 | 说明 |\n| --- | --- |\n| 搜索 | 复用当前模型继续搜索，不是 simulation 数值 |\n| 预算 | 每手 200 ms，尾部保留六十层画面 |",
						assistantMessage: createAssistantMessage(
							"Alpha answer\n\n| 阶段 | 说明 |\n| --- | --- |\n| 搜索 | 复用当前模型继续搜索，不是 simulation 数值 |\n| 预算 | 每手 200 ms，尾部保留六十层画面 |",
						),
						timestamp: Date.now(),
					},
				],
			},
			{
				key: "beta",
				title: "Beta",
				phase: "ready",
				model,
				error: undefined,
				draft: "",
				unread: 1,
				request: undefined,
				turns: [
					{
						input: "Beta question",
						replyText: "Beta answer",
						assistantMessage: createAssistantMessage("Beta answer"),
						timestamp: Date.now(),
					},
				],
			},
		];
		const peerStatusLine = {
			getTopBorder: vi.fn(() => ({ content: " MAIN STATUS ", width: 13 })),
			dispose: vi.fn(),
		};
		let pane: BtwConversationPane;
		const onSelectThread = vi.fn((key: string) => {
			pane.update(threads, key);
			return true;
		});
		pane = new BtwConversationPane({
			ui,
			cwd: process.cwd(),
			expandKeys: [],
			hideThinkingBlock: () => false,
			proseOnlyThinking: () => false,
			requestRender: () => ui.requestRender(),
			statusLine: peerStatusLine,
			onSubmit: () => true,
			canCopy: () => true,
			onCopy: async () => true,
			onClose: vi.fn(),
			onDraftChange: vi.fn(),
			onPersistDraft: vi.fn(),
			onSelectThread,
			onMarkRead: vi.fn(),
			onCloseThread: () => true,
			onPromoteThread: async () => true,
		});
		pane.setViewportHeight(14);
		pane.update(threads, "alpha");
		const expanded = pane.render(100);
		const expandedPlain = expanded.map(line => Bun.stripANSI(line));
		expect(expandedPlain.join("\n")).not.toContain("Threads 2");
		expect(expandedPlain.join("\n")).not.toContain("hover preview");
		expect(expandedPlain.join("\n")).toContain("MAIN STATUS");
		expect(expandedPlain.join("\n")).not.toContain("Ask BTW");
		expect(peerStatusLine.getTopBorder).toHaveBeenCalled();
		const handleRow = Math.floor((expanded.length - 1) / 2);
		const dividerCol = expandedPlain[handleRow - 2]!.indexOf("│");
		const railVisible = () => Bun.stripANSI(pane.render(100)[0] ?? "").indexOf("│", 1) > 0;
		expect(expandedPlain[handleRow - 1]![dividerCol]).toBe("│");
		expect(expandedPlain[handleRow]![dividerCol]).toBe("◀");
		expect(expandedPlain[handleRow + 1]![dividerCol]).toBe("│");
		const pinnedHover: SgrMouseEvent = {
			button: 32,
			col: 1,
			row: 1,
			release: false,
			wheel: null,
			motion: true,
			leftClick: false,
			rightClick: false,
		};
		expect(pane.routeMouse(pinnedHover, 1, 1)).toBe(true);
		pane.clearAppViewportHover();
		vi.advanceTimersByTime(175);
		const pinnedAfterHover = pane.render(100).map(line => Bun.stripANSI(line));
		expect(pinnedAfterHover[0]!.indexOf("│", 1)).toBe(dividerCol);
		expect(railVisible()).toBe(true);
		vi.advanceTimersByTime(200);
		const handleClick: SgrMouseEvent = {
			button: 0,
			col: dividerCol,
			row: handleRow - 1,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			rightClick: false,
		};
		expect(pane.routeMouse(handleClick, handleRow - 1, dividerCol)).toBe(true);
		vi.advanceTimersByTime(25);
		const collapsing = pane.render(100).map(line => Bun.stripANSI(line));
		expect(railVisible()).toBe(true);
		const collapsingDividerCol = collapsing[0]!.indexOf("│", 1);
		expect(collapsingDividerCol).toBeGreaterThan(1);
		expect(collapsingDividerCol).toBeLessThan(dividerCol);
		vi.advanceTimersByTime(200);
		const collapsedRaw = pane.render(100);
		const collapsed = collapsedRaw.map(line => Bun.stripANSI(line));
		expect(railVisible()).toBe(false);
		expect(collapsed[handleRow - 1]).toStartWith("│");
		expect(collapsed[handleRow]).toStartWith("▶");
		expect(collapsed[handleRow + 1]).toStartWith("│");
		expect(collapsedRaw[handleRow]).toContain(`${theme.getFgAnsi("accent")}▶`);
		expect(collapsed.filter((_, row) => Math.abs(row - handleRow) > 1).every(line => line.startsWith("│"))).toBe(
			true,
		);
		expect(pane.wantsAppViewportHover()).toBe(true);
		expect(pane.routeMouse({ ...handleClick, col: 0 }, handleRow - 1, 0)).toBe(true);
		vi.advanceTimersByTime(25);
		const expanding = pane.render(100).map(line => Bun.stripANSI(line));
		expect(railVisible()).toBe(true);
		const expandingDividerCol = expanding[0]!.indexOf("│", 1);
		expect(expandingDividerCol).toBeGreaterThan(1);
		expect(expandingDividerCol).toBeLessThan(dividerCol);
		expect(pane.routeMouse({ ...handleClick, col: expandingDividerCol }, handleRow - 1, expandingDividerCol)).toBe(
			true,
		);
		vi.advanceTimersByTime(200);
		expect(railVisible()).toBe(false);
		expect(pane.routeMouse({ ...handleClick, col: 0 }, handleRow - 1, 0)).toBe(true);
		vi.advanceTimersByTime(200);
		expect(railVisible()).toBe(true);
		expect(pane.routeMouse(handleClick, handleRow - 1, dividerCol)).toBe(true);
		vi.advanceTimersByTime(200);
		const handleHover: SgrMouseEvent = {
			...handleClick,
			button: 32,
			col: 2,
			row: handleRow + 2,
			motion: true,
			leftClick: false,
		};
		expect(pane.routeMouse(handleHover, handleRow + 2, 2)).toBe(true);
		vi.advanceTimersByTime(25);
		const peekOpening = pane.render(100).map(line => Bun.stripANSI(line));
		expect(railVisible()).toBe(true);
		const peekOpeningDividerCol = peekOpening[0]!.indexOf("│", 1);
		expect(peekOpeningDividerCol).toBeGreaterThan(1);
		expect(peekOpeningDividerCol).toBeLessThan(dividerCol + 1);
		vi.advanceTimersByTime(200);
		const peek = pane.render(100).map(line => Bun.stripANSI(line));
		// A peek boundary may cover one cell of a double-width grapheme. The
		// first complete cell after that boundary and every later cell stay fixed.
		const stableTailStart = dividerCol + 3;
		for (let row = 0; row < peek.length; row++) {
			expect(sliceByColumn(peek[row]!, stableTailStart, 100, true)).toBe(
				sliceByColumn(collapsed[row]!, stableTailStart, 100, true),
			);
		}
		expect(
			peek
				.map((line, row) => ({
					row,
					peek: { text: line, width: visibleWidth(line) },
					collapsed: { text: collapsed[row]!, width: visibleWidth(collapsed[row]!) },
				}))
				.filter(widths => widths.peek.width !== widths.collapsed.width),
		).toEqual([]);
		pane.clearAppViewportHover();
		expect(railVisible()).toBe(true);
		vi.advanceTimersByTime(175);
		const peekClosing = pane.render(100).map(line => Bun.stripANSI(line));
		expect(railVisible()).toBe(true);
		const peekClosingDividerCol = peekClosing[0]!.indexOf("│", 1);
		expect(peekClosingDividerCol).toBeGreaterThan(1);
		expect(peekClosingDividerCol).toBeLessThan(dividerCol + 1);
		vi.advanceTimersByTime(200);
		expect(railVisible()).toBe(false);
		expect(pane.routeMouse(handleHover, handleRow + 2, 2)).toBe(true);
		pane.clearAppViewportHover();
		expect(pane.routeMouse(handleHover, handleRow + 2, 2)).toBe(true);
		vi.advanceTimersByTime(180);
		expect(railVisible()).toBe(true);
		expect(pane.routeMouse({ ...handleClick, col: 0, row: handleRow + 1 }, handleRow + 1, 0)).toBe(true);
		expect(railVisible()).toBe(true);

		const idleHeader = pane.renderWorkspaceHeader(100, false);
		const focusedHeader = pane.renderWorkspaceHeader(100, true);
		expect(Bun.stripANSI(idleHeader)).toStartWith("○ BTW");
		expect(Bun.stripANSI(focusedHeader)).toStartWith("● BTW");
		expect(focusedHeader).toContain(theme.fg("accent", theme.bold("BTW")));
		pane.handleInput("\x1bt");
		vi.advanceTimersByTime(200);
		expect(Bun.stripANSI(pane.render(100).join("\n"))).not.toContain("Threads 2");
		expect(pane.routeMouse(handleHover, handleRow + 2, 2)).toBe(true);
		vi.advanceTimersByTime(200);

		const hover: SgrMouseEvent = {
			button: 32,
			col: 1,
			row: 1,
			release: false,
			wheel: null,
			motion: true,
			leftClick: false,
			rightClick: false,
		};
		expect(Bun.stripANSI(pane.renderWorkspaceHeader(100, true))).toContain("Alpha");
		expect(pane.routeMouse(hover, 1, 1)).toBe(true);
		expect(Bun.stripANSI(pane.renderWorkspaceHeader(100, true))).toContain("Beta · preview");
		expect(onSelectThread).not.toHaveBeenCalled();
		pane.routeMouse({ ...hover, col: dividerCol + 4 }, 1, dividerCol + 4);
		expect(railVisible()).toBe(true);
		pane.routeMouse({ ...hover, col: dividerCol + 5 }, 1, dividerCol + 5);
		vi.advanceTimersByTime(200);
		expect(railVisible()).toBe(false);
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Beta answer");

		pane.clearAppViewportHover();
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Beta answer");
		vi.advanceTimersByTime(180);
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Alpha answer");
		expect(railVisible()).toBe(false);
		expect(pane.routeMouse(handleHover, handleRow + 2, 2)).toBe(true);
		vi.advanceTimersByTime(25);
		expect(pane.routeMouse(hover, 1, 1)).toBe(true);
		expect(pane.routeMouse({ ...hover, button: 0, motion: false, leftClick: true }, 1, 1)).toBe(true);
		expect(onSelectThread).toHaveBeenCalledWith("beta");
		vi.advanceTimersByTime(300);
		expect(railVisible()).toBe(true);
		pane.clearAppViewportHover();
		expect(railVisible()).toBe(true);
		vi.advanceTimersByTime(300);
		expect(railVisible()).toBe(false);
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Beta answer");

		pane.handleInput("\x1bt");
		vi.advanceTimersByTime(200);
		pane.update([threads[1]!], "beta");
		expect(pane.wantsAppViewportHover()).toBe(true);
		const selectedBg = theme.getBgAnsi("selectedBg");
		expect(pane.render(100)[0]).not.toContain(selectedBg);
		expect(pane.routeMouse({ ...hover, row: 0 }, 0, 1)).toBe(true);
		expect(pane.render(100)[0]).toContain(selectedBg);
		pane.clearAppViewportHover();
		pane.handleInput("\x1bt");
		pane.dispose();
		const rendersAfterDispose = requestRender.mock.calls.length;
		vi.advanceTimersByTime(180);
		expect(requestRender).toHaveBeenCalledTimes(rendersAfterDispose);
		expect(peerStatusLine.dispose).toHaveBeenCalledTimes(1);
	});
});

describe("BtwController", () => {
	it("dispatches the question to runEphemeralTurn with the btw prompt wrapper and a fresh signal", async () => {
		const runEphemeralTurn = vi.fn(async (_args: RunEphemeralTurnArgs) => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("What changed?");
		// Drain microtasks so the inner promise can resolve.
		await Promise.resolve();
		await Promise.resolve();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		const callArg = runEphemeralTurn.mock.calls[0]?.[0];
		expect(callArg).toBeDefined();
		expect(callArg?.promptText).toContain("<btw>");
		expect(callArg?.promptText).toContain("What changed?");
		expect(callArg?.signal).toBeInstanceOf(AbortSignal);
		expect(typeof callArg?.onTextDelta).toBe("function");
		expect(controller.hasActiveRequest()).toBe(true);
	});

	it("renders completed /btw answers with copy and branch affordances", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("What changed?");
		await drainBtwRequest();

		const panel = btwContainer.children[0] as BtwPanelComponent | undefined;
		expect(panel).toBeDefined();
		const rendered = Bun.stripANSI(panel?.render(120).join("\n") ?? "");
		expect(rendered).toContain("c copy");
		expect(rendered).toContain("b branch to chat");
	});

	it("replaces a previous request by aborting it before issuing the next runEphemeralTurn", async () => {
		const signals: AbortSignal[] = [];
		const first = Promise.withResolvers<RunEphemeralTurnResult>();
		const firstPromise = first.promise;
		const runEphemeralTurn = vi
			.fn<(args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>>()
			.mockImplementationOnce(async args => {
				signals.push(args.signal as AbortSignal);
				return firstPromise;
			})
			.mockImplementationOnce(async args => {
				signals.push(args.signal as AbortSignal);
				return { replyText: "second", assistantMessage: createAssistantMessage("second") };
			});
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("First?");
		await controller.start("Second?");
		// Allow the second call to settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		expect(btwContainer.children).toHaveLength(1);
		// Allow the orphaned first request to finish to keep the test clean.
		first.resolve({ replyText: "first", assistantMessage: createAssistantMessage("first") });
	});

	it("clears the panel when the active request is dismissed via Escape", async () => {
		const runEphemeralTurn = vi.fn(async () => Promise.withResolvers<RunEphemeralTurnResult>().promise);
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		expect(btwContainer.children).toHaveLength(1);
		expect(controller.handleEscape()).toBe(true);
		expect(btwContainer.children).toHaveLength(0);
		expect(controller.hasActiveRequest()).toBe(false);
	});

	it("rejects empty questions before issuing the side-channel call", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "n/a",
			assistantMessage: createAssistantMessage("n/a"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("   ");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(controller.hasActiveRequest()).toBe(false);
	});

	it("shows an error message when no model is configured", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "n/a",
			assistantMessage: createAssistantMessage("n/a"),
		}));
		const session = { model: undefined, runEphemeralTurn } as unknown as InteractiveModeContext["session"];
		const ctx = makeCtx(session);
		const controller = new BtwController(ctx);

		await controller.start("Anything?");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(ctx.showError).toHaveBeenCalled();
	});

	it("does not allow branch while /btw is still running", async () => {
		const runEphemeralTurn = vi.fn(async () => Promise.withResolvers<RunEphemeralTurnResult>().promise);
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(false);
	});

	it("does not allow branch when the completed answer has no originating leaf", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn)) as InteractiveModeContext & {
			setTestLeafId(nextLeafId: string | null): void;
		};
		ctx.setTestLeafId(null);
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(true);
	});

	it("allows branch after a complete non-empty reply", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canBranch()).toBe(true);
		expect(controller.handlesBranchKey()).toBe(true);
	});

	it("refuses branch when the loaded session changed but the leaf id still matches", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn)) as InteractiveModeContext & {
			setTestSessionId(nextSessionId: string): void;
		};
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		expect(controller.canBranch()).toBe(true);

		// A resumed/branched session preserves the entry id, so the leaf still matches;
		// the session id must still gate the promotion.
		ctx.setTestSessionId("session-2");

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(true);
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("/btw branch unavailable: the session changed since /btw started", {
			dim: true,
		});
	});

	it("refuses a completed branch while the main turn is streaming", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const session = makeFakeSession(runEphemeralTurn);
		Object.defineProperty(session, "isStreaming", { value: true });
		const btwContainer = new Container();
		const ctx = makeCtx(session, btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(true);
		const panel = btwContainer.children[0];
		expect(Bun.stripANSI(panel?.render(120).join("\n") ?? "")).not.toContain("b branch to chat");
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.showStatus).toHaveBeenCalledWith("/btw branch unavailable: a turn is still running", {
			dim: true,
		});
	});

	it("does not allow branch after a complete empty reply", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "   ",
			assistantMessage: createAssistantMessage("   "),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(false);
	});

	it("does not allow branch after aborted or errored requests", async () => {
		const abortedRun = vi.fn(async () => Promise.withResolvers<RunEphemeralTurnResult>().promise);
		const abortedController = new BtwController(makeCtx(makeFakeSession(abortedRun)));
		await abortedController.start("Question?");
		expect(abortedController.handleEscape()).toBe(true);
		expect(abortedController.canBranch()).toBe(false);

		const erroredRun = vi.fn(async () => {
			throw new Error("boom");
		});
		const erroredController = new BtwController(makeCtx(makeFakeSession(erroredRun)));
		await erroredController.start("Question?");
		await drainBtwRequest();
		expect(erroredController.canBranch()).toBe(false);
	});

	it("handleBranch returns false and does not call the context when not branchable", async () => {
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "", assistantMessage: createAssistantMessage("") }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).not.toHaveBeenCalled();
	});

	it("handleBranch calls the context with the question and full assistant message when branchable", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(true);
		expect(ctx.handleBtwBranch).toHaveBeenCalledWith(
			{
				anchorLeafId: "leaf-1",
				sessionId: "session-1",
				turns: [
					{
						input: "Question?",
						replyText: "Answer",
						assistantMessage,
						timestamp: expect.any(Number),
					},
				],
			},
			undefined,
		);
	});

	it("keeps a pending branch visible and refuses to dismiss it", async () => {
		const branch = Promise.withResolvers<void>();
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		ctx.handleBtwBranch = vi.fn(async () => {
			await branch.promise;
			return true;
		});
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		const branchPromise = controller.handleBranch();
		await Promise.resolve();
		expect(controller.handlesBranchKey()).toBe(true);

		const panel = btwContainer.children[0];
		expect(Bun.stripANSI(panel?.render(120).join("\n") ?? "")).toContain("Branching to chat");
		expect(controller.handleEscape()).toBe(true);
		expect(btwContainer.children).toHaveLength(1);
		expect(ctx.showStatus).toHaveBeenCalledWith("/btw branch is in progress", { dim: true });

		branch.resolve();
		await branchPromise;
	});

	it("branches the sanitized reply text while preserving non-text assistant content", async () => {
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("raw repeated repeated repeated"),
			content: [
				{
					type: "thinking",
					thinking: "Keep this reasoning.",
					thinkingSignature: "signed-for-ephemeral-prompt",
					itemId: "item-1",
				},
				{ type: "redactedThinking", data: "encrypted-ephemeral-thinking" },
				{ type: "text", text: "raw repeated repeated repeated" },
				{ type: "text", text: "raw duplicate tail" },
			],
		};
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "sanitized", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(true);
		expect(ctx.handleBtwBranch).toHaveBeenCalledWith(
			{
				anchorLeafId: "leaf-1",
				sessionId: "session-1",
				turns: [
					{
						input: "Question?",
						replyText: "sanitized",
						assistantMessage: {
							...assistantMessage,
							content: [
								{ type: "thinking", thinking: "Keep this reasoning." },
								{ type: "text", text: "sanitized" },
							],
							providerPayload: undefined,
						},
						timestamp: expect.any(Number),
					},
				],
			},
			undefined,
		);
	});

	it("copies the sanitized visible reply text after a complete non-empty reply", async () => {
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const runEphemeralTurn = vi.fn(async (args: RunEphemeralTurnArgs) => {
			args.onTextDelta?.("duplicate streaming draft");
			return {
				replyText: "  Visible\tanswer\n\nfrom /btw  ",
				assistantMessage: createAssistantMessage("raw assistant payload"),
			};
		});
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canCopy()).toBe(true);
		expect(await controller.handleCopy()).toBe(true);
		expect(copySpy).toHaveBeenCalledWith(replaceTabs("Visible\tanswer\n\nfrom /btw"));
		expect(ctx.showStatus).toHaveBeenCalledWith("Copied /btw answer to clipboard");
	});

	it("does not copy running, empty, or errored /btw answers", async () => {
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

		const runningRun = vi.fn(async () => Promise.withResolvers<RunEphemeralTurnResult>().promise);
		const runningController = new BtwController(makeCtx(makeFakeSession(runningRun)));
		await runningController.start("Question?");
		expect(runningController.canCopy()).toBe(false);
		expect(await runningController.handleCopy()).toBe(false);
		runningController.dispose();

		const emptyRun = vi.fn(async () => ({ replyText: "   ", assistantMessage: createAssistantMessage("   ") }));
		const emptyController = new BtwController(makeCtx(makeFakeSession(emptyRun)));
		await emptyController.start("Question?");
		await drainBtwRequest();
		expect(emptyController.canCopy()).toBe(false);
		expect(await emptyController.handleCopy()).toBe(false);

		const erroredRun = vi.fn(async () => {
			throw new Error("boom");
		});
		const erroredController = new BtwController(makeCtx(makeFakeSession(erroredRun)));
		await erroredController.start("Question?");
		await drainBtwRequest();
		expect(erroredController.canCopy()).toBe(false);
		expect(await erroredController.handleCopy()).toBe(false);

		expect(copySpy).not.toHaveBeenCalled();
	});

	it("branches the sanitized reply text without native replay payload metadata", async () => {
		const providerPayload = {
			type: "openaiResponsesHistory" as const,
			provider: "openai-codex",
			dt: true,
			items: [{ type: "reasoning", encrypted_content: "raw-ephemeral-output" }],
		};
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("raw ephemeral output"),
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5-codex",
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "native-signature", itemId: "rs_1" },
				{ type: "text", text: "raw ephemeral output" },
			],
			providerPayload,
		};
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "sanitized", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(true);
		expect(ctx.handleBtwBranch).toHaveBeenCalledWith(
			{
				anchorLeafId: "leaf-1",
				sessionId: "session-1",
				turns: [
					{
						input: "Question?",
						replyText: "sanitized",
						assistantMessage: {
							...assistantMessage,
							content: [
								{ type: "thinking", thinking: "reasoning" },
								{ type: "text", text: "sanitized" },
							],
							providerPayload: undefined,
						},
						timestamp: expect.any(Number),
					},
				],
			},
			undefined,
		);
	});

	it("ignores duplicate branch requests while branch promotion is in flight", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const branchStarted = Promise.withResolvers<void>();
		const releaseBranch = Promise.withResolvers<void>();
		ctx.handleBtwBranch = vi.fn(async () => {
			branchStarted.resolve();
			await releaseBranch.promise;
			return true;
		});
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		const firstBranch = controller.handleBranch();
		await branchStarted.promise;

		expect(controller.canBranch()).toBe(false);
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).toHaveBeenCalledTimes(1);

		releaseBranch.resolve();
		expect(await firstBranch).toBe(true);
	});

	it("does not branch a completed answer after the session leaf changes", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn)) as InteractiveModeContext & {
			setTestLeafId(nextLeafId: string | null): void;
		};
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		expect(controller.canBranch()).toBe(true);

		ctx.setTestLeafId("leaf-2");

		expect(controller.canBranch()).toBe(false);
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).not.toHaveBeenCalled();
	});

	it("clears stored branch state on escape and dispose", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const escapeController = new BtwController(makeCtx(makeFakeSession(runEphemeralTurn)));
		await escapeController.start("Question?");
		await drainBtwRequest();
		expect(escapeController.canBranch()).toBe(true);
		expect(escapeController.handleEscape()).toBe(true);
		expect(escapeController.canBranch()).toBe(false);

		const disposeController = new BtwController(makeCtx(makeFakeSession(runEphemeralTurn)));
		await disposeController.start("Question?");
		await drainBtwRequest();
		expect(disposeController.canBranch()).toBe(true);
		disposeController.dispose();
		expect(disposeController.canBranch()).toBe(false);
	});
	it("keeps QuickAsk inline, then upgrades the same turn into one durable workspace pane", async () => {
		const events: BtwThreadEvent[] = [];
		const model = {
			id: "claude-sonnet-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
		};
		const createConversation = vi.fn(
			(_instructions: string, checkpoint?: EphemeralConversationCheckpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: `side-${createConversation.mock.calls.length}`,
					checkpoint,
					runTurn: async (_messages, options) => {
						options.onTextDelta?.("Answer");
						return { replyText: "Answer", assistantMessage: createAssistantMessage("Answer") };
					},
				}),
		);
		const session = {
			sessionId: "session-1",
			model,
			findModel: () => model,
			createEphemeralConversation: createConversation,
		} as unknown as InteractiveModeContext["session"];
		let activePane: BtwConversationPane | undefined;
		const mountedPanes = new Set<BtwConversationPane>();
		const openBtwWorkspacePane = vi.fn((component: unknown) => {
			activePane = component as BtwConversationPane;
			mountedPanes.add(activePane);
			return true;
		});
		const ctx = {
			...makeCtx(session),
			workspaceEnabled: true,
			keybindings: { getKeys: () => ["ctrl+o"] },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
			sessionManager: {
				getEntries: () => [],
				appendCustomEntry: (_customType: string, event: BtwThreadEvent) => events.push(event),
				getLeafId: () => "leaf-1",
				getSessionId: () => "session-1",
				getEntry: (id: string) => (id === "leaf-1" ? {} : undefined),
				getCwd: () => process.cwd(),
			},
			openBtwWorkspacePane,
			closeBtwWorkspacePane: vi.fn(() => {
				activePane = undefined;
				return true;
			}),
			handleBtwBranch: vi.fn(async () => true),
		} as unknown as InteractiveModeContext;
		const controller = new BtwController(ctx);

		await controller.start("First?");
		await drainBtwRequest();
		expect(activePane).toBeUndefined();
		expect(controller.canContinue()).toBe(true);
		expect(Bun.stripANSI(ctx.btwContainer.render(100).join("\n"))).toContain("Enter continue");

		expect(await controller.handleContinue()).toBe(true);
		expect(activePane).toBeDefined();
		expect(Bun.stripANSI(activePane?.render(100).join("\n") ?? "")).toContain("Answer");
		expect(events.map(event => event.op)).toEqual(["create", "read"]);
		expect(events[0]).toMatchObject({
			op: "create",
			anchorLeafId: "leaf-1",
			turns: [expect.objectContaining({ input: "First?" })],
		});

		await controller.start("Second?");
		await drainBtwRequest();
		expect(await controller.handleContinue()).toBe(true);
		expect(mountedPanes.size).toBe(1);
		expect(events.filter(event => event.op === "create")).toHaveLength(2);
		controller.dispose();
	});

	it("switches threads during rail expansion while another durable BTW turn is running", async () => {
		vi.useFakeTimers();
		const events: BtwThreadEvent[] = [];
		const running = Promise.withResolvers<RunEphemeralTurnResult>();
		let runCount = 0;
		let runningDelta: ((delta: string) => void) | undefined;
		const model = { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" };
		const createConversation = (
			_instructions: string,
			checkpoint?: EphemeralConversationCheckpoint,
		): EphemeralConversation =>
			new EphemeralConversation({
				snapshotBaseMessages: () => [],
				sideSessionId: checkpoint?.sideSessionId ?? `side-${runCount + 1}`,
				checkpoint,
				runTurn: async (_messages, options) => {
					runCount++;
					if (runCount === 3) {
						runningDelta = options.onTextDelta;
						runningDelta?.("Working");
						return running.promise;
					}
					const replyText = runCount === 1 ? "First answer" : "Second answer";
					return { replyText, assistantMessage: createAssistantMessage(replyText) };
				},
			});
		const session = {
			sessionId: "session-1",
			model,
			findModel: () => model,
			createEphemeralConversation: createConversation,
		} as unknown as InteractiveModeContext["session"];
		let activePane: BtwConversationPane | undefined;
		const ctx = {
			...makeCtx(session),
			workspaceEnabled: true,
			keybindings: { getKeys: () => [] },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
			sessionManager: {
				getEntries: () => [],
				appendCustomEntry: (_customType: string, event: BtwThreadEvent) => events.push(event),
				getLeafId: () => "leaf-1",
				getSessionId: () => "session-1",
				getEntry: (id: string) => (id === "leaf-1" ? {} : undefined),
				getCwd: () => process.cwd(),
			},
			openBtwWorkspacePane: (component: BtwConversationPane) => {
				activePane = component;
				return true;
			},
			closeBtwWorkspacePane: () => true,
			handleBtwBranch: vi.fn(async () => true),
		} as unknown as InteractiveModeContext;
		const controller = new BtwController(ctx);

		await controller.start("First?");
		await drainBtwRequest();
		expect(await controller.handleContinue()).toBe(true);
		await controller.start("Second?");
		await drainBtwRequest();
		expect(await controller.handleContinue()).toBe(true);
		const pane = activePane;
		if (!pane) throw new Error("Expected durable BTW pane");
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Second answer");

		pane.handleInput("Keep working");
		pane.handleInput("\r");
		await drainBtwRequest();
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Working");

		pane.setViewportHeight(14);
		const expandedRows = pane.render(100).length;
		const handleRow = Math.floor((expandedRows - 1) / 2);
		pane.handleInput("\x1bt");
		vi.advanceTimersByTime(200);
		const expandClick: SgrMouseEvent = {
			button: 0,
			col: 0,
			row: handleRow,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			rightClick: false,
		};
		expect(pane.routeMouse(expandClick, handleRow, 0)).toBe(true);
		vi.advanceTimersByTime(25);
		const clickFirst: SgrMouseEvent = {
			...expandClick,
			col: 1,
			row: 0,
		};
		expect(pane.routeMouse(clickFirst, 0, 1)).toBe(true);
		vi.advanceTimersByTime(200);
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("First answer");

		runningDelta?.(" more");
		await drainBtwRequest();
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("First answer");
		running.resolve({ replyText: "Finished", assistantMessage: createAssistantMessage("Finished") });
		await drainBtwRequest();
		controller.dispose();
	});

	it("refreshes a child from current Main and routes steer and handoff without adding side turns", async () => {
		const events: BtwThreadEvent[] = [];
		const frozenMain: string[] = [];
		let mainContext = "main-v1";
		let leafId = "leaf-v1";
		const model = { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" };
		const createConversation = (
			_instructions: string,
			checkpoint?: EphemeralConversationCheckpoint,
		): EphemeralConversation =>
			new EphemeralConversation({
				snapshotBaseMessages: () => {
					frozenMain.push(mainContext);
					return [{ role: "user", content: mainContext, timestamp: Date.now() }];
				},
				sideSessionId: checkpoint?.sideSessionId ?? "side-1",
				checkpoint,
				runTurn: async () => ({
					replyText: "Side answer",
					assistantMessage: createAssistantMessage("Side answer"),
				}),
			});
		const session = {
			sessionId: "session-1",
			model,
			findModel: () => model,
			createEphemeralConversation: createConversation,
		} as unknown as InteractiveModeContext["session"];
		let activePane: BtwConversationPane | undefined;
		const submitMainMessage = vi.fn((_text: string, _mode: "steer" | "followUp") => true);
		const ctx = {
			...makeCtx(session),
			workspaceEnabled: true,
			keybindings: { getKeys: () => [] },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
			submitMainMessage,
			sessionManager: {
				getEntries: () => [],
				appendCustomEntry: (_customType: string, event: BtwThreadEvent) => events.push(event),
				getLeafId: () => leafId,
				getSessionId: () => "session-1",
				getEntry: () => ({}),
				getCwd: () => process.cwd(),
			},
			openBtwWorkspacePane: (component: BtwConversationPane) => {
				activePane = component;
				return true;
			},
			closeBtwWorkspacePane: () => true,
			handleBtwBranch: vi.fn(async () => true),
		} as unknown as InteractiveModeContext;
		const controller = new BtwController(ctx);
		await controller.start("First?");
		await drainBtwRequest();
		expect(await controller.handleContinue()).toBe(true);
		const pane = activePane;
		if (!pane) throw new Error("Expected durable BTW pane");

		mainContext = "main-v2";
		leafId = "leaf-v2";
		pane.handleInput("/refresh");
		pane.handleInput("\r");
		expect(frozenMain).toEqual(["main-v1", "main-v2"]);
		expect(events.find(event => event.op === "refresh")).toMatchObject({
			op: "refresh",
			anchorLeafId: "leaf-v2",
		});

		pane.handleInput("/steer fix the active turn");
		pane.handleInput("\r");
		expect(submitMainMessage).toHaveBeenLastCalledWith("fix the active turn", "steer");

		pane.handleInput("/handoff apply this result");
		pane.handleInput("\r");
		const handoff = submitMainMessage.mock.calls.at(-1);
		expect(handoff?.[0]).toContain("First?");
		expect(handoff?.[0]).toContain("Side answer");
		expect(handoff).toEqual([expect.any(String), "followUp"]);
		expect(events.filter(event => event.op === "turn")).toHaveLength(0);
		controller.dispose();
	});

	it("promotes a completed QuickAsk directly without journaling a durable child", async () => {
		const events: BtwThreadEvent[] = [];
		const model = { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" };
		const session = {
			sessionId: "session-1",
			model,
			findModel: () => model,
			createEphemeralConversation: () =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "side-quick",
					runTurn: async () => ({ replyText: "Answer", assistantMessage: createAssistantMessage("Answer") }),
				}),
		} as unknown as InteractiveModeContext["session"];
		const handleBtwBranch = vi.fn(async () => true);
		const ctx = {
			...makeCtx(session),
			workspaceEnabled: true,
			keybindings: { getKeys: () => [] },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
			sessionManager: {
				getEntries: () => [],
				appendCustomEntry: (_customType: string, event: BtwThreadEvent) => events.push(event),
				getLeafId: () => "quick-anchor",
				getSessionId: () => "session-1",
				getEntry: (id: string) => (id === "quick-anchor" ? {} : undefined),
				getCwd: () => process.cwd(),
			},
			openBtwWorkspacePane: () => true,
			closeBtwWorkspacePane: () => true,
			handleBtwBranch,
		} as unknown as InteractiveModeContext;
		const controller = new BtwController(ctx);
		await controller.start("Quick?");
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(true);
		expect(handleBtwBranch).toHaveBeenCalledWith(
			expect.objectContaining({ anchorLeafId: "quick-anchor" }),
			undefined,
		);
		expect(events).toEqual([]);
	});

	it("promotes a durable child from its frozen anchor after Main advances and journals removal before switching", async () => {
		const events: BtwThreadEvent[] = [];
		let leafId = "anchor-leaf";
		const model = { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" };
		const session = {
			sessionId: "session-1",
			model,
			findModel: () => model,
			createEphemeralConversation: () =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "side-1",
					runTurn: async () => ({ replyText: "Answer", assistantMessage: createAssistantMessage("Answer") }),
				}),
		} as unknown as InteractiveModeContext["session"];
		const handleBtwBranch = vi.fn(
			async (_request: BtwPromotionRequest, lifecycle: BtwPromotionLifecycle | undefined): Promise<boolean> => {
				lifecycle?.prepare();
				return true;
			},
		);
		const ctx = {
			...makeCtx(session),
			workspaceEnabled: true,
			keybindings: { getKeys: () => ["ctrl+o"] },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
			sessionManager: {
				getEntries: () => [],
				appendCustomEntry: (_customType: string, event: BtwThreadEvent) => events.push(event),
				getLeafId: () => leafId,
				getSessionId: () => "session-1",
				getEntry: () => ({}),
				getCwd: () => process.cwd(),
			},
			openBtwWorkspacePane: () => true,
			closeBtwWorkspacePane: () => true,
			handleBtwBranch,
		} as unknown as InteractiveModeContext;
		const controller = new BtwController(ctx);
		await controller.start("Question?");
		await drainBtwRequest();
		await controller.handleContinue();
		leafId = "late-main-leaf";

		expect(await controller.handleBranch()).toBe(true);
		expect(handleBtwBranch.mock.calls[0]?.[0]).toMatchObject({ anchorLeafId: "anchor-leaf" });
		expect(events.map(event => event.op)).toEqual(["create", "read", "remove"]);
	});
});
