/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Messages queued while the agent works (`pendingMessages` slot): steering
 * messages (Enter) and those waiting for the turn to yield (Ctrl+Q).
 *
 * - Natively (role `omp.queue`): a stack of pills, one per message: a
 *   `corner-down-right` icon, the text on one line, the total (`2 queued`)
 *   in the first pill when several wait, and an Edit control for each
 *   restorable message. A view without per-message edits keeps its dequeue action.
 * - In a text terminal (`src/ui/styles/dock/queue.ts`): a blank row, then per
 *   group a muted `Steering · 1` heading over dim numbered rows, then the dim
 *   hint `└ ⌥↑ to edit`; every row cut to one line.
 */
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import "../styles/dock";
import { kbdKeys } from "../keys/format";
import { formatTooltipKey } from "../keys/hints";

/** Queued messages under one heading. */
export interface QueuedMessageGroup {
	/** `Steering`, `After yield`. */
	readonly label: string;
	readonly messages: readonly string[];
	/** Per-chip actions when supplied; undefined slots cannot be edited. */
	readonly edits?: readonly (QueuedMessageEdit | undefined)[];
}

export interface QueuedMessageEdit {
	readonly id: string;
	restore(): void;
}

/** What the band shows; the controller feeds it from the session queue. */
export class QueueModel {
	/** Groups in order; empty groups are skipped. */
	readonly groups = signal<readonly QueuedMessageGroup[]>([]);
	/** The `app.message.dequeue` key. */
	readonly dequeueKey = signal("alt+up");
	/** Default native Edit action for views without per-chip actions. */
	onEdit: (() => void) | undefined;
}

/** A message on one line (`↵` for its line breaks). */
export function queuedLine(message: string): string {
	return replaceTabs(message).replace(/\s*\r?\n\s*/g, " ↵ ");
}

/** See the module docs. */
export function QueuedMessages(props: { readonly model: QueueModel }): JSXNode {
	const model = props.model;
	return () => {
		const groups = model.groups().filter(group => group.messages.length > 0);
		if (groups.length === 0) return undefined;
		const key = model.dequeueKey();
		const count = groups.reduce((sum, group) => sum + group.messages.length, 0);
		const title = `Edit  ${formatTooltipKey(key)}`;
		let first = true;
		const pills: JSXNode[] = [];
		for (const group of groups) {
			group.messages.forEach((message, index) => {
				const edit = group.edits?.[index];
				const lead = first && count > 1;
				first = false;
				pills.push(
					<row
						key={`${group.label}/${edit?.id ?? index}`}
						role="omp.queue.item"
						align="center"
						gap="sm"
						title={group.label}
					>
						<icon key="icon" name="corner-down-right" />
						<text key="text" text={queuedLine(message)} wrap="none" truncate="end" grow={1} />
						{lead && (
							<badge
								key="count"
								text={`${count} queued`}
								title={`${count} messages queued`}
								role="omp.queue.count"
							/>
						)}
						{(edit || !group.edits) && (
							<row
								key="edit"
								role="omp.queue.edit"
								gap="xs"
								align="center"
								title={title}
								actions={{ click: "queue.edit" }}
								onAction={act => {
									if (act !== "queue.edit") return;
									if (edit) edit.restore();
									else model.onEdit?.();
								}}
							>
								<kbd keys={kbdKeys(key)} />
								<text text="Edit" />
							</row>
						)}
					</row>,
				);
			});
		}
		return (
			<col role="omp.queue" gap="xs" term={{ groups, key }}>
				{pills}
			</col>
		);
	};
}
