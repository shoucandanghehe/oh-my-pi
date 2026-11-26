import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, agentLoop, agentPauseGate, PAUSE_SHUTDOWN_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
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
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

function makeConcurrentEchoTool(
	executed: string[],
	beforeExecute: (message: string) => void | Promise<void>,
): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		concurrency: "shared",
		async execute(_toolCallId, params) {
			await beforeExecute(params.msg);
			executed.push(params.msg);
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

const echoCall = (msg: string) => ({ type: "toolCall" as const, name: "echo", arguments: { msg } });
type LoopOptions = Omit<Partial<AgentLoopConfig>, "model" | "convertToLlm">;

function runLoop(mock: MockModel, tools: AgentTool[] = [], options: LoopOptions = {}, signal?: AbortSignal) {
	return agentLoop(
		[createUserMessage("hi")],
		{ systemPrompt: ["Test"], messages: [], tools },
		{ model: mock.model, convertToLlm: identityConverter, ...options },
		signal,
		mock.stream,
	).result();
}

function observeGateWait() {
	const parked = Promise.withResolvers<void>();
	const restore = agentPauseGate.onWaitersChange(() => {
		if (agentPauseGate.ready && agentPauseGate.modelWaiterCount > 0) parked.resolve();
	});
	return { parked: parked.promise, restore };
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

		const gate = observeGateWait();
		expect(agentPauseGate.pause()).toBe(true);
		expect(agentPauseGate.pause()).toBe(false); // already engaged

		const result = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream).result();
		await gate.parked;
		expect(mock.calls.length).toBe(0); // parked before the first provider call

		try {
			expect(agentPauseGate.ready).toBe(true);
			expect(agentPauseGate.resume()).toBeGreaterThanOrEqual(0);
			const messages = await result;
			expect(mock.calls.length).toBe(1);
			expect(messages[messages.length - 1].role).toBe("assistant");
		} finally {
			gate.restore();
		}
	});

	it("ends a durable pause without an aborted assistant turn", async () => {
		const gate = observeGateWait();
		const controller = new AbortController();
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		try {
			agentPauseGate.pause();
			const result = runLoop(mock, [], {}, controller.signal);
			await gate.parked;
			expect(agentPauseGate.ready).toBe(true);
			controller.abort(PAUSE_SHUTDOWN_ABORT_REASON);
			expect((await result).some(message => message.role === "assistant")).toBe(false);
			expect(mock.calls).toHaveLength(0);
			expect(agentPauseGate.paused).toBe(true);
		} finally {
			gate.restore();
		}
	});

	it("lets an external abort unwind a parked run without releasing the gate", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const abortController = new AbortController();

		const gate = observeGateWait();
		agentPauseGate.pause();
		const result = agentLoop(
			[createUserMessage("hi")],
			context,
			config,
			abortController.signal,
			mock.stream,
		).result();
		await gate.parked;
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
			gate.restore();
		}
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

	it("finishes a tool returned by an in-flight response before acknowledging pause", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>(),
			resumed = Promise.withResolvers<void>();
		const transitions: boolean[] = [],
			executed: string[] = [];
		const mock = createMockModel({
			responses: [
				async () => {
					started.resolve();
					await release.promise;
					return { content: [echoCall("once")] };
				},
				{ content: ["done"] },
			],
		});
		const result = runLoop(mock, [makeEchoTool(executed)], {
			onPauseChange: value => {
				transitions.push(value);
				if (value) paused.resolve();
				else if (transitions.includes(true)) resumed.resolve();
			},
		});
		let finished = false;
		void result.then(() => {
			finished = true;
		});
		await started.promise;
		agentPauseGate.pause();
		release.resolve();
		await paused.promise;
		expect(executed).toEqual(["once"]);
		expect(mock.calls).toHaveLength(1);
		expect(finished).toBe(false);
		agentPauseGate.resume();
		await result;
		await resumed.promise;
		expect(executed).toEqual(["once"]);
		expect(transitions).toContain(true);
		expect(transitions.at(-1)).toBe(false);
	});

	it("does not acknowledge the barrier until all committed tool results finish", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>();
		const transitions: boolean[] = [],
			executed: string[] = [];
		const mock = createMockModel({
			responses: [{ content: [echoCall("first"), echoCall("second")] }, { content: ["done"] }],
		});
		try {
			const result = runLoop(
				mock,
				[
					makeConcurrentEchoTool(executed, async msg => {
						if (msg === "first") {
							agentPauseGate.pause();
							started.resolve();
							await release.promise;
						}
					}),
				],
				{
					onPauseChange: value => {
						transitions.push(value);
						if (value) paused.resolve();
					},
				},
			);
			await started.promise;
			expect(agentPauseGate.ready).toBe(false);
			expect(transitions).not.toContain(true);
			release.resolve();
			await paused.promise;
			expect(transitions).toContain(true);
			expect(executed.toSorted()).toEqual(["first", "second"]);
			agentPauseGate.resume();
			await result;
			expect(executed).toHaveLength(2);
			expect(mock.calls).toHaveLength(2);
		} finally {
			release.resolve();
		}
	});

	it("rechecks the barrier after async credential preparation before the provider starts", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const gate = observeGateWait();
		const provider = Promise.withResolvers<"provider">();
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const stream: StreamFn = (...args) => {
			provider.resolve("provider");
			return mock.stream(...args);
		};
		const result = agentLoop(
			[createUserMessage("hold")],
			{ systemPrompt: ["Test"], messages: [], tools: [] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				getApiKey: async () => {
					entered.resolve();
					await release.promise;
					return undefined;
				},
			},
			undefined,
			stream,
		).result();
		try {
			await entered.promise;
			agentPauseGate.pause();
			release.resolve();
			const boundary = await Promise.race([gate.parked.then(() => "paused"), provider.promise]);
			expect(boundary).toBe("paused");
			expect(mock.calls).toHaveLength(0);
		} finally {
			release.resolve();
			agentPauseGate.resume();
			gate.restore();
			await result;
		}
		expect(mock.calls).toHaveLength(1);
	});

	it("clears Agent pause acknowledgement on re-pause and abort", async () => {
		const gateWait = observeGateWait();
		try {
			const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
			const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
			agentPauseGate.pause();
			const prompt = agent.prompt("hi");
			await gateWait.parked;
			expect(agent.isPaused).toBe(true);
			expect(agent.state.isStreaming).toBe(true);
			agentPauseGate.resume();
			expect(agent.isPaused).toBe(false);
			agentPauseGate.pause();
			expect(agent.isPaused).toBe(true);
			await Promise.resolve();
			expect(agent.isPaused).toBe(true);
			agent.abort();
			expect(agent.isPaused).toBe(false);
			await prompt;
			expect(agent.state.isStreaming).toBe(false);
		} finally {
			gateWait.restore();
		}
	});

	it("keeps a parked prompt running when a pause listener throws", async () => {
		const gateWait = observeGateWait();
		try {
			const mock = createMockModel({ responses: [{ content: ["done"] }] });
			const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
			const transitions: boolean[] = [];
			agent.onPauseChange(paused => {
				transitions.push(paused);
				throw new Error("observer failed");
			});
			agentPauseGate.pause();
			const prompt = agent.prompt("hi");
			await gateWait.parked;
			expect(agent.isPaused).toBe(true);
			agentPauseGate.resume();
			await prompt;
			expect(transitions).toEqual([true, false]);
			expect(agent.state.error).toBeUndefined();
			expect(mock.calls).toHaveLength(1);
		} finally {
			gateWait.restore();
		}
	});
});
