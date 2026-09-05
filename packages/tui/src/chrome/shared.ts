import type { TabBarTheme } from "../components/tab-bar";
import { sanitizeDisplaySingleLine } from "../overlays/extensions/display-text";
import { theme } from "../theme/index";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { truncateToWidth } from "../render/render-utils";
// ═══════════════════════════════════════════════════════════════════════════
// Text Sanitization
// ═══════════════════════════════════════════════════════════════════════════

/** Compact single-line display text for statuses; unlike titles, collapse padding and trim. */
export function sanitizeStatusText(text: string): string {
	return sanitizeDisplaySingleLine(text).replace(/ +/g, " ").trim();
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
