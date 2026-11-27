import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { loadImageInput } from "../../../utils/image-loading";
import { isVideoPath } from "../../../utils/video-preview";
import { extractImagePathFromText } from "./custom-editor";

/** Holds input on its originating pane while the clipboard or attachment bytes are in flight. */
export class PanePaste {
	readonly #pending = new Set<() => void>();
	readonly #held: (() => void)[] = [];

	get pending(): boolean {
		return this.#pending.size > 0;
	}

	hold(replay: () => void): boolean {
		if (!this.pending) return false;
		this.#held.push(replay);
		return true;
	}

	begin(): () => void {
		const finish = () => {
			if (!this.#pending.delete(finish)) return;
			while (this.#pending.size === 0 && this.#held.length > 0) this.#held.shift()!();
		};
		this.#pending.add(finish);
		return finish;
	}

	reset(): void {
		this.#pending.clear();
		this.#held.length = 0;
	}
}

interface PanePathPasteTarget {
	isCurrent(): boolean;
	attach(image: ImageContent, sourcePath?: string): void | Promise<void>;
	pasteText(text: string): void;
	showError(error: unknown): void;
}

/** Typed paths survive failed attachments as text. Finder URLs yield to the other clipboard formats instead. */
export async function pastePaneImagePaths(
	paths: readonly string[],
	cwd: string,
	target: PanePathPasteTarget,
	source: "text" | "finder" = "text",
): Promise<boolean> {
	let attached = false;
	for (const item of paths) {
		if (!target.isCurrent()) break;
		const path = source === "finder" ? extractImagePathFromText(item) : item;
		if (!path) continue;
		try {
			const image = isVideoPath(path) ? null : await loadImageInput({ path, cwd, autoResize: false });
			if (!target.isCurrent()) break;
			if (image) {
				await target.attach({ type: "image", data: image.data, mimeType: image.mimeType }, image.resolvedPath);
				attached = true;
				continue;
			}
		} catch (error) {
			if (!target.isCurrent()) break;
			if (!isEnoent(error)) target.showError(error);
		}
		if (source === "text") target.pasteText(path);
	}
	return attached;
}
