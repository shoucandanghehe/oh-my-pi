import { expect, it } from "bun:test";
import { inputBlocks, replayPrompt } from "@oh-my-pi/pi-ai/providers/antigravity-cli/reconcile";

it("rejects unsupported media instead of sending it to ACP as an image", () => {
	const audio = { type: "audio" as const, data: "YXVkaW8=", mimeType: "audio/wav" };
	const video = { type: "video" as const, data: "dmlkZW8=", mimeType: "video/mp4" };
	expect(() => inputBlocks({ role: "user", content: [audio], timestamp: 0 })).toThrow("does not support audio input");
	expect(() =>
		replayPrompt([
			{ role: "toolResult", toolCallId: "a", toolName: "read", isError: false, content: [video], timestamp: 0 },
			{ role: "user", content: "continue", timestamp: 0 },
		]),
	).toThrow("does not support video input");
});
