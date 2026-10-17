import { type Component, Markdown, Text, type TUI } from "../index";
import { replaceTabs } from "../render/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { sanitizeErrorLine } from "../chrome/error-block";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent } from "../chrome/streaming-panel";
import { interruptKey } from "../chrome/keybinding-hints";
import { formatKeyHint } from "../app-keybindings";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { col, md, node, span, text } from "../native/describe";
import { actionBar, actionButton } from "../native/overlay";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	canBranch?: () => boolean;
	canFollowUp?: () => boolean;
	canOpenThread?: boolean;
	onAction?: (action: "open" | "copy" | "promote" | "follow-up" | "close") => void;
}

export class BtwPanelComponent extends OverlayPanel {
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#canFollowUp: (() => boolean) | undefined;
	#canOpenThread: boolean;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;
	#copied = false;
	#baseTitle: string;
	readonly #question: string;
	readonly #content: StreamingPanelContent;
	readonly #onAction: BtwPanelComponentOptions["onAction"];
	#toolActivity: string | undefined;
	#native: { node: NativeNode; canFollowUp: boolean; canBranch: boolean } | undefined;

	constructor(options: BtwPanelComponentOptions) {
		const baseTitle = `BTW · ${replaceTabs(options.question)}`;
		super(baseTitle, "omp.overlay.btw");
		this.#baseTitle = baseTitle;
		this.#question = replaceTabs(options.question);
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#onAction = options.onAction;
		this.#content = new StreamingPanelContent(() => ({
			sections: [this.#contentComponent()],
			footer: () => this.#footerLine(),
		}));
		this.addChild(this.#content);
		this.#canOpenThread = options.canOpenThread === true;
		this.#rebuild();
	}

	setToolActivity(activity: string | undefined): void {
		if (activity === this.#toolActivity || this.#closed) return;
		this.#toolActivity = activity;
		this.#rebuild();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (
			event.act === "open" ||
			event.act === "copy" ||
			event.act === "promote" ||
			event.act === "follow-up" ||
			event.act === "close"
		)
			this.#onAction?.(event.act);
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#setCopied(false);
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#setCopied(false);
		this.#rebuild();
	}

	markRunning(): void {
		if (this.#closed) return;
		this.#state = "running";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	/** Visual confirmation that `c` copied the answer to the clipboard. */
	markCopied(): void {
		if (this.#closed || !this.isCopyable()) return;
		this.#setCopied(true);
		this.#rebuild();
	}

	#setCopied(copied: boolean): void {
		this.#copied = copied;
		this.title = copied ? `${this.#baseTitle} ✓ Copied` : this.#baseTitle;
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		if (this.#closed) return;
		this.#state = "branching";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#setCopied(false);
		this.#rebuild();
	}
	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return this.#visibleAnswer;
	}

	close(): void {
		this.#closed = true;
	}

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	override describe(): NativeNode {
		const canFollowUp = this.#canFollowUp?.() ?? false;
		const canBranch = this.#canBranch?.() ?? this.isBranchable();
		const memo = this.#native;
		if (memo && memo.canFollowUp === canFollowUp && memo.canBranch === canBranch) return memo.node;
		// Inline in the dock, styled as a sheet by role: a borderless column headed by the question.
		const title = text([span("BTW", "accent"), span(` ${this.#question}`)], { truncate: "end", lines: 1, grow: 1 });
		const live = this.#state === "running" || this.#state === "branching";
		const head = node("row", { role: "omp.sheet.head", gap: "sm", align: "center" }, [
			...(live ? [node("spinner", {})] : []),
			title,
		]);
		const described = col(
			[
				head,
				...(this.#toolActivity ? [text([span(this.#toolActivity, "muted")], { truncate: "end", lines: 1 })] : []),
				this.#describeBody(),
				this.#describeFooter(canFollowUp, canBranch),
			],
			{
				role: this.nativeRole,
				gap: "sm",
				tone: this.#state === "error" ? "error" : this.#state === "aborted" ? "warning" : undefined,
			},
		);
		this.#native = { node: described, canFollowUp, canBranch };
		return described;
	}

	#describeBody(): NativeNode {
		if (this.#state === "error") {
			return text([span(sanitizeErrorLine(this.#errorMessage ?? "Unknown error"), "error")], { wrap: "word" });
		}
		const answer = this.#visibleAnswer;
		if (answer) return col([md(answer, { stream: this.#state === "running" })], { role: "omp.assistant" });
		const waiting = this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
		return text([span(waiting, "dim")]);
	}

	#describeFooter(canFollowUp: boolean, canBranch: boolean): NativeNode {
		return actionBar([
			...(this.#canOpenThread ? [actionButton("Open thread", "open", { keys: "enter", tone: "accent" })] : []),
			...(this.isCopyable() ? [actionButton(this.#copied ? "Copied" : "Copy", "copy", { keys: "c" })] : []),
			...(canFollowUp ? [actionButton("Follow up", "follow-up", { keys: "f" })] : []),
			...(canBranch ? [actionButton("Promote", "promote", { keys: "b" })] : []),
			actionButton("Close", "close", { keys: "escape" }),
		]);
	}

	#rebuild(): void {
		this.#native = undefined;
		this.#content.refresh();
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		// The main editor routes `app.interrupt` (Escape by default) to the panel.
		const esc = interruptKey();
		const open = this.#canOpenThread ? `${formatKeyHint("enter")} open thread · ` : "";
		switch (this.#state) {
			case "running":
				return theme.fg("muted", `${open}${esc} to cancel`);
			case "complete": {
				const actions: string[] = [];
				if (this.#canOpenThread) actions.push(`${formatKeyHint("enter")} open thread`);
				const copyKey = formatKeyHint("c");
				if (this.isCopyable()) actions.push(this.#copied ? `${copyKey} to copy again` : `${copyKey} copy`);
				if (this.#canFollowUp?.()) actions.push(`${formatKeyHint("f")} to follow up`);
				if (this.#canBranch?.() ?? this.isBranchable()) {
					actions.push(`${formatKeyHint("b")} Promote`);
				}
				actions.push(`${esc} dismiss`);
				if (this.#copied) {
					return `${theme.fg("success", "✓ Copied to clipboard")}${theme.fg("muted", actions.length > 0 ? ` · ${actions.join(" · ")}` : "")}`;
				}
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", `${theme.status.pending} Branching to chat…`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · ${open}${esc} to close`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · ${open}${esc} to close`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", sanitizeErrorLine(this.#errorMessage ?? "Unknown error")), 0, 0);
		}
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return new Text(theme.fg("dim", waiting), 0, 0);
		}
		return new Markdown(text, 0, 0, getMarkdownTheme());
	}
}
