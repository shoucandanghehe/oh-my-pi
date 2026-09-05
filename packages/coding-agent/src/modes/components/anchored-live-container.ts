import { type AppViewportScrollRegion, Container } from "@oh-my-pi/pi-tui";

/**
 * Scrolls transient HUD/status rows with the transcript while leaving the
 * editor suffix pinned in the app viewport.
 */
export class AnchoredLiveContainer extends Container implements AppViewportScrollRegion {
	getAppViewportScrollRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}

	getAppViewportScrollRegionEnd(): number | undefined {
		return undefined;
	}
}
