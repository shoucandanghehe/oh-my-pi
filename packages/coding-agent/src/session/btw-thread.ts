import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { EphemeralConversationTurn } from "./ephemeral-conversation";

export interface BtwThreadModelRef {
	provider: string;
	id: string;
}

export interface BtwPromotionRequest {
	anchorLeafId: string;
	sessionId: string;
	turns: readonly EphemeralConversationTurn[];
	/** Effective standard history, including consecutive inputs and tool messages. */
	messages?: readonly AgentMessage[];
}

export interface BtwPromotionLifecycle {
	prepare(): void | Promise<void>;
	rollback(): void | Promise<void>;
}

interface BtwThreadEventBase {
	version: 1;
	key: string;
}

export type BtwThreadEvent =
	| (BtwThreadEventBase & {
			op: "create";
			title: string;
			titleExplicit?: boolean;
			createdAt: number;
			anchorLeafId: string;
			model: BtwThreadModelRef;
	  })
	| (BtwThreadEventBase & { op: "title"; title: string })
	| (BtwThreadEventBase & { op: "draft"; text: string; images?: ImageContent[]; imageLinks?: (string | undefined)[] })
	| (BtwThreadEventBase & { op: "read"; through: number })
	| (BtwThreadEventBase & { op: "request"; input?: string; images?: ImageContent[]; timestamp?: number })
	| (BtwThreadEventBase & { op: "terminal"; error?: string })
	| (BtwThreadEventBase & { op: "remove"; reason: "deleted" | "promoted" });

export interface RestoredBtwThread {
	key: string;
	title: string;
	/** User-supplied headings must survive restoration without automatic renaming. */
	titleExplicit?: boolean;
	createdAt: number;
	anchorLeafId: string;
	model: BtwThreadModelRef;
	sideSessionId: string;
	baseMessages: readonly AgentMessage[];
	turns: readonly EphemeralConversationTurn[];
	draft: string;
	draftImages: ImageContent[];
	draftImageLinks: (string | undefined)[];
	readThrough: number;
	phase: "ready" | "error";
	error?: string;
}
