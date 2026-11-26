/** @jsxImportSource @oh-my-pi/pi-tui */
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { createSurface, effect, onCleanup, Show, untrack, type KeyEvent } from "@oh-my-pi/pi-tui";
import { CombinedAutocompleteProvider } from "../autocomplete/autocomplete";
import { getKeybindings } from "../config/keybindings/keybindings";
import {
	appFollowUpKeys,
	appToolsExpandKeys,
	matchesAnyKey,
	matchesAppInterrupt,
} from "../config/keybindings/matchers";
import type { Settings } from "../config/settings";
import type { AgentLifecycleApi } from "../registry/agent-lifecycle";
import type { AgentHubRegistry } from "../registry/agent-hub-types";
import type { AgentRef } from "../registry/agent-registry";
import { type AgentViewSession, isAgentViewSession } from "../session/agent-session-handle";
import { parseCompactArgs } from "../session/compact-modes";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import {
	type CompactionQueuedMessage,
	queueEntriesForDraft,
	sessionCommandQueue,
} from "../session/session-command-queue";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { restoreDetachedDraft } from "../slash-commands/helpers/draft";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { Composer } from "../ui/composer/composer";
import { QueueModel, QueuedMessages } from "../ui/dock/queue";
import { PaneExtensionWidgets, useExtensionPresentation } from "../ui/dock/widgets";
import { AgentTranscriptViewerModel } from "../ui/overlays/panels/agent-transcript-viewer-model";
import { AgentWorkspaceStatus, AgentWorkspaceTranscript } from "../ui/overlays/panels/agent-transcript-viewer";
import { TreeSelector } from "../ui/overlays/pickers/tree-selector";
import { Overlays } from "../ui/shell/overlays";
import { StatusLine } from "../ui/status/status-line";
import {
	copyToClipboard,
	isClipboardTerminalLocal,
	readClipboardContent,
	readTextFromClipboard,
} from "../utils/clipboard";
import { EnhancedPasteController } from "../utils/enhanced-paste";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import { htmlToPaste } from "../utils/html-paste";
import { ensureSupportedImageInput } from "../utils/image-input";
import { agentTranscriptSource } from "./agent-hub-runtime";
import { firstOfKind } from "./controllers/selector-views";
import { SessionStatusLine } from "./interactive/status-line";
import { cfgAutocompleteMaxVisible, cfgTuiVimMode, cfgTuiVimStartMode, cfgTuiVimYankToClipboard } from "./settings";
import type { NativeWorkspaceSurface } from "./native-workspace/workspace";
import type { AgentHubRemote } from "./view-model/overlays/agent-hub";
import { compactImageMarkers, shiftImageMarkers } from "./view-model/prompt/composer-attachments";
import {
	formatQueueShorthand,
	mergeQueueEntries,
	parseQueueShorthand,
	splitQueuedMessages,
} from "./view-model/prompt/queue-input";
import { materializeImageChipLinks } from "./utils/ui-helpers";
import { conversationPosition } from "./utils/conversation-position";

const COMMANDS = [
	{ name: "stop", description: "Interrupt this agent" },
	{ name: "retry", description: "Retry this agent’s last failed turn" },
	{ name: "continue", description: "Continue this agent" },
	{ name: "queue", description: "Queue a follow-up", argumentHint: "<message>", allowArgs: true },
	{ name: "compact", description: "Compact this agent’s context", argumentHint: "[mode] [focus]", allowArgs: true },
	{ name: "tree", description: "Navigate this agent’s history" },
];

/** An entry remains in the barrier until admission; it can still be restored by interrupt. */
const drainingHeld = new WeakSet<CompactionQueuedMessage>();

interface Draft {
	text: string;
	images?: ImageContent[];
	links?: (string | undefined)[];
	cursor?: number;
}

/** A draft outlives its renderer; asynchronous failures still go back to this agent's draft. */
export class AgentPaneDraft {
	#saved: Draft = { text: "" };
	#composer: Composer | undefined;

	attach(composer: Composer): void {
		this.#composer = composer;
		const { text, images, links, cursor } = this.#saved;
		composer.setDraft(text, images);
		if (links) composer.pendingImageLinks.splice(0, links.length, ...links);
		composer.relinkImages();
		if (cursor !== undefined) composer.setCursor(cursor);
	}

	detach(composer: Composer): void {
		if (this.#composer !== composer) return;
		this.#saved = {
			text: composer.expandedText(),
			images: [...composer.pendingImages],
			links: [...composer.pendingImageLinks],
			cursor: composer.cursor(),
		};
		this.#composer = undefined;
	}

	restore(draft: Draft): void {
		if (this.#composer) {
			restoreDetachedDraft(this.#composer, draft.text, draft.images, draft.links);
			return;
		}
		const old = this.#saved;
		const prefix = shiftImageMarkers(draft.text, old.images?.length ?? 0);
		this.#saved = {
			text: [prefix, old.text].filter(text => text.trim()).join("\n\n"),
			images: [...(old.images ?? []), ...(draft.images ?? [])],
			links: [...(old.links ?? []), ...(draft.links ?? draft.images?.map(() => undefined) ?? [])],
		};
	}
}

interface AgentPaneOptions {
	readonly agentId: string;
	readonly close: () => void;
	readonly rows: () => number;
	readonly columns: () => number;
	readonly writeRaw?: (data: string) => void;
	readonly registry: Pick<AgentHubRegistry<AgentRef>, "get">;
	readonly lifecycle?: Pick<AgentLifecycleApi, "ensureLive">;
	readonly remote?: AgentHubRemote;
	readonly settings: Settings;
	readonly draft: AgentPaneDraft;
	readonly isCurrent: () => boolean;
	readonly knownCommand: (text: string) => boolean;
	readonly copyText?: (text: string) => Promise<void>;
	readonly editInTerminal?: (run: () => Promise<string | null>) => Promise<string | null>;
}

export interface AgentWorkspaceSurface extends NativeWorkspaceSurface {
	/** A pane with a draft, an open picker or any user interaction is kept after the run. */
	protectedFromAutoClose(): boolean;
}

/** One transcript, composer and overlay stack bound to one agent, never the app's focused session. */
export function mountAgentWorkspacePane(options: AgentPaneOptions): AgentWorkspaceSurface {
	const { agentId, close, rows, registry, lifecycle, remote, draft } = options;
	const keybindings = getKeybindings();
	const ref = () => (options.isCurrent() ? registry.get(agentId) : undefined);
	const current = (): AgentViewSession | undefined => {
		const session = ref()?.session;
		return session && isAgentViewSession(session) ? session : undefined;
	};
	const ensure = async (): Promise<AgentViewSession> => {
		if (!ref() || !lifecycle) throw new Error(`Agent ${agentId} is unavailable`);
		const session = await lifecycle.ensureLive(agentId);
		if (!isAgentViewSession(session) || current()?.instanceKey !== session.instanceKey) {
			throw new Error(`Agent ${agentId} changed before the pane operation could run`);
		}
		return session;
	};
	let disposed = false;
	let interacted = false;
	let generation = 0;
	let submissionTail = Promise.resolve();
	let preparingAdmissions = 0;
	let submitMode: "steer" | "followUp" = "steer";
	let composer: Composer;
	const sendable = ref()?.kind !== "advisor" && (lifecycle !== undefined || remote !== undefined);
	const local = sendable && lifecycle !== undefined && !remote;
	const queueModel = new QueueModel();
	queueModel.dequeueKey.set(keybindings.keysFor("app.message.dequeue")[0] ?? "alt+up");
	queueModel.onEdit = dequeue;
	const model = new AgentTranscriptViewerModel({
		agentId,
		transcript: agentTranscriptSource,
		registry: { get: id => (id === agentId ? ref() : undefined) },
		liveSession: current,
		remote,
		settings: current()?.settings ?? options.settings,
		terminalRows: rows,
		expandKeys: keybindings.keysFor("app.tools.expand"),
		hubKeys: [],
		actions: {
			prompt: (act, text) => {
				if (act === "copy-message") copy(text);
			},
			reply: (act, message, text) => {
				if ((act === "copy-answer" || act === "copy-error") && text) copy(text);
				if (act === "retry" && canRetry(message)) retryFromPane();
			},
			allowAction: (act, message) =>
				act === "copy-message" ||
				act === "copy-answer" ||
				act === "copy-error" ||
				(act === "retry" && message !== undefined && canRetry(message)),
		},
		onClose: close,
		onHubClose: close,
	});
	function notice(message: string | undefined): void {
		if (disposed) return;
		model.notice = message;
		model.touch();
	}

	function copy(text: string): void {
		if (!text || disposed || !ref()) return;
		interacted = true;
		void (options.copyText ?? copyToClipboard)(text).catch(error => notice(`Copy failed: ${String(error)}`));
	}

	function canRetry(message: AssistantMessage): boolean {
		if (!local || message.stopReason !== "error") return false;
		const last = model.blocks().findLast(block => block.kind === "assistant" && block.actionMessage !== undefined);
		return last?.kind === "assistant" && last.actionMessage === message;
	}

	async function retry(session: AgentViewSession): Promise<void> {
		if (!(await session.retry())) throw new Error("This agent has no failed turn to retry");
	}

	function retryFromPane(): void {
		interacted = true;
		void ensure()
			.then(session => {
				if (!disposed) return retry(session);
			})
			.catch(error => notice(String(error)));
	}

	function updateQueue(session = current()): void {
		if (disposed || session !== current()) return;
		const queued = session?.getQueuedMessages();
		const held = session && sessionCommandQueue(session);
		const request = held?.request;
		queueModel.groups.set(
			queued
				? [
						{ label: "Steering", messages: queued.steering },
						{ label: "After yield", messages: queued.followUp },
						{ label: "Compaction queued", messages: request ? [request.text] : [] },
						{
							label: "After compaction",
							messages:
								held?.messages.filter(message => !drainingHeld.has(message)).map(message => message.text) ?? [],
						},
					]
				: [],
		);
	}

	function dequeue(): void {
		interacted = true;
		const session = current();
		if (!session || disposed || !local) return;
		const held = sessionCommandQueue(session);
		const queued = session.getQueuedMessages();
		// As in Main, unclaimed steering takes precedence. The runtime pop never
		// withdraws steering the model already took or follow-ups it claimed.
		let message = queued.steering.length > queued.liveSteered ? session.popLastQueuedMessage() : undefined;
		const last = held.messages.at(-1);
		let restored: Draft | undefined;
		if (!message && last && !drainingHeld.has(last)) {
			held.messages.pop();
			restored = {
				text: last.mode === "followUp" ? formatQueueShorthand([last.text]) : last.text,
				images: last.images,
				links: last.imageLinks,
			};
		} else if (!message && held.request) {
			restored = { text: `/queue ${held.request.text}` };
			held.request = undefined;
		} else {
			message ??= session.popLastQueuedMessage();
			if (message)
				restored = {
					text: message.queue === "followUp" ? formatQueueShorthand([message.text]) : message.text,
					images: message.images,
				};
		}
		if (restored) draft.restore(restored);
		else notice("This agent has no queued messages to restore");
		updateQueue(session);
		surface.focus(composer.field);
	}

	function tree(session: AgentViewSession): void {
		if (session.isStreaming || session.isCompacting)
			throw new Error("Wait for this agent before navigating its tree");
		const roots = session.sessionManager.getTree();
		if (!roots.length) throw new Error("This agent has no session entries");
		const sheet = overlays.show(
			() => (
				<overlay key="agent-tree" page={{ role: "omp.tree" }}>
					<TreeSelector
						roots={roots}
						currentLeafId={session.sessionManager.getLeafId()}
						terminalHeight={rows()}
						onCancel={() => sheet.close()}
						onSelect={(id, { summarize }) => {
							sheet.close();
							if (current() !== session) return;
							void session
								.navigateTree(id, { summarize, requireIdle: true })
								.then(result => {
									if (!result.cancelled && result.editorText !== undefined) {
										draft.restore({ text: result.editorText, images: result.editorImages });
									}
									model.poll();
								})
								.catch(error => notice(String(error)));
						}}
						onLabelChange={(id, label) => {
							if (current() === session) {
								void Promise.resolve(session.sessionManager.appendLabelChange(id, label)).catch(error =>
									notice(String(error)),
								);
							}
						}}
					/>
				</overlay>
			),
			{ focus: root => firstOfKind(root, "picker") },
		);
	}

	async function stop(session: AgentViewSession | undefined): Promise<void> {
		generation++;
		if (!session) return;
		const queue = sessionCommandQueue(session);
		const hasHeldInput = queue.request !== undefined || queue.messages.length > 0;
		if (!session.isStreaming && !session.hasInterruptibleInput && !hasHeldInput) {
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			return;
		}
		await session.interruptAndRestoreQueue(input => {
			const entries = queueEntriesForDraft(input, queue.takeForRestore());
			if (entries.length) {
				const { text, images, imageLinks } = mergeQueueEntries(entries, 0);
				draft.restore({ text, images, links: imageLinks });
			}
			updateQueue(session);
		}, hasHeldInput);
	}

	function restoreHeld(session: AgentViewSession): void {
		const { request, messages } = sessionCommandQueue(session).takeForRestore();
		const entries = request ? [{ text: `/queue ${request.text}` }, ...messages] : messages;
		if (entries.length) {
			const { text, images, imageLinks } = mergeQueueEntries(entries, 0);
			draft.restore({ text, images, links: imageLinks });
		}
		updateQueue(session);
	}

	function flushHeld(session: AgentViewSession): Promise<void> {
		const queue = sessionCommandQueue(session);
		return queue.drain(session, {
			execute: async message => {
				drainingHeld.add(message);
				updateQueue(session);
				try {
					await admit(session, message, undefined, generation, () => {
						const index = queue.messages.indexOf(message);
						if (index !== -1) queue.messages.splice(index, 1);
						updateQueue(session);
					});
				} finally {
					drainingHeld.delete(message);
				}
			},
			restore: () => restoreHeld(session),
			changed: () => updateQueue(session),
		});
	}

	async function send(input: Draft, mode: "steer" | "followUp", submittedGeneration: number): Promise<void> {
		let { text } = input;
		const { images } = input;
		let command = parseSlashCommand(text);
		const queued = command?.name === "queue" ? command.args : parseQueueShorthand(text);
		let followUps: string[] | undefined;
		if (queued !== undefined) {
			const messages = splitQueuedMessages(queued);
			if (!messages.length && !images?.length) throw new Error("Usage: /queue <message>");
			[text = "", ...followUps] = messages;
			mode = "followUp";
			command = parseSlashCommand(text);
			if (
				messages.some(message => {
					const name = parseSlashCommand(message)?.name;
					if (name === "compact" && message === messages[0]) return false;
					return (
						name !== undefined && (lookupBuiltinSlashCommand(name) !== undefined || options.knownCommand(message))
					);
				})
			)
				throw new Error("Only agent messages can be queued in this pane");
		}
		if (remote) {
			if (command || queued !== undefined || images?.length)
				throw new Error("The remote Agent Hub accepts text messages only");
			if (!options.isCurrent() || !ref()) throw new Error(`Agent ${agentId} is unavailable`);
			remote.chat(agentId, text);
			return;
		}
		if (command?.name === "stop") {
			if (command.args.trim() || images?.length) throw new Error("Usage: /stop");
			await stop(current());
			return;
		}
		if (
			command &&
			!COMMANDS.some(candidate => candidate.name === command?.name) &&
			(lookupBuiltinSlashCommand(command.name) || options.knownCommand(text))
		) {
			throw new Error(`This command is not available in this pane: /${command.name}`);
		}
		const session = await ensure();
		if (submittedGeneration !== generation || !options.isCurrent())
			throw new Error("Pane input interrupted before submission");
		if (command?.name === "retry" || command?.name === "continue" || command?.name === "tree") {
			if (command.args.trim() || images?.length) throw new Error(`Usage: /${command.name}`);
			if (command.name === "retry") {
				await retry(session);
			} else if (command.name === "continue") {
				if (session.continuePausedAgents) {
					const result = await session.continuePausedAgents();
					if (!result.complete) throw new Error(result.skipped.join("\n"));
				} else {
					await session.resume();
				}
			} else tree(session);
			return;
		}
		if (command?.name === "compact") {
			if (!session.compact) throw new Error("Compaction is not available for this agent");
			if (images?.length) throw new Error("/compact does not accept attachments");
			const queue = sessionCommandQueue(session);
			const args = parseCompactArgs(command.args);
			if ("error" in args) throw new Error(args.error);
			if (mode === "followUp" || queue.holdsInput) {
				queue.request = {
					...conversationPosition(session.sessionManager),
					text,
					instructions: args.instructions,
					mode: args.mode,
				};
				for (const followUp of followUps ?? []) queue.messages.push({ text: followUp, mode: "followUp" });
				updateQueue(session);
				void queue
					.run(session, {
						settleSubmissions: () => submissionTail,
						hasPendingSubmission: () => preparingAdmissions > 0,
						isCurrent: () => options.isCurrent() && current() === session,
						execute: async request => {
							await session.compact(request.instructions, { mode: request.mode });
						},
						flush: () => flushHeld(session),
						restore: () => restoreHeld(session),
						changed: () => updateQueue(session),
					})
					.catch(error => {
						restoreHeld(session);
						notice(String(error));
					});
			} else {
				queue.origin = conversationPosition(session.sessionManager);
				try {
					await session.compact(args.instructions, { mode: args.mode });
				} finally {
					await flushHeld(session);
				}
			}
			return;
		}
		if (session.hasPausedAgents()) throw new Error("This agent is paused; run /continue before sending");
		const queue = sessionCommandQueue(session);
		if (queue.holdsInput || session.isCompacting) {
			queue.origin ??= conversationPosition(session.sessionManager);
			queue.messages.push({ text, images, imageLinks: input.links, mode });
			for (const followUp of followUps ?? []) queue.messages.push({ text: followUp, mode: "followUp" });
			updateQueue(session);
			return;
		}
		await admit(session, { text, images, imageLinks: input.links, mode }, followUps, submittedGeneration);
	}

	async function admit(
		session: AgentViewSession,
		input: CompactionQueuedMessage,
		followUps?: string[],
		submittedGeneration = generation,
		onAdmitted?: () => void,
	): Promise<void> {
		const previous = submissionTail;
		const submission = Promise.withResolvers<void>();
		submissionTail = submission.promise;
		preparingAdmissions++;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			preparingAdmissions--;
			submission.resolve();
		};
		sessionCommandQueue(session).trackSubmission(submission.promise);
		const checkTarget = () => {
			if (submittedGeneration !== generation || current() !== session)
				throw new Error("The pane's target changed before sending");
		};
		try {
			await previous;
			checkTarget();
			let { text, images } = input;
			const result = await session.emitInteractiveInput(text, images);
			checkTarget();
			if (result?.handled) return;
			if (result?.text !== undefined) text = result.text.trim();
			images = result?.images ?? images;
			if (!text && !images?.length) return;
			await session.prompt(text, {
				images,
				followUps,
				streamingBehavior: input.mode,
				runCommands: false,
				throwOnDrop: true,
				onPromptAdmitted() {
					onAdmitted?.();
					release();
				},
			});
		} finally {
			release();
			if (current() === session) updateQueue(session);
		}
	}

	function submit(text: string, mode: "steer" | "followUp"): void {
		interacted = true;
		const capturedImages = composer.pendingImages.splice(0);
		const capturedLinks = composer.pendingImageLinks.splice(0);
		const compact = compactImageMarkers(text.trim(), capturedImages.length);
		const keep = compact?.keep ?? capturedImages.map((_, index) => index);
		const input: Draft = {
			text: compact?.text.trim() ?? text.trim(),
			images: keep.length ? keep.map(index => capturedImages[index]!) : undefined,
			links: keep.length ? keep.map(index => capturedLinks[index]) : undefined,
		};
		if (!input.text && !input.images) return;
		notice(undefined);
		void send(input, mode, generation).then(
			() => {
				if (!disposed) composer.addToHistory(text.trim());
			},
			error => {
				draft.restore(input);
				notice(error instanceof Error ? error.message : String(error));
			},
		);
	}

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		if (matchesAnyKey(key, appToolsExpandKeys(keybindings))) {
			model.toggleExpanded();
			return true;
		}
		if (keybindings.matches(key, "app.clipboard.pasteImage")) {
			return pasteNative();
		}
		if (overlays.open()) return false;
		if (key.id === "escape" || matchesAppInterrupt(key, keybindings) || keybindings.matches(key, "app.clear")) {
			const clear = keybindings.matches(key, "app.clear");
			if (!clear && (composer.completing() || composer.vimConsumesEscape())) return false;
			const session = local ? current() : undefined;
			const queue = session && sessionCommandQueue(session);
			if (
				session?.isStreaming ||
				session?.isCompacting ||
				session?.isRetrying ||
				session?.hasInterruptibleInput ||
				queue?.request ||
				queue?.messages.length ||
				preparingAdmissions > 0
			) {
				void stop(session).catch(error => notice(String(error)));
			} else if (composer.text() || composer.pendingImages.length) composer.clearDraft();
			else if (!clear) close();
			return true;
		}
		if (!sendable) return false;
		if (keybindings.matches(key, "app.clipboard.copyPrompt")) {
			copy(composer.expandedText());
			return true;
		}
		if (keybindings.matches(key, "app.clipboard.copyLine")) {
			const text = composer.text();
			const cursor = composer.cursor();
			const start = cursor === 0 ? 0 : text.lastIndexOf("\n", cursor - 1) + 1;
			const newline = text.indexOf("\n", cursor);
			copy(text.slice(start, newline === -1 ? text.length : newline));
			return true;
		}
		if (keybindings.matches(key, "app.clipboard.pasteTextRaw")) {
			if (!takesPaste() || !isClipboardTerminalLocal()) return false;
			void readTextFromClipboard().then(
				text => {
					if (text && takesPaste()) composer.insertText(text);
				},
				error => notice(`Paste failed: ${String(error)}`),
			);
			return true;
		}
		const editInTerminal = options.editInTerminal;
		if (editInTerminal && keybindings.matches(key, "app.editor.external")) {
			const command = getEditorCommand();
			if (!command) notice("No editor configured. Set $VISUAL or $EDITOR.");
			else {
				const original = composer.expandedText();
				void editInTerminal(() => openInEditor(command, original, { extension: ".omp.md" })).then(
					text => {
						if (!disposed && text !== null && composer.expandedText() === original)
							composer.setCollapsedText(text);
					},
					error => notice(`Failed to open external editor: ${String(error)}`),
				);
			}
			return true;
		}
		if (!local) return false;
		if (matchesAnyKey(key, appFollowUpKeys(keybindings))) {
			submitMode = "followUp";
			try {
				composer.submit();
			} finally {
				submitMode = "steer";
			}
			return true;
		}
		if (keybindings.matches(key, "app.message.dequeue")) {
			dequeue();
			return true;
		}
		if (keybindings.matches(key, "app.retry")) {
			retryFromPane();
			return true;
		}
		if (keybindings.matches(key, "app.session.tree")) {
			void ensure()
				.then(session => {
					if (!disposed) tree(session);
				})
				.catch(error => notice(String(error)));
			return true;
		}
		if (keybindings.matches(key, "app.thinking.cycle")) {
			current()?.cycleThinkingLevel();
			return true;
		}
		return false;
	};

	let paste: EnhancedPasteController | undefined;
	const surface = createSurface(() => {
		composer = new Composer({ sendable: false, placeholder: `Message ${agentId}` });
		composer.setNativePlaceholder(`Message ${agentId}`);
		composer.onSubmit = text => submit(text, submitMode);
		composer.addKeyHandler(onKey);
		if (sendable) draft.attach(composer);
		composer.addEditListener(() => {
			interacted = true;
			if (local && composer.text()) current()?.prewarmModelConnection();
		});
		composer.onYank = (text, register) => {
			if (register === "+" || register === "*" || cfgTuiVimYankToClipboard.get(model.settings() ?? options.settings))
				copy(text);
		};
		if (isClipboardTerminalLocal()) composer.readClipboard = readTextFromClipboard;
		composer.setImageLinkResolver(async images => {
			const target = current();
			if (!target) return [];
			const links = await materializeImageChipLinks(images, target.sessionManager);
			return current() === target ? links : [];
		});
		effect(() => {
			const cwd = model.cwd();
			untrack(() =>
				composer.setAutocomplete(local && cwd ? new CombinedAutocompleteProvider(COMMANDS, cwd) : undefined),
			);
		});
		effect(() => {
			const settings = model.settings() ?? options.settings;
			untrack(() => {
				composer.setVimStartMode(cfgTuiVimStartMode.get(settings));
				composer.setVim(cfgTuiVimMode.get(settings));
				composer.setAutocompleteMaxVisible(cfgAutocompleteMaxVisible.get(settings));
			});
		});
		effect(() => {
			const session = model.live();
			updateQueue(session);
			if (!session) return;
			const queue = sessionCommandQueue(session);
			const recoverHeld = () => {
				if (current() !== session || session.isCompacting || queue.holdsInput || !queue.messages.length) return;
				void flushHeld(session).catch(error => {
					restoreHeld(session);
					notice(String(error));
				});
			};
			onCleanup(
				session.subscribe(event => {
					if (event.type === "queue_update") updateQueue(session);
					if (event.type === "manual_compaction_end" || event.type === "auto_compaction_end")
						queueMicrotask(recoverHeld);
				}),
			);
			queueMicrotask(recoverHeld);
		});
		const presentationSource = () => model.live()?.presentation;
		const presentation = useExtensionPresentation(presentationSource);
		const size = () => ({ rows: rows(), columns: options.columns() });
		return {
			main: <AgentWorkspaceTranscript model={model} />,
			dock: (
				<>
					<QueuedMessages model={queueModel} />
					<AgentWorkspaceStatus model={model} />
					<PaneExtensionWidgets runner={presentationSource} placement="aboveEditor" size={size} />
					{sendable && composer.node}
					<PaneExtensionWidgets runner={presentationSource} placement="belowEditor" size={size} />
					<Show
						when={model.live}
						fallback={
							!remote && <text key="missing-session" text="Status unavailable · no live session" tone="muted" />
						}
					>
						{session => {
							const status = new SessionStatusLine(session, { workspacePane: true });
							status.setSession(session, agentId);
							onCleanup(() => status.dispose());
							// Keep the Main renderer, but only request facts useful in a narrow agent pane.
							status.previewSettings({
								preset: "custom",
								leftSegments: ["model"],
								rightSegments: ["context_pct", "token_total", "cost"],
								segmentOptions: { model: { showThinkingLevel: true } },
								compactThinkingLevel: false,
							});
							return (
								<StatusLine
									settings={status.settings}
									facts={() => ({
										...status.facts(),
										hooks: [...presentation().statuses]
											.sort(([a], [b]) => a.localeCompare(b))
											.map(([, text]) => text),
									})}
									placement={() => ({ bar: "full", gap: false, autocomplete: composer.completing() })}
								/>
							);
						}}
					</Show>
				</>
			),
			layer: () => overlays.nodes(),
		};
	});
	const overlays = new Overlays({
		focused: surface.focused,
		focus: node => surface.focus(node),
		fallback: () => composer.field,
	});
	if (sendable) surface.focus(composer!.field);
	else surface.focus(surface.dock()[0] ?? null);

	const takesPaste = () => sendable && !disposed && surface.focused() === composer.field;
	async function pasteImage(image: ImageContent): Promise<void> {
		const target = current();
		if (!takesPaste() || remote) return;
		try {
			const normalized = await ensureSupportedImageInput(image);
			if (!normalized) throw new Error(`Unsupported pasted image format: ${image.mimeType}`);
			const link = target ? (await materializeImageChipLinks([normalized], target.sessionManager))[0] : undefined;
			if (!takesPaste() || current() !== target) return;
			const n = composer.pendingImages.length + 1;
			composer.insertAtom(composer.chipLabel("image", n), `[Image #${n}]`, {
				kind: "image",
				image: normalized,
				link,
			});
		} catch (error) {
			notice(String(error));
		}
	}
	function pasteNative(): boolean {
		if (!takesPaste() || !isClipboardTerminalLocal()) return false;
		void readClipboardContent()
			.then(({ image, text }) => {
				if (image && !remote)
					return pasteImage({ type: "image", data: image.data.toBase64(), mimeType: image.mimeType });
				if (text && takesPaste()) composer.insertText(text);
			})
			.catch(error => notice(String(error)));
		return true;
	}
	if (sendable && options.writeRaw) {
		paste = new EnhancedPasteController({
			write: options.writeRaw,
			pasteText: text => {
				if (takesPaste()) composer.insertText(text);
			},
			pasteImage,
			acceptsHtml: takesPaste,
			async pasteHtml(html) {
				for (const part of htmlToPaste(html) ?? []) {
					if (!takesPaste()) break;
					if (typeof part === "string") composer.insertText(part);
					else await pasteImage(part);
				}
			},
			showStatus: notice,
			pasteNative,
		});
		queueMicrotask(() => {
			if (!disposed) paste?.enable();
		});
	}
	return {
		surface,
		onKey,
		onAppViewportPasteRequest: pasteNative,
		intercept(event) {
			if (
				event.type === "key" ||
				event.type === "paste" ||
				(event.type === "mouse" && event.mouse.action !== "move")
			) {
				interacted = true;
			}
			return event.type === "osc" && (paste?.handleInput(event.raw) ?? false);
		},
		protectedFromAutoClose: () =>
			interacted || overlays.open() || Boolean(composer.text() || composer.pendingImages.length),
		dispose() {
			disposed = true;
			paste?.disable();
			overlays.closeAll();
			if (sendable) draft.detach(composer);
			model.dispose();
		},
	};
}
