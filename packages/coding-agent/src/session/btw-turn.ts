/** Shared lightweight BTW history lifecycle; durable panes own their conversations separately. */
import type { AssistantMessage, ImageContent, Message } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
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
	/** Earlier turns of a follow-up's topic, used only to import text-only history. */
	history?: readonly BtwHistoryTurn[];
	/** Provider lineage key; failed transports start a fresh lineage over the same frozen context. */
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

/** A collab guest can ask about its replica, but cannot run BTW investigations or publish on the host. */
export function runTextOnlyBtwTurn(
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
	args.signal.throwIfAborted();
	const active = session.model;
	const frozen = args.checkpoint?.model;
	const model =
		!frozen || (active?.provider === frozen.provider && active.id === frozen.id)
			? active
			: session.findModel(frozen.provider, frozen.id);
	if (!model) throw new Error("No active model available for /btw.");
	const textMessage = (text: string, stopReason: "stop" | "aborted", timestamp: number): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason,
		timestamp,
	});
	const nativeTurns = args.checkpoint?.turns ?? [];
	const history: EphemeralConversationTurn[] = [...nativeTurns];
	let trailing = [...(args.checkpoint?.trailingMessages ?? [])];
	const nativeIncomplete = trailing.filter(message => message.role === "user");
	let completed = 0;
	for (const turn of args.history ?? []) {
		const complete = turn.status === "complete";
		if (complete) completed++;
		if (completed < nativeTurns.length || (completed === nativeTurns.length && complete)) continue;
		const assistant = textMessage(turn.answer, complete ? "stop" : "aborted", turn.updatedAt);
		if (complete) {
			history.push({
				input: turn.question,
				images: turn.images ? [...turn.images] : undefined,
				replyText: turn.answer,
				timestamp: turn.createdAt,
				assistantMessage: assistant,
				prefixMessages: trailing.length ? trailing : undefined,
			});
			trailing = [];
			nativeIncomplete.length = 0;
		} else {
			// A checkpoint may already contain an interrupted tool cycle. Keep it
			// as-is; reconstruct only the text of an uncheckpointed turn.
			const question = turn.question;
			const known = nativeIncomplete.findIndex(message => {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
				return (
					text === question ||
					text === prompt.render(btwUserPrompt, { question, inject: true }) ||
					text === prompt.render(btwUserPrompt, { question, inject: true, allowInvestigation: true })
				);
			});
			if (known !== -1) {
				nativeIncomplete.splice(known, 1);
				continue;
			}
			trailing.push({
				role: "user",
				content: [{ type: "text", text: question }, ...(turn.images ?? [])],
				attribution: "agent",
				timestamp: turn.createdAt,
			});
			if (turn.answer) trailing.push(assistant);
		}
	}
	const conversation = session.createEphemeralConversation(
		btwConversationPrompt,
		{
			...args.checkpoint,
			turns: history,
			trailingMessages: trailing.length ? trailing : undefined,
			sideSessionId: args.conversationKey,
		},
		model,
		{ sendToMainSession: summary => session.publishBtwSummary({ ...args.source, summary }) },
	);
	let turn: Promise<EphemeralTurnResult> | undefined;
	try {
		await args.onCheckpoint?.(
			{ ...conversation.freeze(), model: { provider: model.provider, id: model.id } },
			"frozen",
		);
		args.signal.throwIfAborted();
		let fragment = "";
		turn = conversation.prompt(
			args.inject
				? prompt.render(btwUserPrompt, { question: args.question, inject: true, allowInvestigation: true })
				: args.question,
			{
				images: args.images,
				replyMaxBytes: Number.POSITIVE_INFINITY,
				onTextDelta: delta => {
					if (args.signal.aborted) return;
					fragment += delta;
					args.onTextDelta(delta);
				},
				onMessage: event => {
					if (!args.signal.aborted && event.type === "end" && event.message.role === "assistant") fragment = "";
				},
				signal: args.signal,
			},
		);
		try {
			return await untilAborted(args.signal, turn);
		} finally {
			await conversation.session?.settleInFlightMessagePersistence();
			let checkpoint = conversation.checkpoint();
			const tail = checkpoint.trailingMessages;
			if (args.signal.aborted && fragment && tail?.length && tail.at(-1)?.role !== "assistant") {
				// The current stream has not committed an assistant message. Replay only
				// its visible text, not unfinished tool calls or provider signatures.
				checkpoint = { ...checkpoint, trailingMessages: [...tail, textMessage(fragment, "aborted", Date.now())] };
			}
			await args.onCheckpoint?.({ ...checkpoint, model: { provider: model.provider, id: model.id } }, "terminal");
		}
	} finally {
		// The checkpoint is already available to the next turn. Dispose the old
		// runtime only after its transport finishes using it.
		if (args.signal.aborted) await turn?.catch(() => {});
		await conversation.disposeExtensionRuntime();
	}
}
