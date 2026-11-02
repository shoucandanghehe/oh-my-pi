import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type {
	PaneSessionControls,
	PaneRestorableMessage,
	PaneQueuedMessageGroup,
	PaneToolUpdate,
} from "@oh-my-pi/pi-tui/chat/session-controls";
import { TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { AgentViewSession } from "../../session/agent-session-handle";
import type { AgentSession } from "../../session/agent-session";
import { parseCompactArgs } from "../../session/compact-modes";
import { sessionCommandQueue } from "../../session/session-command-queue";
import { parseQueueShorthand, splitQueuedMessages } from "@oh-my-pi/pi-tui/prompt/queue-input";
import { lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { conversationPosition } from "./conversation-position";
import { USER_INTERRUPT_LABEL } from "../../session/messages";

interface SessionPaneControlOptions<TSession extends AgentViewSession> {
	currentSession(): TSession | undefined;
	ensureSession(): Promise<TSession>;
	restore(message: PaneRestorableMessage): void;
	changed(): void;
	error(message: string): void;
	showTree(session: TSession, changed: () => void): void;
	knownCommand(text: string): boolean;
	prepareInput?(session: TSession, input: PaneRestorableMessage): Promise<PaneRestorableMessage | undefined>;
	abort?(session: TSession): Promise<void>;
	prompt?(
		session: TSession,
		input: PaneRestorableMessage,
		mode: "steer" | "followUp",
		onPromptAdmitted?: () => void,
	): Promise<void>;
	projectMessages?(manager: TSession["sessionManager"], session: TSession): readonly AgentMessage[];
}

/** View-local access to the standard session and its shared deferred-command barrier. */
export class SessionPaneControls<TSession extends AgentViewSession = AgentSession> implements PaneSessionControls {
	readonly #listeners = new Set<() => void>();
	#boundSession: TSession | undefined;
	#detach: (() => void) | undefined;
	#submissionTail: Promise<void> = Promise.resolve();
	#submissionGeneration = 0;
	#pendingSubmissions = 0;
	readonly #transcripts = new WeakMap<
		TSession,
		{
			leafId: string | null;
			streaming: boolean;
			branchKey: string;
			messages: readonly AgentMessage[];
		}
	>();

	constructor(private readonly options: SessionPaneControlOptions<TSession>) {}

	subscribe(changed: () => void): () => void {
		this.#listeners.add(changed);
		this.#bindSession(this.options.currentSession());
		return () => {
			this.#listeners.delete(changed);
			this.#bindSession(this.options.currentSession());
		};
	}

	dispose(): void {
		this.#detach?.();
		this.#detach = undefined;
		this.#boundSession = undefined;
		this.#listeners.clear();
	}

	#bindSession(session: TSession | undefined): void {
		const queue = session && sessionCommandQueue(session);
		const needed = Boolean(session && (this.#listeners.size || queue?.request || queue?.messages.length));
		if (session === this.#boundSession && needed) return;
		this.#detach?.();
		this.#detach = undefined;
		this.#boundSession = needed ? session : undefined;
		if (needed && session) {
			const changed = (): void => {
				this.#refresh(session);
				this.#notify();
			};
			const detachEvents = session.subscribe(changed);
			const detachEntries = session.sessionManager.subscribeToEntries(changed);
			this.#detach = () => {
				detachEvents();
				detachEntries();
			};
		}
	}

	#notify(): void {
		this.#bindSession(this.options.currentSession());
		this.options.changed();
		for (const listener of this.#listeners) listener();
	}

	#refresh(session: TSession | undefined): void {
		if (!session || session.isCompacting) return;
		const queue = sessionCommandQueue(session);
		if (queue.request || queue.isRunning || queue.isFlushing || !queue.messages.length) return;
		void this.#flush(session).catch(error => {
			this.#restoreCommands(session);
			this.options.error(`Cannot deliver queued input: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	getMessages(): readonly AgentMessage[] | undefined {
		const session = this.options.currentSession();
		this.#bindSession(session);
		this.#refresh(session);
		if (!session) return undefined;
		const manager = session.sessionManager;
		const leafId = manager.getLeafId();
		const streaming = session.isStreaming;
		const previous = this.#transcripts.get(session);
		if (previous?.leafId === leafId && previous.streaming === streaming) return previous.messages;
		const branchKey = manager
			.getBranch()
			.filter(entry => entry.type !== "custom" || entry.customType !== "btw:thread")
			.map(entry => entry.id)
			.join("\n");
		if (previous?.branchKey === branchKey && previous.streaming === streaming) {
			previous.leafId = leafId;
			return previous.messages;
		}
		const messages =
			this.options.projectMessages?.(manager, session) ??
			session.buildTranscriptSessionContext({ keepInFlightToolCalls: true, collapseCompactedHistory: true })
				.messages;
		this.#transcripts.set(session, { leafId, branchKey, streaming, messages });
		return messages;
	}

	getPending(): readonly PaneQueuedMessageGroup[] {
		const session = this.options.currentSession();
		this.#bindSession(session);
		this.#refresh(session);
		if (!session) return [];
		const snapshot = session.getQueuedMessages();
		const groups: PaneQueuedMessageGroup[] = [];
		for (const queueName of ["steering", "followUp"] as const) {
			const messages = snapshot[queueName];
			if (!messages.length) continue;
			groups.push({
				label: queueName === "steering" ? "Steering" : "After yield",
				messages,
				liveSteered: queueName === "steering" ? snapshot.liveSteered : undefined,
				edits: messages.map(
					(_, index) => session.getQueuedMessageEditAction(queueName, index) ?? (async () => undefined),
				),
			});
		}
		const queue = sessionCommandQueue(session);
		const request = queue.request;
		if (request)
			groups.push({
				label: "Compaction queued",
				messages: [request.text],
				edits: [
					async () => {
						if (queue.request !== request) return undefined;
						queue.request = undefined;
						this.#notify();
						return { text: `/queue ${request.text}` };
					},
				],
			});
		if (queue.messages.length) {
			const held = [...queue.messages];
			groups.push({
				label: "After compaction",
				messages: held.map(message => message.text),
				edits: held.map(message => async () => {
					const index = queue.messages.indexOf(message);
					if (index < 0) return undefined;
					queue.messages.splice(index, 1);
					this.#notify();
					return message;
				}),
			});
		}
		return groups;
	}

	isRunning(): boolean {
		const session = this.options.currentSession();
		return this.#pendingSubmissions > 0 || Boolean(session && (session.isStreaming || session.isCompacting));
	}

	getToolUpdates(): readonly PaneToolUpdate[] {
		const session = this.options.currentSession();
		return session ? [...session.activeToolExecutionUpdates(), ...session.activeToolStreamUpdates()] : [];
	}

	async abort(): Promise<void> {
		// Stop never initializes a parked child. Invalidate input still being prepared
		// and return deferred commands before an idle watcher can deliver them.
		this.#submissionGeneration++;
		const session = this.options.currentSession();
		if (!session) return;
		this.#restoreCommands(session);
		await (this.options.abort?.(session) ?? session.abort({ reason: USER_INTERRUPT_LABEL }));
		this.#notify();
	}

	async retry(): Promise<void> {
		const session = await this.options.ensureSession();
		this.#bindSession(session);
		if (!(await session.retry())) throw new Error("This session has no failed turn to retry");
		this.#notify();
	}

	async dequeue(): Promise<PaneRestorableMessage | undefined> {
		const session = await this.options.ensureSession();
		this.#bindSession(session);
		const queue = sessionCommandQueue(session);
		const held = queue.messages.pop();
		if (held) {
			this.#notify();
			return held;
		}
		if (queue.request) {
			const request = queue.request;
			queue.request = undefined;
			this.#notify();
			return { text: `/queue ${request.text}` };
		}
		const snapshot = session.getQueuedMessages();
		return (
			session.popLastQueuedMessage() ??
			(snapshot.liveSteered
				? await session.getQueuedMessageEditAction("steering", snapshot.liveSteered - 1)?.()
				: undefined)
		);
	}

	async submit(
		text: string,
		images?: ImageContent[],
		mode: "steer" | "followUp" = "steer",
		imageLinks?: (string | undefined)[],
	): Promise<void> {
		const command = parseSlashCommand(text);
		if (command?.name === "stop" || command?.name === "retry") {
			if (command.args.trim() || images?.length) throw new Error(`Usage: /${command.name}`);
			await (command.name === "stop" ? this.abort() : this.retry());
			return;
		}
		const input: PaneRestorableMessage = {
			text,
			images: images ? [...images] : undefined,
			imageLinks: imageLinks ? [...imageLinks] : undefined,
		};
		// Reserve both the source binding and admission order before preprocessing
		// can await hooks or attachment materialization. Release at admission, not
		// at turn completion, so the next submission can steer the running turn.
		const source = this.options.ensureSession();
		void source.catch(() => {});
		const previous = this.#submissionTail;
		const admission = Promise.withResolvers<void>();
		this.#submissionTail = admission.promise;
		const generation = this.#submissionGeneration;
		this.#pendingSubmissions++;
		this.#notify();
		let admitted = false;
		const release = (): void => {
			if (admitted) return;
			admitted = true;
			this.#pendingSubmissions--;
			admission.resolve();
			this.#notify();
		};
		try {
			await previous;
			const session = await source;
			this.#bindSession(session);
			if (generation !== this.#submissionGeneration) throw new Error("Pane input interrupted before submission");
			const prepared = this.options.prepareInput ? await this.options.prepareInput(session, input) : input;
			if (generation !== this.#submissionGeneration) throw new Error("Pane input interrupted before submission");
			if (!prepared) return;
			await this.#dispatch(session, prepared, mode, false, release);
			this.#notify();
		} finally {
			release();
		}
	}

	async #dispatch(
		session: TSession,
		input: PaneRestorableMessage,
		mode: "steer" | "followUp",
		admitOnly: boolean,
		onPromptAdmitted?: () => void,
	): Promise<void> {
		const { text, images } = input;
		const parsed = parseSlashCommand(text);
		const shorthand = parseQueueShorthand(text);
		if (parsed?.name === "queue" || shorthand !== undefined) {
			const split = splitQueuedMessages(shorthand ?? parsed?.args ?? "");
			const messages = split.length ? split : images?.length ? [""] : [];
			if (!messages.length) throw new Error("Usage: /queue <message> (or -> / =>)");
			for (const [index, message] of messages.entries()) {
				try {
					await this.#dispatch(
						session,
						{
							text: message,
							images: index === 0 ? images : undefined,
							imageLinks: index === 0 ? input.imageLinks : undefined,
						},
						"followUp",
						true,
					);
				} catch (error) {
					if (index === 0) throw error;
					for (const remaining of messages.slice(index)) this.options.restore({ text: remaining });
					this.options.error(error instanceof Error ? error.message : String(error));
					return;
				}
			}
			return;
		}
		if (parsed?.name === "stop" || parsed?.name === "retry") {
			if (admitOnly) throw new Error(`This command cannot be queued: /${parsed.name}`);
			if (parsed.args.trim() || images?.length) throw new Error(`Usage: /${parsed.name}`);
			await (parsed.name === "stop" ? this.abort() : this.retry());
			return;
		}
		const queue = sessionCommandQueue(session);
		if (mode === "followUp" && (queue.request || session.isCompacting)) {
			queue.messages.push({ ...input, mode });
			this.#notify();
			return;
		}
		if (parsed?.name === "compact") {
			const args = parseCompactArgs(parsed.args);
			if ("error" in args) throw new Error(args.error);
			if (images?.length) throw new Error("/compact does not accept attachments");
			if (mode === "followUp") {
				queue.request = { ...conversationPosition(session.sessionManager), text, ...args };
				this.#notify();
				if (!queue.isRunning) void this.#runQueuedCompact(session);
				return;
			}
			try {
				await session.compact(args.instructions, { mode: args.mode });
				await this.#flush(session);
			} catch (error) {
				this.#restoreCommands(session);
				throw error;
			}
			return;
		}
		if (parsed?.name === "tree") {
			if (session.isStreaming || session.isCompacting)
				throw new Error("Wait for the session to finish before navigating");
			this.options.showTree(session, () => this.#notify());
			return;
		}
		if (parsed?.name === "continue") {
			const result = await session.continuePausedAgents();
			if (!result.complete) throw new Error(result.skipped.join("\n"));
			return;
		}
		if (parsed && (lookupBuiltinSlashCommand(parsed.name) || this.options.knownCommand(text)))
			throw new Error(`This command is not available in this pane: /${parsed.name}`);
		if (session.hasPausedAgents())
			throw new Error("This session is paused; run /continue before sending another message");
		if (queue.request || session.isCompacting) {
			queue.messages.push({ ...input, mode });
			this.#notify();
		} else if (admitOnly) await this.#admit(session, input, mode);
		else await this.#prompt(session, input, mode, onPromptAdmitted);
	}

	async #prompt(
		session: TSession,
		input: PaneRestorableMessage,
		mode: "steer" | "followUp",
		onPromptAdmitted?: () => void,
	): Promise<void> {
		if (this.options.prompt) {
			await this.options.prompt(session, input, mode, onPromptAdmitted);
			return;
		}
		await session.prompt(input.text, {
			images: input.images,
			streamingBehavior: mode,
			expandPromptTemplates: true,
			runCommands: false,
			onPromptAdmitted,
		});
	}

	async #admit(session: TSession, input: PaneRestorableMessage, mode: "steer" | "followUp"): Promise<void> {
		const admission = Promise.withResolvers<void>();
		let admitted = false;
		void this.#prompt(session, input, mode, () => {
			admitted = true;
			admission.resolve();
		}).then(
			() => admission.resolve(),
			error => {
				if (!admitted) admission.reject(error);
				else {
					this.options.restore(input);
					this.options.error(error instanceof Error ? error.message : String(error));
				}
			},
		);
		await admission.promise;
	}

	async #runQueuedCompact(session: TSession): Promise<void> {
		const queue = sessionCommandQueue(session);
		try {
			await queue.run(session, {
				settleSubmissions: () => this.#submissionTail,
				isCurrent: () => this.options.currentSession() === session,
				hasPendingSubmission: () => this.#pendingSubmissions > 0,
				restore: () => this.#restoreCommands(session),
				changed: () => this.#notify(),
				flush: () => this.#flush(session),
				execute: async request => {
					try {
						await session.compact(request.instructions, { mode: request.mode });
					} catch (error) {
						queue.request = request;
						throw error;
					}
					await this.#flush(session);
				},
			});
		} catch (error) {
			this.#restoreCommands(session);
			this.options.error(`Queued compaction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#flush(session: TSession): Promise<void> {
		return sessionCommandQueue(session).drain(session, {
			execute: message => this.#dispatch(session, message, message.mode, true),
			restore: () => this.#restoreCommands(session),
			changed: () => this.#notify(),
		});
	}

	#restoreCommands(session: TSession): void {
		const queue = sessionCommandQueue(session);
		const entries: PaneRestorableMessage[] = [
			...(queue.request ? [{ text: `/queue ${queue.request.text}` }] : []),
			...queue.messages,
		];
		queue.request = undefined;
		queue.messages = [];
		queue.origin = undefined;
		for (const entry of entries) this.options.restore(entry);
		this.#notify();
	}
}

/** Tree UI shared by every local standard-session pane; the runtime remains the only branch owner. */
export function openPaneSessionTree(
	ui: TUI,
	session: AgentViewSession,
	host: {
		restore(message: PaneRestorableMessage): void;
		changed(): void;
		error(message: string): void;
		focus(): void;
	},
): () => void {
	let closed = false;
	const done = () => {
		if (closed) return;
		closed = true;
		handle.hide();
		selector.dispose();
		host.focus();
		host.changed();
	};
	const selector = new TreeSelectorComponent(
		session.sessionManager.getTree(),
		session.sessionManager.getLeafId(),
		ui.terminal.rows,
		(entryId, options) => {
			done();
			void session.navigateTree(entryId, { summarize: options.summarize, requireIdle: true }).then(
				result => {
					if (result.cancelled) return;
					if (result.editorText !== undefined)
						host.restore({ text: result.editorText, images: result.editorImages });
					host.changed();
				},
				error => host.error(`Tree navigation failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		},
		done,
		(id, label) => {
			void Promise.resolve(session.sessionManager.appendLabelChange(id, label)).catch(error =>
				host.error(`Label update failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		},
	);
	const handle = ui.showOverlay(selector, { width: "100%", maxHeight: "100%" });
	ui.setFocus(selector);
	host.changed();
	return done;
}
