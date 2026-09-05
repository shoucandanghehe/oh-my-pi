import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Plan approval must not block the event controller's serialized dispatch
 * chain. `#handleToolExecutionEnd` detects a completed `xd://propose` write and
 * starts the approval flow; when that flow awaited `handlePlanApproval`
 * in-chain, the operator's review choice and the blocking synthetic execution
 * `session.prompt` parked every subsequent agent event behind it — the TUI
 * froze with zero streaming feedback for the whole approved-plan run.
 *
 * These tests drive the propose completion through the real agent pipeline and
 * assert that events emitted while the review is open render immediately.
 */

/** Complete `write` result carrying the xd://propose dispatch envelope. */
function proposeResult(planFilePath: string, title: string): unknown {
	return {
		content: [{ type: "text", text: "Plan submitted" }],
		details: {
			xdev: {
				tool: "propose",
				mode: "execute",
				inner: { planFilePath, title, planExists: true },
			},
		},
	};
}

describe("plan approval dispatch chain", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let mode: InteractiveMode;
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		sharedTempDir = TempDir.createSync("@plan-approval-chain-shared-");
		await Settings.init({ inMemory: true, cwd: sharedTempDir.path() });
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage?.close();
		sharedTempDir?.removeSync();
	});

	beforeEach(async () => {
		// Prevent ProcessTerminal.start() from talking to the real terminal; the
		// assertions read rendered output via mode.ui.render().
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@plan-approval-chain-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		tempDir?.removeSync();
		setKeybindings(KeybindingsManager.inMemory());
		resetSettingsForTest();
	});

	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 50; i++) await Promise.resolve();
	}

	it("renders agent events live while the plan review is open", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nBody.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		// Hold the review open: the approval flow is parked awaiting the choice.
		const { promise: reviewChoice, resolve: resolveReview } = Promise.withResolvers<string>();
		vi.spyOn(mode, "showPlanReview").mockReturnValue(reviewChoice);
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		// The propose completion rides the normal agent pipeline; the event
		// controller picks it up and starts the approval flow.
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "toolu_propose_live",
			toolName: "write",
			args: { path: "xd://propose", content: "plan" },
			result: proposeResult(planFilePath, "PLAN"),
			isError: false,
		} as never);
		await flushMicrotasks();

		// While the review overlay is still awaiting the operator, an unrelated
		// agent event must render immediately — the dispatch chain is not parked
		// behind the approval flow.
		session.agent.emitExternalEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "live during review" }],
				synthetic: true,
				timestamp: Date.now(),
			},
		} as never);
		await flushMicrotasks();
		expect(Bun.stripANSI(mode.ui.render(120).join("\n"))).toContain("live during review");

		// Cancel cleanly: the flow must settle without a session clear so the
		// test leaves nothing running.
		resolveReview(undefined);
		await flushMicrotasks();
	});
});
