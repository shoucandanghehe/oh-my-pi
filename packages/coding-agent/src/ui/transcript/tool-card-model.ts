import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { TspText } from "@oh-my-pi/pi-wire";
import type { TranscriptPresentation } from "../../extensibility/extensions/render-types";
import type { ToolActivityMode } from "../../modes/settings";
import type { EditMode } from "../../tools/details/edit";
import { defaultPresenter } from "../tools/default";
import { toolEditMode } from "../tools/edit";
import { legacyPresenter, type LegacyToolRenderer } from "../tools/legacy";
import { toolPresenter } from "../tools/registry";
import type { ToolCommandMounted } from "../tools/tool-command";
import { ToolCall, type ToolCallOptions, type ToolPresentation } from "./tool-block";

/** Build Main and side transcript cards from the tool's display metadata, never its execute hook. */
export function createTranscriptToolCall(
	options: ToolCallOptions & {
		readonly tool?: AgentTool;
		/** Unknown on old transcripts with no live session. */
		readonly builtIn?: boolean;
		readonly editMode?: EditMode;
	},
): ToolCall {
	const { tool, builtIn, editMode: mode, ...card } = options;
	const { name } = card;
	const registered = toolPresenter(name);
	const renderer = builtIn ? undefined : legacyRenderer(tool as (AgentTool & Partial<LegacyToolRenderer>) | undefined);
	// A same-named extension tool with no hooks draws a generic card, not the built-in face.
	const presenter = renderer
		? legacyPresenter(renderer, registered ?? defaultPresenter)
		: builtIn === false && registered
			? defaultPresenter
			: undefined;
	const call = new ToolCall({
		...card,
		label: card.label ?? (tool?.label || undefined),
		presenter: card.presenter ?? presenter,
		resolveToolCommand: card.resolveToolCommand ?? toolCommandResolver(tool),
	});
	const editMode = mode ?? toolEditMode(name, tool);
	if (editMode) call.setRenderContext({ editMode });
	return call;
}

/** A presenter's compact row as a tool card's presentation (no terminal control sequences). */
export function toolPresentation(answer: TranscriptPresentation, mode: ToolActivityMode): ToolPresentation {
	if (answer === undefined) return mode === "concise" ? "concise" : "full";
	if (answer === "full") return "full";
	if (answer === "hidden" || answer === "compact") return answer;
	const text = (value: TspText): TspText => (typeof value === "string" ? stripEscapes(value) : value);
	const { label, rows } = answer.compact;
	return {
		compact: {
			...(label !== undefined ? { label: text(label) } : {}),
			...(rows ? { rows: rows.map(text) } : {}),
		},
	};
}

function legacyRenderer(tool: Partial<LegacyToolRenderer> | undefined): LegacyToolRenderer | undefined {
	if (!tool?.renderCall && !tool?.renderResult) return undefined;
	return {
		...(tool.renderCall ? { renderCall: tool.renderCall.bind(tool) } : {}),
		...(tool.renderResult ? { renderResult: tool.renderResult.bind(tool) } : {}),
		...(tool.mergeCallAndResult !== undefined ? { mergeCallAndResult: tool.mergeCallAndResult } : {}),
	};
}

/** Lookup the mounted renderers for tool commands invoked from bash. */
function toolCommandResolver(
	tool: AgentTool | undefined,
): ((name: string) => ToolCommandMounted | undefined) | undefined {
	const session = (tool as { session?: { toolCommands?: { resolve?: (name: string) => unknown } } } | undefined)
		?.session;
	const resolve = session?.toolCommands?.resolve;
	if (!resolve) return undefined;
	return name => {
		const mounted = resolve(name) as (Partial<LegacyToolRenderer> & { label?: string }) | undefined;
		if (!mounted) return undefined;
		const legacy = legacyRenderer(mounted);
		const presenter = toolPresenter(name);
		return {
			...(mounted.label ? { label: mounted.label } : {}),
			...(presenter ? { presenter } : {}),
			...(legacy ? { legacy } : {}),
		};
	};
}
