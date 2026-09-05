import { type AppViewportScrollRegion, Container, type NativeScrollbackLiveRegion } from "@oh-my-pi/pi-tui";

/**
 * Anchored live-region container for HUD/status rows between the transcript and
 * editor. While it has content every row is live, so rebuilt-in-place rows are
 * never committed to native scrollback as stale duplicates. In the app viewport
 * these rows extend the scrollable region, leaving the editor suffix pinned
 * while oversized HUDs remain reachable through the shared viewport scroll.
 */
export class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion, AppViewportScrollRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}

	getAppViewportScrollRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}

	getAppViewportScrollRegionEnd(): number | undefined {
		return undefined;
	}
}
