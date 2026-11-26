/** @jsxImportSource @oh-my-pi/pi-tui */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import {
	computed,
	createSurface,
	effect,
	For,
	type JSXNode,
	type KeyEvent,
	Show,
	signal,
	type Surface,
	untrack,
} from "@oh-my-pi/pi-tui";
import { CombinedAutocompleteProvider } from "../../../autocomplete/autocomplete";
import type { KeybindingsManager } from "../../../config/keybindings/keybindings";
import {
	appFollowUpKeys,
	appToolsExpandKeys,
	matchesAnyKey,
	matchesAppInterrupt,
} from "../../../config/keybindings/matchers";
import { canonicalKeyId } from "../../../config/keybindings/key-id";
import type { SpaceHoldHandler } from "../../../config/keybindings/space-hold";
import { firstOfKind } from "../../../modes/controllers/selector-views";
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
import { Composer } from "../../composer/composer";
import { queuedLine } from "../../dock/queue";
import { Overlays } from "../../shell/overlays";
import { AssistantMessageBlock } from "../../transcript/messages/assistant-message";
import { UserMessage } from "../../transcript/messages/user-message";
import { ToolBlock, ToolCall } from "../../transcript/tool-block";
import { ActionButton } from "./common";
import { TreeSelector } from "../pickers/tree-selector";
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
	readonly keybindings: KeybindingsManager;
	readonly revision: () => number;
	threads(): readonly BtwThread[];
	selected(): BtwThread | undefined;
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
	readonly #composer: Composer;
	readonly #overlays: Overlays;
	readonly #selected;
	readonly #threads;
	readonly #rail = signal(false);
	readonly #expanded = signal(false);
	readonly #approval = signal<SummaryApproval | undefined>(undefined);
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
		this.surface = createSurface(() => {
			composer = new Composer({
				placeholder: "Ask BTW…",
				autocomplete: new CombinedAutocompleteProvider(COMMANDS, options.cwd),
			});
			return {
				main: () => {
					const approval = this.#approval();
					return approval ? (
						<md key="btw-summary" text={approval.summary} />
					) : (
						<ThreadTranscript
							key={this.#selected()}
							thread={this.#thread}
							expanded={this.#expanded}
							options={options}
						/>
					);
				},
				dock: () => {
					const approval = this.#approval();
					return approval ? this.#confirmation(approval) : [this.#chrome, composer.node];
				},
				layer: () => this.#overlays.nodes(),
			};
		});
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
		// Track undo, recall, typing, pasted atoms and dictation alike; the keyed editor must
		// never persist an old draft into the newly selected thread.
		this.#composer.addEditListener(() => this.saveDraft(false));
	}

	readonly #thread = (): BtwThread | undefined => {
		this.options.revision();
		return this.options.selected();
	};

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
			this.saveDraft();
			this.#loadDraft();
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
		this.options.select(key);
		this.#rail.set(false);
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
			if (this.#rail.peek()) this.#rail.set(false);
			else if (thread?.phase === "running" || thread?.conversation.session?.isCompacting)
				this.options.cancel(thread.key);
			else this.options.close();
			return true;
		}
		switch (key.id) {
			case "alt+t":
				this.#rail.set(!this.#rail.peek());
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
		return this.#approval.peek() !== undefined && event.type === "paste";
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
				<Show when={this.#rail}>
					<list
						max={() => ({ lines: Math.max(1, Math.floor(this.options.rows() / 3)) })}
						selected={this.#selected() ?? null}
						onSelect={key => this.options.select(key)}
						onActivate={key => this.#select(key)}
					>
						{this.#threads().map(item => (
							<item
								key={item.key}
								label={sanitizeDisplayLine(item.title)}
								value={
									item.phase === "running" ? "Replying" : item.unread ? `${item.unread} unread` : undefined
								}
							/>
						))}
					</list>
				</Show>
				<row gap="sm" wrap>
					<text grow={1} truncate="end" text={thread ? `BTW · ${sanitizeDisplayLine(thread.title)}` : "BTW"} />
					<PaneButton id="threads" label="Threads" />
					<PaneButton id="new" label="New" />
					{(thread?.phase === "running" || session?.isCompacting) && <PaneButton id="stop" label="Stop" />}
					{thread && this.options.canPromote(thread.key) && <PaneButton id="promote" label="Promote" />}
					{thread && <PaneButton id="delete" label="Delete" />}
					<PaneButton id="close" label="Close" />
				</row>
			</col>
		);
	};

	#action(act: string): void {
		if (this.#approval.peek() || this.#overlays.open()) return;
		const thread = this.#thread();
		switch (act) {
			case "threads":
				this.#rail.set(!this.#rail.peek());
				break;
			case "new":
				this.saveDraft();
				this.options.newThread();
				break;
			case "stop":
				if (thread) this.options.cancel(thread.key);
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
		this.#overlays.closeAll();
		this.#composer.setSpaceHold([], undefined);
	};
}

function PaneButton(props: { id: string; label: string }): JSXNode {
	return <ActionButton id={props.id} label={props.label} title={props.label} />;
}

function ThreadTranscript(props: {
	thread(): BtwThread | undefined;
	expanded(): boolean;
	options: BtwPaneOptions;
	key?: string;
}): JSXNode {
	const messages = computed(() => {
		const thread = props.thread();
		return thread ? projectBtwMessages(thread.conversation.sessionManager, thread.conversation.session) : [];
	});
	const resultById = computed(
		() =>
			new Map(
				messages().flatMap(message =>
					message.role === "toolResult" ? [[message.toolCallId, message] as const] : [],
				),
			),
	);
	const stream = computed(() => {
		const thread = props.thread();
		const message = thread?.conversation.session?.agent.state.streamMessage ?? thread?.request?.streamMessage;
		if (message?.role !== "assistant") return undefined;
		const last = messages().at(-1);
		return last?.role === "assistant" && last.timestamp === message.timestamp ? undefined : message;
	});
	return (
		<col role="omp.btw.transcript" gap="sm">
			{() => !messages().length && <text text="Ask a side question without interrupting Main." tone="muted" />}
			<For each={messages}>
				{message => (
					<ThreadMessage
						message={message}
						options={props.options}
						expanded={props.expanded}
						resultById={resultById}
					/>
				)}
			</For>
			<AssistantMessageBlock
				model={{
					message: stream,
					transient: true,
					hideThinking: props.options.hideThinking,
					expandThinking: props.expanded,
					proseOnlyThinking: props.options.proseOnlyThinking(),
					reacts: false,
				}}
			/>
			{() => {
				const thread = props.thread();
				if (!thread) return undefined;
				if (thread.conversation.session?.isCompacting) return <spinner label="Compacting BTW" />;
				if (thread.phase === "running") return <spinner label="Replying" />;
				if (thread.error) return <text text={thread.error} tone="error" wrap="word" />;
				if (readAgentsPaused(thread.conversation.sessionManager.getBranch()))
					return <text text="BTW thread paused · /continue to resume" tone="muted" />;
			}}
		</col>
	);
}

function ThreadMessage(props: {
	message: AgentMessage;
	options: BtwPaneOptions;
	expanded(): boolean;
	resultById(): ReadonlyMap<string, Extract<AgentMessage, { role: "toolResult" }>>;
}): JSXNode {
	const { message } = props;
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
	if (message.role !== "assistant") return undefined;
	const reply: AssistantMessage = message;
	return [
		<AssistantMessageBlock
			model={{
				message: reply,
				finalized: true,
				hideThinking: props.options.hideThinking,
				expandThinking: props.expanded,
				proseOnlyThinking: props.options.proseOnlyThinking(),
				reacts: false,
			}}
		/>,
		...reply.content.flatMap(part => {
			if (part.type !== "toolCall") return [];
			const call = new ToolCall({ id: part.id, name: part.name, args: part.arguments });
			call.setArgsComplete();
			effect(() => {
				const result = props.resultById().get(part.id);
				const expanded = props.expanded();
				untrack(() => {
					if (result) call.updateResult(result, false);
					call.setExpanded(expanded);
				});
			});
			return [<ToolBlock call={call} />];
		}),
	];
}
