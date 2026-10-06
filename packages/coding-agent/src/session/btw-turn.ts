/**
 * Headless `/btw` turn lifecycle shared by the TUI controller and RPC mode:
 * record bookkeeping for a new topic or follow-up, and the ephemeral model turn.
 */
import { Snowflake } from "@oh-my-pi/pi-utils";
import btwConversationPrompt from "../prompts/system/btw-conversation.md" with { type: "text" };
import type { AgentSession } from "./agent-session";
import { type BtwHistoryRecord, type BtwHistoryTurn, getBtwTurns } from "./btw-history";
import type { EphemeralConversationTurn, EphemeralTurnResult } from "./ephemeral-conversation";

export interface BtwTurnStart {
	/** The record with the new turn appended, status `running`. */
	record: BtwHistoryRecord;
	/** Earlier turns of a follow-up's topic, replayed as context. */
	history?: readonly BtwHistoryTurn[];
	/** Provider lineage key; successful follow-ups share one, a failed turn starts a fresh one. */
	conversationKey: string;
}

/** Start a new topic, or append a follow-up turn to `previous`. */
export function beginBtwTurn(question: string, leafId: string | null, previous?: BtwHistoryRecord): BtwTurnStart {
	const now = Date.now();
	const turn: BtwHistoryTurn = { question, answer: "", status: "running", createdAt: now, updatedAt: now };
	const record: BtwHistoryRecord = previous
		? { ...previous, followUps: [...(previous.followUps ?? []), turn] }
		: { ...turn, id: Snowflake.next(), leafId };
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
	session: Pick<AgentSession, "model" | "createEphemeralConversation">,
	args: {
		question: string;
		history?: readonly BtwHistoryTurn[];
		conversationKey: string;
		onTextDelta: (delta: string) => void;
		signal: AbortSignal;
	},
): Promise<EphemeralTurnResult> {
	const model = session.model;
	if (!model) throw new Error("No active model available for /btw.");
	const history: EphemeralConversationTurn[] = [];
	for (const turn of args.history ?? []) {
		if (!turn.answer) continue;
		history.push({
			input: turn.question,
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
	const conversation = session.createEphemeralConversation(
		btwConversationPrompt,
		{ turns: history, sideSessionId: args.conversationKey },
		model,
	);
	return conversation.prompt(args.question, {
		// /btw answers are read in full and saved to history: keep the
		// repeated-line collapse, but not the 4 KiB cap meant for one-liners.
		replyMaxBytes: Number.POSITIVE_INFINITY,
		onTextDelta: args.onTextDelta,
		signal: args.signal,
	});
}
