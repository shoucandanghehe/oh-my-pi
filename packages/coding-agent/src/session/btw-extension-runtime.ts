import type { Agent, AgentTool, AgentToolContext, ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { bindPreparedExtensions } from "../extensibility/extensions/loader";
import { ExtensionRunner } from "../extensibility/extensions/runner";
import type { ExtensionUIContext, PreparedExtension, ToolInfo } from "../extensibility/extensions/types";
import { ExtensionToolWrapper, RegisteredToolAdapter } from "../extensibility/extensions/wrapper";
import { applyToolProxy } from "../extensibility/tool-proxy";
import { unwrapHashlineHeaderPath } from "../tools/hashline-header-path";
import { dispatchXdevTool, resolveXdevTool, type XdevState, xdevDocs, xdevListing } from "../tools/xdev";
import type { AgentSession } from "./agent-session";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { SessionManager } from "./session-manager";

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

/** An explicit, independent extension binding and restricted tool set for a BTW conversation. */
export class BtwExtensionRuntime {
	readonly runner: ExtensionRunner;
	readonly tools: AgentTool[];
	readonly sessionManager: SessionManager;
	readonly modelRegistry: ModelRegistry;
	readonly #agent: Agent;
	session!: AgentSession;
	#disposed = false;
	readonly #onSessionClosed: ((manager: SessionManager) => void) | undefined;
	/** Whether a call to one of {@link tools} stays within BTW's read-only and send-to-main permissions. */
	readonly permits: (tool: AgentTool, args: Record<string, unknown>) => boolean;

	constructor(
		runner: ExtensionRunner,
		agent: Agent,
		tools: AgentTool[],
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
		permits: (tool: AgentTool, args: Record<string, unknown>) => boolean,
		onSessionClosed?: (manager: SessionManager) => void,
	) {
		this.runner = runner;
		this.tools = tools;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.#agent = agent;
		this.permits = permits;
		this.#onSessionClosed = onSessionClosed;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.session?.dispose({
			pausedExit: this.session.hasPausedAgents(),
			onSessionClosed: this.#onSessionClosed,
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
		sendToMainSessionTool?: AgentTool;
		approveSummary?: (summary: string, signal?: AbortSignal) => Promise<boolean>;
		approvalUI?: ExtensionUIContext;
		sessionManager: SessionManager;
		createSession: (runtime: BtwExtensionRuntime) => AgentSession;
		onSessionClosed?: (manager: SessionManager) => void;
	}): Promise<BtwExtensionRuntime> {
		const { agent, modelRegistry, settings } = options;
		const bound = await bindPreparedExtensions(options.preparedExtensions, options.cwd);
		const sessionManager = options.sessionManager;
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
			resolve: name => resolveXdevTool(xdev, name),
		};
		const tools: AgentTool[] = [];
		for (const mainTool of options.availableTools) {
			if (!Object.hasOwn(SIDE_NATIVE_TOOLS, mainTool.name) || !safeNames.has(mainTool.name)) continue;
			if (!directNames.has(mainTool.name) && !mountedNames.has(mainTool.name)) continue;
			// Main's wrapper must never execute in BTW, even for xd:// devices.
			const native = mainTool instanceof ExtensionToolWrapper ? mainTool.unwrap() : mainTool;
			if (native instanceof RegisteredToolAdapter || native instanceof ExtensionToolWrapper) continue;
			const guarded = {
				execute: async (...args: Parameters<AgentTool["execute"]>) => {
					if (!options.isReadOnlyToolCall(native, args[1] as Record<string, unknown>)) {
						throw new Error("Tool call is not permitted in a read-only BTW conversation");
					}
					const input = args[1];
					const path = input && typeof input === "object" && "path" in input ? input.path : undefined;
					const device =
						native.name === "read" && typeof path === "string"
							? parseXdUrl(unwrapHashlineHeaderPath(path))
							: null;
					if (device) {
						const text = device.name === null ? xdevListing(xdev) : xdevDocs(xdev, device.name);
						return { content: [{ type: "text", text }] };
					}
					return native.execute(...args);
				},
			} satisfies Pick<AgentTool, "execute">;
			applyToolProxy(native, guarded);
			const sideTool = new ExtensionToolWrapper(guarded as AgentTool, runner);
			xdev.tools.set(sideTool.name, sideTool);
			xdev.builtInNames.add(sideTool.name);
			if (mountedNames.has(sideTool.name)) xdev.mountedNames.add(sideTool.name);
			if (directNames.has(sideTool.name)) tools.push(sideTool);
		}
		const sendToMainSession = options.sendToMainSessionTool
			? new ExtensionToolWrapper(
					options.sendToMainSessionTool instanceof ExtensionToolWrapper
						? options.sendToMainSessionTool.unwrap()
						: options.sendToMainSessionTool,
					runner,
				)
			: undefined;
		if (sendToMainSession) {
			xdev.tools.set(sendToMainSession.name, sendToMainSession);
			xdev.builtInNames.add(sendToMainSession.name);
			xdev.mountedNames.add(sendToMainSession.name);
		}
		let deviceWriteTool: AgentTool | undefined;
		const mainWrite = options.mainTools.find(tool => tool.name === "write");
		if (mainWrite && safeNames.has("write") && xdev.mountedNames.size > 0) {
			const native = mainWrite instanceof ExtensionToolWrapper ? mainWrite.unwrap() : mainWrite;
			if (!(native instanceof RegisteredToolAdapter) && !(native instanceof ExtensionToolWrapper)) {
				// Main's write declaration stays untouched; only the execution is device-only.
				const deviceWrite = {
					name: native.name,
					label: native.label,
					description: native.description,
					parameters: native.parameters,
					session: { xdev },
					// The send device runs its own mandatory approval inside the dispatch.
					approval: (args: unknown) => (resolvePermittedDevice(args) ? ("read" as const) : ("exec" as const)),
					execute: async (...args: Parameters<AgentTool["execute"]>) => {
						const resolved = resolvePermittedDevice(args[1]);
						if (!resolved) throw new Error("Only read-only xd:// devices are available in BTW");
						const sendsToMain = resolved.target === sendToMainSession;
						if (sendsToMain && !runner.hasUI()) {
							throw new Error(`${resolved.name} requires interactive user approval.`);
						}
						const context = args[4];
						const { result, xdev: dispatch } = await dispatchXdevTool(
							xdev,
							resolved.name,
							resolved.content,
							args[0],
							args[2],
							args[3],
							context && !sendsToMain ? { ...context, xdevPolicyKey: native.name } : context,
						);
						return { ...result, details: { xdev: dispatch } };
					},
				};
				applyToolProxy(native, deviceWrite);
				deviceWriteTool = new ExtensionToolWrapper(deviceWrite, runner);
				tools.push(deviceWriteTool);
			}
		}
		function resolvePermittedDevice(
			input: unknown,
		): { name: string; content: string; target: AgentTool } | undefined {
			if (!input || typeof input !== "object" || !("path" in input) || !("content" in input)) return undefined;
			if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
			const name = parseXdUrl(unwrapHashlineHeaderPath(input.path))?.name;
			if (!name) return undefined;
			const target = xdev.tools.get(name);
			if (!target) return undefined;
			if (target === sendToMainSession) return { name, content: input.content, target };
			let decoded: unknown;
			try {
				decoded = JSON.parse(input.content);
			} catch {
				return undefined;
			}
			if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
			return options.isReadOnlyToolCall(target, decoded as Record<string, unknown>)
				? { name, content: input.content, target }
				: undefined;
		}
		const permits = (tool: AgentTool, args: Record<string, unknown>): boolean =>
			tool === deviceWriteTool ? resolvePermittedDevice(args) !== undefined : options.isReadOnlyToolCall(tool, args);
		const side = new BtwExtensionRuntime(
			runner,
			agent,
			tools,
			sessionManager,
			queryRegistry,
			permits,
			options.onSessionClosed,
		);
		const session = options.createSession(side);
		side.session = session;
		const ui = options.approvalUI;
		const sideUI =
			sendToMainSession && (ui || options.approveSummary)
				? (Object.create(runner.getUIContext()) as ExtensionUIContext)
				: undefined;
		if (sideUI) {
			sideUI.select = async (title, choices, dialogOptions) => {
				const approval = dialogOptions?.toolApproval;
				if (
					!approval ||
					approval.toolName !== sendToMainSession?.name ||
					choices.length !== 2 ||
					choices[0] !== "Approve" ||
					choices[1] !== "Deny"
				)
					return undefined;
				if (options.approveSummary) {
					const args = approval.args as { summary: string };
					return (await options.approveSummary(args.summary, dialogOptions?.signal)) ? "Approve" : "Deny";
				}
				return ui?.select(title, choices, dialogOptions);
			};
		}
		runner.initialize(
			{
				sendMessage: (message, sendOptions) => {
					void session.sendCustomMessage(message, sendOptions).catch(error => {
						logger.warn("BTW extension send failed", { error: String(error) });
					});
				},
				sendUserMessage: (content, sendOptions) => session.sendUserMessage(content, sendOptions),
				appendEntry: (customType, data) => {
					sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => session.getEnabledToolNames(),
				getAllTools: () => options.toolInfos.filter(info => tools.some(tool => tool.name === info.name)),
				setActiveTools: names =>
					session.setActiveToolsByName(names.filter(name => tools.some(tool => tool.name === name))),
				getCommands: () => getSessionSlashCommands(session),
				setModel: model => runExtensionSetModel(session, model),
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
				getSessionName: () => sessionManager.getSessionName(),
				setSessionName: async name => {
					await sessionManager.setSessionName(name, "user");
				},
			},
			{
				getModel: () => isolateModel(agent.state.model),
				isIdle: () => !agent.state.isStreaming,
				abort: () => agent.abort(),
				hasPendingMessages: () => session.queuedMessageCount > 0,
				shutdown: () => unsupported("shutdown"),
				getContextUsage: () => session.getContextUsage(),
				compact: instructions => runExtensionCompact(session, instructions),
				getSystemPrompt: () => [...agent.state.systemPrompt],
			},
			{
				getContextUsage: () => session.getContextUsage(),
				waitForIdle: () => agent.waitForIdle(),
				newSession: async () => unsupported("newSession"),
				branch: async entryId => ({ cancelled: (await session.branch(entryId)).cancelled }),
				navigateTree: async (entryId, navOptions) => ({
					cancelled: (await session.navigateTree(entryId, { summarize: navOptions?.summarize })).cancelled,
				}),
				switchSession: async () => unsupported("switchSession"),
				reload: async () => session.reload(),
				compact: instructions => runExtensionCompact(session, instructions),
			},
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
			hasQueuedMessages: () => this.session.queuedMessageCount > 0,
			abort: () => agent.abort(),
			settings: this.runner.sessionSettings,
			ui: this.runner.getUIContext(),
			hasUI: this.runner.hasUI(),
			toolNames: this.tools.map(tool => tool.name),
			toolCall,
			toolApprovalPreview: "never",
		};
	}
}
