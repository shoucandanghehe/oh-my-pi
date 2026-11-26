import { colorLuma } from "@oh-my-pi/pi-utils/color";
import { KITTY_PLACEHOLDER } from "../driver/images/kitty";
import { SgrState, sgrParams, tokens } from "../text/ansi";
import { visibleWidth } from "../text/width";
import type { Theme } from "../theme/contract";
import { FG_DEFAULT, fgSgr } from "../theme/color";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Gray the visible cells along a diagonal, preserving links, background and image placements. */
export function petrifyRows(rows: string[], width: number, progress: number, theme: Theme): string[] {
	if (!theme.has("muted") && !theme.has("dim")) return rows;
	const light = colorLuma(theme.hex("muted"))!;
	const dark = colorLuma(theme.hex("dim"))!;
	const shades = Array.from({ length: 6 }, (_, index) => {
		const channel = Math.round((light + ((dark - light) * index) / 5) * 255);
		return fgSgr(`rgb(${channel}, ${channel}, ${channel})`, theme.depth);
	});
	return rows.map((row, y) => {
		const start = (0.5 * y) / Math.max(1, rows.length - 1);
		if (progress < start || !row) return row;
		const style = new SgrState();
		let x = 0;
		let active = "";
		let result = "";
		for (const token of tokens(row)) {
			if (token.escape) {
				if (active) result += style.foreground ?? FG_DEFAULT;
				active = "";
				result += token.text;
				const sgr = sgrParams(token.text);
				if (sgr !== undefined) style.apply(sgr);
				continue;
			}
			for (const { segment } of segmenter.segment(token.text)) {
				const age = progress - start - (0.29 * x) / Math.max(1, width - 1);
				const cells = visibleWidth(segment);
				x += cells;
				const next =
					cells > 0 && segment !== " " && age >= 0 && !segment.startsWith(KITTY_PLACEHOLDER)
						? shades[Math.min(shades.length - 1, Math.floor((age / 0.2) * shades.length))]!
						: "";
				if (next !== active) result += next || (style.foreground ?? FG_DEFAULT);
				result += segment;
				active = next;
			}
		}
		return active ? result + (style.foreground ?? FG_DEFAULT) : result;
	});
}
