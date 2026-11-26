/** @jsxImportSource @oh-my-pi/pi-tui */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createSurface, type KeyEvent } from "@oh-my-pi/pi-tui";
import { getKeybindings } from "../config/keybindings/keybindings";
import { appFollowUpKeys, matchesAnyKey, matchesAppInterrupt } from "../config/keybindings/matchers";
import type { Settings } from "../config/settings";
import type { AgentLifecycleApi } from "../registry/agent-lifecycle";
import type { AgentHubRegistry } from "../registry/agent-hub-types";
import type { AgentRef } from "../registry/agent-registry";
import { type AgentViewSession, isAgentViewSession } from "../session/agent-session-handle";
import type { AgentSession } from "../session/agent-session";
import { parseCompactArgs } from "../session/compact-modes";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { restoreDetachedDraft } from "../slash-commands/helpers/draft";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { Composer } from "../ui/composer/composer";
import { AgentTranscriptViewerModel } from "../ui/overlays/panels/agent-transcript-viewer-model";
import { AgentWorkspaceStatus, AgentWorkspaceTranscript } from "../ui/overlays/panels/agent-transcript-viewer";
import { TreeSelector } from "../ui/overlays/pickers/tree-selector";
import { Overlays } from "../ui/shell/overlays";
import { isClipboardTerminalLocal, readClipboardContent } from "../utils/clipboard";
import { EnhancedPasteController } from "../utils/enhanced-paste";
import { htmlToPaste } from "../utils/html-paste";
import { ensureSupportedImageInput } from "../utils/image-input";
import { agentTranscriptSource } from "./agent-hub-runtime";
import { firstOfKind } from "./controllers/selector-views";
import type { NativeWorkspaceSurface } from "./native-workspace/workspace";
import type { AgentHubRemote } from "./view-model/overlays/agent-hub";
import { compactImageMarkers, shiftImageMarkers } from "./view-model/prompt/composer-attachments";
import { parseQueueShorthand, splitQueuedMessages } from "./view-model/prompt/queue-input";
import { materializeImageChipLinks } from "./utils/ui-helpers";

interface Draft {
	text: string;
	images?: ImageContent[];
	links?: (string | undefined)[];
	cursor?: number;
}

/** These actions run on the session's home thread, if the view exposes them. */
type PaneSession = AgentViewSession &
	Partial<Pick<AgentSession, "compact" | "navigateTree">> & {
		readonly sessionManager: AgentViewSession["sessionManager"] &
			Partial<Pick<AgentSession["sessionManager"], "getTree" | "appendLabelChange">>;
		hasPausedAgents?(): boolean;
		continuePausedAgents?(): Promise<{ complete: boolean; skipped: readonly string[] }>;
	};

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
	readonly writeRaw?: (data: string) => void;
	readonly registry: Pick<AgentHubRegistry<AgentRef>, "get">;
	readonly lifecycle?: Pick<AgentLifecycleApi, "ensureLive">;
	readonly remote?: AgentHubRemote;
	readonly settings: Settings;
	readonly draft: AgentPaneDraft;
	readonly isCurrent: () => boolean;
	readonly knownCommand: (text: string) => boolean;
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
	const ensure = async (): Promise<PaneSession> => {
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
	let composer: Composer;
	const sendable = ref()?.kind !== "advisor" && (lifecycle !== undefined || remote !== undefined);
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
		onClose: close,
		onHubClose: close,
	});
	function notice(message: string | undefined): void {
		if (disposed) return;
		model.notice = message;
		model.touch();
	}

	function tree(session: PaneSession): void {
		const navigate = session.navigateTree;
		const readTree = session.sessionManager.getTree;
		if (!navigate || !readTree) throw new Error("Tree navigation is not available for this agent");
		if (session.isStreaming || session.isCompacting)
			throw new Error("Wait for this agent before navigating its tree");
		const roots = readTree.call(session.sessionManager);
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
							void navigate
								.call(session, id, { summarize, requireIdle: true })
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
								void Promise.resolve(session.sessionManager.appendLabelChange?.(id, label)).catch(error =>
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

	async function send(input: Draft, mode: "steer" | "followUp", submittedGeneration: number): Promise<void> {
		let { text, images } = input;
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
			generation++;
			await current()?.abort({ reason: USER_INTERRUPT_LABEL });
			return;
		}
		if (
			command &&
			!["retry", "continue", "compact", "tree"].includes(command.name) &&
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
				if (!(await session.retry())) throw new Error("This agent has no failed turn to retry");
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
			if (mode === "followUp") throw new Error("Deferred compaction is not supported in agent panes");
			const args = parseCompactArgs(command.args);
			if ("error" in args) throw new Error(args.error);
			await session.compact(args.instructions, { mode: args.mode });
			return;
		}
		if (session.hasPausedAgents?.()) throw new Error("This agent is paused; run /continue before sending");
		const result = await session.extensionRunner?.emitInput(text, images, "interactive");
		if (result?.handled) return;
		if (result?.text !== undefined) text = result.text.trim();
		images = result?.images ?? images;
		if (!text && !images?.length) return;
		if (submittedGeneration !== generation || current() !== session)
			throw new Error("The pane's target changed before sending");
		await session.prompt(text, { images, followUps, streamingBehavior: mode, runCommands: false, throwOnDrop: true });
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
		if (keybindings.matches(key, "app.tools.expand")) {
			model.toggleExpanded();
			return true;
		}
		if (keybindings.matches(key, "app.clipboard.pasteImage")) {
			return pasteNative();
		}
		if (overlays.open()) return false;
		if (key.id === "escape") {
			const session = current();
			if (session?.isStreaming || session?.isCompacting || session?.isRetrying) {
				generation++;
				void session.abort({ reason: USER_INTERRUPT_LABEL }).catch(error => notice(String(error)));
			} else if (composer.text() || composer.pendingImages.length) composer.clearDraft();
			else close();
			return true;
		}
		if (matchesAppInterrupt(key)) {
			generation++;
			void current()
				?.abort({ reason: USER_INTERRUPT_LABEL })
				.catch(error => notice(String(error)));
			return true;
		}
		if (sendable && matchesAnyKey(key, appFollowUpKeys(keybindings))) {
			const text = composer.expandedText();
			submit(text, "followUp");
			composer.clearDraft({ recall: false });
			return true;
		}
		if (sendable && keybindings.matches(key, "app.message.dequeue")) {
			const message = current()?.popLastQueuedMessage();
			if (message) draft.restore({ text: message.text, images: message.images });
			else notice("This agent has no queued messages");
			return true;
		}
		return false;
	};

	let paste: EnhancedPasteController | undefined;
	const surface = createSurface(() => {
		composer = new Composer({ sendable: false, placeholder: `Message ${agentId}` });
		composer.setNativePlaceholder(`Message ${agentId}`);
		composer.onSubmit = text => submit(text, "steer");
		composer.addKeyHandler(onKey);
		if (sendable) draft.attach(composer);
		composer.addEditListener(() => {
			interacted = true;
		});
		return {
			main: <AgentWorkspaceTranscript model={model} />,
			dock: (
				<>
					<AgentWorkspaceStatus model={model} />
					{sendable && composer.node}
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
			if (event.type === "key" || event.type === "paste") interacted = true;
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
