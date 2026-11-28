/** @jsxImportSource @oh-my-pi/pi-tui */
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import {
	type AnsiWorkspace,
	createSurface,
	effect,
	type JSXNode,
	type KeyEvent,
	onCleanup,
	signal,
	untrack,
} from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
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
import { QueueModel, QueuedMessages, type QueuedMessageEdit } from "../ui/dock/queue";
import { PaneExtensionWidgets, useExtensionPresentation } from "../ui/dock/widgets";
import { handleTranscriptKey } from "../ui/keys/transcript";
import { AgentTranscriptViewerModel } from "../ui/overlays/panels/agent-transcript-viewer-model";
import {
	AgentWorkspaceNotice,
	AgentWorkspaceTranscript,
	STATUS_TONE,
} from "../ui/overlays/panels/agent-transcript-viewer";
import { TreeSelector } from "../ui/overlays/pickers/tree-selector";
import { Overlays } from "../ui/shell/overlays";
import { isUserPrompt, syntheticReplayId } from "../ui/transcript/messages/user-message";
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
import { tagImageAttachmentSource } from "../utils/image-source";
import { agentTranscriptSource } from "./agent-hub-runtime";
import { firstOfKind } from "./controllers/selector-views";
import { bindComposerStatus } from "./interactive/frame";
import { SessionStatusLine } from "./interactive/status-line";
import {
	cfgAutocompleteMaxVisible,
	cfgComposerShape,
	cfgComposerTokenRate,
	cfgTuiVimMode,
	cfgTuiVimStartMode,
	cfgTuiVimYankToClipboard,
} from "./settings";
import { statusLineSettings } from "./status-line-host";
import type { NativeWorkspaceSurface } from "./native-workspace/workspace";
import type { AgentHubRemote } from "./view-model/overlays/agent-hub";
import { compactImageMarkers, shiftImageMarkers } from "./view-model/prompt/composer-attachments";
import { extractImagePastePathsFromText } from "./view-model/prompt/custom-editor";
import { NativePaneScroll } from "./view-model/prompt/native-pane-scroll";
import { PanePaste, pastePaneImagePaths } from "./view-model/prompt/pane-paste";
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
const MISSING_SESSION_STATUS = "Status unavailable · no live session";

/** An entry remains in the barrier until admission; it can still be restored by interrupt. */
const drainingHeld = new WeakSet<CompactionQueuedMessage>();

interface Draft {
	text: string;
	images?: ImageContent[];
	links?: (string | undefined)[];
	cursor?: number;
}

interface AgentPanePasteTarget {
	readonly session: AgentViewSession | undefined;
	isCurrent(): boolean;
	pasteText(text: string): void;
	attach(image: ImageContent, sourcePath?: string): Promise<void>;
	showError(error: unknown): void;
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
	readonly showHub?: () => void;
	readonly nativeSupports?: (kind: string) => boolean;
	readonly ansiWorkspace?: Pick<AnsiWorkspace, "visibleMain" | "transcript">;
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
	const pasteBarrier = new PanePaste();
	let submitMode: "steer" | "followUp" = "steer";
	let composer: Composer;
	const sendable = ref()?.kind !== "advisor" && (lifecycle !== undefined || remote !== undefined);
	const local = sendable && lifecycle !== undefined && !remote;
	const queueModel = new QueueModel();
	queueModel.dequeueKey.set(keybindings.keysFor("app.message.dequeue")[0] ?? "alt+up");
	const heldEditIds = new WeakMap<object, number>();
	let heldEditSeq = 0;
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
	const scroll = new NativePaneScroll(options.nativeSupports, keybindings, notice);

	function copy(text: string): void {
		if (!text || disposed || !ref()) return;
		interacted = true;
		void (options.copyText ?? copyToClipboard)(text).catch(error => notice(`Copy failed: ${String(error)}`));
	}

	function canRetry(message: AssistantMessage): boolean {
		if (!local || message.stopReason !== "error") return false;
		const last = model
			.blocks()
			.findLast(block => block.kind === "assistant" && block.view().actionMessage !== undefined);
		return last?.kind === "assistant" && last.view().actionMessage === message;
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
		if (!session) {
			queueModel.groups.set([]);
			return;
		}
		const queued = session.getQueuedMessages();
		const ids = local ? session.getQueuedMessageEditIds() : undefined;
		const held = sessionCommandQueue(session);
		const request = held.request;
		const pending = held.messages.filter(message => !drainingHeld.has(message));
		const edit = (id: string, take: () => Draft | undefined): QueuedMessageEdit => ({
			id: `${session.instanceKey}/${id}`,
			restore() {
				if (disposed || current() !== session) return;
				interacted = true;
				const restored = take();
				if (restored) draft.restore(restored);
				else notice("That message is no longer queued");
				updateQueue(session);
				surface.focus(composer.field);
			},
		});
		const ordinaryEdits = (queue: "steering" | "followUp") =>
			queued[queue].map((text, index) => {
				const id = ids?.[queue][index];
				if (id === undefined) return undefined;
				return edit(id, () => {
					const message = session.takeQueuedMessageAt(queue, index, text, id);
					if (!message) return undefined;
					return {
						text: queue === "followUp" ? formatQueueShorthand([message.text]) : message.text,
						images: message.images,
					};
				});
			});
		const heldEdit = (entry: object, take: () => Draft | undefined) => {
			if (!local) return undefined;
			let id = heldEditIds.get(entry);
			if (id === undefined) {
				id = ++heldEditSeq;
				heldEditIds.set(entry, id);
			}
			return edit(`held:${id}`, take);
		};
		queueModel.groups.set([
			{ label: "Steering", messages: queued.steering, edits: ordinaryEdits("steering") },
			{ label: "After yield", messages: queued.followUp, edits: ordinaryEdits("followUp") },
			{
				label: "Compaction queued",
				messages: request ? [request.text] : [],
				edits: request
					? [
							heldEdit(request, () => {
								if (held.request !== request) return undefined;
								held.request = undefined;
								return { text: `/queue ${request.text}` };
							}),
						]
					: [],
			},
			{
				label: "After compaction",
				messages: pending.map(message => message.text),
				edits: pending.map(message =>
					heldEdit(message, () => {
						const index = held.messages.indexOf(message);
						if (index < 0 || drainingHeld.has(message)) return undefined;
						held.messages.splice(index, 1);
						return {
							text: message.mode === "followUp" ? formatQueueShorthand([message.text]) : message.text,
							images: message.images,
							links: message.imageLinks,
						};
					}),
				),
			},
		]);
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
		if (
			!overlays.open() &&
			!composer.completing() &&
			handleTranscriptKey(key, keybindings, options.ansiWorkspace?.transcript(surface))
		)
			return true;
		if (matchesAnyKey(key, appToolsExpandKeys(keybindings))) {
			if (options.ansiWorkspace) {
				const view = options.ansiWorkspace.visibleMain(surface);
				const replays = view?.nodes.map(syntheticReplayId).filter(id => id !== undefined);
				model.toggleExpanded({ anchor: view?.followingTail ? replays?.at(-1) : replays?.[0] });
			} else model.toggleExpanded();
			return true;
		}
		if (keybindings.matches(key, "app.clipboard.pasteImage")) {
			return pasteNative();
		}
		if (overlays.open()) return false;
		if (
			options.showHub &&
			(keybindings.matches(key, "app.agents.hub") || keybindings.matches(key, "app.session.observe"))
		) {
			interacted = true;
			options.showHub();
			return true;
		}
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
		if (!sendable) return scrollEmptyTranscript(key);
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
			const target = capturePasteTarget();
			const release = pasteBarrier.begin();
			void readTextFromClipboard()
				.then(text => {
					if (text) target.pasteText(text);
				})
				.catch(target.showError)
				.finally(release);
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
		if (options.nativeSupports && key.id === "ctrl+enter") {
			composer.insertText("\n");
			return true;
		}
		if (!local) return scrollEmptyTranscript(key);
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
		return scrollEmptyTranscript(key);
	};

	function scrollEmptyTranscript(key: KeyEvent): boolean {
		return (
			!options.ansiWorkspace && !composer.text().trim() && composer.pendingImages.length === 0 && scroll.handle(key)
		);
	}

	let paste: EnhancedPasteController | undefined;
	const surface = createSurface(() => {
		composer = new Composer({
			sendable: false,
			placeholder: `Message ${agentId}`,
			hideFocusedPlaceholder: true,
			deferSubmit: replay => pasteBarrier.hold(replay),
		});
		composer.setNativePlaceholder(`Message ${agentId}`);
		composer.onSubmit = text => submit(text, submitMode);
		composer.addKeyHandler(onKey);
		// Stop replaces Send while the agent runs, as on Main's composer; it interrupts as Esc does.
		composer.addActionHandler(act => {
			if (act !== "interrupt") return false;
			void stop(local ? current() : undefined).catch(error => notice(String(error)));
			return true;
		});
		effect(() => {
			model.rev();
			const running = local && model.ref()?.status === "running";
			untrack(() => composer.setState(running ? { running } : {}));
		});
		composer.addPasteHandler(({ text }) => {
			if (!text) return pasteNative();
			return pastePaths(text, capturePasteTarget());
		});
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
				composer.setShape(cfgComposerShape.get(settings));
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
		// The agent's status line, drawn in its composer by the code that draws Main's.
		const statusPanel = signal<JSXNode>(undefined);
		effect(() => {
			const session = model.live();
			untrack(() => {
				if (!session) {
					if (!options.nativeSupports && !remote)
						composer.setStatus(({ theme }) => ({
							content: theme.fg("muted", MISSING_SESSION_STATUS),
							width: visibleWidth(MISSING_SESSION_STATUS),
						}));
					return;
				}
				const status = new SessionStatusLine(session, { workspacePane: true });
				onCleanup(statusLineSettings.listen(session.settings, () => status.reloadSettings()));
				const line = bindComposerStatus(
					composer,
					{
						settings: status.settings,
						facts: () => ({
							...status.facts(),
							hooks: [...presentation().statuses].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text),
						}),
					},
					{
						shape: () => cfgComposerShape.get(model.settings() ?? options.settings),
						clickable: false,
						rate: () =>
							cfgComposerTokenRate.get(model.settings() ?? options.settings) ? status.composerRate() : undefined,
					},
				);
				statusPanel.set(line.panel);
				onCleanup(() => {
					statusPanel.set(undefined);
					composer.setStatus(undefined);
					composer.setSlots({});
					status.dispose();
				});
			});
		});
		const size = () => ({ rows: rows(), columns: options.columns() });
		return {
			main: (
				<>
					{options.nativeSupports && <col key="agent-transcript-scroll" scroll={scroll.request} />}
					<AgentWorkspaceTranscript model={model} />
				</>
			),
			dock: (
				<>
					<QueuedMessages model={queueModel} />
					<AgentWorkspaceNotice model={model} />
					<PaneExtensionWidgets runner={presentationSource} placement="aboveEditor" size={size} />
					{() =>
						!model.live() &&
						options.nativeSupports &&
						!remote && <text key="missing-session" text={MISSING_SESSION_STATUS} tone="muted" />
					}
					{sendable && composer.node}
					{/* As under Main's composer: Tern draws the status in its composer, a plain terminal adds the bar. */}
					{() => (options.nativeSupports && sendable ? undefined : statusPanel())}
					<PaneExtensionWidgets runner={presentationSource} placement="belowEditor" size={size} />
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
	function capturePasteTarget(): AgentPanePasteTarget {
		const session = current();
		const isCurrent = () => !disposed && ref() !== undefined && current() === session;
		return {
			session,
			isCurrent,
			pasteText(text) {
				if (isCurrent()) composer.insertText(text);
			},
			async attach(image, sourcePath) {
				if (!isCurrent() || remote) return;
				const normalized = await ensureSupportedImageInput(image);
				if (!normalized) throw new Error(`Unsupported pasted image format: ${image.mimeType}`);
				if (!isCurrent()) return;
				const attachment = sourcePath ? tagImageAttachmentSource(normalized, sourcePath, "image") : normalized;
				const link = session
					? (await materializeImageChipLinks([attachment], session.sessionManager))[0]
					: undefined;
				if (!isCurrent()) return;
				const n = composer.pendingImages.length + 1;
				composer.insertAtom(composer.chipLabel("image", n), `[Image #${n}]`, {
					kind: "image",
					image: attachment,
					link,
				});
			},
			showError(error) {
				if (isCurrent()) notice(`Paste failed: ${String(error)}`);
			},
		};
	}
	function pastePaths(text: string, target: AgentPanePasteTarget): boolean {
		if (!local || !target.session) return false;
		const paths = extractImagePastePathsFromText(text, { allowRelativeFile: true });
		if (!paths) return false;
		const release = pasteBarrier.begin();
		void pastePaneImagePaths(paths, target.session.sessionManager.getCwd(), target)
			.catch(target.showError)
			.finally(release);
		return true;
	}
	function pasteNative(): boolean {
		if (!takesPaste() || !isClipboardTerminalLocal()) return false;
		const target = capturePasteTarget();
		const release = pasteBarrier.begin();
		void readClipboardContent()
			.then(async ({ fileUrls, image, text }) => {
				if (local && fileUrls.length) {
					// Finder supplies absolute file URLs even when the pane's session is parked.
					const cwd = target.session?.sessionManager.getCwd() ?? model.cwd() ?? process.cwd();
					if (await pastePaneImagePaths(fileUrls, cwd, target, "finder")) return;
				}
				if (image && !remote)
					return target.attach({ type: "image", data: image.data.toBase64(), mimeType: image.mimeType });
				if (text && target.isCurrent() && !pastePaths(text, target)) target.pasteText(text);
			})
			.catch(target.showError)
			.finally(release);
		return true;
	}
	if (sendable && options.writeRaw) {
		paste = new EnhancedPasteController({
			write: options.writeRaw,
			beginPaste() {
				if (!takesPaste()) return { isCurrent: () => false, finish() {} };
				interacted = true;
				const target = capturePasteTarget();
				const release = pasteBarrier.begin();
				return {
					isCurrent: target.isCurrent,
					finish(text) {
						try {
							if (text && target.isCurrent() && !pastePaths(text, target)) target.pasteText(text);
						} finally {
							release();
						}
					},
				};
			},
			pasteText: text => capturePasteTarget().pasteText(text),
			async pasteImage(image) {
				const target = capturePasteTarget();
				await target.attach(image).catch(target.showError);
			},
			acceptsHtml: () => sendable,
			async pasteHtml(html) {
				const target = capturePasteTarget();
				for (const part of htmlToPaste(html) ?? []) {
					if (!target.isCurrent()) break;
					if (typeof part === "string") target.pasteText(part);
					else await target.attach(part).catch(target.showError);
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
		titleDetail(focused, width) {
			model.rev();
			const status = model.ref()?.status;
			const name = model.live()?.model?.id ?? model.model;
			const hints =
				!focused || width < 34
					? ""
					: width < 48
						? " · Esc"
						: `${sendable ? " · Enter send" : ""}${options.showHub ? " · Hub" : ""} · Esc`;
			return [
				...(status ? [{ t: ` ${status}`, s: STATUS_TONE[status] }] : []),
				...(name ? [{ t: ` · ${name}`, s: "muted" }] : []),
				...(hints ? [{ t: hints, s: "dim" }] : []),
			];
		},
		onKey,
		isPrompt: isUserPrompt,
		onPasteRequest: pasteNative,
		intercept(event, replay) {
			if ((event.type === "key" || event.type === "paste") && takesPaste() && pasteBarrier.hold(replay)) return true;
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
			pasteBarrier.reset();
			paste?.disable();
			overlays.closeAll();
			if (sendable) draft.detach(composer);
			model.dispose();
		},
	};
}
