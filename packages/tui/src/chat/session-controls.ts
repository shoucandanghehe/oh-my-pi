import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { QueuedMessageGroup } from "../prompt/queued-messages";
import type { SlashCommand } from "../autocomplete";

export type PaneToolUpdate = Extract<AgentEvent, { type: "tool_execution_update" | "tool_stream_update" }>;

/** Only commands implemented against the pane's own session. */
export const PANE_SESSION_SLASH_COMMANDS: readonly SlashCommand[] = [
	{ name: "queue", description: "Queue input after the current turn", argumentHint: "<message>", allowArgs: true },
	{ name: "compact", description: "Compact this session", argumentHint: "[mode] [focus]", allowArgs: true },
	{ name: "tree", description: "Navigate this session's conversation tree" },
	{ name: "continue", description: "Continue this paused session" },
	{ name: "stop", description: "Stop this session's current operation" },
	{ name: "retry", description: "Retry this session's last failed turn" },
];

/** A detached prompt returned to its originating pane editor. */
export interface PaneRestorableMessage {
	text: string;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
}

export interface PaneQueuedMessageGroup extends QueuedMessageGroup {
	edits: readonly (() => Promise<PaneRestorableMessage | undefined>)[];
}

/** Host-owned controls for the same durable session displayed by a pane. */
export interface PaneSessionControls {
	submit(
		text: string,
		images?: ImageContent[],
		mode?: "steer" | "followUp",
		imageLinks?: (string | undefined)[],
	): Promise<void>;
	dequeue(): Promise<PaneRestorableMessage | undefined>;
	abort(): Promise<void>;
	retry(): Promise<void>;
	isRunning(): boolean;
	getToolUpdates(): readonly PaneToolUpdate[];
	getPending(): readonly PaneQueuedMessageGroup[];
	/** Committed display context; unchanged snapshots retain their array identity. */
	getMessages(): readonly AgentMessage[] | undefined;
	subscribe(changed: () => void): () => void;
	dispose?(): void;
}
