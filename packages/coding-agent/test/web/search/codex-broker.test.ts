import { describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";

function makeNativeSearchResponse(): string {
	return JSON.stringify({
		encrypted_output: "encrypted-search-output",
		output: "Broker-backed Codex answer",
		results: [
			{
				type: "text_result",
				ref_id: "turn0search0",
				title: "Broker",
				url: "https://example.com/broker",
				snippet: "Broker-backed Codex answer",
			},
		],
	});
}

describe("Codex web search broker auth", () => {
	it("uses AuthStorage.getOAuthAccess for token + account metadata without opening AgentStorage", async () => {
		const getOAuthAccess = vi.fn(async () => ({
			accessToken: "broker-refreshed-access-token",
			accountId: "broker-account-id",
		}));
		const authStorage = { getOAuthAccess } as unknown as AuthStorage;
		const openSpy = vi.spyOn(AgentStorage, "open");
		let requestHeaders: Headers | undefined;

		const fetchMock: FetchImpl = async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response(makeNativeSearchResponse(), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const params: SearchParams = {
			query: "broker codex search",
			systemPrompt: "Use web search.",
			authStorage,
			sessionId: "codex-broker-session",
		};

		const result = await searchCodex({ ...params, fetch: fetchMock });

		expect(result.provider).toBe("codex");
		expect(getOAuthAccess).toHaveBeenCalledWith("openai-codex", "codex-broker-session", { signal: undefined });
		expect(requestHeaders?.get("authorization")).toBe("Bearer broker-refreshed-access-token");
		expect(requestHeaders?.get("chatgpt-account-id")).toBe("broker-account-id");
		expect(openSpy).not.toHaveBeenCalled();
	});
});
