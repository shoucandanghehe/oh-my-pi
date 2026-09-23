import type { Agent, AgentEvent, AgentTool, AgentToolContext, ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { bindPreparedExtensions } from "../extensibility/extensions/loader";
import { ExtensionRunner, emitSessionShutdownEvent } from "../extensibility/extensions/runner";
import type { ExtensionUIContext, PreparedExtension, ToolInfo } from "../extensibility/extensions/types";
import { ExtensionToolWrapper, RegisteredToolAdapter } from "../extensibility/extensions/wrapper";
import writeDeviceOnlyDescription from "../prompts/tools/write-device-only.md" with { type: "text" };
import { unwrapHashlineHeaderPath } from "../tools/plan-mode-guard";
import { dispatchXdevTool, type XdevState, xdevDocs, xdevListing } from "../tools/xdev";
import { SessionManager } from "./session-manager";

const SIDE_NATIVE_TOOLS: Record<string, true> = {
	read: true,
	glob: true,
	grep: true,
	ast_grep: true,
	web_search: true,
	recall: true,
	reflect: true,
	lsp: true,
	github: true,
};

function unsupported(action: string): never {
	throw new Error(`BTW extension host does not support ${action}`);
}
/** Detach model metadata exposed to extensions from Main's mutable registry objects. */
function isolateModel(model: Model): Model {
	const detached: Record<PropertyKey, unknown> = {};
	for (const key of Reflect.ownKeys(model)) {
		const descriptor = Object.getOwnPropertyDescriptor(model, key);
		if (!descriptor?.enumerable) continue;
		const value: unknown = Reflect.get(model, key);
		detached[key] = typeof value === "function" ? value : structuredClone(value);
	}
	return detached as unknown as Model;
}

/** An explicit, independent extension binding for a durable side conversation. */
export class BtwExtensionRuntime {
	readonly runner: ExtensionRunner;
	readonly tools: AgentTool[];
	readonly sessionManager: SessionManager;
	readonly modelRegistry: ModelRegistry;
	readonly #agent: Agent;
	readonly #unsubscribe: () => void;
	#eventTail = Promise.resolve();
	#turnIndex = 0;
	#disposed = false;

	constructor(
		runner: ExtensionRunner,
		agent: Agent,
		tools: AgentTool[],
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		this.runner = runner;
		this.tools = tools;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.#agent = agent;
		this.#unsubscribe = agent.subscribe(event => {
			this.#eventTail = this.#eventTail
				.then(() => this.#emitAgentEvent(event))
				.catch(error => {
					logger.warn("BTW extension event failed", { event: event.type, error: String(error) });
				});
		});
	}

	static async create(options: {
		agent: Agent;
		mainTools: readonly AgentTool[];
		availableTools: readonly AgentTool[];
		mountedNames: readonly string[];
		preparedExtensions: readonly PreparedExtension[];
		modelRegistry: ModelRegistry;
		settings: Settings;
		cwd: string;
		toolInfos: readonly ToolInfo[];
		isReadOnlyToolCall: (tool: AgentTool, args: Record<string, unknown>) => boolean;
		shareSummaryTool?: AgentTool;
		approvalUI?: ExtensionUIContext;
	}): Promise<BtwExtensionRuntime> {
		const { agent, modelRegistry, settings } = options;
		const bound = await bindPreparedExtensions(options.preparedExtensions, options.cwd);
		const sessionManager = SessionManager.inMemory(options.cwd);
		// The context's legacy modelRegistry surface is deliberately limited; registration,
		// credential mutation, and provider configuration belong to Main, not BTW.
		const queryRegistry = new Proxy(modelRegistry, {
			get(target, key) {
				if (key === "getAvailable") return () => target.getAvailable().map(isolateModel);
				throw new Error(`BTW extension host does not expose modelRegistry.${String(key)}`);
			},
		});
		const runner = new ExtensionRunner(
			bound.extensions,
			bound.runtime,
			options.cwd,
			sessionManager,
			queryRegistry,
			undefined,
			settings,
		);
		const safeNames = new Set(
			options.toolInfos.filter(info => info.sourceInfo.source === "builtin").map(info => info.name),
		);
		const directNames = new Set(options.mainTools.map(tool => tool.name));
		const mountedNames = new Set(options.mountedNames);
		const xdev: XdevState = {
			tools: new Map(),
			mountedNames: new Set(),
			builtInNames: new Set(),
			isActive: name => directNames.has(name) && xdev.tools.has(name),
		};
		const tools: AgentTool[] = [];
		for (const mainTool of options.availableTools) {
			if (!Object.hasOwn(SIDE_NATIVE_TOOLS, mainTool.name) || !safeNames.has(mainTool.name)) continue;
			if (!directNames.has(mainTool.name) && !mountedNames.has(mainTool.name)) continue;
			// Main's wrapper must never execute in BTW, even for xd:// devices.
			const native = mainTool instanceof ExtensionToolWrapper ? mainTool.unwrap() : mainTool;
			if (native instanceof RegisteredToolAdapter || native instanceof ExtensionToolWrapper) continue;
			const guarded = new Proxy(native, {
				get(target, key, receiver) {
					if (key !== "execute") return Reflect.get(target, key, receiver);
					return async (...args: Parameters<AgentTool["execute"]>) => {
						if (!options.isReadOnlyToolCall(target, args[1] as Record<string, unknown>)) {
							throw new Error("Tool call is not permitted in a read-only BTW conversation");
						}
						const input = args[1];
						const path = input && typeof input === "object" && "path" in input ? input.path : undefined;
						const device =
							target.name === "read" && typeof path === "string"
								? parseXdUrl(unwrapHashlineHeaderPath(path))
								: null;
						if (device) {
							const text = device.name === null ? xdevListing(xdev) : xdevDocs(xdev, device.name);
							return { content: [{ type: "text", text }] };
						}
						return target.execute(...args);
					};
				},
			});
			const sideTool = new ExtensionToolWrapper(guarded, runner);
			xdev.tools.set(sideTool.name, sideTool);
			xdev.builtInNames.add(sideTool.name);
			if (mountedNames.has(sideTool.name)) xdev.mountedNames.add(sideTool.name);
			if (directNames.has(sideTool.name)) tools.push(sideTool);
		}
		const mainWrite = options.mainTools.find(tool => tool.name === "write");
		if (mainWrite && safeNames.has("write") && xdev.mountedNames.size > 0) {
			const native = mainWrite instanceof ExtensionToolWrapper ? mainWrite.unwrap() : mainWrite;
			if (!(native instanceof RegisteredToolAdapter) && !(native instanceof ExtensionToolWrapper)) {
				const deviceWrite = new Proxy(native, {
					get(target, key, receiver) {
						if (key === "description") return writeDeviceOnlyDescription;
						if (key === "approval")
							return (args: unknown) => {
								const resolved = resolveReadOnlyDevice(args);
								return resolved ? ("read" as const) : ("exec" as const);
							};
						if (key !== "execute") return Reflect.get(target, key, receiver);
						return async (...args: Parameters<AgentTool["execute"]>) => {
							const input = args[1];
							const resolved = resolveReadOnlyDevice(input);
							if (!resolved) throw new Error("Only read-only xd:// devices are available in BTW");
							const { result, xdev: dispatch } = await dispatchXdevTool(
								xdev,
								resolved.name,
								resolved.content,
								args[0],
								args[2],
								args[3],
								args[4] ? { ...args[4], xdevApproved: true } : undefined,
							);
							return { ...result, details: { xdev: dispatch } };
						};
					},
				});
				tools.push(new ExtensionToolWrapper(deviceWrite, runner));
			}
		}
		function resolveReadOnlyDevice(input: unknown): { name: string; content: string } | undefined {
			if (!input || typeof input !== "object" || !("path" in input) || !("content" in input)) return undefined;
			if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
			const name = parseXdUrl(unwrapHashlineHeaderPath(input.path))?.name;
			if (!name) return undefined;
			const target = xdev.tools.get(name);
			if (!target) return undefined;
			let decoded: unknown;
			try {
				decoded = JSON.parse(input.content);
			} catch {
				return undefined;
			}
			if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
			return options.isReadOnlyToolCall(target, decoded as Record<string, unknown>)
				? { name, content: input.content }
				: undefined;
		}
		if (options.shareSummaryTool) {
			const native =
				options.shareSummaryTool instanceof ExtensionToolWrapper
					? options.shareSummaryTool.unwrap()
					: options.shareSummaryTool;
			tools.push(new ExtensionToolWrapper(native, runner));
		}
		const side = new BtwExtensionRuntime(runner, agent, tools, sessionManager, queryRegistry);
		const ui = options.approvalUI;
		const sideUI =
			ui && options.shareSummaryTool ? (Object.create(runner.getUIContext()) as ExtensionUIContext) : undefined;
		if (sideUI && ui) {
			sideUI.select = (title, choices, dialogOptions) =>
				title.includes("shareSummaryWithMain") &&
				choices.length === 2 &&
				choices[0] === "Approve" &&
				choices[1] === "Deny"
					? ui.select(title, choices, dialogOptions)
					: Promise.resolve(undefined);
		}
		runner.initialize(
			{
				sendMessage: () => unsupported("sendMessage"),
				sendUserMessage: () => unsupported("sendUserMessage"),
				appendEntry: () => unsupported("appendEntry"),
				setLabel: () => unsupported("setLabel"),
				getActiveTools: () => tools.map(tool => tool.name),
				getAllTools: () => options.toolInfos.filter(info => tools.some(tool => tool.name === info.name)),
				setActiveTools: async () => unsupported("setActiveTools"),
				getCommands: () => [],
				setModel: async () => unsupported("setModel"),
				getThinkingLevel: () => agent.state.thinkingLevel,
				setThinkingLevel: () => unsupported("setThinkingLevel"),
				getSessionName: () => undefined,
				setSessionName: async () => unsupported("setSessionName"),
			},
			{
				getModel: () => isolateModel(agent.state.model),
				isIdle: () => !agent.state.isStreaming,
				abort: () => agent.abort(),
				hasPendingMessages: () => false,
				shutdown: () => unsupported("shutdown"),
				getContextUsage: () => undefined,
				compact: async () => unsupported("compact"),
				getSystemPrompt: () => [...agent.state.systemPrompt],
			},
			undefined,
			sideUI,
			"tui",
			{ installFileFallbacks: false, registerProviders: false },
		);
		try {
			await runner.emit({ type: "session_start" });
		} catch (error) {
			await side.dispose();
			throw error;
		}
		return side;
	}

	/** Never forward a Main-owned execution context into side tools. */
	createToolContext(toolCall?: ToolCallContext): AgentToolContext {
		const agent = this.#agent;
		return {
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			model: isolateModel(agent.state.model),
			isIdle: () => !agent.state.isStreaming,
			hasQueuedMessages: () => false,
			abort: () => agent.abort(),
			settings: this.runner.sessionSettings,
			ui: this.runner.getUIContext(),
			hasUI: this.runner.hasUI(),
			toolNames: this.tools.map(tool => tool.name),
			toolCall,
			toolApprovalPreview: "never",
		};
	}

	async settleEvents(): Promise<void> {
		await this.#eventTail;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		await this.#eventTail;
		try {
			await emitSessionShutdownEvent(this.runner);
		} catch (error) {
			logger.warn("BTW extension shutdown failed", { error: String(error) });
		}
	}

	async #emitAgentEvent(event: AgentEvent): Promise<void> {
		const runner = this.runner;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await runner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await runner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			await runner.emit({ type: "turn_start", turnIndex: this.#turnIndex, timestamp: Date.now() });
		} else if (event.type === "turn_end") {
			await runner.emit({
				type: "turn_end",
				turnIndex: this.#turnIndex++,
				message: event.message,
				toolResults: event.toolResults,
			});
		} else if (event.type === "message_start") {
			await runner.emit({ type: "message_start", message: event.message });
		} else if (event.type === "message_update") {
			await runner.emit({
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			});
		} else if (event.type === "message_end") {
			let message: typeof event.message;
			try {
				message = structuredClone(event.message);
			} catch {
				// Third-party metadata may not be cloneable; keep notification-only
				// observers detached from the agent's mutable transcript.
				message = JSON.parse(JSON.stringify(event.message)) as typeof event.message;
			}
			await runner.emit({ type: "message_end", message });
		} else if (event.type === "tool_execution_start") {
			await runner.emit({
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			});
		} else if (event.type === "tool_execution_update") {
			await runner.emit({
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			});
		} else if (event.type === "tool_execution_end") {
			await runner.emit({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			});
		}
	}
}
