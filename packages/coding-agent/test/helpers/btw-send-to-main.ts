import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";

/**
 * Main's built-in `write`. BTW reaches `xd://send_to_main_session` through its own
 * device-only copy of this declaration; Main's instance must never execute there.
 * Register it in Main's tools, `toolRegistry`, and `builtInToolNames`.
 */
export function createMainWriteTool(): AgentTool {
	return {
		name: "write",
		label: "Write",
		description: "Write a file or execute an xd:// device",
		parameters: type({ path: "string", content: "string" }),
		execute: async () => {
			throw new Error("Main's write must not execute in BTW");
		},
	};
}

/** The model's `write xd://send_to_main_session` call carrying `summary`. */
export function sendToMainSessionCall(id: string, summary: string): ToolCall {
	return {
		type: "toolCall",
		id,
		name: "write",
		arguments: { path: "xd://send_to_main_session", content: JSON.stringify({ summary }) },
	};
}
