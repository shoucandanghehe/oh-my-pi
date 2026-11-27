/** @jsxImportSource @oh-my-pi/pi-tui */
import { type Accessor, type JSXNode, type ScrollRequest, signal, untrack } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../styles/panels/model-upgrade-dialog";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { bindingGlyph } from "../../styles/panels/common";
import { ActionButton } from "./common";

interface ModelUpgradeDialogProps {
	readonly title: string;
	readonly explanation: string;
	readonly rows: Accessor<number>;
	onAnswer(answer: "Approve" | "Deny" | undefined): void;
}

export function ModelUpgradeDialog(props: ModelUpgradeDialogProps): JSXNode {
	const choice = signal<"Approve" | "Deny">("Approve");
	const scroll = signal<ScrollRequest | undefined>(undefined);
	const page = signal(0);
	// Reserve room for the title, footer and surrounding editor-area chrome.
	const detailRows = () => Math.max(1, Math.min(12, props.rows() - 6));
	const hint = `${bindingGlyph("tui.select.pageUp", "pageUp")}/${bindingGlyph("tui.select.pageDown", "pageDown")} scroll`;
	return (
		<col
			onKey={key => {
				if (key.kind === "release") return false;
				if (matchesSelectCancel(key)) {
					props.onAnswer(undefined);
					return true;
				}
				const keyId = selectKeyId(key);
				switch (keyId) {
					case "pageUp":
					case "pageDown":
						page.set(untrack(page) + (keyId === "pageUp" ? -1 : 1));
						scroll.set({
							by: keyId === "pageUp" ? "page-up" : "page-down",
							n: (untrack(scroll)?.n ?? 0) + 1,
						});
						return true;
					case "up":
					case "down":
						choice.set(untrack(choice) === "Approve" ? "Deny" : "Approve");
						return true;
					case "home":
						choice.set("Approve");
						return true;
					case "end":
						choice.set("Deny");
						return true;
					case "enter":
						props.onAnswer(untrack(choice));
						return true;
				}
				return false;
			}}
			onAction={action => {
				if (action === "Approve" || action === "Deny") props.onAnswer(action);
			}}
		>
			<text key="title" tone="accent" text={props.title} truncate="end" />
			<list
				key="viewport"
				max={() => ({ lines: detailRows() })}
				term={() => ({ role: "omp.model-upgrade.explanation", rows: detailRows(), page: page() })}
			>
				<col key="explanation" scroll={scroll}>
					<text text={props.explanation} />
				</col>
			</list>
			<row key="actions" align="center" gap="sm">
				{(["Approve", "Deny"] as const).map(label => (
					<ActionButton
						id={label}
						label={() => `${choice() === label ? currentTheme().symbols.symbol("nav.cursor") : " "} ${label}`}
						mark={() => (choice() === label ? "pick" : undefined)}
					/>
				))}
				<text text={hint} tone="muted" truncate="end" />
			</row>
		</col>
	);
}
