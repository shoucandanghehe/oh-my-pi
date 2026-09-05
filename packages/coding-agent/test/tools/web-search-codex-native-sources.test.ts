import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

async function searchNative(results: unknown[]) {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			expect(new URL(request.url).pathname).toBe("/codex/alpha/search");
			expect(request.headers.get("authorization")).toBe("Bearer local-test-key");
			return Response.json({
				output: "  Answer with [invented source](https://invented.example/placeholder).  ",
				results,
			});
		},
	});
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	authStorage.keys.setRuntime("openai-codex", "local-test-key");
	const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const bundled = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.6-luna");
	if (!bundled) throw new Error("Missing native Codex test model");
	try {
		return await searchCodex({
			query: "native source evidence",
			systemPrompt: "",
			authStorage,
			modelRegistry,
			model: { ...bundled, baseUrl: `http://127.0.0.1:${server.port}`, useResponsesLite: true },
		});
	} finally {
		server.stop(true);
		authStorage.close();
	}
}

describe("Codex native structured source evidence", () => {
	it("rejects an empty result list even when the answer contains a URL", async () => {
		await expect(searchNative([])).rejects.toBeInstanceOf(SearchProviderError);
	});

	it("rejects results without a parseable structured source instead of promoting answer links", async () => {
		await expect(searchNative([{ type: "text_result", url: "not a URL" }])).rejects.toBeInstanceOf(
			SearchProviderError,
		);
	});

	it("deduplicates structured sources and excludes answer-only links", async () => {
		const source = {
			type: "text_result",
			title: "Verified article",
			url: "https://verified.example/article",
			snippet: "Structured evidence snippet.",
		};
		const response = await searchNative([source, source]);
		expect(response.sources).toEqual([
			{
				title: "Verified article",
				url: "https://verified.example/article",
				snippet: "Structured evidence snippet.",
			},
		]);
		expect(response.answer).toBe("Answer with [invented source](https://invented.example/placeholder).");
	});
});
