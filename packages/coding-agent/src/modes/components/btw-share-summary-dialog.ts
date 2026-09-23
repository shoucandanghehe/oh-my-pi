import { Markdown, SelectList, Text } from "@oh-my-pi/pi-tui";
import { OverlayPanel } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { col, md, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton } from "@oh-my-pi/pi-tui/native/overlay";
import { plainLine } from "@oh-my-pi/pi-tui/native/spans";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { getMarkdownTheme, getSelectListTheme, theme } from "@oh-my-pi/pi-tui/theme/theme";

/** Approval of one exact side-thread summary, on the side-thread's own surface. */
export class BtwShareSummaryDialog extends OverlayPanel {
	readonly #choices: SelectList;
	readonly #body: NativeNode[];
	readonly nativeOverlay = {
		role: "omp.overlay.btw.share-summary",
		head: "Share with Main",
		size: "md",
	} as const;

	constructor(
		threadTitle: string,
		summary: string,
		readonly resolve: (approved: boolean) => void,
	) {
		super("Share with Main", "omp.overlay.btw.share-summary");
		const source = `BTW · ${plainLine(threadTitle)}`;
		this.#choices = new SelectList(
			[
				{ value: "approve", label: "Share summary" },
				{ value: "deny", label: "Cancel" },
			],
			2,
			getSelectListTheme(),
		);
		this.#choices.onSelect = item => resolve(item.value === "approve");
		this.#choices.onCancel = () => resolve(false);
		this.addChild(new Text(theme.fg("muted", source), 0, 0));
		this.addChild(new Markdown(replaceTabs(summary), 0, 1, getMarkdownTheme()));
		this.addChild(this.#choices);
		this.#body = [text([span(source, "muted")]), md(replaceTabs(summary))];
	}

	override describe(): NativeNode {
		const approve = this.#choices.getSelectedItem()?.value === "approve";
		return col(
			[
				...this.#body,
				actionBar([
					actionButton("Cancel", "deny", {
						keys: approve ? "escape" : "enter",
						tone: approve ? undefined : "accent",
					}),
					actionButton("Share summary", "approve", {
						keys: approve ? "enter" : undefined,
						tone: approve ? "accent" : undefined,
					}),
				]),
			],
			{ gap: "sm" },
		);
	}

	handleInput(data: string): void {
		this.#choices.handleInput(data);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "approve" || event.act === "deny") this.resolve(event.act === "approve");
	}
}
