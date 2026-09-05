import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
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
	type EphemeralConversationSideOptions,
	type EphemeralConversationStatus,
	type EphemeralTurnOptions,
} from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { Container, replaceTabs, type SgrMouseEvent, sliceByColumn, type TUI } from "@oh-my-pi/pi-tui";

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
			createPeer: () => ({
				getTopBorder: () => ({ content: " MAIN STATUS ", width: 13 }),
				setRuntimeStatus: () => {},
				dispose: () => {},
			}),
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
	it("binds the status line to the selected BTW runtime", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const runtimeStatus = (id: string, name: string): EphemeralConversationStatus => ({
			sessionId: id,
			model: {
				id,
				name,
				provider: "anthropic",
				contextWindow: 200_000,
				thinking: false,
			} as unknown as EphemeralConversationStatus["model"],
			thinkingLevel: undefined,
			isStreaming: false,
			latestAssistantMessage: undefined,
			stats: {
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				premiumRequests: 0,
				cost: 0,
				contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
			},
		});
		const threads = [
			{
				key: "alpha",
				title: "Alpha",
				phase: "ready",
				model: { provider: "anthropic", id: "alpha" },
				error: undefined,
				draft: "",
				unread: 0,
				request: undefined,
				turns: [],
				status: runtimeStatus("alpha", "Side Alpha"),
			},
			{
				key: "beta",
				title: "Beta",
				phase: "ready",
				model: { provider: "anthropic", id: "beta" },
				error: undefined,
				draft: "",
				unread: 0,
				request: undefined,
				turns: [],
				status: runtimeStatus("beta", "Side Beta"),
			},
		] as BtwThreadView[];
		let activeModel = "Main";
		const statusLine = {
			setRuntimeStatus: vi.fn((status: EphemeralConversationStatus | undefined) => {
				activeModel = status?.model.name ?? "Main";
			}),
			getTopBorder: vi.fn(() => ({
				content: ` ${activeModel} STATUS `,
				width: activeModel.length + 8,
				revision: 0,
			})),
			dispose: vi.fn(),
		};
		const pane = new BtwConversationPane({
			ui,
			cwd: process.cwd(),
			expandKeys: [],
			hideThinkingBlock: () => false,
			proseOnlyThinking: () => false,
			requestRender: () => ui.requestRender(),
			statusLine,
			onSubmit: () => true,
			onNewThread: () => true,
			canCopy: () => false,
			onCopy: async () => false,
			onClose: vi.fn(),
			onDraftChange: vi.fn(),
			onPersistDraft: vi.fn(),
			onSelectThread: () => true,
			onMarkRead: vi.fn(),
			onCloseThread: () => true,
			onPromoteThread: async () => true,
		});

		pane.setViewportHeight(14);
		pane.update(threads, "alpha");
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Side Alpha STATUS");
		pane.update(threads, "beta");
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Side Beta STATUS");
		expect(statusLine.setRuntimeStatus).toHaveBeenLastCalledWith(threads[1]?.status, "Beta");
		pane.dispose();
	});

	it("updates the current stream block without rebuilding the displayed thread", () => {
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const ui = { requestRender, requestComponentRender } as unknown as TUI;
		const pane = new BtwConversationPane({
			ui,
			cwd: process.cwd(),
			expandKeys: [],
			hideThinkingBlock: () => false,
			proseOnlyThinking: () => false,
			requestRender,
			statusLine: {
				setRuntimeStatus: vi.fn(),
				getTopBorder: () => ({ content: " STATUS ", width: 8, revision: 0 }),
				dispose: vi.fn(),
			},
			onSubmit: () => true,
			onNewThread: () => true,
			canCopy: () => false,
			onCopy: async () => false,
			onClose: vi.fn(),
			onDraftChange: vi.fn(),
			onPersistDraft: vi.fn(),
			onSelectThread: () => true,
			onMarkRead: vi.fn(),
			onCloseThread: () => true,
			onPromoteThread: async () => true,
		});
		const thread: BtwThreadView = {
			key: "stream",
			title: "Streaming",
			phase: "running",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			error: undefined,
			draft: "",
			unread: 0,
			turns: [],
			request: {
				input: "Explain",
				messages: [],
				streamMessage: createAssistantMessage("partial one"),
				timestamp: 1,
			},
		};
		try {
			pane.setViewportHeight(12);
			pane.update([thread], thread.key);
			expect(Bun.stripANSI(pane.render(80).join("\n"))).toContain("partial one");
			requestRender.mockClear();
			requestComponentRender.mockClear();

			pane.update(
				[
					{
						...thread,
						request: {
							...thread.request!,
							streamMessage: createAssistantMessage("partial two"),
						},
					},
				],
				thread.key,
			);

			expect(requestComponentRender).toHaveBeenCalled();
			expect(Bun.stripANSI(pane.render(80).join("\n"))).toContain("partial two");
		} finally {
			pane.dispose();
		}
	});

	it("keeps the scrolled viewport anchored when a tool-using stream completes", () => {
		const requestRender = vi.fn();
		const ui = { requestRender, requestComponentRender: vi.fn() } as unknown as TUI;
		const pane = new BtwConversationPane({
			ui,
			cwd: process.cwd(),
			expandKeys: [],
			hideThinkingBlock: () => false,
			proseOnlyThinking: () => false,
			requestRender,
			statusLine: {
				setRuntimeStatus: vi.fn(),
				getTopBorder: () => ({ content: " STATUS ", width: 8, revision: 0 }),
				dispose: vi.fn(),
			},
			onSubmit: () => true,
			onNewThread: () => true,
			canCopy: () => false,
			onCopy: async () => false,
			onClose: vi.fn(),
			onDraftChange: vi.fn(),
			onPersistDraft: vi.fn(),
			onSelectThread: () => true,
			onMarkRead: vi.fn(),
			onCloseThread: () => true,
			onPromoteThread: async () => true,
		});
		const partialAnswer = Array.from({ length: 120 }, (_value, index) => String(index + 1)).join("\n");
		const answer = Array.from({ length: 200 }, (_value, index) => String(index + 1)).join("\n");
		const streamMessage = createAssistantMessage(partialAnswer);
		const finalMessage = createAssistantMessage(answer);
		const intermediateText = Array.from({ length: 40 }, (_value, index) => `preface-${index + 1}`).join("\n");
		const intermediateMessage: AssistantMessage = {
			...createAssistantMessage(`${intermediateText}\n`),
			content: [
				{ type: "text", text: `${intermediateText}\n` },
				{ type: "toolCall", id: "read-context", name: "read", arguments: { path: "context.ts" } },
			],
			stopReason: "toolUse",
		};
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read-context",
			toolName: "read",
			content: [{ type: "text", text: "context" }],
			isError: false,
			timestamp: 1,
		};
		const requestMessages: AgentMessage[] = [intermediateMessage, toolResult];
		const turns: Array<BtwThreadView["turns"][number]> = [];
		const thread: BtwThreadView = {
			key: "stream",
			title: "Streaming",
			phase: "running",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			error: undefined,
			draft: "",
			unread: 0,
			turns,
			request: {
				input: "Count",
				messages: requestMessages,
				streamMessage,
				timestamp: 1,
			},
		};
		const visibleNumbers = (): string[] =>
			pane
				.render(80)
				.map(line => Bun.stripANSI(line).match(/^│ (\d+)/)?.[1])
				.filter((line): line is string => line !== undefined);
		try {
			pane.setViewportHeight(12);
			pane.update([thread], thread.key);
			pane.render(80);
			pane.handleInput("\x1b[5~");
			const scrolledRows = visibleNumbers();
			expect(Number(scrolledRows[0])).toBeGreaterThan(1);

			const grownThread: BtwThreadView = {
				...thread,
				request: {
					...thread.request!,
					streamMessage: finalMessage,
				},
			};
			pane.update([grownThread], thread.key);
			expect(visibleNumbers()[0]).toBe(scrolledRows[0]);
			const beforeCompletion = visibleNumbers();

			requestMessages.push(finalMessage);
			const endedThread: BtwThreadView = {
				...grownThread,
				request: {
					...grownThread.request!,
					messages: requestMessages,
					streamMessage: undefined,
				},
			};
			pane.update([endedThread], thread.key);
			expect(visibleNumbers()[0]).toBe(beforeCompletion[0]);

			turns.push({
				input: "Count",
				assistantMessage: finalMessage,
				intermediateMessages: [intermediateMessage, toolResult],
				replyText: `${intermediateText}\n${answer}`,
				timestamp: 1,
			});
			const completedThread: BtwThreadView = {
				...endedThread,
				phase: "ready",
				turns,
				request: undefined,
			};
			pane.update([completedThread], thread.key);
			expect(visibleNumbers()[0]).toBe(scrolledRows[0]);

			pane.update([completedThread], thread.key);
			expect(visibleNumbers()[0]).toBe(scrolledRows[0]);
		} finally {
			pane.dispose();
		}
	});

	it("defaults the rail closed and selects a hover-previewed thread without pinning it open", () => {
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
			getTopBorder: vi.fn(() => ({ content: " MAIN STATUS ", width: 13, revision: 0 })),
			setRuntimeStatus: vi.fn(),
			dispose: vi.fn(),
		};
		const onSubmit = vi.fn(() => true);
		const onNewThread = vi.fn(() => true);
		const onCopy = vi.fn(async (_key: string) => true);
		const onSelectThread = vi.fn((key: string) => {
			pane.update(threads, key);
			return true;
		});
		const pane = new BtwConversationPane({
			ui,
			cwd: process.cwd(),
			expandKeys: [],
			hideThinkingBlock: () => false,
			proseOnlyThinking: () => false,
			requestRender: () => ui.requestRender(),
			statusLine: peerStatusLine,
			onSubmit,
			onNewThread,
			canCopy: () => true,
			onCopy,
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
		pane.handleInput("draft");
		pane.handleInput("\x1b");
		expect(pane.render(100).join("\n")).not.toContain("draft");
		const initial = pane.render(100);
		const initialPlain = initial.map(line => Bun.stripANSI(line));
		expect(initialPlain.join("\n")).not.toContain("Threads 2");
		expect(initialPlain.join("\n")).not.toContain("hover preview");
		expect(initialPlain.join("\n")).toContain("MAIN STATUS");
		expect(initialPlain.join("\n")).not.toContain("Ask BTW");
		expect(peerStatusLine.getTopBorder).toHaveBeenCalled();
		const handleRow = Math.floor((initial.length - 1) / 2);
		const railVisible = () => Bun.stripANSI(pane.render(100)[0] ?? "").indexOf("│", 1) > 0;
		expect(railVisible()).toBe(false);
		expect(initialPlain[handleRow - 1]).toStartWith("│");
		expect(initialPlain[handleRow]).toStartWith("▶");
		expect(initialPlain[handleRow + 1]).toStartWith("│");
		const handleClick: SgrMouseEvent = {
			button: 0,
			col: 0,
			row: handleRow - 1,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			rightClick: false,
		};
		expect(pane.routeMouse(handleClick, handleRow - 1, 0)).toBe(true);
		vi.advanceTimersByTime(200);
		const expanded = pane.render(100);
		const expandedPlain = expanded.map(line => Bun.stripANSI(line));
		const dividerCol = expandedPlain[handleRow - 2]!.indexOf("│");
		expect(expandedPlain[handleRow - 1]![dividerCol]).toBe("│");
		expect(expandedPlain[handleRow]![dividerCol]).toBe("◀");
		expect(expandedPlain[handleRow + 1]![dividerCol]).toBe("│");
		const newButton = expanded.at(-1);
		expect(newButton).toBeDefined();
		expect(Bun.stripANSI(newButton!)).toContain("[ + New BTW ]");
		expect(newButton).not.toContain(theme.getBgAnsi("selectedBg"));
		const newButtonRow = expanded.length - 1;
		const newButtonHover = {
			...handleClick,
			col: 1,
			row: newButtonRow,
			motion: true,
			leftClick: false,
		};
		expect(pane.routeMouse(newButtonHover, newButtonRow, 1)).toBe(true);
		expect(pane.render(100)[newButtonRow]).toContain(theme.getBgAnsi("selectedBg"));
		expect(pane.routeMouse({ ...handleClick, col: 1, row: newButtonRow }, newButtonRow, 1)).toBe(true);
		expect(onNewThread).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
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
		expect(pane.routeMouse({ ...handleClick, col: dividerCol }, handleRow - 1, dividerCol)).toBe(true);
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
		expect(pane.routeMouse({ ...handleClick, col: dividerCol }, handleRow - 1, dividerCol)).toBe(true);
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
		pane.handleInput("\t");
		expect(onSelectThread).toHaveBeenLastCalledWith("beta");
		expect(Bun.stripANSI(pane.renderWorkspaceHeader(100, true))).not.toContain("preview");
		expect(onSelectThread).toHaveBeenCalledTimes(1);
		pane.update(threads, "alpha");
		expect(pane.routeMouse(hover, 1, 1)).toBe(true);
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
		pane.handleInput("\x1bc");
		expect(onCopy).toHaveBeenLastCalledWith("beta");

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
		expect(controller.hasActiveRequest()).toBe(false);
		expect(ctx.btwContainer.children).toHaveLength(0);
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
		expect(controller.canContinue()).toBe(false);
		expect(controller.handlesContinueKey()).toBe(false);

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

	it("keeps the bare copy key reserved while an inline copy is in flight", async () => {
		const pendingCopy = Promise.withResolvers<void>();
		vi.spyOn(clipboard, "copyToClipboard").mockImplementation(() => pendingCopy.promise);
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const controller = new BtwController(makeCtx(makeFakeSession(runEphemeralTurn)));

		await controller.start("Question?");
		await drainBtwRequest();
		const firstCopy = controller.handleCopy();
		await Promise.resolve();

		expect(controller.canCopy()).toBe(false);
		expect(controller.handlesCopyKey()).toBe(true);
		expect(await controller.handleCopy()).toBe(false);

		pendingCopy.resolve();
		expect(await firstCopy).toBe(true);
	});

	it("does not reserve bare b or c after the inline QuickAsk panel is unmounted", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		expect(controller.handlesBranchKey()).toBe(true);
		expect(controller.handlesCopyKey()).toBe(true);

		ctx.btwContainer.clear();
		expect(controller.canBranch()).toBe(true);
		expect(controller.canCopy()).toBe(true);
		expect(controller.handlesBranchKey()).toBe(false);
		expect(controller.handlesCopyKey()).toBe(false);
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
	it("renders durable tool events through the same transcript path as Main", async () => {
		const events: BtwThreadEvent[] = [];
		const model = {
			id: "claude-sonnet-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
		};
		const turnGate = Promise.withResolvers<void>();
		const turnFinished = Promise.withResolvers<void>();
		const toolCall: AssistantMessage = {
			...createAssistantMessage(""),
			content: [
				{ type: "thinking", thinking: "Inspecting fixture" },
				{
					type: "toolCall",
					id: "read-fixture",
					name: "read",
					arguments: {},
					[kStreamingPartialJson]: '{"path":"fixture.ts"}',
				},
			],
			stopReason: "toolUse",
		};
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read-fixture",
			toolName: "read",
			content: [{ type: "text", text: "fixture contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		const createConversation = vi.fn(
			(
				_instructions: string,
				checkpoint?: EphemeralConversationCheckpoint,
				_model?: unknown,
				_sideOptions?: EphemeralConversationSideOptions,
			) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: checkpoint?.sideSessionId ?? "side-direct",
					checkpoint,
					runTurn: async (_messages, options) => {
						options.onMessage?.({ type: "update", message: toolCall });
						await turnGate.promise;
						options.onMessage?.({ type: "end", message: toolCall });
						options.onMessage?.({ type: "end", message: toolResult });
						return {
							replyText: "Direct answer",
							assistantMessage: createAssistantMessage("Direct answer"),
							intermediateMessages: [toolCall, toolResult],
						};
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
		const ctx = {
			...makeCtx(session),
			workspaceEnabled: true,
			keybindings: { getKeys: () => [] },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
			sessionManager: {
				getEntries: () => [],
				appendCustomEntry: (_customType: string, event: BtwThreadEvent) => {
					events.push(event);
					if (event.op === "turn") turnFinished.resolve();
				},
				getLeafId: () => "leaf-1",
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

		await controller.start("");
		const pane = activePane;
		if (!pane) throw new Error("Expected an empty durable BTW pane");
		pane.handleInput("First durable?");
		pane.handleInput("\r");
		await drainBtwRequest();
		const liveTranscript = Bun.stripANSI(pane.render(100).join("\n"));
		expect(liveTranscript).toContain("fixture.ts");
		expect(liveTranscript.match(/Inspecting fixture/g)).toHaveLength(1);
		expect(liveTranscript).not.toContain("Direct answer");

		turnGate.resolve();
		await turnFinished.promise;
		await drainBtwRequest();

		expect(ctx.btwContainer.children).toHaveLength(0);
		expect(createConversation.mock.calls[0]?.[3]).toMatchObject({ readOnlyTools: true });
		expect(events[0]).toMatchObject({ op: "create", anchorLeafId: "leaf-1", turns: [] });
		expect(events.map(event => event.op)).toContain("turn");
		const completedTranscript = Bun.stripANSI(pane.render(100).join("\n"));
		expect(completedTranscript).toContain("fixture.ts");
		expect(completedTranscript.match(/Inspecting fixture/g)).toHaveLength(1);
		expect(completedTranscript).toContain("Direct answer");
		controller.dispose();
	});

	it("submits a pane image to BTW and journals it without modifying Main", async () => {
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const requests: AgentMessage[][] = [];
		const events: BtwThreadEvent[] = [];
		const completed = Promise.withResolvers<void>();
		const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
		const session = {
			sessionId: "session-1",
			model,
			createEphemeralConversation: (_instructions: string, checkpoint?: EphemeralConversationCheckpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: "image-side",
					checkpoint,
					runTurn: async messages => {
						requests.push(messages);
						return { replyText: "Image received", assistantMessage: createAssistantMessage("Image received") };
					},
				}),
		} as unknown as InteractiveModeContext["session"];
		let pane: BtwConversationPane | undefined;
		const ctx = {
			...makeCtx(session),
			workspaceEnabled: true,
			keybindings: { getKeys: () => [] },
			sessionManager: {
				getEntries: () => [],
				appendCustomEntry: (_type: string, event: BtwThreadEvent) => {
					events.push(event);
					if (event.op === "turn") completed.resolve();
				},
				getLeafId: () => "leaf-1",
				getSessionId: () => "session-1",
				getEntry: () => ({}),
				getCwd: () => process.cwd(),
			},
			openBtwWorkspacePane: (component: BtwConversationPane) => {
				pane = component;
				return true;
			},
			closeBtwWorkspacePane: () => true,
		} as unknown as InteractiveModeContext;
		const controller = new BtwController(ctx);
		try {
			await controller.start("");
			if (!pane) throw new Error("Expected BTW pane");
			const editor = pane.getPasteTarget()!;
			editor.setDraft("[Image #1]", [image]);
			pane.handleInput("\r");
			await completed.promise;
			const request = requests[0]?.at(-1);
			expect(request?.role).toBe("user");
			expect(request && "content" in request ? request.content : undefined).toEqual([
				{ type: "text", text: "[Image #1]" },
				image,
			]);
			expect(events.find(event => event.op === "turn")).toMatchObject({ turn: { images: [image] } });
			expect(pane.getPasteTarget()?.pendingImages).toEqual([]);
			expect(ctx.btwContainer.children).toHaveLength(0);
		} finally {
			controller.dispose();
		}
	});

	it("keeps QuickAsk inline, then upgrades the same turn into one durable workspace pane", async () => {
		const events: BtwThreadEvent[] = [];
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
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
					runTurn: async messages => {
						const input = messages.at(-1);
						const text =
							input?.role === "user" && Array.isArray(input.content)
								? input.content.map(block => ("text" in block ? block.text : "")).join("")
								: "";
						const replyText = `Answer: ${text}`;
						return { replyText, assistantMessage: createAssistantMessage(replyText) };
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
		const quickPanel = ctx.btwContainer.children[0];
		if (!quickPanel) throw new Error("Expected inline QuickAsk panel");
		expect(controller.handlesContinueKey()).toBe(true);
		ctx.btwContainer.clear();
		expect(controller.canContinue()).toBe(true);
		expect(controller.handlesContinueKey()).toBe(false);
		ctx.btwContainer.addChild(quickPanel);
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
		const pane = activePane;
		if (!pane) throw new Error("Expected durable BTW pane");
		pane.handleInput("\x1bc");
		await drainBtwRequest();
		expect(copySpy).toHaveBeenLastCalledWith("Answer: First?");
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
		let runningMessage: EphemeralTurnOptions["onMessage"];
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
						runningMessage = options.onMessage;
						runningMessage?.({ type: "update", message: createAssistantMessage("Working") });
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

		runningMessage?.({ type: "update", message: createAssistantMessage("Working more") });
		await drainBtwRequest();
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("First answer");
		running.resolve({ replyText: "Finished", assistantMessage: createAssistantMessage("Finished") });
		await drainBtwRequest();
		controller.dispose();
	});

	it("keeps the frozen Main context when /refresh is submitted as ordinary BTW input", async () => {
		const events: BtwThreadEvent[] = [];
		const frozenMain: string[] = [];
		let mainContext = "main-v1";
		let leafId = "leaf-v1";
		const model = { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" };
		let capturedSideOptions: EphemeralConversationSideOptions | undefined;
		const createConversation = (
			_instructions: string,
			checkpoint?: EphemeralConversationCheckpoint,
			_model?: unknown,
			sideOptions?: EphemeralConversationSideOptions,
		): EphemeralConversation => {
			capturedSideOptions = sideOptions;
			return new EphemeralConversation({
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
		};
		const sendUserMessage = vi.fn(async (_text: string, _options: { deliverAs: "steer" | "followUp" }) => {});
		const publishBtwSummary = vi.fn(
			async (_summary: { threadKey: string; threadTitle: string; summary: string }) => {},
		);
		const session = {
			sessionId: "session-1",
			model,
			findModel: () => model,
			createEphemeralConversation: createConversation,
			isStreaming: true,
			sendUserMessage,
			publishBtwSummary,
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
		await drainBtwRequest();
		expect(frozenMain).toEqual(["main-v1"]);
		expect(events.map(event => event.op)).not.toContain("refresh");
		expect(events.find(event => event.op === "turn")).toMatchObject({
			turn: expect.objectContaining({ input: "/refresh" }),
		});

		expect(capturedSideOptions).toMatchObject({ readOnlyTools: true });
		await capturedSideOptions?.shareSummaryWithMain?.("Cache invalidation must happen after commit.");
		expect(publishBtwSummary).toHaveBeenLastCalledWith({
			threadKey: expect.any(String),
			threadTitle: "First?",
			summary: "Cache invalidation must happen after commit.",
		});

		pane.handleInput("/handoff apply this result");
		pane.handleInput("\r");
		await drainBtwRequest();
		const handoff = sendUserMessage.mock.calls.at(-1);
		expect(handoff?.[0]).toContain("First?");
		expect(handoff?.[0]).toContain("Side answer");
		expect(handoff).toEqual([expect.any(String), { deliverAs: "followUp" }]);
		expect(events.filter(event => event.op === "turn")).toHaveLength(1);
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
			createEphemeralConversation: (_instructions: string, checkpoint?: EphemeralConversationCheckpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: checkpoint?.sideSessionId ?? "side-1",
					checkpoint,
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

	it("persists an unsubmitted draft before promoting its thread", async () => {
		const events: BtwThreadEvent[] = [];
		const model = { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" };
		const session = {
			sessionId: "session-1",
			model,
			findModel: () => model,
			createEphemeralConversation: (_instructions: string, checkpoint?: EphemeralConversationCheckpoint) =>
				new EphemeralConversation({
					snapshotBaseMessages: () => [],
					sideSessionId: checkpoint?.sideSessionId ?? "side-1",
					checkpoint,
					runTurn: async () => ({ replyText: "Answer", assistantMessage: createAssistantMessage("Answer") }),
				}),
		} as unknown as InteractiveModeContext["session"];
		const handleBtwBranch = vi.fn(
			async (_request: BtwPromotionRequest, lifecycle: BtwPromotionLifecycle | undefined): Promise<boolean> => {
				lifecycle?.prepare();
				return true;
			},
		);
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
				getEntry: () => ({}),
				getCwd: () => process.cwd(),
			},
			openBtwWorkspacePane: (component: BtwConversationPane) => {
				activePane = component;
				return true;
			},
			closeBtwWorkspacePane: () => true,
			handleBtwBranch,
		} as unknown as InteractiveModeContext;
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		expect(await controller.handleContinue()).toBe(true);
		const pane = activePane;
		if (!pane) throw new Error("Expected durable BTW pane");

		// Draft the next question, then promote straight from the pane without
		// submitting or switching threads: the draft must reach the old
		// session's journal before the branch switches sessions.
		pane.handleInput("my draft");
		expect(await controller.handleBranch()).toBe(true);
		expect(events.map(event => event.op)).toEqual(["create", "read", "draft", "remove"]);
		expect(events.find(event => event.op === "draft")).toMatchObject({ op: "draft", text: "my draft" });
		controller.dispose();
	});

	it("keeps the editor input and reports it when submitting into a running reply", async () => {
		const events: BtwThreadEvent[] = [];
		const running = Promise.withResolvers<RunEphemeralTurnResult>();
		let runCount = 0;
		const model = { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" };
		const createConversation = (
			_instructions: string,
			checkpoint?: EphemeralConversationCheckpoint,
		): EphemeralConversation =>
			new EphemeralConversation({
				snapshotBaseMessages: () => [],
				sideSessionId: checkpoint?.sideSessionId ?? `side-${runCount + 1}`,
				checkpoint,
				runTurn: async () => {
					runCount++;
					if (runCount === 2) return running.promise;
					return { replyText: "First answer", assistantMessage: createAssistantMessage("First answer") };
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

		pane.handleInput("Second question");
		pane.handleInput("\r");
		await drainBtwRequest();

		pane.setViewportHeight(14);
		pane.handleInput("Keep this input");
		pane.handleInput("\r");
		expect(ctx.showStatus).toHaveBeenCalledWith("A BTW reply is still streaming — wait for it to finish", {
			dim: true,
		});
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("Keep this input");

		running.resolve({ replyText: "Second answer", assistantMessage: createAssistantMessage("Second answer") });
		await drainBtwRequest();
		controller.dispose();
	});

	it("manages blank threads and deletes the active thread with /delete", async () => {
		const events: BtwThreadEvent[] = [];
		const model = { id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" };
		let conversationCount = 0;
		let turnCount = 0;
		const createConversation = (
			_instructions: string,
			checkpoint?: EphemeralConversationCheckpoint,
		): EphemeralConversation =>
			new EphemeralConversation({
				snapshotBaseMessages: () => [],
				sideSessionId: checkpoint?.sideSessionId ?? `side-${++conversationCount}`,
				checkpoint,
				runTurn: async messages => {
					turnCount++;
					const input = messages.at(-1);
					const text =
						input?.role === "user" && Array.isArray(input.content)
							? input.content.map(block => ("text" in block ? block.text : "")).join("")
							: "";
					return { replyText: `reply:${text}`, assistantMessage: createAssistantMessage(`reply:${text}`) };
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

		await controller.start("");
		const pane = activePane;
		if (!pane) throw new Error("Expected durable BTW pane");

		pane.handleInput("/new");
		pane.handleInput("\r");
		await drainBtwRequest();
		pane.handleInput("/new");
		pane.handleInput("\r");
		await drainBtwRequest();

		const creates = events.filter(event => event.op === "create");
		expect(creates).toHaveLength(1);
		expect(creates[0]).toMatchObject({ op: "create", title: "BTW" });
		expect(turnCount).toBe(0);

		pane.handleInput("Second question");
		pane.handleInput("\r");
		await drainBtwRequest();
		expect(turnCount).toBe(1);
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("reply:Second question");

		pane.handleInput("/new");
		pane.handleInput("\r");
		await drainBtwRequest();
		const blankCreate = events.filter(event => event.op === "create").at(-1);
		expect(blankCreate).toBeDefined();
		expect(blankCreate?.key).not.toBe(creates[0]?.key);

		pane.handleInput("\x1b");
		expect(controller.canCopy()).toBe(true);
		expect(controller.handlesCopyKey()).toBe(false);
		expect(events).toContainEqual({ version: 1, op: "remove", key: blankCreate!.key, reason: "deleted" });
		expect(events).not.toContainEqual({ version: 1, op: "remove", key: creates[0]!.key, reason: "deleted" });

		await controller.start("");
		const reopenedPane = activePane;
		if (!reopenedPane) throw new Error("Expected reopened durable BTW pane");
		reopenedPane.handleInput("\x1b");
		reopenedPane.handleInput("/delete");
		reopenedPane.handleInput("\r");
		await drainBtwRequest();
		expect(turnCount).toBe(1);
		expect(events).toContainEqual({ version: 1, op: "remove", key: creates[0]!.key, reason: "deleted" });
		controller.dispose();
	});

	it("renders the side assistant stream in the pane while a durable reply is running", async () => {
		const events: BtwThreadEvent[] = [];
		const running = Promise.withResolvers<RunEphemeralTurnResult>();
		let thinkingMessage: EphemeralTurnOptions["onMessage"];
		let runCount = 0;
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
					if (runCount === 1) {
						return { replyText: "First answer", assistantMessage: createAssistantMessage("First answer") };
					}
					thinkingMessage = options.onMessage;
					return running.promise;
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

		pane.setViewportHeight(14);
		pane.handleInput("Why does this fail?");
		pane.handleInput("\r");
		await drainBtwRequest();

		const thinking = createAssistantMessage("");
		thinking.content = [{ type: "thinking", thinking: "careful reasoning" }];
		thinkingMessage?.({ type: "update", message: thinking });
		await drainBtwRequest();
		expect(Bun.stripANSI(pane.render(100).join("\n"))).toContain("careful reasoning");

		running.resolve({ replyText: "Because.", assistantMessage: createAssistantMessage("Because.") });
		await drainBtwRequest();
		controller.dispose();
	});
});
