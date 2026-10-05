import { Container } from "../tui";
import { Spacer } from "../components/spacer";
import { TruncatedText } from "../components/truncated-text";
import { formatKeyHint, formatTooltipKey } from "../key-hint-format";
import type { KeyId } from "../keys";
import { kbd, node, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { replaceTabs } from "../utils";
import { theme } from "../theme/theme";

/** Queued messages under one heading ("Steering", "After yield"). */
export interface QueuedMessageGroup {
	readonly label: string;
	readonly messages: readonly string[];
	/** Leading entries already sent into the current provider response. */
	readonly liveSteered?: number;
}

/**
 * Messages queued while the agent works, above the editor. ANSI: a heading
 * per group, numbered dim rows and the dequeue hint. Natively (§8.1): a
 * stack of pills, each `corner-down-right` · the text · `⌥↑ Edit`, the total
 * (`N queued`, not a position) in the first pill when more than one waits;
 * each edit control restores its own message, while the keyboard hint retains
 * the last-message dequeue.
 */
export class QueuedMessagesBand extends Container {
	readonly #native: NativeNode;
	readonly #editTargets = new Map<string, { group: number; index: number }>();

	constructor(
		groups: readonly QueuedMessageGroup[],
		dequeueKey: KeyId,
		private readonly onEdit: (group: number, index: number) => void,
	) {
		super();
		this.addChild(new Spacer(1));
		for (const group of groups) {
			const heading = theme.fg("muted", `${group.label}${theme.sep.dot}${group.messages.length}`);
			this.addChild(new TruncatedText(heading, 1, 0));
			for (let index = 0; index < group.messages.length; index++) {
				const message = replaceTabs(group.messages[index] ?? "").replace(/\r?\n/g, " ↵ ");
				this.addChild(new TruncatedText(theme.fg("dim", `  ${index + 1}. ${message}`), 1, 0));
			}
		}
		this.addChild(
			new TruncatedText(theme.fg("dim", `  ${theme.tree.hook} ${formatKeyHint(dequeueKey)} to edit`), 1, 0),
		);
		const editTitle = `Edit  ${formatTooltipKey(dequeueKey)}`;

		const count = groups.reduce((sum, group) => sum + group.messages.length, 0);
		const pills: NativeNode[] = [];
		groups.forEach((group, groupIndex) => {
			group.messages.forEach((message, index) => {
				this.#editTargets.set(`${group.label}/${index}/edit`, { group: groupIndex, index });
				const live = index < (group.liveSteered ?? 0);
				const children: NativeNode[] = [
					node("icon", { name: "corner-down-right" }, undefined, "icon"),
					node(
						"text",
						{
							text: replaceTabs(message).replace(/\s*\r?\n\s*/g, " ↵ "),
							wrap: "none",
							truncate: "end",
							grow: 1,
						},
						undefined,
						"text",
					),
				];
				if (pills.length === 0 && count > 1) {
					children.push(
						node(
							"badge",
							{ text: `${count} queued`, title: `${count} messages queued`, role: "omp.queue.count" },
							undefined,
							"count",
						),
					);
				}
				children.push(
					node(
						"row",
						{
							role: "omp.queue.edit",
							gap: "xs",
							align: "center",
							title: live ? `Stop current response and edit  ${formatTooltipKey(dequeueKey)}` : editTitle,
							actions: { click: "queue.edit" },
						},
						[kbd(dequeueKey), text(live ? "Stop & edit" : "Edit")],
						"edit",
					),
				);
				pills.push(
					node(
						"row",
						{ role: "omp.queue.item", align: "center", gap: "sm", title: group.label },
						children,
						`${group.label}/${index}`,
					),
				);
			});
		});
		this.#native = node("col", { role: "omp.queue", gap: "xs" }, pills);
	}

	override describe(): NativeNode {
		return this.#native;
	}

	/** Restore the message belonging to the clicked pill, not an unrelated last entry. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action" || event.act !== "queue.edit") return;
		const target = this.#editTargets.get(event.key);
		if (target) this.onEdit(target.group, target.index);
	}
}
