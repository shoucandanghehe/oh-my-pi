import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { calculateContextTokens, hasContextTokenUsage } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Effort, Model } from "@oh-my-pi/pi-ai";

export interface EphemeralTurnOptions {
	promptText: string;
	onTextDelta?: (delta: string) => void;
	onThinkingDelta?: (delta: string) => void;
	/** Mirrors the side agent's transcript message lifecycle for alternate render surfaces. */
	onMessage?: (event: { type: "update"; message: AssistantMessage } | { type: "end"; message: AgentMessage }) => void;
	signal?: AbortSignal;
	dedupeReply?: boolean;
}

/** Side-channel capabilities for a conversation: read-only tools and one-way summary sharing with Main. */
export interface EphemeralConversationSideOptions {
	/** Allow read-only tools (read/glob/grep) instead of blocking every call. */
	readOnlyTools?: boolean;
	/** Install `shareSummaryWithMain` for a user-approved BTW knowledge summary. */
	shareSummaryWithMain?: (summary: string) => void | Promise<void>;
}

export interface EphemeralTurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
	intermediateMessages?: readonly AgentMessage[];
}

export interface EphemeralConversationTurn {
	input: string;
	assistantMessage: AssistantMessage;
	intermediateMessages?: readonly AgentMessage[];
	prefixMessages?: readonly AgentMessage[];
	replyText: string;
	timestamp: number;
}

export interface EphemeralConversationCheckpoint {
	baseMessages?: readonly AgentMessage[];
	turns: readonly EphemeralConversationTurn[];
	sideSessionId: string;
}

export interface FrozenEphemeralConversationCheckpoint extends EphemeralConversationCheckpoint {
	baseMessages: readonly AgentMessage[];
}
export interface EphemeralConversationStatus {
	sessionId: string;
	model: Model;
	thinkingLevel: Effort | undefined;
	isStreaming: boolean;
	latestAssistantMessage: AssistantMessage | undefined;
	stats: {
		tokens: {
			input: number;
			output: number;
			reasoning: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		premiumRequests: number;
		cost: number;
		contextUsage:
			| {
					tokens: number;
					contextWindow: number;
					percent: number;
			  }
			| undefined;
	};
}

export interface EphemeralConversationOptions {
	snapshotBaseMessages: () => readonly AgentMessage[];
	runTurn: (
		messages: AgentMessage[],
		options: Omit<EphemeralTurnOptions, "promptText">,
	) => Promise<EphemeralTurnResult>;
	turnPrefixMessages?: () => readonly AgentMessage[];
	checkpoint?: EphemeralConversationCheckpoint;
	sideSessionId: string;
	getTool?: (name: string) => AgentTool | undefined;
	getRuntimeState?: () => {
		model: Model;
		thinkingLevel: Effort | undefined;
		streamMessage?: AssistantMessage | null;
		isStreaming: boolean;
	};
}

/**
 * Owns one side-channel context, snapshotted on its first prompt, and its
 * independent multi-turn history. Turns commit only after a complete reply.
 */
export class EphemeralConversation {
	#baseMessages: readonly AgentMessage[] | undefined;
	readonly #snapshotBaseMessages: EphemeralConversationOptions["snapshotBaseMessages"];
	readonly #turnPrefixMessages: EphemeralConversationOptions["turnPrefixMessages"];
	readonly #runTurn: EphemeralConversationOptions["runTurn"];
	readonly #getTool: EphemeralConversationOptions["getTool"];
	readonly #getRuntimeState: EphemeralConversationOptions["getRuntimeState"];
	readonly #sideSessionId: string;
	readonly #turns: EphemeralConversationTurn[] = [];
	readonly #committedUsage = {
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		premiumRequests: 0,
		cost: 0,
	};
	#latestAssistantMessage: AssistantMessage | undefined;
	#latestContextAssistant: AssistantMessage | undefined;
	#running = false;

	constructor(options: EphemeralConversationOptions) {
		this.#snapshotBaseMessages = options.snapshotBaseMessages;
		this.#turnPrefixMessages = options.turnPrefixMessages;
		this.#getTool = options.getTool;
		this.#getRuntimeState = options.getRuntimeState;
		this.#runTurn = options.runTurn;
		this.#sideSessionId = options.sideSessionId;
		this.#baseMessages = options.checkpoint?.baseMessages;
		if (options.checkpoint) {
			this.#turns.push(...options.checkpoint.turns);
			for (const turn of options.checkpoint.turns) this.#recordTurnStatus(turn);
		}
	}

	get turns(): readonly EphemeralConversationTurn[] {
		return this.#turns;
	}

	get isRunning(): boolean {
		return this.#running;
	}

	getTool(name: string): AgentTool | undefined {
		return this.#getTool?.(name);
	}
	get status(): EphemeralConversationStatus | undefined {
		const runtime = this.#getRuntimeState?.();
		if (!runtime) return undefined;
		const streamMessage = runtime.streamMessage ?? undefined;
		const streamUsage = streamMessage?.usage;
		const contextAssistant =
			streamMessage && hasContextTokenUsage(streamMessage.usage) ? streamMessage : this.#latestContextAssistant;
		const contextWindow = runtime.model.contextWindow ?? 0;
		const contextTokens = contextAssistant ? calculateContextTokens(contextAssistant.usage) : undefined;
		return {
			sessionId: this.#sideSessionId,
			model: runtime.model,
			thinkingLevel: runtime.thinkingLevel,
			isStreaming: runtime.isStreaming,
			latestAssistantMessage: streamMessage ?? this.#latestAssistantMessage,
			stats: {
				tokens: {
					input: this.#committedUsage.input + (streamUsage?.input ?? 0),
					output: this.#committedUsage.output + (streamUsage?.output ?? 0),
					reasoning: this.#committedUsage.reasoning + (streamUsage?.reasoningTokens ?? 0),
					cacheRead: this.#committedUsage.cacheRead + (streamUsage?.cacheRead ?? 0),
					cacheWrite: this.#committedUsage.cacheWrite + (streamUsage?.cacheWrite ?? 0),
					total: this.#committedUsage.total + (streamUsage?.totalTokens ?? 0),
				},
				premiumRequests: this.#committedUsage.premiumRequests + (streamUsage?.premiumRequests ?? 0),
				cost: this.#committedUsage.cost + (streamUsage?.cost.total ?? 0),
				contextUsage:
					contextTokens === undefined
						? undefined
						: {
								tokens: contextTokens,
								contextWindow,
								percent: contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0,
							},
			},
		};
	}

	checkpoint(): FrozenEphemeralConversationCheckpoint {
		if (!this.#baseMessages) throw new Error("Cannot checkpoint an ephemeral conversation before its first prompt");
		return {
			baseMessages: this.#baseMessages,
			turns: [...this.#turns],
			sideSessionId: this.#sideSessionId,
		};
	}

	freeze(): FrozenEphemeralConversationCheckpoint {
		this.#baseMessages ??= this.#snapshotBaseMessages();
		return this.checkpoint();
	}
	#recordAssistantUsage(message: AssistantMessage): void {
		const usage = message.usage;
		this.#latestAssistantMessage = message;
		if (hasContextTokenUsage(usage)) this.#latestContextAssistant = message;
		this.#committedUsage.input += usage.input;
		this.#committedUsage.output += usage.output;
		this.#committedUsage.reasoning += usage.reasoningTokens ?? 0;
		this.#committedUsage.cacheRead += usage.cacheRead;
		this.#committedUsage.cacheWrite += usage.cacheWrite;
		this.#committedUsage.total += usage.totalTokens;
		this.#committedUsage.premiumRequests += usage.premiumRequests ?? 0;
		this.#committedUsage.cost += usage.cost.total;
	}

	#recordTurnStatus(turn: EphemeralConversationTurn): void {
		for (const message of turn.intermediateMessages ?? []) {
			if (message.role === "assistant") this.#recordAssistantUsage(message);
		}
		this.#recordAssistantUsage(turn.assistantMessage);
	}

	#appendTurns(messages: AgentMessage[]): void {
		for (const turn of this.#turns) {
			if (turn.prefixMessages) messages.push(...turn.prefixMessages);
			messages.push({
				role: "user",
				content: [{ type: "text", text: turn.input }],
				attribution: "agent",
				timestamp: turn.timestamp,
			});
			if (turn.intermediateMessages) messages.push(...turn.intermediateMessages);
			messages.push(turn.assistantMessage);
		}
	}

	async prompt(input: string, options: Omit<EphemeralTurnOptions, "promptText"> = {}): Promise<EphemeralTurnResult> {
		if (this.#running) throw new Error("Ephemeral conversation already has a turn in progress");
		const timestamp = Date.now();
		const baseMessages = this.#baseMessages ?? this.#snapshotBaseMessages();
		this.#baseMessages = baseMessages;
		const messages = [...baseMessages];
		const prefixMessages = this.#turnPrefixMessages?.() ?? [];
		this.#appendTurns(messages);
		messages.push(...prefixMessages);
		messages.push({
			role: "user",
			content: [{ type: "text", text: input }],
			attribution: "agent",
			timestamp,
		});

		this.#running = true;
		try {
			const result = await this.#runTurn(messages, options);
			const turn: EphemeralConversationTurn = {
				input,
				prefixMessages: prefixMessages.length > 0 ? prefixMessages : undefined,
				assistantMessage: result.assistantMessage,
				intermediateMessages: result.intermediateMessages,
				replyText: result.replyText,
				timestamp,
			};
			this.#turns.push(turn);
			this.#recordTurnStatus(turn);
			return result;
		} finally {
			this.#running = false;
		}
	}
}
