import type { Agent, AgentTool, AgentToolContext, ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { type } from "@oh-my-pi/omptype";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { bindPreparedExtensions } from "../extensibility/extensions/loader";
import { ExtensionRunner } from "../extensibility/extensions/runner";
import type { ExtensionUIContext, PreparedExtension, ToolInfo } from "../extensibility/extensions/types";
import { ExtensionToolWrapper, RegisteredToolAdapter } from "../extensibility/extensions/wrapper";
import { applyToolProxy } from "../extensibility/tool-proxy";
import type { AgentSession } from "./agent-session";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { SessionManager } from "./session-manager";

import sendToMainSessionDescription from "../prompts/tools/send-to-main-session.md" with { type: "text" };
import { isBtwInvestigationTool, isBtwReadOnlyToolCall } from "./session-tools";

const sendToMainSessionParameters = type({ summary: "string > 0" });

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

	get statuses(): ReadonlyMap<string, string> {
		return this.runner.getPresentation().statuses;
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
		availableTools: readonly AgentTool[];
		preparedExtensions: readonly PreparedExtension[];
		modelRegistry: ModelRegistry;
		settings: Settings;
		cwd: string;
		toolInfos: readonly ToolInfo[];
		sendToMainSession?: (summary: string) => void | Promise<void>;
		approveSummary?: (summary: string, signal?: AbortSignal) => Promise<boolean>;
		approvalUI?: ExtensionUIContext;
		onStatusChange?: () => void;
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
		const tools: AgentTool[] = [];
		for (const mainTool of options.availableTools) {
			if (!isBtwInvestigationTool(mainTool.name) || !safeNames.has(mainTool.name)) continue;
			// Main's wrapper must never execute in BTW.
			const native = mainTool instanceof ExtensionToolWrapper ? mainTool.unwrap() : mainTool;
			if (native instanceof RegisteredToolAdapter || native instanceof ExtensionToolWrapper) continue;
			const guarded = {
				execute: async (...args: Parameters<AgentTool["execute"]>) => {
					if (!isBtwReadOnlyToolCall(native, args[1] as Record<string, unknown>)) {
						throw new Error("Tool call is not permitted in a read-only BTW conversation");
					}
					return native.execute(...args);
				},
			} satisfies Pick<AgentTool, "execute">;
			applyToolProxy(native, guarded);
			tools.push(new ExtensionToolWrapper(guarded as AgentTool, runner));
		}
		const { approveSummary, approvalUI, sendToMainSession } = options;
		const summaryTool: AgentTool<typeof sendToMainSessionParameters> | undefined = sendToMainSession
			? {
					name: "send_to_main_session",
					label: "Send to Main Session",
					description: sendToMainSessionDescription,
					parameters: sendToMainSessionParameters,
					intent: "omit",
					async execute(_id, { summary }, signal) {
						signal?.throwIfAborted();
						// This cross-session action needs an exact-text confirmation even in yolo
						// mode or when an extension calls execute directly.
						const approved = approveSummary
							? await approveSummary(summary, signal)
							: await approvalUI?.confirm("Send BTW summary to Main?", summary, { signal });
						signal?.throwIfAborted();
						if (approved !== true) throw new Error("The user did not approve sending this BTW summary");
						await sendToMainSession(summary);
						return { content: [{ type: "text", text: "Summary sent to the main session." }] };
					},
				}
			: undefined;
		if (summaryTool) tools.push(summaryTool);
		const permits = (tool: AgentTool, args: Record<string, unknown>): boolean =>
			tool === summaryTool
				? approveSummary !== undefined || approvalUI !== undefined
				: isBtwReadOnlyToolCall(tool, args);
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
				getModel: () => (agent.state.model ? isolateModel(agent.state.model) : undefined),
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
			undefined,
			"tui",
			{
				installFileFallbacks: false,
				registerProviders: false,
			},
		);
		const { onStatusChange } = options;
		if (onStatusChange) {
			let statuses = runner.getPresentation().statuses;
			session.addDisposer(
				runner.subscribePresentation(() => {
					const next = runner.getPresentation().statuses;
					if (next === statuses) return;
					statuses = next;
					onStatusChange();
				}),
			);
		}
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
			model: agent.state.model ? isolateModel(agent.state.model) : undefined,
			isIdle: () => !agent.state.isStreaming,
			hasQueuedMessages: () => this.session.queuedMessageCount > 0,
			abort: () => agent.abort(),
			settings: this.runner.sessionSettings,
			ui: this.runner.getUIContext(),
			hasUI: this.runner.hasUI(),
			toolNames: this.tools.map(tool => tool.name),
			toolCall,
		};
	}
}
