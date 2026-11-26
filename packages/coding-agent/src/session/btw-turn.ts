/**
 * Headless `/btw` turn lifecycle shared by the TUI controller and RPC mode:
 * record bookkeeping for a new topic or follow-up, and the ephemeral model turn.
 */
import type { AssistantMessage, ImageContent, Message } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import btwConversationPrompt from "../prompts/system/btw-conversation.md" with { type: "text" };
import btwUserPrompt from "../prompts/system/btw-user.md" with { type: "text" };
import type { AgentSession } from "./agent-session";
import { type BtwHistoryRecord, type BtwHistoryTurn, getBtwTurns } from "./btw-history";
import type { BtwSummarySource } from "./messages";
import type {
	EphemeralConversationTurn,
	EphemeralTurnResult,
	FrozenEphemeralConversationCheckpoint,
} from "./ephemeral-conversation";

export interface BtwTurnStart {
	/** The record with the new turn appended, status `running`. */
	record: BtwHistoryRecord;
	/** Earlier turns of a follow-up's topic, replayed as context. */
	history?: readonly BtwHistoryTurn[];
	/** Provider lineage key; successful follow-ups share one, a failed turn starts a fresh one. */
	conversationKey: string;
}

/** Start a new topic headed by `title` when given, or append a follow-up turn to `previous`. */
export function beginBtwTurn(
	question: string,
	leafId: string | null,
	previous?: BtwHistoryRecord,
	images?: ImageContent[],
	title?: string,
): BtwTurnStart {
	const now = Date.now();
	const turn: BtwHistoryTurn = {
		question,
		...(images?.length ? { images } : {}),
		answer: "",
		status: "running",
		createdAt: now,
		updatedAt: now,
	};
	const record: BtwHistoryRecord = previous
		? { ...previous, followUps: [...(previous.followUps ?? []), turn] }
		: { ...turn, id: Snowflake.next(), leafId, ...(title ? { title } : {}) };
	const history = previous ? getBtwTurns(previous) : undefined;
	// A cancelled/failed transport may still be unwinding. Start a fresh
	// lineage after that boundary, while successful follow-ups share one.
	const transportEpoch = (history?.findLastIndex(item => item.status !== "complete") ?? -1) + 1;
	return { record, history, conversationKey: `btw:${record.id}:${transportEpoch}` };
}

/** Patch the record's latest turn (the last follow-up, else the record itself). */
export function patchLatestBtwTurn(record: BtwHistoryRecord, patch: Partial<BtwHistoryTurn>): BtwHistoryRecord {
	const followUps = record.followUps;
	if (followUps?.length) {
		return { ...record, followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1]!, ...patch }] };
	}
	return { ...record, ...patch };
}

/**
 * Run one `/btw` question as an ephemeral turn; earlier turns of its topic are replayed as context.
 * Not `async`: returns the session's own promise so callers settle on the same tick as the turn.
 */
export function runBtwTurn(
	session: Pick<AgentSession, "model" | "runEphemeralTurn">,
	args: {
		question: string;
		/** Images attached to this question; earlier turns replay their own. */
		images?: ImageContent[];
		history?: readonly BtwHistoryTurn[];
		/** Ask for steering prompts in an `<inject>` block (the `btw.inject` setting). */
		inject?: boolean;
		conversationKey: string;
		onTextDelta: (delta: string) => void;
		signal: AbortSignal;
	},
): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
	const model = session.model;
	if (!model) throw new Error("No active model available for /btw.");
	const history: Message[] = [];
	for (const turn of args.history ?? []) {
		history.push({
			role: "user",
			content: [
				{ type: "text", text: prompt.render(btwUserPrompt, { question: turn.question, inject: args.inject }) },
				...(turn.images ?? []),
			],
			attribution: "agent",
			timestamp: turn.createdAt,
		});
		if (!turn.answer) continue;
		// Saved BTW history contains visible text, not provider-native reasoning
		// or replay signatures. These are context messages, not new billed turns.
		history.push({
			role: "assistant",
			content: [{ type: "text", text: turn.answer }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: turn.updatedAt,
		});
	}
	return session.runEphemeralTurn({
		promptText: prompt.render(btwUserPrompt, { question: args.question, inject: args.inject }),
		promptImages: args.images,
		history,
		conversationKey: args.conversationKey,
		// /btw answers are read in full and saved to history: keep the
		// repeated-line collapse, but not the 4 KiB cap meant for one-liners.
		replyMaxBytes: Number.POSITIVE_INFINITY,
		purpose: "btw",
		onTextDelta: args.onTextDelta,
		signal: args.signal,
	});
}

export interface BtwTurnCheckpoint extends FrozenEphemeralConversationCheckpoint {
	model: { provider: string; id: string };
}

/** Only data and RPC-supported callbacks cross threads; the conversation stays on its owner's home thread. */
export interface BtwTurnOptions {
	question: string;
	images?: ImageContent[];
	/** Import only saved history turns that have no native checkpoint (legacy records or external additions). */
	history?: readonly BtwHistoryTurn[];
	checkpoint?: BtwTurnCheckpoint;
	inject?: boolean;
	conversationKey: string;
	source: BtwSummarySource;
	onTextDelta: (delta: string) => void;
	/** Capture frozen context before dispatch and native messages at termination. */
	onCheckpoint?: (checkpoint: BtwTurnCheckpoint, phase: "frozen" | "terminal") => Promise<void>;
	signal: AbortSignal;
}

/** Run a history-panel turn on the owning session, never on the UI's Main session. */
export async function runCheckpointedBtwTurn(
	session: Pick<AgentSession, "model" | "findModel" | "createEphemeralConversation" | "publishBtwSummary">,
	args: BtwTurnOptions,
): Promise<EphemeralTurnResult> {
	const active = session.model;
	const frozen = args.checkpoint?.model;
	const model =
		!frozen || (active?.provider === frozen.provider && active.id === frozen.id)
			? active
			: session.findModel(frozen.provider, frozen.id);
	if (!model) throw new Error("No active model available for /btw.");
	const history: EphemeralConversationTurn[] = [];
	const legacyHistory = args.checkpoint
		? args.history?.filter(turn => turn.status === "complete").slice(args.checkpoint.turns.length)
		: args.history;
	for (const turn of legacyHistory ?? []) {
		if (!turn.answer) continue;
		history.push({
			input: turn.question,
			images: turn.images ? [...turn.images] : undefined,
			replyText: turn.answer,
			timestamp: turn.createdAt,
			assistantMessage: {
				role: "assistant",
				content: [{ type: "text", text: turn.answer }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: turn.updatedAt,
			},
		});
	}
	if (history[0] && args.checkpoint?.trailingMessages?.length) {
		history[0].prefixMessages = args.checkpoint.trailingMessages;
	}
	const conversation = session.createEphemeralConversation(
		btwConversationPrompt,
		{
			...args.checkpoint,
			turns: [...(args.checkpoint?.turns ?? []), ...history],
			trailingMessages: history.length ? undefined : args.checkpoint?.trailingMessages,
			sideSessionId: args.conversationKey,
		},
		model,
		{ sendToMainSession: summary => session.publishBtwSummary({ ...args.source, summary }) },
	);
	try {
		await args.onCheckpoint?.(
			{ ...conversation.freeze(), model: { provider: model.provider, id: model.id } },
			"frozen",
		);
		try {
			return await conversation.prompt(
				args.inject
					? prompt.render(btwUserPrompt, { question: args.question, inject: true, allowInvestigation: true })
					: args.question,
				{
					images: args.images,
					replyMaxBytes: Number.POSITIVE_INFINITY,
					onTextDelta: args.onTextDelta,
					signal: args.signal,
				},
			);
		} finally {
			await conversation.session?.settleInFlightMessagePersistence();
			const checkpoint = conversation.checkpoint();
			await args.onCheckpoint?.({ ...checkpoint, model: { provider: model.provider, id: model.id } }, "terminal");
		}
	} finally {
		await conversation.disposeExtensionRuntime();
	}
}
