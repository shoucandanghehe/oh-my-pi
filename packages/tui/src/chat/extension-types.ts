import type { AssistantMessage, ThinkingContent } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "../tui";
import type { Theme } from "../theme/theme";
import type { CustomMessage, HookMessage } from "./messages";

export type ExtensionUiComponent = Component & { dispose?(): void };

export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;

export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

/** A mounted view's presentation callbacks, without an interactive extension host. */
export interface ExtensionPresentationObserver {
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
	setStatus(key: string, text: string | undefined): void;
}

/** Replays current presentation and follows changes until the observer detaches. */
export interface ExtensionPresentationSource {
	observePresentation(observer: ExtensionPresentationObserver): () => void;
}

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface AssistantThinkingRenderContext {
	/** Stable parent message metadata for renderer-local async state. */
	message: Readonly<Pick<AssistantMessage, "timestamp" | "responseId" | "api" | "provider" | "model">>;
	/** Provider-native reasoning identity; fall back to the block indices. */
	content: Readonly<Pick<ThinkingContent, "itemId" | "thinkingSignature">>;
	contentIndex: number;
	thinkingIndex: number;
	text: string;
	requestRender(): void;
}

export type AssistantThinkingRenderResult =
	| Component
	| { type: "append"; component: Component }
	| { type: "replace"; component: Component }
	| undefined;

export type AssistantThinkingRenderer = (
	context: AssistantThinkingRenderContext,
	theme: Theme,
) => AssistantThinkingRenderResult;

export interface AssistantTextRenderContext {
	/**
	 * The message being drawn; `message.timestamp` identifies the reply for `ctx.ui.rerenderMessage()`.
	 * After a tool call this is only the segment drawn there, so its `content` does not hold the whole reply.
	 * A deep copy: editing it, at any depth, cannot change the stored reply.
	 */
	message: AssistantMessage;
	/**
	 * The text block's index in the full reply's `content`, also when the reply is drawn in segments
	 * around tool calls; not an index into `message.content` for a segment. It counts the content as
	 * currently stored: a transcript rebuild that drops tool calls left without a result shifts later
	 * blocks down, so do not persist it as a permanent key.
	 */
	contentIndex: number;
	/** The block's markdown as drawn so far, after any earlier renderer. */
	text: string;
	/** True while the block may still grow; false for its final render, a block sealed at a tool call, and later redraws. */
	streaming: boolean;
}

/**
 * Display-only transform of one assistant text block: returns the markdown to draw, or `undefined`
 * to draw `context.text` unchanged. The session, exports and model context keep the original text.
 */
export type AssistantTextRenderer = (context: AssistantTextRenderContext) => string | undefined;

/** Extension text renderers for one assistant component, and where its content starts in the full reply. */
export interface AssistantTextRendering {
	renderers: readonly AssistantTextRenderer[];
	/** Index in the full reply's `content` of this component's first block; a segment after a tool call starts past it. */
	contentOffset: number;
}

export interface HookMessageRenderOptions {
	/** Whether the view is expanded */
	expanded: boolean;
}

/**
 * Renderer for hook messages.
 * Hooks register these to provide custom TUI rendering for their message types.
 */
export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
	theme: Theme,
) => Component | undefined;
