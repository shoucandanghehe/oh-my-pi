import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { calculateContextTokens, hasContextTokenUsage } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Effort, ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import type { AgentSession } from "./agent-session";
import type { BtwExtensionRuntime } from "./btw-extension-runtime";
import { dedupeEphemeralReply } from "./messages";
import { buildSessionContext } from "./session-context";
import { SessionManager } from "./session-manager";

export interface EphemeralTurnOptions {
	promptText: string;
	images?: ImageContent[];
	onTextDelta?: (delta: string) => void;
	onThinkingDelta?: (delta: string) => void;
	onMessage?: (event: { type: "update"; message: AssistantMessage } | { type: "end"; message: AgentMessage }) => void;
	signal?: AbortSignal;
	/** Standard session admission, before preflight/provider dispatch. */
	onPromptAdmitted?: () => void;
	/** User pane turns may expand this child's own templates; synthetic callers keep literal input. */
	expandPromptTemplates?: boolean;
	dedupeReply?: boolean;
	/** UTF-8 byte cap after deduplication; `Infinity` keeps a long answer whole. */
	replyMaxBytes?: number;
}

export interface EphemeralConversationSideOptions {
	sendToMainSession?: (summary: string) => void | Promise<void>;
	approveSummary?: (summary: string, signal?: AbortSignal) => Promise<boolean>;
	/** Durable child transcript, independent from Main. */
	sessionManager?: SessionManager;
	/** Host-owned standard storage survives terminal child-runtime disposal. */
	onSessionClosed?: (manager: SessionManager) => void;
}

export interface EphemeralTurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
	intermediateMessages?: readonly AgentMessage[];
}

export interface EphemeralConversationTurn {
	input: string;
	images?: ImageContent[];
	assistantMessage: AssistantMessage;
	intermediateMessages?: readonly AgentMessage[];
	prefixMessages?: readonly AgentMessage[];
	replyText: string;
	timestamp: number;
}

export interface EphemeralConversationCheckpoint {
	baseMessages?: readonly AgentMessage[];
	turns: readonly EphemeralConversationTurn[];
	sideSessionId: string;
	/** Native messages after the last completed turn, including an interrupted assistant/tool cycle. */
	trailingMessages?: readonly AgentMessage[];
}

export interface FrozenEphemeralConversationCheckpoint extends EphemeralConversationCheckpoint {
	baseMessages: readonly AgentMessage[];
}

export interface EphemeralConversationStatus {
	sessionId: string;
	model: Model;
	thinkingLevel: Effort | undefined;
	isStreaming: boolean;
	latestAssistantMessage: AssistantMessage | undefined;
	stats: {
		tokens: {
			input: number;
			output: number;
			reasoning: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		premiumRequests: number;
		cost: number;
		contextUsage: { tokens: number; contextWindow: number; percent: number } | undefined;
	};
}

export interface EphemeralConversationOptions {
	snapshotBaseMessages: () => readonly AgentMessage[];
	checkpoint?: EphemeralConversationCheckpoint;
	sideSessionId: string;
	sessionManager?: SessionManager;
	onSessionClosed?: (manager: SessionManager) => void;
	/** Build the standard child session and its restricted extension binding. */
	createSession: (manager: SessionManager) => Promise<{ session: AgentSession; runtime?: BtwExtensionRuntime }>;
	/** Preserve secret redaction while streaming incomplete placeholder tokens. */
	textReadyForDelta?: (text: string) => string;
	prepareTurn?: (
		turn: Pick<EphemeralConversationTurn, "images" | "prefixMessages">,
		signal?: AbortSignal,
	) => Promise<Pick<EphemeralConversationTurn, "images" | "prefixMessages">>;
}

const CONTEXT_TYPE = "btw:context";

interface BtwProjectionCache {
	sessionId: string;
	leafId: string | null;
	checkpoint?: FrozenEphemeralConversationCheckpoint;
	contextInitialized?: boolean;
	messages?: AgentMessage[];
	messageSession?: AgentSession;
	messageStreaming?: boolean;
	usageFingerprint?: string;
	usage?: {
		tokens: EphemeralConversationStatus["stats"]["tokens"];
		premiumRequests: number;
		cost: number;
		latest?: AssistantMessage;
		context?: AssistantMessage;
	};
}

const projections = new WeakMap<SessionManager, BtwProjectionCache>();

interface BtwContextOrigin {
	sessionId: string;
	sideSessionId: string;
	markerId: string;
	inheritedIds: ReadonlySet<string>;
	baseMessages: readonly AgentMessage[];
}

const origins = new WeakMap<SessionManager, BtwContextOrigin>();

function contextOrigin(manager: SessionManager): BtwContextOrigin | undefined {
	const sessionId = manager.getSessionId();
	const existing = origins.get(manager);
	if (existing?.sessionId === sessionId) return existing;
	const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === CONTEXT_TYPE);
	if (marker?.type !== "custom") return undefined;
	const inherited = manager.getBranch(marker.id).filter(entry => entry.id !== marker.id);
	const lineage = marker.data;
	const sideSessionId =
		lineage && typeof lineage === "object" && "sideSessionId" in lineage && typeof lineage.sideSessionId === "string"
			? lineage.sideSessionId
			: sessionId;
	const origin = {
		sessionId,
		sideSessionId,
		markerId: marker.id,
		inheritedIds: new Set(inherited.map(entry => entry.id)),
		baseMessages: structuredClone(buildSessionContext(inherited, inherited.at(-1)?.id ?? null).messages),
	};
	origins.set(manager, origin);
	return origin;
}

function projectionCache(manager: SessionManager): BtwProjectionCache {
	const sessionId = manager.getSessionId();
	const leafId = manager.getLeafId();
	const previous = projections.get(manager);
	if (previous?.sessionId === sessionId && previous.leafId === leafId) return previous;
	const next = { sessionId, leafId };
	projections.set(manager, next);
	return next;
}

/** Provider-only replay of an unsigned text fragment; the native journal remains interrupted. */
export function replayInterruptedBtwText(messages: AgentMessage[]): AgentMessage[] {
	return messages.map(message =>
		message.role === "assistant" &&
		message.stopReason === "aborted" &&
		!message.providerPayload &&
		!message.responseId &&
		message.content.length > 0 &&
		message.content.every(block => block.type === "text" && !block.textSignature)
			? { ...message, stopReason: "stop" }
			: message,
	);
}

/** Seed a frozen context into a new child session. Subsequent writes belong to AgentSession. */
export function seedBtwConversation(manager: SessionManager, checkpoint: FrozenEphemeralConversationCheckpoint): void {
	if (manager.getEntries().some(entry => entry.type === "custom" && entry.customType === CONTEXT_TYPE)) return;
	if (manager.getEntries().some(entry => entry.type === "message" || entry.type === "custom_message")) {
		throw new Error("Cannot seed BTW context into a nonempty session");
	}
	const append = (message: AgentMessage): void => {
		// Frozen summaries are materialized messages, not child compaction operations.
		manager.appendMaterializedContextMessage(structuredClone(message));
	};
	for (const message of checkpoint.baseMessages) append(message);
	manager.appendCustomEntry(CONTEXT_TYPE, { sideSessionId: checkpoint.sideSessionId });
	for (const turn of checkpoint.turns) {
		for (const message of turn.prefixMessages ?? []) append(message);
		append({
			role: "user",
			content: [{ type: "text", text: turn.input }, ...(turn.images ?? [])],
			attribution: "agent",
			timestamp: turn.timestamp,
		});
		for (const message of turn.intermediateMessages ?? []) append(message);
		append(turn.assistantMessage);
	}
	for (const message of checkpoint.trailingMessages ?? []) append(message);
}

function replyText(messages: readonly AgentMessage[]): string {
	return messages
		.filter((message): message is AssistantMessage => message.role === "assistant")
		.flatMap(message => message.content)
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("")
		.trim();
}
/** Child-only display transcript with the standard compaction and tree semantics. */
export function projectBtwMessages(manager: SessionManager, session?: AgentSession): AgentMessage[] {
	const cache = projectionCache(manager);
	const streaming = session?.agent.state.isStreaming ?? false;
	if (cache.messages && cache.messageSession === session && cache.messageStreaming === streaming)
		return cache.messages;
	const origin = contextOrigin(manager);
	const entries = origin
		? manager.getBranch().filter(entry => entry.id !== origin.markerId && !origin.inheritedIds.has(entry.id))
		: [];
	cache.messages = session
		? session.buildTranscriptSessionContext({
				keepInFlightToolCalls: true,
				collapseCompactedHistory: true,
				excludeEntryIds: origin?.inheritedIds,
			}).messages
		: buildSessionContext(entries, entries.at(-1)?.id ?? null, undefined, {
				transcript: true,
				collapseCompactedHistory: true,
			}).messages;
	cache.messageSession = session;
	cache.messageStreaming = streaming;
	return cache.messages;
}

/** Compatibility projection of the selected standard session branch, never a second journal. */
export function projectBtwConversation(manager: SessionManager): FrozenEphemeralConversationCheckpoint {
	const cache = projectionCache(manager);
	if (cache.checkpoint) return cache.checkpoint;
	const origin = contextOrigin(manager);
	cache.contextInitialized = origin !== undefined;
	const baseMessages = origin?.baseMessages ?? [];
	const childEntries = origin
		? manager.getBranch().filter(entry => entry.id !== origin.markerId && !origin.inheritedIds.has(entry.id))
		: [];
	const childMessages = buildSessionContext(childEntries, childEntries.at(-1)?.id ?? null, undefined, {
		preserveInterruptedMessages: true,
	}).messages;
	const sideSessionId = origin?.sideSessionId ?? manager.getSessionId();
	const turns: EphemeralConversationTurn[] = [];
	let prefixes: AgentMessage[] = [];
	let input: Extract<AgentMessage, { role: "user" }> | undefined;
	let messages: AgentMessage[] = [];
	let trailingMessages: AgentMessage[] = [];
	const finish = (): void => {
		trailingMessages = input ? [...prefixes, input, ...messages] : [...prefixes];
		const last = messages.findLastIndex(message => message.role === "assistant");
		const assistantMessage = messages[last];
		if (
			input &&
			assistantMessage?.role === "assistant" &&
			(assistantMessage.stopReason === "stop" || assistantMessage.stopReason === "length") &&
			assistantMessage.stopDetails?.type !== "pause_turn"
		) {
			const content =
				typeof input.content === "string" ? [{ type: "text" as const, text: input.content }] : input.content;
			const images = content.filter((part): part is ImageContent => part.type === "image");
			turns.push({
				input: content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join(""),
				images: images.length ? images : undefined,
				prefixMessages: prefixes.length ? prefixes : undefined,
				assistantMessage,
				intermediateMessages: last > 0 ? messages.slice(0, last) : undefined,
				replyText: replyText(messages),
				timestamp: input.timestamp,
			});
			trailingMessages = [];
		}
	};
	for (const message of childMessages) {
		if (message.role === "user") {
			finish();
			if (input) {
				const lastAssistant = messages.findLastIndex(
					previous =>
						previous.role === "assistant" &&
						(previous.stopReason === "stop" || previous.stopReason === "length") &&
						previous.stopDetails?.type !== "pause_turn",
				);
				prefixes = lastAssistant < 0 ? [...prefixes, input, ...messages] : messages.slice(lastAssistant + 1);
			}
			input = message;
			messages = [];
		} else if (input) {
			messages.push(message);
		} else {
			prefixes.push(message);
		}
	}
	finish();
	cache.checkpoint = structuredClone({
		baseMessages,
		turns,
		sideSessionId,
		...(trailingMessages.length ? { trailingMessages } : {}),
	});
	return cache.checkpoint;
}

/** Async resource handle and UI projection over a complete, independent AgentSession. */
export class EphemeralConversation {
	readonly sessionManager: SessionManager;
	#session: AgentSession | undefined;
	readonly #options: EphemeralConversationOptions;
	#runtime: BtwExtensionRuntime | undefined;
	#initializing: Promise<void> | undefined;
	#disposing: Promise<void> | undefined;
	#disposed = false;
	#running = false;

	constructor(options: EphemeralConversationOptions) {
		this.#options = options;
		this.sessionManager = options.sessionManager ?? SessionManager.inMemory();
	}

	get session(): AgentSession | undefined {
		return this.#session;
	}

	get turns(): readonly EphemeralConversationTurn[] {
		return projectBtwConversation(this.sessionManager).turns;
	}

	get isRunning(): boolean {
		return this.#running || this.session?.isStreaming === true;
	}

	getTool(name: string): AgentTool | undefined {
		return this.session?.agent.state.tools.find(tool => tool.name === name);
	}

	get extensionRunner(): ExtensionRunner | undefined {
		return this.#runtime?.runner;
	}

	freeze(): FrozenEphemeralConversationCheckpoint {
		if (
			this.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === CONTEXT_TYPE)
		) {
			return this.checkpoint();
		}
		seedBtwConversation(this.sessionManager, {
			baseMessages: this.#options.checkpoint?.baseMessages ?? this.#options.snapshotBaseMessages(),
			turns: this.#options.checkpoint?.turns ?? [],
			trailingMessages: this.#options.checkpoint?.trailingMessages,
			sideSessionId: this.#options.sideSessionId,
		});
		return this.checkpoint();
	}

	checkpoint(): FrozenEphemeralConversationCheckpoint {
		const checkpoint = projectBtwConversation(this.sessionManager);
		if (!projectionCache(this.sessionManager).contextInitialized) {
			throw new Error("Cannot checkpoint an ephemeral conversation before freezing its context");
		}
		return checkpoint;
	}

	async initializeExtensionRuntime(): Promise<void> {
		if (this.#disposed) throw new Error("BTW extension runtime was disposed");
		if (this.session) return;
		this.freeze();
		this.#initializing ??= this.#options.createSession(this.sessionManager).then(async ({ session, runtime }) => {
			if (this.#disposed) {
				await session.dispose({
					pausedExit: session.hasPausedAgents(),
					onSessionClosed: this.#options.onSessionClosed,
				});
				return;
			}
			this.#session = session;
			this.#runtime = runtime;
		});
		await this.#initializing;
	}

	async disposeExtensionRuntime(): Promise<void> {
		this.#disposed = true;
		this.#disposing ??= (async () => {
			await this.#initializing?.catch(() => {});
			const session = this.session;
			this.#session = undefined;
			this.#runtime = undefined;
			await session?.dispose({
				pausedExit: session.hasPausedAgents(),
				onSessionClosed: this.#options.onSessionClosed,
			});
		})();
		await this.#disposing;
	}

	get status(): EphemeralConversationStatus | undefined {
		const session = this.session;
		const model = session?.model;
		if (!session || !model) return undefined;
		const cache = projectionCache(this.sessionManager);
		const usageFingerprint = JSON.stringify(this.sessionManager.getUsageStatistics());
		if (!cache.usage || cache.usageFingerprint !== usageFingerprint) {
			const origin = contextOrigin(this.sessionManager);
			const messages = projectBtwMessages(this.sessionManager, session);
			const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
			let premiumRequests = 0;
			let cost = 0;
			const latest = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
			const context = messages.findLast(
				(message): message is AssistantMessage =>
					message.role === "assistant" && hasContextTokenUsage(message.usage),
			);
			for (const entry of this.sessionManager.getEntries()) {
				if (origin?.inheritedIds.has(entry.id)) continue;
				const usage =
					entry.type === "model_usage"
						? entry.usage
						: entry.type === "message" && entry.message.role === "assistant"
							? entry.message.usage
							: undefined;
				if (!usage) continue;
				tokens.input += usage.input;
				tokens.output += usage.output;
				tokens.reasoning += usage.reasoningTokens ?? 0;
				tokens.cacheRead += usage.cacheRead;
				tokens.cacheWrite += usage.cacheWrite;
				tokens.total += usage.totalTokens;
				premiumRequests += usage.premiumRequests ?? 0;
				cost += usage.cost.total;
			}
			cache.usage = { tokens, premiumRequests, cost, latest, context };
			cache.usageFingerprint = usageFingerprint;
		}
		const committed = cache.usage;
		const stream = session.agent.state.streamMessage;
		const assistant = stream?.role === "assistant" ? stream : undefined;
		const streamUsage = assistant?.usage;
		const tokens = {
			input: committed.tokens.input + (streamUsage?.input ?? 0),
			output: committed.tokens.output + (streamUsage?.output ?? 0),
			reasoning: committed.tokens.reasoning + (streamUsage?.reasoningTokens ?? 0),
			cacheRead: committed.tokens.cacheRead + (streamUsage?.cacheRead ?? 0),
			cacheWrite: committed.tokens.cacheWrite + (streamUsage?.cacheWrite ?? 0),
			total: committed.tokens.total + (streamUsage?.totalTokens ?? 0),
		};
		const context = assistant && hasContextTokenUsage(assistant.usage) ? assistant : committed.context;
		const contextTokens = context ? calculateContextTokens(context.usage) : undefined;
		const contextWindow = model.contextWindow ?? 0;
		return {
			sessionId: this.checkpoint().sideSessionId,
			model,
			thinkingLevel: session.agent.state.thinkingLevel,
			isStreaming: session.isStreaming,
			latestAssistantMessage: assistant ?? committed.latest,
			stats: {
				tokens,
				premiumRequests: committed.premiumRequests + (streamUsage?.premiumRequests ?? 0),
				cost: committed.cost + (streamUsage?.cost.total ?? 0),
				contextUsage:
					contextTokens === undefined
						? undefined
						: {
								tokens: contextTokens,
								contextWindow,
								percent: contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0,
							},
			},
		};
	}

	async prompt(input: string, options: Omit<EphemeralTurnOptions, "promptText"> = {}): Promise<EphemeralTurnResult> {
		if (this.isRunning) throw new Error("Ephemeral conversation already has a turn in progress");
		this.#running = true;
		try {
			await this.initializeExtensionRuntime();
			const session = this.session;
			if (!session) throw new Error("BTW extension runtime was disposed");
			options.signal?.throwIfAborted();
			const prepared = this.#options.prepareTurn
				? await this.#options.prepareTurn({ images: options.images }, options.signal)
				: { images: options.images };
			options.signal?.throwIfAborted();
			for (const message of prepared.prefixMessages ?? []) {
				if (message.role === "compactionSummary" || message.role === "branchSummary") {
					throw new Error("BTW prompt prefixes cannot enact a context rewrite");
				}
				this.sessionManager.appendMessage(message);
				session.agent.appendMessage(message);
			}
			const start = session.messages.length;
			let aborting: Promise<void> | undefined;
			const abort = (): void => {
				const reason: unknown = options.signal?.reason;
				aborting ??= session.abort({
					reason: reason instanceof Error ? reason.message : reason === undefined ? undefined : String(reason),
				});
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			let providerText = "";
			let emittedText = "";
			const emitText = (text: string): void => {
				if (text.length > emittedText.length) {
					options.onTextDelta?.(text.slice(emittedText.length));
					emittedText = text;
				}
			};
			const detach = session.subscribe(event => {
				if (event.type === "message_end" && event.message.role !== "user") {
					options.onMessage?.({ type: "end", message: event.message });
				} else if (event.type === "message_update" && event.message.role === "assistant") {
					options.onMessage?.({ type: "update", message: event.message });
					const update = event.assistantMessageEvent;
					if (update.type === "text_delta") {
						providerText += update.delta;
						emitText(this.#options.textReadyForDelta?.(providerText) ?? providerText);
					}
					if (update.type === "thinking_delta") options.onThinkingDelta?.(update.delta);
				}
			});
			try {
				await session.prompt(input, {
					images: prepared.images,
					attribution: "agent",
					expandPromptTemplates: options.expandPromptTemplates ?? false,
					runCommands: false,
					onPromptAdmitted: options.onPromptAdmitted,
				});
				if (session.agent.state.error) throw new Error(session.agent.state.error);
				options.signal?.throwIfAborted();
				const messages = session.messages.slice(start + 1);
				const final = messages.findLastIndex(message => message.role === "assistant");
				const assistantMessage = messages[final];
				if (assistantMessage?.role !== "assistant") throw new Error("BTW turn ended without an assistant message");
				const text = replyText(messages);
				emitText(text);
				return {
					replyText: options.dedupeReply === false ? text : dedupeEphemeralReply(text, options.replyMaxBytes),
					assistantMessage,
					intermediateMessages: messages.slice(0, final),
				};
			} finally {
				detach();
				options.signal?.removeEventListener("abort", abort);
				await aborting;
			}
		} finally {
			this.#running = false;
		}
	}
}
