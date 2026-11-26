/** @jsxImportSource @oh-my-pi/pi-tui */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Accessor, computed, effect, For, type JSXNode, onCleanup, signal, untrack } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { ExtensionRunner } from "../../extensibility/extensions/runner";
import type { TranscriptBlock, TranscriptPresentation } from "../../extensibility/extensions/render-types";
import { messageFace } from "../../modes/interactive/messages";
import {
	cfgDisplayAdvisorCollapsedLines,
	cfgDisplayToolActivity,
	cfgTerminalShowImages,
} from "../../modes/settings";
import {
	messageBlock,
	onTranscriptPresentersChanged,
	resolveTranscriptPresentation,
} from "../../session/transcript/transcript-presentation";
import { splitAssistantMessageToolTimeline } from "../../session/transcript/transcript-render-helpers";
import "../styles/messages";
import "../styles/tools";
import "../tools";
import { cardExpansion } from "./expansion";
import { PresentedBlock } from "./figures/presented-block";
import { AssistantMessageBlock, type AssistantMessageModel } from "./messages/assistant-message";
import type { SideToolCalls } from "./side-tool-calls";
import { ToolBlock, type ToolCall } from "./tool-block";
import { toolPresentation } from "./tool-card-model";

export interface SideTranscriptDisplay {
	readonly runner: Accessor<ExtensionRunner | undefined>;
	readonly settings: Accessor<Settings | undefined>;
	readonly expanded: Accessor<boolean>;
	readonly presentation: (block: TranscriptBlock) => TranscriptPresentation;
}

/** Capture only the presentation of the session supplying this transcript, never the focused host. */
export function sideTranscriptDisplay(
	runner: Accessor<ExtensionRunner | undefined>,
	settings: Accessor<Settings | undefined>,
	expanded: Accessor<boolean>,
): SideTranscriptDisplay {
	const revision = signal(0);
	onCleanup(onTranscriptPresentersChanged(() => revision.update(value => value + 1)));
	const presenters = computed(() => (revision(), runner()?.getTranscriptPresenters() ?? []));
	return {
		runner,
		settings,
		expanded,
		presentation: block => resolveTranscriptPresentation(presenters(), block),
	};
}

export function SideToolCard(props: { readonly call: ToolCall; readonly display: SideTranscriptDisplay }): JSXNode {
	const { call, display } = props;
	const facts = call.facts;
	effect(() => {
		const value = display.expanded();
		untrack(() => {
			if (facts.expanded() !== value) call.setExpanded(value);
		});
	});
	effect(() => {
		const settings = display.settings();
		const showActivity = !settings || cfgDisplayToolActivity.get(settings) !== "hidden";
		const showImages = !settings || cfgTerminalShowImages.get(settings);
		untrack(() => {
			call.setActivityVisible(showActivity);
			call.setShowImages(showImages);
		});
	});
	effect(() => {
		const result = facts.result();
		const settings = display.settings();
		const presentation = toolPresentation(
			display.presentation({
				type: "toolCall",
				id: call.id,
				toolName: call.name,
				args: facts.args(),
				...(result ? { result } : {}),
				isError: result?.isError === true,
				isPartial: result === undefined || facts.partial(),
			}),
			settings ? cfgDisplayToolActivity.get(settings) : "detailed",
		);
		untrack(() => call.setPresentation(presentation));
	});
	return <ToolBlock call={call} />;
}

export function SideMessage(props: {
	readonly message: AgentMessage;
	readonly display: SideTranscriptDisplay;
}): JSXNode {
	const { display, message } = props;
	const activityVisible = () => {
		const settings = display.settings();
		return !settings || cfgDisplayToolActivity.get(settings) !== "hidden";
	};
	return () => {
		const runner = display.runner();
		const face = messageFace(message, {
			expanded: display.expanded,
			activityVisible,
			advisorCollapsedLines: () => {
				const settings = display.settings();
				return settings ? cfgDisplayAdvisorCollapsedLines.get(settings) : 0;
			},
			renderer: customType => runner?.getMessageRenderer(customType),
			onRenderError: (customType, error) =>
				logger.warn("Extension message renderer failed", { customType, error: String(error) }),
			imageLinks: () => undefined,
			skillPath: () => undefined,
			actions: () => false,
			hour12: () => undefined,
			promptZones: () => false,
			magicKeywords: () => [],
			onUserAction: () => {},
		});
		if (!face) return undefined;
		if (!face.presented) return face.face();
		const block = messageBlock(face.presented);
		const fold = cardExpansion(display.expanded);
		return (
			<PresentedBlock
				block={block}
				presentation={() => display.presentation(block)}
				expanded={fold.expanded}
				onToggle={fold.toggle}
				activityVisible={activityVisible}
			>
				{face.face({ expanded: fold.expanded, onToggle: value => fold.toggle(!value) })}
			</PresentedBlock>
		);
	};
}

export function SideAssistantBlock(props: {
	readonly model: AssistantMessageModel;
	readonly display: SideTranscriptDisplay;
}): JSXNode {
	const { display } = props;
	return (
		<AssistantMessageBlock
			model={{
				...props.model,
				expandThinking: display.expanded,
				textRenderers: () => display.runner()?.getAssistantTextRenderers() ?? [],
				thinkingRenderers: () => display.runner()?.getAssistantThinkingRenderers() ?? [],
			}}
		/>
	);
}

/** A complete reply (or its live tail) reads in the same order as Main: prose, tool, post-tool prose. */
export function SideReply(props: {
	readonly message: Accessor<AssistantMessage | undefined>;
	readonly tools: SideToolCalls;
	readonly display: SideTranscriptDisplay;
	readonly live?: boolean;
	readonly hideThinking?: Accessor<boolean>;
	readonly proseOnlyThinking?: boolean;
}): JSXNode {
	const { message, live, display, hideThinking, proseOnlyThinking } = props;
	const timeline = computed(() => {
		const current = message();
		return current ? splitAssistantMessageToolTimeline(current) : undefined;
	});
	const calls = computed(
		() =>
			message()?.content.flatMap(part => {
				if (part.type !== "toolCall") return [];
				const call = props.tools.get(part.id);
				return call ? [call] : [];
			}) ?? [],
	);
	const block = (
		segment: Accessor<AssistantMessage | undefined>,
		contentOffset: number,
		isTransient: Accessor<boolean>,
	): JSXNode => (
		<SideAssistantBlock
			display={display}
			model={{
				message: segment,
				contentOffset,
				finalized: () => !isTransient(),
				transient: isTransient,
				hideThinking,
				proseOnlyThinking,
				reacts: false,
			}}
		/>
	);
	const lead = computed(() => {
		const current = message();
		const split = timeline();
		if (!current || !split) return undefined;
		return current.stopReason === "aborted" || current.stopReason === "error"
			? {
					...split.beforeTools,
					stopReason: current.stopReason,
					errorMessage: current.errorMessage,
					retryRecovery: current.retryRecovery,
				}
			: split.beforeTools;
	});
	return [
		block(lead, 0, () => live === true && !timeline()?.hasToolCalls),
		<For each={calls}>
			{call => [
				<SideToolCard call={call} display={display} />,
				block(
					() => timeline()?.afterToolCalls.get(call.id),
					untrack(() => timeline()?.contentOffsets.get(call.id) ?? 0),
					() => live === true && call.id === timeline()?.lastToolCallId,
				),
			]}
		</For>,
	];
}
