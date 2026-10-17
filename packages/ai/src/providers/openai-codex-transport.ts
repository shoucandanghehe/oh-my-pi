import { $env, $flag } from "@oh-my-pi/pi-utils";
import type { Model, OpenAIWebSocketPreference } from "../types";

/** Read the optional process-wide Codex WebSocket override. */
export function getOpenAICodexWebSocketEnvValue(): boolean | undefined {
	return $env.PI_CODEX_WEBSOCKET === undefined ? undefined : $flag("PI_CODEX_WEBSOCKET");
}

/** WS-only overrides transport preferences; otherwise resolve env, caller, then model. */
export function isOpenAICodexWebSocketPreferred(
	model: Model<"openai-codex-responses">,
	options?: { preferWebsockets?: OpenAIWebSocketPreference },
): boolean {
	if (options?.preferWebsockets === "only") return true;
	const envValue = getOpenAICodexWebSocketEnvValue();
	if (envValue !== undefined) return envValue;
	if (options?.preferWebsockets === false) return false;
	return options?.preferWebsockets === true || model.preferWebsockets === true;
}
