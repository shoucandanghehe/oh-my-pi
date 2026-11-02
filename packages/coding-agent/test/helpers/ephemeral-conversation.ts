import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Effort, Model, TextContent, ThinkingContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	EphemeralConversation,
	type EphemeralConversationOptions,
	type EphemeralTurnOptions,
	type EphemeralTurnResult,
	replayInterruptedBtwText,
} from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { createAssistantMessage } from "./agent-session-setup";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";

/** Legacy UI fixtures script only the model boundary; history and queues remain production code. */
interface TestEphemeralConversationBaseOptions extends Omit<EphemeralConversationOptions, "createSession"> {
	tools?: AgentTool[];
	getRuntimeState?: () => {
		model: Model;
		thinkingLevel: Effort | undefined;
		streamMessage?: AssistantMessage | null;
		isStreaming: boolean;
	};
}

export type TestEphemeralConversationOptions = TestEphemeralConversationBaseOptions &
	(
		| {
				runTurn: (
					messages: AgentMessage[],
					options: Omit<EphemeralTurnOptions, "promptText">,
				) => Promise<EphemeralTurnResult>;
				streamFn?: never;
		  }
		| { streamFn: StreamFn; runTurn?: never }
	);

const activeConversations = new Set<TestEphemeralConversation>();

export async function disposeTestEphemeralConversations(): Promise<void> {
	await Promise.all([...activeConversations].map(conversation => conversation.disposeExtensionRuntime()));
}

export class TestEphemeralConversation extends EphemeralConversation {
	constructor(options: TestEphemeralConversationOptions) {
		super({
			...options,
			createSession: async sessionManager => {
				const state = options.getRuntimeState?.();
				const model = state?.model ?? getBundledModel("anthropic", "claude-sonnet-4-5");
				const agent = new Agent({
					initialState: {
						model,
						messages: sessionManager.buildSessionContext({ preserveInterruptedMessages: true }).messages,
						thinkingLevel: state?.thinkingLevel,
						tools: options.tools ?? [],
					},
					convertToLlm: messages => convertToLlm(replayInterruptedBtwText(messages)),
					streamFn:
						options.streamFn ??
						((_model, context, request) => {
							const stream = new AssistantMessageEventStream();
							const base: AssistantMessage = {
								...createAssistantMessage(""),
								api: model.api,
								provider: model.provider,
								model: model.id,
							};
							const content: AssistantMessage["content"] = [];
							const partial = (): AssistantMessage => ({
								...base,
								content: content.map(block => ({ ...block })),
							});
							let settled = false;
							let text: TextContent | undefined;
							let thinking: ThinkingContent | undefined;
							const detach = (): void => request?.signal?.removeEventListener("abort", abort);
							const abort = (): void => {
								if (settled) return;
								settled = true;
								detach();
								const message: AssistantMessage = {
									...partial(),
									stopReason: "aborted",
									errorMessage: "aborted",
								};
								stream.push({ type: "error", reason: "aborted", error: message });
							};
							stream.push({ type: "start", partial: partial() });
							request?.signal?.addEventListener("abort", abort, { once: true });
							if (request?.signal?.aborted) abort();
							queueMicrotask(async () => {
								if (settled) return;
								try {
									const result = await options.runTurn!([...context.messages], {
										signal: request?.signal,
										onTextDelta: delta => {
											if (settled) return;
											if (!text) {
												text = { type: "text", text: "" };
												content.push(text);
												stream.push({
													type: "text_start",
													contentIndex: content.indexOf(text),
													partial: partial(),
												});
											}
											text.text += delta;
											stream.push({
												type: "text_delta",
												contentIndex: content.indexOf(text),
												delta,
												partial: partial(),
											});
										},
										onThinkingDelta: delta => {
											if (settled) return;
											if (!thinking) {
												thinking = { type: "thinking", thinking: "" };
												content.push(thinking);
												stream.push({
													type: "thinking_start",
													contentIndex: content.indexOf(thinking),
													partial: partial(),
												});
											}
											thinking.thinking += delta;
											stream.push({
												type: "thinking_delta",
												contentIndex: content.indexOf(thinking),
												delta,
												partial: partial(),
											});
										},
									});
									if (settled) return;
									settled = true;
									detach();
									if (text)
										stream.push({
											type: "text_end",
											contentIndex: content.indexOf(text),
											content: text.text,
											partial: partial(),
										});
									if (thinking)
										stream.push({
											type: "thinking_end",
											contentIndex: content.indexOf(thinking),
											content: thinking.thinking,
											partial: partial(),
										});
									stream.push({ type: "done", reason: "stop", message: result.assistantMessage });
								} catch (error) {
									if (settled) return;
									settled = true;
									detach();
									const message: AssistantMessage = {
										...partial(),
										stopReason: "error",
										errorMessage: error instanceof Error ? error.message : String(error),
									};
									stream.push({ type: "error", reason: "error", error: message });
								}
							});
							return stream;
						}),
				});
				const session = new AgentSession({
					agent,
					sessionManager,
					settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
					modelRegistry: {
						getApiKey: async () => "fixture-key",
						resolver: () => async () => "fixture-key",
						authStorage: { usage: { ingestHeaders: () => {} }, oauth: { identity: () => undefined } },
						hasLazyRuntimeMetadata: () => false,
					} as never,
					memoryEnabled: false,
				});
				return { session };
			},
		});
		activeConversations.add(this);
	}

	override async disposeExtensionRuntime(): Promise<void> {
		try {
			await super.disposeExtensionRuntime();
		} finally {
			activeConversations.delete(this);
		}
	}
}
