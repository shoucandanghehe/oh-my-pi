import { defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { scrollbar } from "@oh-my-pi/pi-tui/term/painters/picker";
import { nodeState } from "@oh-my-pi/pi-tui/term/painters/state";
import { padTo } from "@oh-my-pi/pi-tui/text/width";
import { termOf } from "./common";

interface ExplanationViewport {
	readonly rows: number;
	readonly page: number;
}

// Native terminals scroll the list's full content. The row renderer needs to
// clip the wrapped text explicitly: its generic list only limits item rows.
defineRolePainter("list", "omp.model-upgrade.explanation", (node, cx) => {
	const body = node.children()[0];
	if (!body || cx.width < 2) return EMPTY_BLOCK;
	const { rows, page } = termOf<ExplanationViewport>(node) as ExplanationViewport;
	const full = cx.paint(body, cx.width);
	if (full.rows.length <= rows) return full;
	const width = cx.width - 1;
	const wrapped = cx.paint(body, width);
	const total = wrapped.rows.length;
	// The previous painted position, like a picker window, is terminal-only
	// state. Clamp each move so PageUp works immediately even after overscroll.
	const window = nodeState(node, "explanation-window", () => ({ top: 0, page: 0 }));
	const previous = window.peek();
	const top = Math.max(0, Math.min(total - rows, previous.top + (page - previous.page) * Math.max(1, rows - 1)));
	if (top !== previous.top || page !== previous.page) window.set({ top, page });
	const bar = scrollbar(cx.theme, total, top, rows);
	return { rows: wrapped.rows.slice(top, top + rows).map((line, i) => `${padTo(line, width)}${bar[i]}`) };
});
