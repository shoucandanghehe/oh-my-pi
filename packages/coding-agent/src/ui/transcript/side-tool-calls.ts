import type { AssistantMessage, ToolCall as ToolCallPart } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { runWithOwner, signal, untrack } from "@oh-my-pi/pi-tui";
import type { Settings } from "../../config/settings";
import { formatModelString } from "../../config/model-resolver";
import { cfgMcpRenderMarkdownResults } from "../../mcp/settings";
import { toolArgsRevealTarget, ToolArgsRevealController } from "@oh-my-pi/pi-tui/chat/tool-args-reveal";
import { cfgDisplayShellVisualization, cfgDisplaySmoothStreaming } from "../../modes/settings";
import { type AgentViewSession, isLocalAgentSession } from "../../session/agent-session-handle";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import {
	asyncJobState,
	isSettledJobFrame,
	parksAsBackground,
	renderArgsWithIntent,
	settleWithJobFrame,
	toolRenderName,
} from "../../session/transcript/tool-execution";
import { resolveEditToolMode } from "../../utils/edit-mode";
import type { ToolCall, ToolCallOptions, ToolCallResult } from "./tool-block";
import { createTranscriptToolCall } from "./tool-card-model";

interface SideCall {
	readonly call: ToolCall;
	committed: boolean;
	returned: boolean;
	background: boolean;
}

type Start = Extract<AgentSessionEvent, { type: "tool_execution_start" }>;

/** A state publication and its saved assistant can overlap for one paint. The saved reply wins. */
function uncommittedAssistant(
	stream: AgentMessage | null | undefined,
	messages: readonly AgentMessage[],
): AssistantMessage | undefined {
	if (stream?.role !== "assistant") return undefined;
	const last = messages.findLast(message => message.role === "assistant");
	return last?.timestamp === stream.timestamp &&
		last.provider === stream.provider &&
		last.model === stream.model &&
		(last.responseId === undefined || stream.responseId === undefined || last.responseId === stream.responseId)
		? undefined
		: stream;
}

/** Tool cards owned by one side transcript. An id remains the same card from preview through result. */
export class SideToolCalls {
	readonly #calls = new Map<string, SideCall>();
	readonly #starts = new Map<string, Start>();
	readonly #reveal: ToolArgsRevealController;
	readonly #revision = signal(0);
	#streamIds = new Set<string>();
	#finishedAssistant: AssistantMessage | undefined;
	#session: AgentViewSession | undefined;
	#unsubscribe: (() => void) | undefined;

	constructor(
		private readonly options: {
			readonly settings?: Settings;
			readonly inspectShell?: ToolCallOptions["inspectShell"];
			readonly expanded: () => boolean;
			readonly onSessionChange?: () => void;
		},
	) {
		this.#reveal = new ToolArgsRevealController({
			getSmoothStreaming: () => {
				const settings = this.#session?.settings ?? this.options.settings;
				return settings ? cfgDisplaySmoothStreaming.get(settings) : false;
			},
		});
	}

	bind(session: AgentViewSession | undefined): void {
		if (this.#session === session) return;
		this.dispose();
		this.#session = session;
		this.#unsubscribe = session?.subscribe(event => {
			if (this.#session !== session) return;
			if (event.type === "tool_execution_start") this.#starts.set(event.toolCallId, event);
			else if (event.type === "tool_execution_end") this.#starts.delete(event.toolCallId);
			else if (event.type === "tool_stream_update")
				this.#calls.get(event.toolCallId)?.call.updateStreamPreview(event.update);
			else if (event.type === "message_start" && event.message.role === "assistant")
				this.#finishedAssistant = undefined;
			else if (event.type === "message_end" && event.message.role === "assistant")
				this.#finishedAssistant = event.message;
			else if (event.type === "agent_end") {
				this.#starts.clear();
				this.#finishedAssistant = undefined;
			}
			this.options.onSessionChange?.();
		});
	}

	dispose(): void {
		this.#session = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#calls.clear();
		this.#starts.clear();
		this.#streamIds.clear();
		this.#finishedAssistant = undefined;
		this.#reveal.stop();
		this.#revision.update(value => value + 1);
	}

	/** A branch rebuild replaces saved cards, but can still commit the currently displayed preview. */
	clearCommitted(): void {
		for (const [id, entry] of this.#calls) {
			if (entry.committed) this.#calls.delete(id);
		}
		this.#revision.update(value => value + 1);
	}

	setExpanded(expanded: boolean): void {
		for (const { call } of this.#calls.values()) call.setExpanded(expanded);
	}

	get(id: string): ToolCall | undefined {
		this.#revision();
		return this.#calls.get(id)?.call;
	}

	commit(part: ToolCallPart, message: AssistantMessage): ToolCall {
		const entry = this.#calls.get(part.id) ?? this.#create(part, message);
		if (entry.committed) return entry.call;
		entry.committed = true;
		this.#reveal.finish(part.id);
		const start = this.#starts.get(part.id);
		entry.call.updateArgs(start ? renderArgsWithIntent(start.args, start.intent) : part.arguments);
		entry.call.setArgsComplete();
		return entry.call;
	}

	stream(raw: AgentMessage | null | undefined, saved: readonly AgentMessage[]): AssistantMessage | undefined {
		// Keep message_end on screen until persistence publishes the same assistant; it owns the
		// final argument snapshot even when streamMessage has already been cleared.
		const finished = this.#finishedAssistant;
		const message = uncommittedAssistant(finished ?? raw, saved);
		if (!message) this.#finishedAssistant = undefined;
		const ids = new Set<string>();
		for (const part of message?.content ?? []) {
			if (part.type !== "toolCall" || !message) continue;
			ids.add(part.id);
			const entry = this.#calls.get(part.id) ?? this.#create(part, message);
			if (entry.committed || entry.call.state().executionStarted) continue;
			const partialJson = finished ? undefined : getStreamingPartialJson(part);
			if (partialJson !== undefined) {
				const session = this.#session;
				const tool = session && isLocalAgentSession(session) ? session.getToolByName(part.name) : undefined;
				entry.call.updateArgs(
					this.#reveal.setTarget(
						part.id,
						partialJson,
						toolArgsRevealTarget(entry.call.name, part.customWireName !== undefined, tool),
					),
				);
				this.#reveal.bind(part.id, entry.call);
			} else {
				this.#reveal.finish(part.id);
				entry.call.updateArgs(part.arguments);
				if (finished) entry.call.setArgsComplete();
			}
		}
		for (const id of this.#streamIds) {
			if (ids.has(id)) continue;
			this.#reveal.finish(id);
			if (!this.#calls.get(id)?.committed) this.#calls.delete(id);
		}
		this.#streamIds = ids;
		return message;
	}

	finish(id: string, result: ToolCallResult): void {
		const entry = this.#calls.get(id);
		if (!entry || entry.returned) return;
		entry.returned = true;
		entry.background = result.isError !== true && parksAsBackground(entry.call.name, result.details, true);
		entry.call.updateResult(result, entry.background);
		if (!entry.background) entry.call.seal();
	}

	syncExecution(): void {
		const session = this.#session;
		if (!session) return;
		for (const id of new Set([...session.agent.state.pendingToolCalls, ...this.#starts.keys()])) {
			const call = this.get(id);
			if (!call) continue;
			const start = this.#starts.get(id);
			if (start && !call.state().executionStarted) call.updateArgs(renderArgsWithIntent(start.args, start.intent));
			this.#reveal.finish(id);
			call.setExecutionStarted();
		}
		for (const result of session.agent.getPendingToolResults()) this.finish(result.toolCallId, result);
		for (const { toolCallId, partialResult } of session.activeToolExecutionUpdates()) {
			const entry = this.#calls.get(toolCallId);
			if (!entry || (entry.returned && !entry.background)) continue;
			const { call } = entry;
			call.setExecutionStarted();
			if (entry.background && isSettledJobFrame(partialResult.details)) {
				settleWithJobFrame(call, partialResult, toolCallId);
				entry.background = false;
			} else if (call.facts.result() !== partialResult) {
				call.updateResult(
					asyncJobState(partialResult.details) === "failed" ? { ...partialResult, isError: true } : partialResult,
					true,
				);
			}
		}
		for (const { toolCallId, update } of session.activeToolStreamUpdates())
			this.#calls.get(toolCallId)?.call.updateStreamPreview(update);
	}

	#create(part: ToolCallPart, message: AssistantMessage): SideCall {
		const session = this.#session;
		const tool = session && isLocalAgentSession(session) ? session.getToolByName(part.name) : undefined;
		const metadata = this.#session?.getToolRenderMetadata?.(part.name);
		const name = metadata?.name ?? toolRenderName(part.name, tool);
		const settings = this.#session?.settings ?? this.options.settings;
		const editMode =
			name === "edit" && settings
				? resolveEditToolMode({
						settings,
						getActiveModelString: () => formatModelString({ provider: message.provider, id: message.model }),
					})
				: undefined;
		// The card survives the reactive update that first discovered it.
		const call = runWithOwner(null, () =>
			createTranscriptToolCall({
				id: part.id,
				name,
				label: metadata?.label,
				tool,
				builtIn: metadata ? metadata.builtIn : tool ? this.#session?.hasBuiltInTool(name) : undefined,
				args: part.arguments,
				editMode,
				inspectShell: this.options.inspectShell,
				shellVisualization: settings ? cfgDisplayShellVisualization.get(settings) : undefined,
				mcpMarkdown: settings ? cfgMcpRenderMarkdownResults.get(settings) : undefined,
			}),
		);
		call.setExpanded(untrack(this.options.expanded));
		const entry = { call, committed: false, returned: false, background: false };
		this.#calls.set(part.id, entry);
		return entry;
	}
}
