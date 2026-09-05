import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

export interface EphemeralTurnOptions {
	promptText: string;
	onTextDelta?: (delta: string) => void;
	signal?: AbortSignal;
	dedupeReply?: boolean;
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

export interface EphemeralConversationOptions {
	snapshotBaseMessages: () => readonly AgentMessage[];
	runTurn: (
		messages: AgentMessage[],
		options: Omit<EphemeralTurnOptions, "promptText">,
	) => Promise<EphemeralTurnResult>;
	checkpoint?: EphemeralConversationCheckpoint;
	sideSessionId: string;
}

/**
 * Owns one side-channel context, snapshotted on its first prompt, and its
 * independent multi-turn history. Turns commit only after a complete reply.
 */
export class EphemeralConversation {
	#baseMessages: readonly AgentMessage[] | undefined;
	readonly #snapshotBaseMessages: EphemeralConversationOptions["snapshotBaseMessages"];
	readonly #runTurn: EphemeralConversationOptions["runTurn"];
	readonly #sideSessionId: string;
	readonly #turns: EphemeralConversationTurn[] = [];
	#running = false;

	constructor(options: EphemeralConversationOptions) {
		this.#snapshotBaseMessages = options.snapshotBaseMessages;
		this.#runTurn = options.runTurn;
		this.#sideSessionId = options.sideSessionId;
		this.#baseMessages = options.checkpoint?.baseMessages;
		if (options.checkpoint) this.#turns.push(...options.checkpoint.turns);
	}

	get turns(): readonly EphemeralConversationTurn[] {
		return this.#turns;
	}

	get isRunning(): boolean {
		return this.#running;
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

	async prompt(input: string, options: Omit<EphemeralTurnOptions, "promptText"> = {}): Promise<EphemeralTurnResult> {
		if (this.#running) throw new Error("Ephemeral conversation already has a turn in progress");
		const timestamp = Date.now();
		const baseMessages = this.#baseMessages ?? this.#snapshotBaseMessages();
		this.#baseMessages = baseMessages;
		const messages = [...baseMessages];
		for (const turn of this.#turns) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: turn.input }],
				attribution: "agent",
				timestamp: turn.timestamp,
			});
			if (turn.intermediateMessages) messages.push(...turn.intermediateMessages);
			messages.push(turn.assistantMessage);
		}
		messages.push({
			role: "user",
			content: [{ type: "text", text: input }],
			attribution: "agent",
			timestamp,
		});

		this.#running = true;
		try {
			const result = await this.#runTurn(messages, options);
			this.#turns.push({
				input,
				assistantMessage: result.assistantMessage,
				intermediateMessages: result.intermediateMessages,
				replyText: result.replyText,
				timestamp,
			});
			return result;
		} finally {
			this.#running = false;
		}
	}
}
