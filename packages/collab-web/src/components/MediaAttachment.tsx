import type { ReactNode } from "react";

/** Inline audio/video from a saved message or tool result. The transcript may contain untyped historic blocks. */
export function MediaAttachment({ block }: { block: { type: string } }): ReactNode {
	if (block.type !== "audio" && block.type !== "video") return null;
	if (!("mimeType" in block) || typeof block.mimeType !== "string" ||
		!("data" in block) || typeof block.data !== "string") return null;
	if (!block.mimeType.startsWith(`${block.type}/`)) return null;
	const src = `data:${block.mimeType};base64,${block.data}`;
	return block.type === "audio"
		? <audio controls preload="none" src={src} />
		: <video controls preload="none" src={src} style={{ maxWidth: "100%" }} />;
}
