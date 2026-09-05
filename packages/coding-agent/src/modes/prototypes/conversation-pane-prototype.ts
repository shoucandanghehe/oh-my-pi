/**
 * Throwaway prototype for one responsive conversation-pane design: workspace
 * header as the single identity/status surface, flex transcript, sticky composer.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import {
	type Component,
	type Focusable,
	type MouseRoutable,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	type SgrMouseEvent,
	TUI,
	type ViewportHeightAware,
	visibleWidth,
	WorkspaceLayout,
	type WorkspaceLayoutNode,
	WorkspaceModel,
} from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { ChatTranscriptBuilder } from "../components/chat-transcript-builder";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme, initTheme, stopThemeWatcher, theme } from "../theme/theme";

type ConversationKind = "main" | "agent" | "btw";
type ConversationStatus = "ready" | "running" | "responding";

interface ConversationSpec {
	kind: ConversationKind;
	paneId: string;
	title: string;
	statusSegments: readonly string[];
	statusRight: string;
	placeholder: string;
	messages: AgentMessage[];
}

interface ConversationPrototypePaneOptions {
	ui: TUI;
	spec: ConversationSpec;
	focusPane: (direction: 1 | -1) => void;
	toggleAdvisor: () => void;
	requestRender: () => void;
	exit: () => void;
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const LAYOUT: WorkspaceLayoutNode = {
	kind: "split",
	splitId: "prototype-root",
	axis: "x",
	children: [
		{ node: { kind: "pane", paneId: "main" }, weight: 3 },
		{
			node: {
				kind: "split",
				splitId: "prototype-side",
				axis: "y",
				children: [
					{ node: { kind: "pane", paneId: "agent" }, weight: 1 },
					{ node: { kind: "pane", paneId: "btw" }, weight: 1 },
				],
			},
			weight: 2,
		},
	],
};

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp,
	};
}

function userMessage(text: string, timestamp: number): Extract<AgentMessage, { role: "user" }> {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function initialMessages(kind: ConversationKind): AgentMessage[] {
	const now = Date.now() - 60_000;
	if (kind === "main") {
		return [
			userMessage("Bring Agent and BTW panes up to the same interaction quality as Main.", now),
			assistantMessage(
				"The current panes fork the conversation experience. I would keep one canonical transcript and composer surface, then preserve only domain differences.",
				now + 1_000,
			),
			userMessage("What should stay different?", now + 2_000),
			assistantMessage(
				"- **Main** keeps full commands, tools, and session status.\n- **Agent** keeps messaging and a read-only Advisor mode.\n- **BTW** stays ephemeral and tool-free.\n\nThe shell—scrolling, focus, composer, status, and selection—should feel identical.",
				now + 3_000,
			),
			assistantMessage(
				"Resize the terminal to exercise the responsive collapse. Ctrl+Left/Right moves focus, Alt+A previews a transient notice, and F4 toggles Reviewer between messageable Agent and read-only Advisor.",
				now + 4_000,
			),
		];
	}
	if (kind === "agent") {
		return [
			userMessage("Audit the detached transcript experience.", now),
			assistantMessage(
				"The transcript renderer is capable, but its shell is cramped: duplicated borders, hard-coded hints, and a basic editor consume attention that should stay on the conversation.",
				now + 1_000,
			),
			assistantMessage("I am still running. You can message me without leaving this pane.", now + 2_000),
		];
	}
	return [
		userMessage("Can I ask follow-up questions here without interrupting Main?", now),
		assistantMessage(
			"Yes. This remains a tool-free, ephemeral side conversation. The new shell should make that constraint feel intentional rather than second-class.",
			now + 1_000,
		),
		userMessage("And then promote the useful answer?", now + 2_000),
		assistantMessage(
			"Use the branch action when a side-thread deserves to become the main conversation.",
			now + 3_000,
		),
	];
}

function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	if (safeWidth === 0) return "";
	const truncated = truncateToWidth(replaceTabs(text), safeWidth);
	return `${truncated}${" ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)))}`;
}

function renderComposerStatusLine(
	spec: ConversationSpec,
	width: number,
	notice: string | undefined,
): { content: string; width: number } {
	const availableWidth = Math.max(0, Math.trunc(width));
	if (availableWidth === 0) return { content: "", width: 0 };
	if (notice) {
		const content = truncateToWidth(theme.fg("warning", ` ⚠ ${notice} `), availableWidth);
		return { content, width: visibleWidth(content) };
	}

	const segments = [...spec.statusSegments];
	const separator = theme.fg("muted", " > ");
	const renderLeft = (): string =>
		` ${segments.map((segment, index) => (index === 0 ? theme.fg("accent", segment) : segment)).join(separator)} `;
	let right = ` ${theme.fg("warning", spec.statusRight)} `;
	let left = renderLeft();
	if (visibleWidth(left) + visibleWidth(right) > availableWidth) right = "";
	while (segments.length > 1 && visibleWidth(left) + visibleWidth(right) > availableWidth) {
		segments.pop();
		left = renderLeft();
	}

	if (!right) {
		const content = truncateToWidth(left, availableWidth);
		return { content, width: visibleWidth(content) };
	}
	const gapWidth = Math.max(1, availableWidth - visibleWidth(left) - visibleWidth(right));
	const content = `${left}${theme.fg("border", theme.boxRound.horizontal.repeat(gapWidth))}${right}`;
	return { content, width: visibleWidth(content) };
}

class ConversationPrototypePane implements Component, Focusable, MouseRoutable, ViewportHeightAware {
	readonly editor: CustomEditor;
	readonly #builder: ChatTranscriptBuilder;
	readonly #options: ConversationPrototypePaneOptions;
	readonly #scrollView = new ScrollView([], { height: 8, scrollbar: "auto", scrollbarStyle: "braille" });
	#messages: AgentMessage[];
	#height = 10;
	#followBottom = true;
	#responding = false;
	#notice: string | undefined;
	#replySequence = 0;
	#transcriptWidth = 1;
	#disposed = false;
	#focused = false;
	#readOnly = false;

	constructor(options: ConversationPrototypePaneOptions) {
		this.#options = options;
		this.#messages = [...options.spec.messages];
		this.#builder = new ChatTranscriptBuilder({
			ui: options.ui,
			cwd: process.cwd(),
			requestRender: options.requestRender,
		});
		this.#builder.rebuild(this.#messages);
		this.editor = new CustomEditor(getEditorTheme());
		const defaultBorderColor = this.editor.borderColor;
		this.editor.borderColor = text => {
			if (this.#responding) return theme.fg("warning", text);
			if (this.editor.focused) return theme.fg("accent", text);
			return defaultBorderColor(text);
		};
		this.editor.setUseTerminalCursor(false);
		this.editor.setPlaceholder(options.spec.placeholder);
		this.editor.setMaxHeight(5);
		this.editor.setShimmerRepaintHandler(options.requestRender);
		this.editor.setTopBorderProvider(availableWidth => this.#editorTopBorder(availableWidth));
		this.editor.onSubmit = text => this.#submit(text);
		this.editor.onClear = options.exit;
		this.editor.onExit = options.exit;
		this.editor.onEscape = () => {
			this.editor.setText("");
			this.#notice = "Draft cleared";
			options.requestRender();
		};
		this.editor.setCustomKeyHandler("f4", options.toggleAdvisor);
		this.editor.setCustomKeyHandler("ctrl+left", () => options.focusPane(-1));
		this.editor.setCustomKeyHandler("ctrl+right", () => options.focusPane(1));
		this.editor.setCustomKeyHandler("alt+a", () => this.#previewNotice());
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(focused: boolean) {
		this.#focused = focused;
	}

	get focusTarget(): Component {
		return this.#readOnly ? this : this.editor;
	}

	setReadOnly(readOnly: boolean): void {
		if (this.#options.spec.kind !== "agent" || this.#readOnly === readOnly) return;
		this.#readOnly = readOnly;
		this.#replySequence++;
		this.#responding = false;
		this.editor.setText("");
		this.editor.setPlaceholder(readOnly ? "read-only · advisor" : this.#options.spec.placeholder);
		this.editor.disableSubmit = readOnly;
		this.#notice = undefined;
		this.#options.requestRender();
	}

	header(width: number, focused: boolean): string {
		const status = this.#status();
		const focusIndicator = focused ? theme.fg("accent", "●") : theme.fg("muted", "○");
		const name = focused
			? theme.fg("accent", theme.bold(this.#options.spec.title))
			: theme.bold(this.#options.spec.title);
		let state: string | undefined;
		if (this.#readOnly) {
			state = "advisor";
		} else if (status === "responding") {
			state = theme.fg("warning", "responding");
		} else if (status === "running") {
			state = "running";
		}
		const suffix = state ? theme.fg("muted", ` · ${state}`) : "";
		return fitLine(` ${focusIndicator} ${name}${suffix}`, width);
	}

	setViewportHeight(height: number): void {
		this.#height = Math.max(1, Math.trunc(height));
	}

	handleInput(data: string): void {
		if (this.#readOnly) {
			if (matchesKey(data, "ctrl+c")) {
				this.#options.exit();
				return;
			}
			if (matchesKey(data, "f4")) {
				this.#options.toggleAdvisor();
				return;
			}
			if (matchesKey(data, "ctrl+left")) {
				this.#options.focusPane(-1);
				return;
			}
			if (matchesKey(data, "ctrl+right")) {
				this.#options.focusPane(1);
				return;
			}
			if (matchesKey(data, "alt+a")) {
				this.#previewNotice();
				return;
			}
			if (matchesKey(data, "j")) {
				this.#scrollView.scroll(1);
			} else if (matchesKey(data, "k")) {
				this.#scrollView.scroll(-1);
			} else if (data === "g") {
				this.#scrollView.scrollToTop();
			} else if (data === "G") {
				this.#scrollView.scrollToBottom();
			} else if (!this.#scrollView.handleScrollKey(data)) {
				return;
			}
		} else if (!this.#scrollView.handleScrollKey(data)) {
			return;
		}
		this.#syncFollowBottom();
		this.#options.requestRender();
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		if (col >= this.#transcriptWidth) return false;
		const handled = this.#scrollView.routeMouse(event, line, col);
		if (!handled) return false;
		this.#syncFollowBottom();
		this.#options.requestRender();
		return true;
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, Math.trunc(width));
		const composer = this.#renderComposer(safeWidth);
		const transcriptHeight = Math.max(0, this.#height - composer.length);
		const transcript = transcriptHeight > 0 ? this.#renderTranscript(safeWidth, transcriptHeight) : [];
		return [...transcript, ...composer].slice(-this.#height);
	}

	dispose(): void {
		this.#disposed = true;
		this.#replySequence++;
		this.#builder.dispose();
	}

	#status(): ConversationStatus {
		if (this.#responding) return "responding";
		return this.#options.spec.kind === "agent" ? "running" : "ready";
	}

	#editorTopBorder(availableWidth: number): { content: string; width: number } | undefined {
		if (this.#height <= 7) return undefined;
		return renderComposerStatusLine(this.#options.spec, availableWidth, this.#notice);
	}

	#renderComposer(width: number): readonly string[] {
		const micro = this.#height <= 7;
		this.editor.setBorderVisible(!micro);
		this.editor.setMaxHeight(micro ? 1 : 5);
		if (!micro) return this.editor.render(width);
		if (this.#notice) return [fitLine(` ${theme.fg("warning", `⚠ ${this.#notice}`)}`, width)];

		const context = this.#options.spec.statusSegments[2];
		const compactStatus = context
			? `${theme.fg("accent", "π")} ${theme.fg("muted", "·")} ${context}`
			: theme.fg("accent", "π");
		const prefix = this.#readOnly
			? `${compactStatus} ${theme.fg("muted", "·")}`
			: `${compactStatus} ${theme.fg("accent", "›")}`;
		const lines = this.editor.render(Math.max(1, width - visibleWidth(prefix) - 1));
		return lines.map((line, index) =>
			fitLine(`${index === 0 ? `${prefix} ` : " ".repeat(visibleWidth(prefix) + 1)}${line}`, width),
		);
	}

	#renderTranscript(width: number, height: number): readonly string[] {
		this.#transcriptWidth = width;
		const lines = this.#builder.container.render(Math.max(1, width - 1));
		this.#scrollView.setLines(lines);
		this.#scrollView.setHeight(height);
		if (this.#followBottom) this.#scrollView.scrollToBottom();
		return this.#scrollView.render(width);
	}

	#syncFollowBottom(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#previewNotice(): void {
		this.#notice = "connection lost — retrying";
		this.#options.requestRender();
	}

	async #submit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text || this.#responding || this.#readOnly) return;
		if (this.#options.spec.kind === "btw" && text === "/clear") {
			this.#replySequence++;
			this.#messages = [];
			this.#notice = "Ephemeral conversation cleared";
			this.#builder.rebuild(this.#messages);
			this.#followBottom = true;
			this.#options.requestRender();
			return;
		}

		const timestamp = Date.now();
		this.#messages.push(userMessage(text, timestamp));
		const responseIndex = this.#messages.length;
		const response = this.#prototypeResponse(text);
		this.#messages.push(assistantMessage("", timestamp + 1));
		this.#responding = true;
		this.editor.disableSubmit = true;
		this.#notice = undefined;
		this.#followBottom = true;
		const sequence = ++this.#replySequence;
		for (const progress of [0.2, 0.45, 0.7, 1]) {
			if (this.#disposed || sequence !== this.#replySequence) return;
			const end = Math.max(1, Math.ceil(response.length * progress));
			this.#messages[responseIndex] = assistantMessage(response.slice(0, end), timestamp + 1);
			this.#builder.rebuild(this.#messages);
			this.#options.requestRender();
			await Bun.sleep(140);
		}
		if (this.#disposed || sequence !== this.#replySequence) return;
		this.#responding = false;
		this.editor.disableSubmit = this.#readOnly;
		this.#options.requestRender();
	}

	#prototypeResponse(input: string): string {
		const safeInput = replaceTabs(input).replace(/[\r\n]+/g, " ");
		if (this.#options.spec.kind === "agent") {
			return `Agent received “${safeInput}”. This simulated reply uses the same transcript and composer shell while preserving agent-specific status and actions.`;
		}
		if (this.#options.spec.kind === "btw") {
			return `BTW received “${safeInput}”. The conversation remains ephemeral and tool-free; only its interaction quality is shared with Main.`;
		}
		return `Main received “${safeInput}”. Compare the same send, stream, scroll, and focus behavior across all three panes.`;
	}
}

class ConversationPanePrototype {
	readonly #ui: TUI;
	readonly #finish: () => void;
	readonly #panes = new Map<string, ConversationPrototypePane>();
	readonly workspace: WorkspaceLayout;
	#advisor = false;
	#closed = false;

	constructor(ui: TUI, finish: () => void) {
		this.#ui = ui;
		this.#finish = finish;
		const paneSpecs: ConversationSpec[] = [
			{
				kind: "main",
				paneId: "main",
				title: "Main",
				statusSegments: [
					"π",
					"⬢ GPT-5.6 Sol · ◕ xhigh",
					"◫ 57.5%/372K ⟲",
					"📁 ~/code/oh-my-pi",
					"⑂ demo/app-viewport-backend ?1",
					"⤴ #2103 ▶───────────◀",
				],
				statusRight: "🪙 715K",
				placeholder: "Continue the main conversation…",
				messages: initialMessages("main"),
			},
			{
				kind: "agent",
				paneId: "agent",
				title: "Reviewer",
				statusSegments: [
					"π",
					"⬢ GPT-5.6 Sol · ◕ xhigh",
					"◫ 18%/372K",
					"📁 ~/code/oh-my-pi",
					"⑂ demo/app-viewport-backend ?1",
				],
				statusRight: "🪙 42K",
				placeholder: "Message this agent…",
				messages: initialMessages("agent"),
			},
			{
				kind: "btw",
				paneId: "btw",
				title: "BTW",
				statusSegments: ["π", "⬢ GPT-5.6 Sol · ◕ xhigh", "◫ 9%/372K", "📁 ~/code/oh-my-pi", "ephemeral · no tools"],
				statusRight: "🪙 8K",
				placeholder: "Continue the side conversation…",
				messages: initialMessages("btw"),
			},
		];

		this.workspace = new WorkspaceLayout({
			model: new WorkspaceModel(LAYOUT),
			panes: paneSpecs.map(spec => {
				const pane = new ConversationPrototypePane({
					ui,
					spec,
					focusPane: direction => this.workspace.focusNextPane(direction),
					toggleAdvisor: () => this.#toggleAdvisor(),
					requestRender: () => ui.requestRender(),
					exit: () => this.close(),
				});
				this.#panes.set(spec.paneId, pane);
				return {
					paneId: spec.paneId,
					title: spec.title,
					component: pane,
					focusTarget: () => pane.focusTarget,
					scroll: "component" as const,
					minWidth: 24,
					minHeight: 6,
				};
			}),
			height: () => ui.terminal.rows,
			requestRender: () => ui.requestRender(),
			focus: component => ui.setFocus(component),
			renderHeader: (pane, width, focused) => this.#renderHeader(pane.paneId, width, focused),
			renderSash: (text, axis) => {
				const glyph = axis === "x" ? "┃" : "━";
				return theme.fg("borderAccent", glyph.repeat(visibleWidth(text)));
			},
			renderDropPreview: text => theme.fg("accent", text),
			renderDropPreviewGhost: text => theme.fg("muted", text),
		});
	}

	start(): void {
		const main = this.#panes.get("main");
		if (!main) throw new Error("Prototype main pane unavailable");
		this.#ui.addChild(this.workspace);
		this.#ui.setFocus(main.editor);
		this.#ui.start({ clearScrollback: true });
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pane of this.#panes.values()) pane.dispose();
		this.#ui.stop();
		this.#finish();
	}

	#toggleAdvisor(): void {
		const agentPane = this.#panes.get("agent");
		if (!agentPane) return;
		this.#advisor = !this.#advisor;
		agentPane.setReadOnly(this.#advisor);
		this.workspace.focusPane("agent");
	}

	#renderHeader(paneId: string, width: number, focused: boolean): string {
		return this.#panes.get(paneId)?.header(width, focused) ?? "";
	}
}

Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
await Settings.init({ cwd: process.cwd() });
await initTheme();
const ui = new TUI(new ProcessTerminal(), false);
const { promise, resolve } = Promise.withResolvers<void>();
const prototype = new ConversationPanePrototype(ui, resolve);
const stop = (): void => prototype.close();
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
prototype.start();
await promise;
process.removeListener("SIGTERM", stop);
process.removeListener("SIGHUP", stop);
stopThemeWatcher();
