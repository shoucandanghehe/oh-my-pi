import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { resolveCodexAlphaSearchUrl, resolveCodexResponsesUrl } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

function makeSseResponse(): string {
	return [
		`data: ${JSON.stringify({ type: "response.web_search_call.completed", item_id: "ws_test" })}`,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Broker-backed Codex answer",
						annotations: [{ type: "url_citation", url: "https://example.com/broker", title: "Broker" }],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_broker", model: "broker-selected-model" },
		})}`,
		"",
	].join("\n");
}

function makeNativeSearchResponse(): string {
	return JSON.stringify({
		output: "Broker-backed Codex answer",
		results: [{ type: "text_result", url: "https://example.com/broker", title: "Broker" }],
	});
}

function makeParams(authStorage: AuthStorage, modelRegistry: ModelRegistry, useResponsesLite: boolean): SearchParams {
	return {
		query: "broker codex search",
		systemPrompt: "Use web search.",
		authStorage,
		modelRegistry,
		sessionId: "codex-broker-session",
		model: {
			...buildModel({
				id: "broker-selected-model",
				name: "broker-selected-model",
				api: "openai-codex-responses",
				provider: "broker-codex",
				baseUrl: CODEX_BASE_URL,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			}),
			useResponsesLite,
		},
	};
}

function searchResponse(useResponsesLite: boolean): Response {
	return new Response(useResponsesLite ? makeNativeSearchResponse() : makeSseResponse(), {
		headers: { "Content-Type": useResponsesLite ? "application/json" : "text/event-stream" },
	});
}

describe("Codex web search broker auth", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
	});

	it.each([true, false])(
		"uses the selected provider token and account metadata without opening AgentStorage (native=%s)",
		async useResponsesLite => {
			const getOAuthAccess = vi.spyOn(authStorage.oauth, "access").mockResolvedValue({
				accessToken: "broker-refreshed-access-token",
				accountId: "broker-account-id",
			});
			const openSpy = vi.spyOn(AgentStorage, "open");
			const params = makeParams(authStorage, modelRegistry, useResponsesLite);
			let requestUrl: string | undefined;
			let requestHeaders: Headers | undefined;
			let requestBody: Record<string, unknown> | undefined;
			const fetchMock: FetchImpl = async (url, init) => {
				requestUrl = String(url);
				requestHeaders = new Headers(init?.headers);
				requestBody = JSON.parse(String(init?.body));
				return searchResponse(useResponsesLite);
			};

			const result = await searchCodex({ ...params, fetch: fetchMock });

			expect(result.provider).toBe("codex");
			expect(getOAuthAccess).toHaveBeenCalledWith("broker-codex", "codex-broker-session", { signal: undefined });
			expect(requestUrl).toBe(
				(useResponsesLite ? resolveCodexAlphaSearchUrl : resolveCodexResponsesUrl)(params.model.baseUrl),
			);
			expect(requestBody?.model).toBe("broker-selected-model");
			if (useResponsesLite) expect(requestBody?.id).toBe("codex-broker-session");
			expect(requestHeaders?.get("authorization")).toBe("Bearer broker-refreshed-access-token");
			expect(requestHeaders?.get("chatgpt-account-id")).toBe("broker-account-id");
			expect(result.sources).toEqual([{ title: "Broker", url: "https://example.com/broker" }]);
			expect(openSpy).not.toHaveBeenCalled();
		},
	);

	it.each([true, false])(
		"refreshes broker credentials without changing the selected model (native=%s)",
		async useResponsesLite => {
			const controller = new AbortController();
			const getOAuthAccess = vi
				.spyOn(authStorage.oauth, "access")
				.mockResolvedValueOnce({ accessToken: "expired-token", accountId: "expired-account" })
				.mockResolvedValueOnce({ accessToken: "refreshed-token", accountId: "refreshed-account" });
			const requestHeaders: Headers[] = [];
			const resolveModelHeaders = vi
				.spyOn(modelRegistry, "resolveModelHeaders")
				.mockImplementation(async () => ({ "X-Refresh-Generation": String(requestHeaders.length) }));
			const params = makeParams(authStorage, modelRegistry, useResponsesLite);
			const fetchMock: FetchImpl = async (url, init) => {
				requestHeaders.push(new Headers(init?.headers));
				expect(String(url)).toBe(
					(useResponsesLite ? resolveCodexAlphaSearchUrl : resolveCodexResponsesUrl)(params.model.baseUrl),
				);
				expect(JSON.parse(String(init?.body)).model).toBe("broker-selected-model");
				if (requestHeaders.length === 1) return new Response("Unauthorized", { status: 401 });
				return searchResponse(useResponsesLite);
			};

			const result = await searchCodex({ ...params, fetch: fetchMock, signal: controller.signal });

			expect(result.model).toBe("broker-selected-model");
			expect(requestHeaders).toHaveLength(2);
			expect(requestHeaders[0].get("authorization")).toBe("Bearer expired-token");
			expect(requestHeaders[0].get("chatgpt-account-id")).toBe("expired-account");
			expect(requestHeaders[1].get("authorization")).toBe("Bearer refreshed-token");
			expect(requestHeaders[1].get("chatgpt-account-id")).toBe("refreshed-account");
			expect(requestHeaders[1].get("x-refresh-generation")).toBe("1");
			expect(resolveModelHeaders).toHaveBeenCalledWith(params.model, controller.signal);
			expect(getOAuthAccess).toHaveBeenLastCalledWith("broker-codex", "codex-broker-session", {
				forceRefresh: true,
				signal: controller.signal,
			});
		},
	);
});
