/**
 * Mid-conversation reasoning effort via `configuration_update` input items
 * (GPT-6 family; `model.compat.supportsConfigurationUpdate`).
 *
 * The request-level `reasoning.effort` is pinned to the value of the session's
 * first request so the cached prompt prefix survives an effort change. Each
 * later change is carried as a `configuration_update` item inserted at the
 * tail of the transcript — before the user message it takes effect on, or
 * after the latest tool result when the level changes inside a tool loop — and
 * replayed at that position on every subsequent request until another update
 * overrides it. Mirrors the Anthropic provider's stable `output_config.effort`
 * planning.
 *
 * Used by both the platform Responses provider and the Codex provider; the
 * state lives in each provider's session state, keyed per conversation. A side
 * request plans against a copy of its parent conversation's state (see
 * {@link resolveOpenAIRequestControlState}), so it sends the parent's prefix.
 *
 * Wire constraints (OpenAI reasoning guide): the GPT-6 family supports the item
 * in standard (not `pro`) reasoning mode, adjacent updates are rejected, and
 * `/responses/compact` rejects histories containing them — compaction
 * requests are built outside this planner and never carry the items.
 */

import type { OpenAIToolControlState } from "./openai-tool-additions";

export interface OpenAIInputInsertion<TItem> {
	index: number;
	item: TItem;
}

/** Insert controls in transcript order, keeping the callers' order at equal positions. */
export function insertOpenAIInputUpdates<TItem>(
	input: TItem[],
	insertions: readonly OpenAIInputInsertion<NoInfer<TItem>>[],
): void {
	let offset = 0;
	for (const { index, item } of insertions.toSorted((a, b) => a.index - b.index)) {
		input.splice(index + offset++, 0, item);
	}
}

/** `configuration_update` input item; only `reasoning.effort` is updatable. */
export interface ConfigurationUpdateItem {
	type: "configuration_update";
	reasoning: { effort: string };
}

interface EffortTransition<TEffort extends string> {
	/** Input-array position the item is spliced into (before `input[index]`). */
	index: number;
	/** Fingerprint of `input[index - 1]` at record time; a mismatch means the history was rewritten. */
	anchor: string;
	effort: TEffort;
}

/** Per-conversation request controls, planned against the unmodified transcript. */
export interface OpenAIRequestControlState<TEffort extends string = string, TTool = never> {
	sessionId: string;
	baseEffort?: TEffort;
	currentEffort?: TEffort;
	transitions: EffortTransition<TEffort>[];
	tools?: OpenAIToolControlState<TTool>;
}

export function createOpenAIEffortControlState<TEffort extends string, TTool = never>(
	sessionId: string,
): OpenAIRequestControlState<TEffort, TTool> {
	return { sessionId, transitions: [] };
}

const MAX_EFFORT_CONTROL_STATES = 16;

/**
 * Fetch (or create) the control state for one conversation from a provider's
 * bounded per-session map, refreshing its LRU slot.
 */
export function resolveOpenAIRequestControlState<TEffort extends string, TTool>(
	states: Map<string, OpenAIRequestControlState<TEffort, TTool>>,
	keyOf: (sessionId: string) => string,
	sessionId: string,
	parentSessionId: string | undefined,
): OpenAIRequestControlState<TEffort, TTool> {
	if (parentSessionId !== undefined && parentSessionId !== sessionId) {
		const parent = states.get(keyOf(parentSessionId));
		return parent ? { ...structuredClone(parent), sessionId } : createOpenAIEffortControlState(sessionId);
	}
	const key = keyOf(sessionId);
	const existing = states.get(key);
	if (existing) {
		states.delete(key);
		states.set(key, existing);
		return existing;
	}
	const created = createOpenAIEffortControlState<TEffort, TTool>(sessionId);
	states.set(key, created);
	if (states.size > MAX_EFFORT_CONTROL_STATES) {
		const oldest = states.keys().next().value;
		if (oldest !== undefined) states.delete(oldest);
	}
	return created;
}

/** Release one routing session's request controls without affecting other sessions. */
export function releaseOpenAIRequestControlSession<TEffort extends string, TTool>(
	states: Map<string, OpenAIRequestControlState<TEffort, TTool>>,
	sessionId: string,
): void {
	for (const [key, state] of states) {
		if (state.sessionId === sessionId) states.delete(key);
	}
}

interface AnchorableItem {
	type?: string | null;
	role?: string;
	id?: string | null;
	status?: string | null;
}

/**
 * Fingerprint of the item a transition sits after. Output-only lifecycle
 * fields are excluded: a live response item carries `id`/`status` that the
 * sanitized replay of the same item drops.
 */
function effortControlAnchor(input: readonly AnchorableItem[], index: number): string {
	if (index === 0) return "";
	const item = input[index - 1];
	if (!item) return "";
	const { id: _id, status: _status, ...stable } = item;
	return String(Bun.hash(JSON.stringify(stable)));
}

function resetOpenAIEffortControlState(state: OpenAIRequestControlState<string, unknown>): void {
	state.baseEffort = undefined;
	state.currentEffort = undefined;
	state.transitions = [];
}

/**
 * Discard the baseline when the request no longer continues the conversation
 * it was captured for: a wire history that shrank or was rewritten under a
 * recorded transition (compaction, branch switch, `/clear`). The next request
 * re-baselines from its own effort, which is what the API asks for after
 * compaction anyway.
 */
function syncOpenAIEffortControlState(
	state: OpenAIRequestControlState<string, unknown>,
	input: readonly AnchorableItem[],
): void {
	for (const transition of state.transitions) {
		if (transition.index > input.length || transition.anchor !== effortControlAnchor(input, transition.index)) {
			resetOpenAIEffortControlState(state);
			return;
		}
	}
}

/**
 * Pin the request-level effort to the session baseline and splice pending
 * `configuration_update` items into `input` (mutated in place).
 *
 * `input` is the freshly built transcript for this request, without any
 * `configuration_update` items. `requested` is the wire effort the caller
 * would otherwise send at the request level. `minimized` replaces it once a
 * baseline exists, where the change rides an update and keeps the cached
 * prefix; a request that sets the baseline runs at `requested`. Returns the
 * effort to send at the request level (the baseline).
 */
export function planStableOpenAIEffort<TItem extends AnchorableItem, TEffort extends string>(
	state: OpenAIRequestControlState<TEffort, unknown>,
	input: Array<TItem | ConfigurationUpdateItem>,
	requested: TEffort,
	minimized?: TEffort,
	toolInsertions: readonly OpenAIInputInsertion<NoInfer<TItem>>[] = [],
): TEffort {
	syncOpenAIEffortControlState(state, input);
	if (state.baseEffort === undefined) {
		state.baseEffort = requested;
		state.currentEffort = requested;
		insertOpenAIInputUpdates(input, toolInsertions);
		return requested;
	}
	const effort = minimized ?? requested;
	if (state.currentEffort !== effort) {
		const last = input[input.length - 1];
		const index = last && "role" in last && last.role === "user" ? input.length - 1 : input.length;
		const existing = state.transitions.find(transition => transition.index === index);
		if (existing) {
			existing.effort = effort;
		} else {
			state.transitions.push({ index, anchor: effortControlAnchor(input, index), effort });
		}
		// A change back to the effort already in force at that position is a
		// no-op on the wire; drop it rather than send a redundant item.
		let preceding = state.baseEffort;
		let precedingIndex = -1;
		for (const transition of state.transitions) {
			if (transition.index < index && transition.index > precedingIndex) {
				preceding = transition.effort;
				precedingIndex = transition.index;
			}
		}
		if (effort === preceding) {
			state.transitions = state.transitions.filter(transition => transition.index !== index);
		}
		state.currentEffort = effort;
	}
	insertOpenAIInputUpdates(input, [
		...state.transitions.map(({ index, effort }) => ({
			index,
			item: { type: "configuration_update" as const, reasoning: { effort } },
		})),
		...toolInsertions,
	]);
	return state.baseEffort;
}
