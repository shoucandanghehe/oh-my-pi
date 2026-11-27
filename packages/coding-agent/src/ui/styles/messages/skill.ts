/**
 * Skill invocations (`card` role `omp.skill`).
 *
 * - Callout (the skill led the draft): a `userMessageBg` box one row and one
 *   cell in, behind a `customMessageLabel` rail (`▎`) down its left edge; the
 *   skill chip as a soft pill and the muted prompt size head it, the rest of
 *   the draft follows as bubble Markdown.
 * - Inline (the skill sat mid-prompt): the draft as a user bubble with the
 *   chip inline; expanded, a callout with the chip and the prompt follows.
 * - Expanded, the callout ends with a muted `prompt` subhead and the loaded
 *   skill prompt.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { type TextRow, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TermChip } from "../../transcript/messages/chips";
import { fillRow, termOf } from "./fill";
import { fileLink } from "../tools/file-common";
import { bubbleMarkdown } from "./user";

interface SkillTerm {
	label: string;
	/** The skill's SKILL.md: the pill links to it. */
	path?: string;
	lines?: string;
	leading: boolean;
	draft: string;
	chips: readonly TermChip[];
	prompt: string;
	expanded: boolean;
}

const BG = "userMessageBg";

function paintSkill(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const term = termOf<SkillTerm>(node);
	const width = cx.width;
	const boxWidth = Math.max(1, width - 1);
	const inner = Math.max(1, boxWidth - 2);
	const pill = fileLink(
		cx,
		theme.bg("customMessageBg", theme.fg("customMessageLabel", `\x1b[1m${term.label ?? ""}\x1b[22m`)),
		term.path,
		1,
	);
	const header = term.lines ? `${pill}  ${theme.fg("muted", term.lines)}` : pill;
	const content: string[] = [...wrap(header, inner)];
	const textRows: (TextRow | undefined)[] = [];
	const rail = theme.bg(BG, theme.fg("customMessageLabel", theme.symbols.symbol("skill.rail")));
	const inset = visibleWidth(rail) + 1;
	const append = ({ rows, textRows: source }: Block): void => {
		const top = content.length + 1;
		source?.forEach((row, i) => {
			if (row) textRows[top + i] = { ...row, start: row.start + inset, end: row.end + inset };
		});
		content.push(...rows);
	};
	if (term.leading && term.draft) {
		content.push("");
		append(bubbleMarkdown(theme, term.draft, inner, { chips: term.chips, hyperlinks: cx.hyperlinks }));
	}
	if (term.expanded && term.prompt) {
		content.push("", theme.fg("muted", "prompt"), "");
		append(bubbleMarkdown(theme, term.prompt, inner, {}));
	}
	const callout = ["", ...content, ""].map(row => rail + fillRow(theme, BG, row === "" ? "" : ` ${row}`, boxWidth));
	if (term.leading) return { rows: callout, textRows };
	const bubble = term.draft
		? bubbleMarkdown(theme, term.draft, width, { chips: term.chips, padding: 1, hyperlinks: cx.hyperlinks })
		: undefined;
	const rows = bubble?.rows.map(row => fillRow(theme, BG, row, width)) ?? [];
	if (!term.expanded) return { rows, textRows: bubble?.textRows };
	const descriptions = bubble?.textRows?.slice() ?? [];
	descriptions.length = rows.length;
	return { rows: [...rows, ...callout], textRows: [...descriptions, ...textRows] };
}

defineRolePainter("card", "omp.skill", paintSkill);
