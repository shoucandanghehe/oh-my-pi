import type { OpenAIInputInsertion } from "./openai-configuration-update";
import type { ToolChoiceAllowed } from "./openai-responses-wire";

interface ToolAddition<TTool> {
	index: number;
	prefix: bigint | number;
	definitions: TTool[];
}

export interface OpenAIToolControlState<TTool> {
	/** Ordered wire definitions; null preserves an omitted top-level `tools` field. */
	declared?: TTool[] | null;
	additions: ToolAddition<TTool>[];
}

export interface OpenAIAdditionalTools<TTool> {
	type: "additional_tools";
	role: "developer";
	tools: TTool[];
}

/** Tool declarations actually sent, including the positions of inline declarations. */
export function fingerprintOpenAIToolDeclarations(request: { input?: unknown; tools?: unknown }): string {
	const additions: Array<[number, object]> = [];
	if (Array.isArray(request.input)) {
		for (const [index, item] of request.input.entries()) {
			if (item && typeof item === "object" && "type" in item && item.type === "additional_tools") {
				additions.push([index, item]);
			}
		}
	}
	return JSON.stringify([request.tools, additions]);
}

interface ToolIdentity {
	type: string;
	name?: string;
}

function toolKey(tool: ToolIdentity): string {
	return tool.name === undefined ? `type:${tool.type}` : `name:${tool.name}`;
}

/** Plan against the unmodified transcript; Lite's leading declaration is not part of its tool history. */
export function planStableOpenAITools<TTool extends ToolIdentity>(
	state: OpenAIToolControlState<TTool>,
	input: readonly { type?: string | null; role?: string; id?: string | null; status?: string | null }[],
	tools: TTool[] | undefined,
	options: { lite?: boolean; sideRequest: boolean; toolsDisabled: boolean },
): {
	declared: TTool[] | undefined;
	insertions: OpenAIInputInsertion<OpenAIAdditionalTools<TTool>>[];
	choice?: ToolChoiceAllowed | "none";
} {
	const start = options.lite ? 1 : 0;
	const active = new Map(tools?.map(tool => [toolKey(tool), tool]));
	const rebaseline = () => {
		state.declared = tools === undefined ? null : structuredClone(tools);
		state.additions = [];
		return { declared: tools, insertions: [] };
	};
	if (state.declared === undefined || active.size !== (tools?.length ?? 0)) return rebaseline();

	const known = new Map(
		[...(state.declared ?? []), ...state.additions.flatMap(addition => addition.definitions)].map(tool => [
			toolKey(tool),
			tool,
		]),
	);
	let withdrawn = false;
	for (const [key, previous] of known) {
		const current = active.get(key);
		if (!current) withdrawn = true;
		else if (JSON.stringify(previous) !== JSON.stringify(current)) return rebaseline();
	}

	let choice: ToolChoiceAllowed | "none" | undefined;
	if (withdrawn) {
		// Side requests have their own tool scope. Also leave native caller-supplied
		// declarations alone: their callable tools are not described by `tools`.
		if (
			options.sideRequest ||
			(!options.toolsDisabled && input.some((item, index) => index >= start && item.type === "additional_tools"))
		) {
			return rebaseline();
		}
		if (options.toolsDisabled || active.size === 0) {
			choice = "none";
		} else if (options.lite) {
			// Selective allowlists are verified on Full; Lite keeps its existing declaration contract.
			return rebaseline();
		} else {
			choice = {
				type: "allowed_tools",
				mode: "auto",
				tools: [...active.values()].map(tool =>
					tool.name === undefined ? { type: tool.type } : { type: tool.type, name: tool.name },
				),
			};
		}
	}
	const added = [...active].flatMap(([key, tool]) => (known.has(key) ? [] : [tool]));
	const index = input.at(-1)?.role === "user" ? input.length - 1 : input.length;
	if (state.additions.length > 0 || added.length > 0) {
		const prefixes = new Map<number, bigint | number>();
		const positions = new Set([...state.additions.map(addition => addition.index), index]);
		let prefix: bigint | number = 0;
		for (let cursor = start; cursor <= index; cursor++) {
			if (positions.has(cursor)) prefixes.set(cursor, prefix);
			if (cursor === index) break;
			const { id: _id, status: _status, ...item } = input[cursor]!;
			prefix = Bun.hash(JSON.stringify(item), prefix);
		}
		if (state.additions.some(addition => prefixes.get(addition.index) !== addition.prefix)) return rebaseline();
		if (added.length > 0) state.additions.push({ index, prefix, definitions: structuredClone(added) });
	}

	// Never expose retained definitions to request hooks by reference.
	const replay = (definitions: TTool[]) => definitions.map(tool => active.get(toolKey(tool)) ?? structuredClone(tool));

	return {
		declared: state.declared ? replay(state.declared) : undefined,
		choice,
		insertions: state.additions.map(addition => ({
			index: addition.index,
			item: {
				type: "additional_tools",
				role: "developer",
				tools: replay(addition.definitions),
			},
		})),
	};
}
