import type { TabBarTheme } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { truncateToWidth } from "../tools/render-utils";
import { theme } from "./theme/theme";

// ═══════════════════════════════════════════════════════════════════════════
// Text Sanitization
// ═══════════════════════════════════════════════════════════════════════════

/** Sanitize text for display in a single-line status. Strips ANSI/VT escape sequences, maps remaining C0/C1 control characters to spaces, collapses whitespace, trims. */

export function sanitizeStatusText(text: string): string {
	return sanitizeText(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Shared focus marker and title treatment for app-viewport workspace panes. */
export function renderWorkspacePaneHeader(title: string, width: number, focused: boolean, suffix = ""): string {
	const indicator = focused ? theme.fg("accent", "●") : theme.fg("muted", "○");
	const styledTitle = focused ? theme.fg("accent", theme.bold(title)) : theme.fg("muted", title);
	return truncateToWidth(`${indicator} ${styledTitle}${suffix}`, Math.max(1, width));
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Bar Theme
// ═══════════════════════════════════════════════════════════════════════════

/** Shared tab bar theme used by fullscreen overlays (settings, agent hub). */
export function getTabBarTheme(): TabBarTheme {
	return {
		label: (text: string) => theme.bold(theme.fg("accent", text)),
		activeTab: (text: string) => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
		inactiveTab: (text: string) => theme.fg("muted", text),
		mutedTab: (text: string) => theme.fg("dim", text),
		hoverTab: (text: string) => theme.bg("selectedBg", theme.fg("text", text)),
		hint: (text: string) => theme.fg("dim", text),
	};
}

export { parseCommandArgs } from "../utils/command-args";
