/**
 * Subagent worker entry for the focus-view tests: the real link wiring of
 * `subagent-worker-entry` with the identity, agents and auth services, plus a
 * probe service that hands the test functions driving real `AgentSession`s
 * homed on this worker. Sessions are built over the main thread's model
 * registry (its worker mirror); a turn prompted with `[hold]` streams its
 * reply in two deltas, holding between them until the test opens the gate.
 */
import { MessagePort, parentPort } from "node:worker_threads";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
} from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { type } from "@oh-my-pi/omptype";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { authService } from "../../src/thread/services/auth";
import { identityThreadService } from "../../src/thread/services/identity";
import { EventBus } from "../../src/utils/event-bus";

/** What the worker-side session reports about itself. */
export interface FocusSessionReport {
	configuredThinkingLevel: string | undefined;
	steering: string[];
	followUp: string[];
	customEntries: Array<{ customType: string; data: unknown }>;
	userTexts: string[];
	todoPhases: TodoPhase[];
	prewarmCount: number;
}

/** Operations the test drives on the worker. */
export interface FocusProbe {
	/** Build, register, and return the key of a session homed here, over main's `registry`. */
	open(id: string, registry: ModelRegistry, settings: Record<string, unknown>): Promise<string>;
	/** Prompt the session on its home thread; resolves when the run settles. */
	prompt(id: string, text: string): Promise<void>;
	/** Release the reply held between its two deltas. */
	release(): Promise<void>;
	report(id: string): Promise<FocusSessionReport>;
	/** Drop every queued follow-up for good, as queue editing does. */
	dropFollowUps(id: string): Promise<void>;
}

/** Test-only boot globals of the probe service. */
export interface FocusProbeGlobals {
	ready(probe: FocusProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const sessions = new Map<string, AgentSession>();
const prewarmCounts = new Map<string, number>();
let gate = Promise.withResolvers<void>();

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A turn whose newest user message says `[hold]` streams "Hel", holds for the gate, then "lo"; others answer "ok". */
function heldStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const lastUser = context.messages.findLast(message => message.role === "user");
	const prompt = textOf(lastUser?.content);
	const hold = prompt.includes("[hold]");
	if (prompt.includes("[live]")) {
		const live = options?.liveSteering;
		const signal = options?.signal;
		if (!live || !signal) throw new Error("live steering was not offered");
		signal.addEventListener("abort", () => stream.fail(new Error("aborted")), { once: true });
		void live
			.wait(signal)
			.then(() => live.claim(signal))
			.catch(error => {
				if (!signal.aborted) stream.fail(error);
			});
	}
	void (async () => {
		const text: TextContent = { type: "text", text: "" };
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		if (prompt === "[tool]" && context.messages.at(-1)?.role === "user") {
			const call: ToolCall = { type: "toolCall", id: "worker-lookup", name: "probe_lookup", arguments: {} };
			partial.content.push(call);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial });
			const prefix = '{"path":"worker live prefix';
			setStreamingPartialJson(call, prefix);
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: prefix, partial });
			await gate.promise;
			const final = { ...call, arguments: { path: "worker live prefix.txt" } };
			partial.content[0] = final;
			partial.stopReason = "toolUse";
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: final, partial });
			stream.push({ type: "done", reason: "toolUse", message: partial });
			return;
		}
		partial.content.push(text);
		stream.push({ type: "text_start", contentIndex: 0, partial });
		if (hold) {
			text.text = "Hel";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Hel", partial });
			await gate.promise;
			if (options?.signal?.aborted) return;
			text.text = "Hello";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "lo", partial });
		} else {
			text.text = "ok";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial });
		}
		stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial });
		partial.duration = 10;
		stream.push({ type: "done", reason: "stop", message: partial });
	})();
	return stream;
}

function local(id: string): AgentSession {
	const session = sessions.get(id);
	if (!session) throw new Error(`no local session ${id}`);
	return session;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
	}
	return text;
}

const probe: FocusProbe = {
	open: async (id, registry, overrides) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model missing");
		const lookup: AgentTool = {
			name: "probe_lookup",
			label: "Lookup on worker",
			description: "Returns a fixture document",
			parameters: type({ path: "string" }),
			async execute(_id, _args, _signal, update) {
				update?.({ content: [{ type: "text", text: "Still reading on worker" }] });
				await gate.promise;
				return { content: [{ type: "text", text: "Worker returned the document" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Focus fixture"], tools: [lookup] },
			convertToLlm,
			streamFn: heldStream,
		});
		const sessionManager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("input", (event, ctx) => {
					if (event.source !== "interactive" || !event.text.startsWith("owner:")) return;
					const draft = event.text.slice("owner:".length);
					ctx.ui.setStatus("worker-status", draft === "clear" ? undefined : `${id} extension status`);
					ctx.ui.setWidget("worker-widget", draft === "clear" ? undefined : [`${id} extension widget`], {
						placement: "belowEditor",
					});
					return { text: `${id} handled ${draft}` };
				});
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"worker-input",
		);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(overrides),
			modelRegistry: registry,
			toolRegistry: new Map([[lookup.name, lookup]]),
			extensionRunner: new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, registry),
			agentId: id,
		});
		// Do not connect to a real provider when the mirror routes a prewarm here.
		session.prewarmModelConnection = () => {
			prewarmCounts.set(id, (prewarmCounts.get(id) ?? 0) + 1);
		};
		sessions.set(id, session);
		AgentRegistry.global().register({ id, displayName: id, kind: "sub", session, sessionFile: null, status: "idle" });
		AgentRegistry.global().syncSessionStatus(id, session);
		return session.instanceKey;
	},
	prompt: async (id, text) => {
		await local(id).prompt(text);
	},
	release: async () => {
		gate.resolve();
		gate = Promise.withResolvers<void>();
	},
	report: async id => {
		const session = local(id);
		return {
			configuredThinkingLevel: session.configuredThinkingLevel(),
			steering: [...session.getQueuedMessages().steering],
			followUp: [...session.getQueuedMessages().followUp],
			customEntries: session.sessionManager
				.getEntries()
				.flatMap(entry => (entry.type === "custom" ? [{ customType: entry.customType, data: entry.data }] : [])),
			userTexts: session.messages.flatMap(message => (message.role === "user" ? [textOf(message.content)] : [])),
			todoPhases: session.getTodoPhases(),
			prewarmCount: prewarmCounts.get(id) ?? 0,
		};
	},
	dropFollowUps: async id => {
		const session = local(id);
		session.dropQueuedMessages(session.agent.peekFollowUpQueue());
	},
};

function isProbeGlobals(value: unknown): value is FocusProbeGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probeService: ThreadService = {
	name: "focus-probe",
	boot(globals) {
		if (!isProbeGlobals(globals)) throw new Error("probe globals missing");
		globals.ready(probe);
	},
};

const services: readonly ThreadService[] = [identityThreadService, agentsThreadService, authService, probeService];

function isInit(value: unknown): value is SubagentWorkerInit {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-init" &&
		isThreadId(Reflect.get(value, "threadId")) &&
		Reflect.get(value, "replyPort") instanceof MessagePort &&
		Reflect.get(value, "counter") instanceof SharedArrayBuffer
	);
}

function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}

let frameHandler: ((frame: RpcFrame) => void) | undefined;

port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (!isInit(message)) return;
		setCurrentThreadId(message.threadId);
		const link: WorkerThreadLink = new RpcLink(
			{
				send: frame => port.postMessage(frame),
				listen: handler => {
					frameHandler = handler;
					return () => {
						frameHandler = undefined;
					};
				},
			},
			{
				name: `${message.threadId}↔main`,
				sync: { port: message.replyPort, counter: new Int32Array(message.counter) },
			},
		);
		for (const service of services) service.installWorker?.(link);
		link.handle("boot", async globals => {
			for (const service of services) await service.boot?.(globals[service.name], link);
		});
		link.handle("ping", nonce => nonce);
		const ready: SubagentWorkerReady = {
			type: "subagent-worker-ready",
		};
		port.postMessage(ready);
		return;
	}
	if (isFrame(message)) frameHandler(message);
});
