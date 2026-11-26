/** @jsxImportSource @oh-my-pi/pi-tui */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import {
	batch,
	computed,
	createSurface,
	effect,
	For,
	type JSXNode,
	type KeyEvent,
	onCleanup,
	signal,
	type Surface,
	untrack,
} from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { CombinedAutocompleteProvider } from "../../../autocomplete/autocomplete";
import type { KeybindingsManager } from "../../../config/keybindings/keybindings";
import {
	appFollowUpKeys,
	appToolsExpandKeys,
	listKeyId,
	matchesAnyKey,
	matchesAppInterrupt,
} from "../../../config/keybindings/matchers";
import { canonicalKeyId } from "../../../config/keybindings/key-id";
import type { SpaceHoldHandler } from "../../../config/keybindings/space-hold";
import { firstOfKind } from "../../../modes/controllers/selector-views";
import { formatCost } from "../../../modes/view-model/overlays/agent-hub-renderer";
import { compactImageMarkers, formatVisionMarker } from "../../../modes/view-model/prompt/composer-attachments";
import type { NativeWorkspaceSurface } from "../../../modes/native-workspace/workspace";
import type { AgentSession } from "../../../session/agent-session";
import type { BtwThread } from "../../../session/btw-manager";
import { projectBtwMessages } from "../../../session/ephemeral-conversation";
import { readAgentsPaused } from "../../../session/exit-diagnostics";
import {
	type CompactionQueuedMessage,
	sessionCommandQueue,
	type YieldCompaction,
} from "../../../session/session-command-queue";
import { isClipboardTerminalLocal, readClipboardContent, readImageFromClipboard } from "../../../utils/clipboard";
import { Composer, type ComposerSlots } from "../../composer/composer";
import { queuedLine } from "../../dock/queue";
import { PaneExtensionWidgets } from "../../dock/widgets";
import { Overlays } from "../../shell/overlays";
import { SideToolCalls } from "../../transcript/side-tool-calls";
import { UserMessage } from "../../transcript/messages/user-message";
import {
	SideMessage,
	SideReply,
	type SideTranscriptDisplay,
	sideTranscriptDisplay,
} from "../../transcript/side-transcript";
import { ActionButton } from "./common";
import { BtwTopicRail } from "./btw-topic-rail";
import { TreeSelector } from "../pickers/tree-selector";
import { SelectSheet } from "../pickers/select-sheet";
import { sanitizeDisplayLine } from "../../../extensibility/inventory/display-text";
import "../../styles/messages";
import "../../styles/tools";

export interface BtwPaneDraft {
	readonly text: string;
	readonly images: ImageContent[];
	readonly imageLinks: (string | undefined)[];
}

export type BtwQueueEdit =
	| { kind: "steering" | "followUp"; text: string }
	| { kind: "held"; message: CompactionQueuedMessage }
	| { kind: "compact"; request: YieldCompaction };

interface BtwPaneOptions {
	readonly cwd: string;
	readonly rows: () => number;
	readonly columns: () => number;
	/** Presence distinguishes a Tern workspace surface from an ANSI pane. */
	readonly nativeSupports?: (kind: string) => boolean;
	readonly keybindings: KeybindingsManager;
	readonly revision: () => number;
	threads(): readonly BtwThread[];
	selected(): BtwThread | undefined;
	loadPresentation(key: string): void;
	select(key: string): void;
	setDraft(key: string, draft: BtwPaneDraft): void;
	persistDraft(key: string): void;
	submit(key: string | undefined, input: BtwPaneDraft, mode: "steer" | "followUp"): boolean;
	newThread(): void;
	cancel(key: string): void;
	dequeue(key: string): void;
	editQueued(key: string, message: BtwQueueEdit): void;
	delete(key: string): void;
	copy(key: string): void;
	canPromote(key: string): boolean;
	promote(key: string): void;
	close(): void;
	showError(error: unknown): void;
	dictation?(target: Composer): SpaceHoldHandler;
	hideThinking(): boolean;
	proseOnlyThinking(): boolean;
}

interface SummaryApproval {
	readonly title: string;
	readonly summary: string;
	finish(approved: boolean): void;
}

const COMMANDS = [
	{ name: "new", description: "Start a new durable BTW thread", argumentHint: "[question]", allowArgs: true },
	{ name: "help", description: "List BTW actions" },
	{ name: "stop", description: "Cancel this thread’s reply" },
	{ name: "continue", description: "Continue paused conversations" },
	{ name: "retry", description: "Retry this thread’s last reply" },
	{ name: "queue", description: "Queue a follow-up", argumentHint: "<message>", allowArgs: true },
	{ name: "compact", description: "Compact this BTW thread", argumentHint: "[mode] [focus]", allowArgs: true },
	{ name: "tree", description: "Navigate this BTW thread’s history" },
	{
		name: "handoff",
		description: "Confirm sending this conversation to Main",
		argumentHint: "[instruction]",
		allowArgs: true,
	},
	{ name: "promote", description: "Branch this thread into a new Main session" },
	{ name: "delete", description: "Delete this durable thread" },
];

/** The workspace owns this view; its manager owns the conversation and the draft. */
export class BtwConversationPane implements NativeWorkspaceSurface {
	readonly surface: Surface;
	readonly ansiRail: BtwTopicRail | undefined;
	readonly #composer: Composer;
	readonly #overlays: Overlays;
	readonly #selected;
	readonly #threads;
	readonly #expanded = signal(false);
	readonly #approval = signal<SummaryApproval | undefined>(undefined);
	readonly #menu = signal<{ key: string; active: string } | undefined>(undefined);
	readonly #lifetime = new AbortController();
	#approvalTail = Promise.resolve();
	#mode: "steer" | "followUp" = "steer";
	#draftKey: string | undefined;
	#loadingDraft = false;
	#disposed = false;

	constructor(private readonly options: BtwPaneOptions) {
		this.#selected = computed(() => {
			options.revision();
			return options.selected()?.key;
		});
		this.#threads = computed(() => {
			options.revision();
			return options.threads();
		});
		let composer!: Composer;
		let rail: BtwTopicRail | undefined;
		this.surface = createSurface(() => {
			composer = new Composer({
				placeholder: "Ask BTW…",
				autocomplete: new CombinedAutocompleteProvider(COMMANDS, options.cwd),
			});
			if (options.nativeSupports) composer.setSlots(this.#nativeStatus());
			else {
				rail = new BtwTopicRail({
					rows: options.rows,
					threads: this.#threads,
					selected: this.#selected,
					blocked: () => this.#approval() !== undefined,
					select: key => this.#select(key),
					newThread: () => this.#action("new"),
				});
			}
			effect(() => {
				const key = this.#selected();
				if (key !== undefined) untrack(() => options.loadPresentation(key));
			});
			const presentation = () => this.#displayed()?.conversation.extensionRunner;
			const size = () => ({ rows: options.rows(), columns: options.columns() });
			const above = <PaneExtensionWidgets runner={presentation} placement="aboveEditor" size={size} />;
			const below = <PaneExtensionWidgets runner={presentation} placement="belowEditor" size={size} />;
			return {
				main: () => {
					const approval = this.#approval();
					return approval ? (
						<md key="btw-summary" text={approval.summary} />
					) : (
						<ThreadTranscript
							key={this.#displayed()?.key}
							thread={this.#displayed}
							expanded={this.#expanded}
							options={options}
						/>
					);
				},
				mainScrollScope: options.nativeSupports
					? undefined
					: () => {
							if (this.#approval()) return undefined;
							const key = this.#displayed()?.key;
							if (key !== undefined) return { key, preview: this.ansiRail?.preview() === key };
						},
				dock: () => {
					const approval = this.#approval();
					return approval ? this.#confirmation(approval) : [this.#chrome, above, composer.node, below];
				},
				layer: () => this.#overlays.nodes(),
			};
		});
		this.ansiRail = rail;
		this.#composer = composer;
		this.#overlays = new Overlays({
			focused: this.surface.focused,
			focus: node => this.surface.focus(node),
			fallback: () => (this.#approval.peek() ? null : composer.field),
		});
		// The surface's dynamic regions are lazy; all callbacks above run after the composer exists.
		this.surface.focus(composer.field);
		composer.onSubmit = text => this.#submit(text);
		composer.addPasteHandler(paste => {
			if (paste.text) return false;
			void this.#pasteClipboard(true);
			return true;
		});
		composer.addActionHandler(action => {
			if (action !== "interrupt") return false;
			const thread = this.#thread();
			if (thread?.phase === "running" || thread?.conversation.session?.isCompacting) options.cancel(thread.key);
			return true;
		});
		composer.setSpaceHold(
			options.keybindings.keysFor("app.stt.pushToTalk").map(canonicalKeyId),
			options.dictation?.(composer),
		);
		this.#loadDraft();
		this.ansiRail?.selectionChanged(this.#draftKey);
		// Track undo, recall, typing, pasted atoms and dictation alike; the keyed editor must
		// never persist an old draft into the newly selected thread.
		this.#composer.addEditListener(() => {
			this.ansiRail?.preview.set(undefined);
			this.saveDraft(false);
		});
	}

	readonly #thread = (): BtwThread | undefined => {
		this.options.revision();
		return this.options.selected();
	};

	readonly #displayed = (): BtwThread | undefined => {
		const preview = this.ansiRail?.preview();
		return (
			(preview === undefined ? undefined : this.#threads().find(thread => thread.key === preview)) ?? this.#thread()
		);
	};

	readonly #facts = computed(() => {
		const thread = this.#displayed();
		if (!thread) return;
		const session = thread.conversation.session;
		const status = thread.conversation.status;
		const liveModel = status?.model;
		const branch = !liveModel ? thread.conversation.sessionManager.getBranch() : undefined;
		const savedModel = branch?.findLast(entry => entry.type === "model_change" && !entry.resolvedModelIsFallback);
		const savedEffort = branch?.findLast(entry => entry.type === "thinking_level_change");
		const usage = status?.stats.contextUsage;
		const stats = status?.stats;
		return {
			model: sanitizeDisplayLine(
				liveModel?.name ?? (savedModel?.type === "model_change" ? savedModel.model : thread.model.id),
			),
			effort: liveModel
				? liveModel.thinking
					? ((session?.isAutoThinking ? session.autoResolvedThinkingLevel() : undefined) ??
						session?.configuredThinkingLevel() ??
						"off")
					: undefined
				: (savedEffort?.configured ?? savedEffort?.thinkingLevel ?? undefined),
			context: usage && usage.contextWindow > 0 ? `${Math.round(usage.percent)}% context` : undefined,
			usage,
			tokens: stats?.tokens.total ? `${formatNumber(stats.tokens.total)} tokens` : undefined,
			cost: stats?.cost ? formatCost(stats.cost) : undefined,
			requests: stats?.premiumRequests ? `${formatNumber(stats.premiumRequests)} premium requests` : undefined,
			statuses: thread.conversation.extensionStatuses,
		};
	});

	#nativeStatus(): ComposerSlots {
		return {
			model: () => {
				const model = this.#facts()?.model;
				return (
					model && (
						<row key="model" role="omp.composer.model" align="center" gap="xs">
							<icon name="model" />
							<text text={model} wrap="none" />
						</row>
					)
				);
			},
			effort: () => {
				const level = this.#facts()?.effort;
				return (
					level && (
						<row key="effort" role="omp.composer.effort" align="center" gap="xs" title="Thinking effort">
							<effort level={level} />
							<text text={level} wrap="none" />
						</row>
					)
				);
			},
			context: () => {
				const facts = this.#facts();
				const usage = facts?.usage;
				return (
					facts?.context &&
					usage && (
						<meter
							key="context"
							role="omp.composer.context"
							style="bar"
							value={Math.min(1, usage.percent / 100)}
							label={`${Math.round(usage.percent)}%`}
							total={String(usage.contextWindow)}
							title={facts.context}
						/>
					)
				);
			},
			extras: () => this.#statusLine(true),
			usage: () => {
				const cost = this.#facts()?.cost;
				return cost && <text key="usage" role="omp.composer.usage" text={cost} wrap="none" />;
			},
		};
	}

	#statusLine(native = false): JSXNode {
		const facts = this.#facts();
		if (!facts) return undefined;
		return (
			<status
				key="btw-status"
				role={native ? "omp.composer.extras" : "omp.btw.status"}
				transparent={native}
				grow={native ? 1 : undefined}
			>
				{!native && <seg key="model" priority={2} min={{ w: "5ch" }} spans={[{ t: facts.model, s: "accent" }]} />}
				{!native && facts.effort && <seg key="effort" priority={1} spans={[{ t: facts.effort }]} />}
				<seg key="read-only" spans={[{ t: "Read-only", s: "muted" }]} />
				{!native && facts.context && <seg key="context" spans={[{ t: facts.context }]} />}
				{facts.tokens && <seg key="tokens" spans={[{ t: facts.tokens, s: "muted" }]} />}
				{!native && facts.cost && <seg key="cost" spans={[{ t: facts.cost, s: "muted" }]} />}
				{facts.requests && <seg key="requests" spans={[{ t: facts.requests, s: "muted" }]} />}
				{facts.statuses &&
					[...facts.statuses].map(([key, status]) => (
						<seg key={`extension:${key}`} spans={[{ t: sanitizeDisplayLine(status), s: "muted" }]} />
					))}
			</status>
		);
	}

	#draft(text = this.#composer.expandedText(), take = false): BtwPaneDraft {
		const images = take ? this.#composer.pendingImages.splice(0) : this.#composer.pendingImages;
		const links = take ? this.#composer.pendingImageLinks.splice(0) : this.#composer.pendingImageLinks;
		const compacted = compactImageMarkers(text, images.length);
		const keep = compacted?.keep ?? images.map((_, index) => index);
		return { text: compacted?.text ?? text, images: keep.map(i => images[i]!), imageLinks: keep.map(i => links[i]) };
	}

	#loadDraft(): void {
		const thread = this.#thread();
		this.#draftKey = thread?.key;
		this.#loadingDraft = true;
		try {
			this.#composer.setDraft(thread?.draft ?? "", thread?.draftImages);
			if (thread) this.#composer.pendingImageLinks.splice(0, Infinity, ...thread.draftImageLinks);
			this.#composer.setPlaceholder(thread ? "Reply in BTW…" : "Ask a side question without interrupting Main…");
			this.#composer.relinkImages();
		} finally {
			this.#loadingDraft = false;
		}
	}

	/** A model change may select a different thread or restore a rejected submission. */
	syncDraft(): void {
		if (this.#disposed) return;
		const thread = this.#thread();
		if (thread?.key !== this.#draftKey) {
			const previous = this.#draftKey;
			const draft = this.#draft();
			this.#menu.set(undefined);
			this.#loadDraft();
			this.ansiRail?.selectionChanged(thread?.key);
			if (previous !== undefined) {
				this.options.setDraft(previous, draft);
				this.options.persistDraft(previous);
			}
		}
	}

	restoreDraft(key: string): void {
		if (!this.#disposed && this.#draftKey === key) this.#loadDraft();
	}

	showTree(
		key: string,
		session: AgentSession,
		onNavigated: (draft?: { text: string; images?: ImageContent[] }) => void,
	): boolean {
		if (this.#disposed || this.#selected() !== key || this.#approval.peek()) return false;
		const manager = session.sessionManager;
		const roots = manager.getTree();
		if (!roots.length) throw new Error("This BTW thread has no entries");
		const current = () =>
			!this.#disposed && this.#thread()?.key === key && this.#thread()?.conversation.session === session;
		const sheet = this.#overlays.show(
			() => (
				<overlay key="btw-tree" page={{ role: "omp.tree" }}>
					<TreeSelector
						roots={roots}
						currentLeafId={manager.getLeafId()}
						terminalHeight={this.options.rows()}
						onCancel={() => sheet.close()}
						onSelect={(id, { summarize }) => {
							sheet.close();
							if (!current()) return;
							void session.navigateTree(id, { summarize, requireIdle: true }).then(
								result => {
									if (result.cancelled) return;
									onNavigated(
										result.editorText === undefined
											? undefined
											: { text: result.editorText, images: result.editorImages },
									);
								},
								error => this.options.showError(error),
							);
						}}
						onLabelChange={(id, label) => {
							if (current()) {
								void Promise.resolve(manager.appendLabelChange(id, label)).catch(error =>
									this.options.showError(error),
								);
							}
						}}
					/>
				</overlay>
			),
			{ focus: root => firstOfKind(root, "picker") },
		);
		return true;
	}
	saveDraft(persist = true): void {
		const key = this.#draftKey;
		if (key === undefined || this.#loadingDraft) return;
		this.options.setDraft(key, this.#draft());
		if (persist) this.options.persistDraft(key);
	}

	#submit(text: string): void {
		this.ansiRail?.preview.set(undefined);
		const input = this.#draft(text, true);
		const key = this.#draftKey;
		const sent = this.options.submit(key, input, this.#mode);
		if (!sent && this.#draftKey === key) {
			this.#composer.setDraft(input.text, input.images);
			this.#composer.pendingImageLinks.splice(0, Infinity, ...input.imageLinks);
		} else if (sent) {
			this.#composer.addToHistory(text);
			// A send can synchronously select a different thread. Never clear its draft.
			if (this.#draftKey === key) this.saveDraft();
		}
	}

	#select(key: string): void {
		this.saveDraft();
		this.ansiRail?.preview.set(undefined);
		this.options.select(key);
	}

	readonly onAppViewportPasteRequest = (): void => {
		void this.#pasteClipboard(false);
	};

	async #pasteClipboard(imageOnly: boolean): Promise<void> {
		if (!isClipboardTerminalLocal() || this.surface.focused() !== this.#composer.field) return;
		const key = this.#draftKey;
		try {
			const { image, text } = imageOnly
				? { image: await readImageFromClipboard(), text: "" }
				: await readClipboardContent();
			if (
				this.#disposed ||
				key !== this.#draftKey ||
				this.surface.focused() !== this.#composer.field ||
				this.#approval.peek() ||
				this.#overlays.open()
			)
				return;
			if (image) {
				const number = this.#composer.pendingImages.length + 1;
				this.#composer.insertAtom(this.#composer.chipLabel("image", number), formatVisionMarker("image", number), {
					kind: "image",
					image: { type: "image", data: image.data.toBase64(), mimeType: image.mimeType },
				});
			} else if (text) {
				this.#composer.insertText(text);
			} else return;
			this.saveDraft();
		} catch (error) {
			this.options.showError(error);
		}
	}

	async approve(title: string, summary: string, signal?: AbortSignal): Promise<boolean> {
		const lifetime = this.#lifetime.signal;
		const cancel = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
		const previous = this.#approvalTail;
		const finished = Promise.withResolvers<void>();
		this.#approvalTail = finished.promise;
		try {
			await previous;
			if (cancel.aborted) return false;
			const answer = Promise.withResolvers<boolean>();
			const finish = (approved: boolean) => {
				cancel.removeEventListener("abort", deny);
				this.#approval.set(undefined);
				if (!this.#disposed) this.surface.focus(this.#composer.field);
				answer.resolve(approved);
			};
			const deny = () => finish(false);
			cancel.addEventListener("abort", deny, { once: true });
			this.ansiRail?.clearHover();
			this.#menu.set(undefined);
			this.#overlays.closeAll();
			this.surface.focus(null);
			this.#approval.set({ title, summary, finish });
			return await answer.promise;
		} finally {
			finished.resolve();
		}
	}

	readonly onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		const approval = this.#approval.peek();
		if (approval) {
			if (
				key.kind === "press" &&
				!key.afterPaste &&
				(key.id === "enter" || matchesAppInterrupt(key, this.options.keybindings))
			) {
				approval.finish(key.id === "enter");
			}
			return true;
		}
		if (this.#overlays.open()) return false;
		const { keybindings } = this.options;
		const thread = this.#thread();
		const menu = this.#menu.peek();
		if (thread && menu?.key === thread.key) {
			const actions = this.#threadActions(thread);
			const current = Math.max(
				0,
				actions.findIndex(action => action.id === menu.active),
			);
			const command = listKeyId(key, keybindings);
			if (command === "escape") this.#menu.set(undefined);
			else if (command === "enter" && key.kind === "press" && !key.afterPaste) this.#action(actions[current]!.id);
			else if (command === "up" || command === "down") {
				const next = (current + actions.length + (command === "up" ? -1 : 1)) % actions.length;
				this.#menu.set({ ...menu, active: actions[next]!.id });
			}
			return true;
		}
		if (keybindings.matches(key, "app.message.dequeue")) {
			if (thread) this.options.dequeue(thread.key);
			return true;
		}
		if (matchesAnyKey(key, appFollowUpKeys(keybindings))) {
			this.#mode = "followUp";
			try {
				this.#composer.submit();
			} finally {
				this.#mode = "steer";
			}
			return true;
		}
		if (matchesAnyKey(key, appToolsExpandKeys(keybindings))) {
			this.#expanded.set(!this.#expanded.peek());
			return true;
		}
		if (
			matchesAppInterrupt(key, keybindings) &&
			!this.#composer.vimConsumesEscape() &&
			!this.#composer.completing()
		) {
			if (thread?.phase === "running" || thread?.conversation.session?.isCompacting) {
				this.ansiRail?.clearHover();
				this.options.cancel(thread.key);
			} else if (!this.ansiRail?.dismiss()) this.options.close();
			return true;
		}
		switch (key.id) {
			case "alt+t":
				this.#action("threads");
				return true;
			case "alt+enter":
				if (thread) this.options.promote(thread.key);
				return true;
			case "alt+shift+d":
				if (thread) this.options.delete(thread.key);
				return true;
			case "alt+c":
				if (thread) this.options.copy(thread.key);
				return true;
			case "tab":
			case "shift+tab": {
				if (this.#composer.text() !== "" || this.#composer.completing()) return false;
				const threads = this.#threads();
				const selected = threads.findIndex(item => item.key === thread?.key);
				const next = threads[(selected + threads.length + (key.id === "tab" ? 1 : -1)) % threads.length];
				if (!next || next === thread) return false;
				this.#select(next.key);
				return true;
			}
		}
		if (keybindings.matches(key, "app.clipboard.pasteImage")) {
			void this.#pasteClipboard(true);
			return true;
		}
		return false;
	};

	readonly intercept: NonNullable<NativeWorkspaceSurface["intercept"]> = event => {
		if (event.type === "key") return this.onKey(event.key);
		return event.type === "paste" && (this.#approval.peek() !== undefined || this.#menu.peek() !== undefined);
	};

	readonly #chrome = (): JSXNode => {
		const thread = this.#thread();
		const session = thread?.conversation.session;
		const queue = session && sessionCommandQueue(session);
		const pending = session?.getQueuedMessages();
		const queued: { label: string; text: string; action?: BtwQueueEdit }[] = [];
		if (pending) {
			for (const [index, text] of pending.steering.entries())
				queued.push({
					label: "Steering",
					text,
					action: index < pending.liveSteered ? undefined : { kind: "steering", text },
				});
			for (const text of pending.followUp)
				queued.push({ label: "After yield", text, action: { kind: "followUp", text } });
		}
		if (queue?.request) {
			const request = queue.request;
			queued.push({ label: "Compaction queued", text: request.text, action: { kind: "compact", request } });
		}
		for (const message of queue?.messages ?? [])
			queued.push({ label: "After compaction", text: message.text, action: { kind: "held", message } });
		return (
			<col key="btw-actions" gap="xs" onAction={act => this.#action(act)} role="omp.btw.workspace">
				{thread && queued.length > 0 && (
					<col
						role="omp.btw.queue"
						onAction={act => {
							const item = queued[Number(act)];
							if (item?.action && !this.#approval.peek() && !this.#overlays.open())
								this.options.editQueued(thread.key, item.action);
						}}
					>
						{queued.map(({ label, text, action }, index) => (
							<row key={String(index)} gap="sm">
								<text grow={1} truncate="end" text={`${label} · ${queuedLine(text)}`} />
								{action && <PaneButton id={String(index)} label="Edit" />}
							</row>
						))}
					</col>
				)}
				{!this.options.nativeSupports && this.#statusLine()}
				<row gap="sm" wrap>
					<text
						grow={1}
						truncate="end"
						text={() => {
							const displayed = this.#displayed();
							return displayed
								? `BTW · ${this.ansiRail?.preview() ? "Preview · " : ""}${sanitizeDisplayLine(displayed.title)}`
								: "BTW";
						}}
					/>
					<PaneButton id="threads" label="Threads" />
					<PaneButton id="new" label="New" />
					{this.options.nativeSupports ? (
						thread &&
						(this.options.nativeSupports("menu") ? (
							this.#nativeActions(thread)
						) : (
							<ActionButton id="more" label="···" title="Thread actions" />
						))
					) : (
						<>
							{(thread?.phase === "running" || session?.isCompacting) && <PaneButton id="stop" label="Stop" />}
							{thread && this.options.canPromote(thread.key) && <PaneButton id="promote" label="Promote" />}
							{thread && <PaneButton id="delete" label="Delete" />}
						</>
					)}
					<PaneButton id="close" label="Close" />
				</row>
			</col>
		);
	};

	#nativeActions(thread: BtwThread): JSXNode {
		const { key } = thread;
		const actions = this.#threadActions(thread);
		return (
			<menu
				key={`actions:${key}`}
				role="omp.btw.actions"
				title="Thread actions"
				align="end"
				size="sm"
				items={actions}
				open={() => this.#menu()?.key === key}
				active={() => {
					const menu = this.#menu();
					if (menu?.key !== key) return undefined;
					return actions.find(action => action.id === menu.active)?.id ?? actions[0]!.id;
				}}
				onToggle={collapsed => {
					if (this.#selected() !== key || this.#approval.peek() || this.#overlays.open()) return;
					this.#menu.set(collapsed ? undefined : { key, active: actions[0]!.id });
				}}
				onAction={act => {
					if (this.#selected() === key && actions.some(action => action.id === act)) this.#action(act);
				}}
			/>
		);
	}

	#threadActions(thread: BtwThread): { id: string; label: string; danger?: boolean }[] {
		return [
			...(thread.phase === "running" || thread.conversation.session?.isCompacting
				? [{ id: "stop", label: "Stop" }]
				: []),
			...(thread.turns.at(-1)?.replyText ? [{ id: "copy", label: "Copy answer" }] : []),
			...(this.options.canPromote(thread.key) ? [{ id: "promote", label: "Promote" }] : []),
			{ id: "delete", label: "Delete thread", danger: true },
		];
	}

	#showPicker(kind: "threads" | "actions"): void {
		const thread = this.#thread();
		const initial = kind === "threads" ? thread?.key : undefined;
		const title = kind === "threads" ? "BTW threads" : "Thread actions";
		const items = () =>
			kind === "threads"
				? this.#threads().map(topic => ({
						id: topic.key,
						label: sanitizeDisplayLine(topic.title),
						detail: topic.phase === "running" ? "Replying" : topic.unread ? `${topic.unread} unread` : undefined,
					}))
				: this.#thread()?.key === thread?.key && thread
					? this.#threadActions(thread)
					: [];
		const sheet = this.#overlays.show(
			() => (
				<overlay key={`btw-${kind}`} role={`omp.btw.${kind}`} size="sm" modal>
					<SelectSheet
						title={title}
						items={items}
						initial={initial}
						current={initial === undefined ? undefined : [initial]}
						onCancel={() => sheet.close()}
						onPick={id => {
							sheet.close();
							if (kind === "threads") this.#select(id);
							else if (this.#thread()?.key === thread?.key) this.#action(id);
						}}
					/>
				</overlay>
			),
			{ focus: root => firstOfKind(root, "picker") },
		);
	}

	#action(act: string): void {
		if (this.#approval.peek() || this.#overlays.open()) return;
		this.#menu.set(undefined);
		const thread = this.#thread();
		switch (act) {
			case "threads":
				if (this.ansiRail) this.ansiRail.toggle();
				else this.#showPicker("threads");
				break;
			case "more":
				this.#showPicker("actions");
				break;
			case "new":
				this.ansiRail?.preview.set(undefined);
				this.saveDraft();
				this.options.newThread();
				break;
			case "stop":
				if (thread) this.options.cancel(thread.key);
				break;
			case "copy":
				if (thread) this.options.copy(thread.key);
				break;
			case "promote":
				if (thread) this.options.promote(thread.key);
				break;
			case "delete":
				if (thread) this.options.delete(thread.key);
				break;
			case "close":
				this.options.close();
				break;
		}
	}

	#confirmation(approval: SummaryApproval): JSXNode {
		return (
			<col
				key="btw-approval"
				role="omp.btw.summary-approval"
				gap="sm"
				onAction={act => {
					if (act === "approve" || act === "deny") approval.finish(act === "approve");
				}}
			>
				<text text={`Send to Main from BTW · ${sanitizeDisplayLine(approval.title)}?`} />
				<row gap="sm">
					<PaneButton id="approve" label="Send" />
					<PaneButton id="deny" label="Deny" />
				</row>
			</col>
		);
	}

	readonly dispose = (): void => {
		if (this.#disposed) return;
		this.saveDraft();
		this.#disposed = true;
		this.#lifetime.abort();
		this.ansiRail?.dispose();
		this.#overlays.closeAll();
		this.#composer.setSpaceHold([], undefined);
	};
}

function PaneButton(props: { id: string; label: string }): JSXNode {
	return <ActionButton id={props.id} label={props.label} title={props.label} />;
}

interface BtwTranscriptSource {
	readonly thread: BtwThread;
	readonly conversation: BtwThread["conversation"];
	readonly session: AgentSession | undefined;
}

function ThreadTranscript(props: {
	thread(): BtwThread | undefined;
	expanded(): boolean;
	options: BtwPaneOptions;
	key?: string;
}): JSXNode {
	const source = computed<readonly BtwTranscriptSource[]>(previous => {
		const thread = props.thread();
		if (!thread) return [];
		const { conversation } = thread;
		const session = conversation.session;
		const old = previous?.[0];
		if (previous && old?.thread === thread && old.conversation === conversation && old.session === session)
			return previous;
		return [{ thread, conversation, session }];
	});
	return (
		<For
			each={source}
			fallback={
				<col role="omp.btw.transcript" gap="sm">
					<text text="Ask a side question without interrupting Main." tone="muted" />
				</col>
			}
		>
			{current => (
				<ThreadTranscriptBody
					source={current}
					thread={props.thread}
					options={props.options}
					expanded={props.expanded}
				/>
			)}
		</For>
	);
}

function ThreadTranscriptBody(props: {
	source: BtwTranscriptSource;
	thread(): BtwThread | undefined;
	expanded(): boolean;
	options: BtwPaneOptions;
}): JSXNode {
	const { thread, conversation, session } = props.source;
	const display = sideTranscriptDisplay(
		() => conversation.extensionRunner,
		() => session?.settings,
		props.expanded,
	);
	const messages = signal<readonly AgentMessage[]>([]);
	const stream = signal<AssistantMessage | undefined>(undefined);
	const eventRevision = signal(0);
	const tools = new SideToolCalls({
		expanded: props.expanded,
		onSessionChange: () => eventRevision.update(value => value + 1),
	});
	tools.bind(session);
	onCleanup(() => tools.dispose());
	effect(() => {
		eventRevision();
		// Read the selected thread's revision, but never adopt another thread's session.
		if (props.thread() !== thread || thread.conversation !== conversation || conversation.session !== session) return;
		const projected = projectBtwMessages(conversation.sessionManager, session);
		untrack(() =>
			batch(() => {
				const previous = messages();
				if (previous !== projected) {
					const append =
						previous.length <= projected.length &&
						previous.every((message, index) => message === projected[index]);
					if (!append) tools.clearCommitted();
					for (let i = append ? previous.length : 0; i < projected.length; i++) {
						const message = projected[i]!;
						if (message.role === "assistant") {
							for (const part of message.content) {
								if (part.type === "toolCall") tools.commit(part, message);
							}
						} else if (message.role === "toolResult") {
							tools.finish(message.toolCallId, message);
						}
					}
				}
				const live = tools.stream(session?.agent.state.streamMessage ?? thread.request?.streamMessage, projected);
				tools.syncExecution();
				messages.set(projected);
				stream.set(live);
			}),
		);
	});

	const blocks = (
		<>
			{() => !messages().length && <text text="Ask a side question without interrupting Main." tone="muted" />}
			<For each={messages}>
				{message => <ThreadMessage message={message} options={props.options} tools={tools} display={display} />}
			</For>
			<SideReply
				message={stream}
				tools={tools}
				display={display}
				live
				hideThinking={props.options.hideThinking}
				proseOnlyThinking={props.options.proseOnlyThinking()}
			/>
			{() => {
				const thread = props.thread();
				if (thread !== props.source.thread || thread.conversation !== conversation) return undefined;
				if (thread.conversation.session?.isCompacting) return <spinner label="Compacting BTW" />;
				if (thread.phase === "running") return <spinner label="Replying" />;
				if (thread.error) return <text text={thread.error} tone="error" wrap="word" />;
				if (readAgentsPaused(thread.conversation.sessionManager.getBranch()))
					return <text text="BTW thread paused · /continue to resume" tone="muted" />;
			}}
		</>
	);
	// The ANSI viewport indexes top-level blocks; keep Tern's semantic grouping.
	return props.options.nativeSupports ? (
		<col role="omp.btw.transcript" gap="sm">
			{blocks}
		</col>
	) : (
		blocks
	);
}

function ThreadMessage(props: {
	message: AgentMessage;
	options: BtwPaneOptions;
	tools: SideToolCalls;
	display: SideTranscriptDisplay;
}): JSXNode {
	const { message } = props;
	if (message.role === "toolResult") return undefined;
	if (message.role === "user") {
		const parts =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const images = parts.filter(part => part.type === "image");
		return (
			<UserMessage
				model={{
					text: parts.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n"),
					images,
					timestamp: message.timestamp,
				}}
			/>
		);
	}
	if (message.role !== "assistant") return <SideMessage message={message} display={props.display} />;
	return (
		<SideReply
			message={() => message}
			tools={props.tools}
			display={props.display}
			hideThinking={props.options.hideThinking}
			proseOnlyThinking={props.options.proseOnlyThinking()}
		/>
	);
}
