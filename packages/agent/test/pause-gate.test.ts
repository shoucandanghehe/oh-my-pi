import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop, agentPauseGate, PAUSE_SHUTDOWN_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeEchoTool(executed: string[]): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			executed.push(params.msg);
			return { content: [{ type: "text", text: params.msg }] };
		},
	};
	return echoTool as AgentTool;
}

async function waitForGateState(activeLoops: number, modelWaiters: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (
		(agentPauseGate.activeLoopCount !== activeLoops || agentPauseGate.modelWaiterCount !== modelWaiters) &&
		Date.now() < deadline
	) {
		await Bun.sleep(5);
	}
	if (agentPauseGate.activeLoopCount !== activeLoops || agentPauseGate.modelWaiterCount !== modelWaiters) {
		throw new Error(
			`Pause gate did not reach active=${activeLoops}, waiters=${modelWaiters}; ` +
				`got active=${agentPauseGate.activeLoopCount}, waiters=${agentPauseGate.modelWaiterCount}`,
		);
	}
}

describe("agentPauseGate", () => {
	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	it("holds the next model call while paused and releases it on resume", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal, loopId?: symbol) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal, loopId);
		};
		expect(agentPauseGate.pause()).toBe(true);
		expect(agentPauseGate.pause()).toBe(false); // already engaged

		const result = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream).result();
		await parked.promise;
		expect(mock.calls.length).toBe(0); // parked before the first provider call

		try {
			expect(agentPauseGate.activeLoopCount).toBe(1);
			expect(agentPauseGate.modelWaiterCount).toBe(1);
			expect(agentPauseGate.ready).toBe(true);
			expect(agentPauseGate.resume()).toBeGreaterThanOrEqual(0);
			const messages = await result;
			expect(mock.calls.length).toBe(1);
			expect(messages[messages.length - 1].role).toBe("assistant");
			// Loop unregisters when the run settles; give the finally a tick.
			const settleDeadline = Date.now() + 500;
			while (agentPauseGate.activeLoopCount !== 0 && Date.now() < settleDeadline) {
				await Bun.sleep(5);
			}
			expect(agentPauseGate.activeLoopCount).toBe(0);
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("rechecks the gate after async model preparation before starting the provider", async () => {
		const syncEntered = Promise.withResolvers<void>();
		const releaseSync = Promise.withResolvers<void>();
		const providerStarted = Promise.withResolvers<void>();
		const waiterReached = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			syncContextBeforeModelCall: async () => {
				syncEntered.resolve();
				await releaseSync.promise;
			},
		};
		const stream: StreamFn = (...args) => {
			providerStarted.resolve();
			return mock.stream(...args);
		};
		const unsubscribe = agentPauseGate.onWaitersChange(() => {
			if (agentPauseGate.activeLoopCount === 1 && agentPauseGate.modelWaiterCount === 1) {
				waiterReached.resolve();
			}
		});
		const result = agentLoop([createUserMessage("hi")], context, config, undefined, stream).result();

		await syncEntered.promise;
		agentPauseGate.pause();
		releaseSync.resolve();
		const boundary = await Promise.race([
			providerStarted.promise.then(() => "provider" as const),
			waiterReached.promise.then(() => "paused" as const),
		]);
		try {
			expect(boundary).toBe("paused");
			expect(mock.calls.length).toBe(0);
		} finally {
			unsubscribe();
			agentPauseGate.resume();
			await result;
		}
		expect(mock.calls.length).toBe(1);
	});

	it("lets in-flight tools finish and parks only before the next model call", async () => {
		const executed: string[] = [];
		// Signal exactly when the loop parks on the gate. A test-local manual
		// patch (not vi.spyOn) so a sibling file's restoreAllMocks cannot remove
		// it, and a gate regression that never parks hangs this await (test
		// timeout) instead of racing past a vacuous assertion.
		const toolBoundary = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal, loopId?: symbol) => {
			toolBoundary.resolve();
			return originalWait.call(agentPauseGate, signal, loopId);
		};
		const mock = createMockModel({
			responses: [
				() => {
					// Engage the gate while the model response is being produced: the
					// tool batch must still run, then the follow-up model call parks.
					agentPauseGate.pause();
					return { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "frozen" } }] };
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [makeEchoTool(executed)] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		try {
			const result = agentLoop([createUserMessage("run echo")], context, config, undefined, mock.stream).result();
			await toolBoundary.promise;
			expect(executed).toEqual(["frozen"]); // tools always finish
			expect(mock.calls.length).toBe(1); // next model call parked

			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["frozen"]);
			expect(mock.calls.length).toBe(2);
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("lets an external abort unwind a parked run without releasing the gate", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const abortController = new AbortController();

		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal, loopId?: symbol) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal, loopId);
		};
		agentPauseGate.pause();
		const result = agentLoop(
			[createUserMessage("hi")],
			context,
			config,
			abortController.signal,
			mock.stream,
		).result();
		await parked.promise;
		abortController.abort("user interrupt");

		// The run must terminate as aborted promptly (not stay parked until
		// resume). The provider request itself carries the aborted signal, so
		// whether the transport is entered at all is an implementation detail.
		try {
			const messages = await result;
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");
			if (last.role === "assistant") {
				expect(last.stopReason).toBe("aborted");
			}
			expect(agentPauseGate.paused).toBe(true); // aborting one run never resumes the process
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("ends a parked run without an aborted assistant turn on pause-shutdown abort", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const abortController = new AbortController();

		agentPauseGate.pause();
		const result = agentLoop(
			[createUserMessage("hi")],
			context,
			config,
			abortController.signal,
			mock.stream,
		).result();
		await waitForGateState(1, 1);
		expect(agentPauseGate.ready).toBe(true);
		abortController.abort(PAUSE_SHUTDOWN_ABORT_REASON);

		const messages = await result;
		// Only the user prompt is new — no synthesized aborted assistant turn.
		expect(messages.some(m => m.role === "assistant")).toBe(false);
		expect(mock.calls.length).toBe(0);
		expect(agentPauseGate.paused).toBe(true);
	});

	it("re-parks a waiter when the gate is re-engaged in the same tick as resume", async () => {
		agentPauseGate.pause();
		let released = false;
		const waiter = agentPauseGate.waitUntilResumed().then(() => {
			released = true;
		});

		agentPauseGate.resume();
		agentPauseGate.pause(); // re-engage before the waiter's microtask runs
		await Promise.resolve();
		expect(released).toBe(false);

		agentPauseGate.resume();
		await waiter;
		expect(released).toBe(true);
	});

	it("reports pause state transitions to onChange subscribers", () => {
		const transitions: boolean[] = [];
		const unsubscribe = agentPauseGate.onChange(paused => transitions.push(paused));
		agentPauseGate.pause();
		agentPauseGate.resume();
		unsubscribe();
		agentPauseGate.pause();
		agentPauseGate.resume();
		expect(transitions).toEqual([true, false]);
	});

	it("tracks waiter membership for barrier readiness", async () => {
		const loopId = agentPauseGate.registerLoop();
		expect(agentPauseGate.activeLoopCount).toBe(1);
		expect(agentPauseGate.ready).toBe(false); // gate not engaged

		agentPauseGate.pause();
		expect(agentPauseGate.ready).toBe(false); // loop not parked yet

		const waiter = agentPauseGate.waitUntilResumed(undefined, loopId);
		await Bun.sleep(1);
		expect(agentPauseGate.modelWaiterCount).toBe(1);
		expect(agentPauseGate.ready).toBe(true);

		agentPauseGate.resume();
		await waiter;
		agentPauseGate.unregisterLoop(loopId);
		expect(agentPauseGate.activeLoopCount).toBe(0);
	});
});
