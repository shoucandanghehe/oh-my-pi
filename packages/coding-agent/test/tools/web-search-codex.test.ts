import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, type FetchImpl, type Model, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { hasCodexSearch, searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";

type CapturedRequest = {
	url: string;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
	signal?: AbortSignal | null;
};

function codexModel(id: string, baseUrl = "https://chatgpt.com/backend-api"): Model<"openai-codex-responses"> {
	const bundled = getBundledModel<"openai-codex-responses">("openai-codex", id);
	if (bundled) return { ...bundled, baseUrl };
	return buildModel({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

const selectedCodexModel = codexModel("gpt-5.4");
const proxyCodexModel = {
	...selectedCodexModel,
	baseUrl: "https://proxy.example/backend-api",
	headers: { "X-Proxy-Tenant": "tenant-1" },
};

function proxyModel(id: string): Model<"openai-codex-responses"> {
	return {
		...codexModel(id, proxyCodexModel.baseUrl),
		headers: proxyCodexModel.headers,
	};
}

function makeNativeSearchResponse(): string {
	return JSON.stringify({
		output: "Example Article (https://example.com/article)\nSearch result snippet.",
		results: [
			{
				type: "text_result",
				title: "Example Article",
				url: "https://example.com/article",
				snippet: "Search result snippet.",
			},
		],
	});
}

// A completed hosted web_search tool call. Real Codex searches always stream a
// `response.web_search_call.*` event; the provider now requires that evidence
// (#6988), so every success fixture must include it.
const WEB_SEARCH_CALL_EVENT = `data: ${JSON.stringify({
	type: "response.web_search_call.completed",
	item_id: "ws_test",
})}`;

function makeSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Codex answer",
						annotations: [{ type: "url_citation", url: "https://example.com/article", title: "Example Article" }],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_codex_test",
				model,
				usage: {
					input_tokens: 12,
					output_tokens: 7,
					total_tokens: 19,
				},
			},
		})}`,
		"",
	].join("\n");
}

function makeImagePlaceholderSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_text.delta",
			delta: "OpenAI Responses API defaults `store` to false unless you opt in.",
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "(see attached image)",
						annotations: [
							{ type: "url_citation", url: "https://platform.openai.com/docs/api-reference/responses" },
						],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_codex_placeholder_test",
				model,
			},
		})}`,
		"",
	].join("\n");
}

function makeMarkdownLinkSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "See [Example Article](https://example.com/article) for details.",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_markdown_test", model },
		})}`,
		"",
	].join("\n");
}

function makePlainUrlSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Sources:\n- https://example.com/article\n- https://example.com/faq",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_plain_url_test", model },
		})}`,
		"",
	].join("\n");
}

function makeMarkdownParenthesesSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "See [Function](https://en.wikipedia.org/wiki/Function_(mathematics)) for details.",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_markdown_parentheses_test", model },
		})}`,
		"",
	].join("\n");
}

function makePlainUrlPunctuationSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Read https://example.com/article. Then compare https://example.com/faq), and keep https://en.wikipedia.org/wiki/Function_(mathematics).",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_plain_url_punctuation_test", model },
		})}`,
		"",
	].join("\n");
}

describe("searchCodex model selection", () => {
	const residencyPayload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-test",
				chatgpt_data_residency: "us",
			},
		}),
	).toString("base64url");
	const residencyToken = `header.${residencyPayload}.signature`;
	let oauthAuthStorage: AuthStorage;
	let emailOnlyAuthStorage: AuthStorage;
	let proxyAuthStorage: AuthStorage;
	let oauthOnlyAuthStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let proxyModelRegistry: ModelRegistry;
	let oauthModelRegistry: ModelRegistry;
	let capturedRequest: CapturedRequest | null = null;

	function createAuthStorage(): AuthStorage {
		return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	}

	beforeEach(() => {
		oauthAuthStorage = createAuthStorage();
		vi.spyOn(oauthAuthStorage.oauth, "access").mockResolvedValue({
			accessToken: residencyToken,
			accountId: "acct-test",
		});
		emailOnlyAuthStorage = createAuthStorage();
		vi.spyOn(emailOnlyAuthStorage.oauth, "access").mockResolvedValue({
			accessToken: "email-only-access-token",
			email: "user@example.com",
		});
		proxyAuthStorage = createAuthStorage();
		proxyAuthStorage.keys.setRuntime("openai-codex", "test-proxy-key");
		oauthOnlyAuthStorage = createAuthStorage();
		oauthOnlyAuthStorage.keys.setRuntime("openai-codex", "official-oauth-token");
		vi.spyOn(oauthOnlyAuthStorage.keys, "source").mockReturnValue({ kind: "oauth", concrete: true });
		modelRegistry = new ModelRegistry(oauthAuthStorage, undefined, { ignoreLocalModelConfig: true });
		proxyModelRegistry = new ModelRegistry(proxyAuthStorage, undefined, { ignoreLocalModelConfig: true });
		oauthModelRegistry = new ModelRegistry(oauthOnlyAuthStorage, undefined, { ignoreLocalModelConfig: true });
	});

	function makeSearchParams(
		query: string,
		fetch?: FetchImpl,
		model: Model<"openai-codex-responses"> = selectedCodexModel,
	): SearchParams {
		return {
			query,
			systemPrompt: "Codex test system prompt",
			authStorage: oauthAuthStorage,
			model,
			modelRegistry,
			...(fetch ? { fetch } : {}),
		};
	}

	function mockCodexFetch(responseModel: string, responseBody?: string): FetchImpl {
		capturedRequest = null;
		return (url, init) => {
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
				signal: init?.signal,
			};
			const nativeSearch = capturedRequest.url.endsWith("/alpha/search");
			return Promise.resolve(
				new Response(responseBody ?? (nativeSearch ? makeNativeSearchResponse() : makeSseResponse(responseModel)), {
					status: 200,
					headers: { "Content-Type": nativeSearch ? "application/json" : "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
		capturedRequest = null;
		oauthAuthStorage.close();
		emailOnlyAuthStorage.close();
		proxyAuthStorage.close();
		oauthOnlyAuthStorage.close();
	});

	it("uses native Alpha Search for the selected Responses-Lite model", async () => {
		const result = await searchCodex(
			makeSearchParams("selected native model", mockCodexFetch("gpt-5.6-luna"), codexModel("gpt-5.6-luna")),
		);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
		expect(new Headers(capturedRequest?.headers).get("x-openai-internal-codex-residency")).toBe("us");
		expect(capturedRequest?.body?.model).toBe("gpt-5.6-luna");
		expect(result.model).toBe("gpt-5.6-luna");
		expect(result.sources).toEqual([
			{ title: "Example Article", url: "https://example.com/article", snippet: "Search result snippet." },
		]);
	});

	it("uses email-only OAuth credentials without an account header", async () => {
		const result = await searchCodex({
			...makeSearchParams("email-only Codex search", mockCodexFetch("gpt-5.6-luna"), codexModel("gpt-5.6-luna")),
			authStorage: emailOnlyAuthStorage,
			modelRegistry: new ModelRegistry(emailOnlyAuthStorage, undefined, { ignoreLocalModelConfig: true }),
		});

		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer email-only-access-token");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
		expect(result.answer).toBe("Example Article (https://example.com/article)\nSearch result snippet.");
		expect(result.sources).toEqual([
			{ title: "Example Article", url: "https://example.com/article", snippet: "Search result snippet." },
		]);
	});

	it("applies the configured request timeout to Codex search", async () => {
		const timeoutSignal = new AbortController().signal;
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);

		await searchCodex({
			...makeSearchParams("slow codex search", mockCodexFetch("gpt-5.6-luna"), codexModel("gpt-5.6-luna")),
			timeoutMs: 180_000,
		});

		expect(timeoutSpy).toHaveBeenCalledWith(180_000);
		expect(capturedRequest?.signal).toBe(timeoutSignal);
	});

	function sentUserText(): string | undefined {
		const commands = capturedRequest?.body?.commands as { search_query?: Array<{ q: string }> } | undefined;
		if (commands) return commands.search_query?.[0]?.q;
		const input = capturedRequest?.body?.input as Array<Record<string, unknown>> | undefined;
		const userItem = input?.find(item => item.role === "user");
		const content = userItem?.content as Array<Record<string, unknown>> | undefined;
		return content?.[0]?.text as string | undefined;
	}

	it.each(["gpt-5.6-luna", "gpt-5.4"])("normalizes Google-style query operators for %s", async modelId => {
		await searchCodex(
			makeSearchParams(
				'bun runtime site:bun.sh -site:reddit.com after:2024-01-01 "exact phrase"',
				mockCodexFetch(modelId),
				codexModel(modelId),
			),
		);

		expect(capturedRequest).not.toBeNull();
		expect(sentUserText()).toBe('bun runtime "exact phrase" site:bun.sh -site:reddit.com after:2024-01-01');
		if (capturedRequest?.url.endsWith("/responses")) {
			// The hosted endpoint does not support a separate filters object.
			expect(capturedRequest?.body?.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
		}
	});

	it.each(["gpt-5.6-luna", "gpt-5.4"])("sends directive-free queries byte-identical for %s", async modelId => {
		const query = "how does the bun runtime schedule timers?";
		await searchCodex(makeSearchParams(query, mockCodexFetch(modelId), codexModel(modelId)));

		expect(sentUserText()).toBe(query);
	});

	it("uses configured Codex endpoint, API key, and headers without OAuth", async () => {
		const result = await searchCodex({
			...makeSearchParams("proxy codex model", mockCodexFetch("gpt-5.4"), proxyCodexModel),
			authStorage: proxyAuthStorage,
			modelRegistry: proxyModelRegistry,
		});

		expect(await hasCodexSearch(proxyAuthStorage)).toBe(true);
		expect(capturedRequest?.url).toBe("https://proxy.example/backend-api/codex/responses");
		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-proxy-key");
		expect(headers.get("x-proxy-tenant")).toBe("tenant-1");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(headers.has("x-openai-internal-codex-residency")).toBe(false);
		expect(result.answer).toBe("Codex answer");
	});

	it.each([
		{ id: "tenant-native", useResponsesLite: true, route: "alpha/search" },
		{ id: "tenant-hosted", useResponsesLite: false, route: "responses" },
	])("keeps selected provider credentials on its selected $id endpoint", async ({ id, useResponsesLite, route }) => {
		const model = {
			...codexModel("gpt-5.4", "https://tenant.example/backend-api"),
			id,
			provider: "tenant-codex",
			useResponsesLite,
			headers: { "X-Model-Tenant": "selected" },
		};
		const controller = new AbortController();
		proxyAuthStorage.keys.setRuntime(model.provider, "selected-provider-key");
		const credentialSource = vi.spyOn(proxyAuthStorage.keys, "source");
		const getOAuthAccess = vi.spyOn(oauthAuthStorage.oauth, "access");
		const resolver = vi.spyOn(proxyModelRegistry, "resolver");
		const resolveModelHeaders = vi.spyOn(proxyModelRegistry, "resolveModelHeaders");
		// Decoys reproduce the old hard-coded openai-codex registry lookup.
		vi.spyOn(proxyModelRegistry, "find").mockReturnValue(
			codexModel("gpt-5.6-luna", "https://wrong.example/backend-api"),
		);
		vi.spyOn(proxyModelRegistry, "getProviderBaseUrl").mockReturnValue("https://wrong.example/backend-api");
		const fetchMock: FetchImpl = async (url, init) => {
			expect(String(url)).toBe(`https://tenant.example/backend-api/codex/${route}`);
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer selected-provider-key");
			expect(headers.get("x-model-tenant")).toBe("selected");
			expect(headers.has("x-proxy-tenant")).toBe(false);
			expect(JSON.parse(init?.body as string).model).toBe(id);
			return new Response(useResponsesLite ? makeNativeSearchResponse() : makeSseResponse(id), {
				headers: { "Content-Type": useResponsesLite ? "application/json" : "text/event-stream" },
			});
		};

		const result = await searchCodex({
			...makeSearchParams("selected provider", fetchMock, model),
			modelRegistry: proxyModelRegistry,
			sessionId: "selected-session",
			signal: controller.signal,
		});

		expect(result.model).toBe(id);
		expect(credentialSource).toHaveBeenCalledWith("tenant-codex");
		expect(resolver).toHaveBeenCalledWith(model, "selected-session");
		expect(resolveModelHeaders).toHaveBeenCalledWith(model, controller.signal);
		expect(getOAuthAccess).not.toHaveBeenCalled();
	});

	it("propagates cancellation through the selected model header resolver before sending credentials", async () => {
		const controller = new AbortController();
		const abortError = new DOMException("Search cancelled", "AbortError");
		const fetchMock = vi.fn();
		const getOAuthAccess = vi.spyOn(oauthAuthStorage.oauth, "access");
		vi.spyOn(modelRegistry, "resolveModelHeaders").mockImplementation(async (_model, signal) => {
			controller.abort(abortError);
			signal?.throwIfAborted();
			return undefined;
		});

		await expect(
			searchCodex({
				...makeSearchParams("cancel during headers", fetchMock),
				signal: controller.signal,
			}),
		).rejects.toBe(abortError);
		expect(getOAuthAccess).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses native Alpha Search for Responses-Lite models on a configured Codex endpoint", async () => {
		const result = await searchCodex({
			...makeSearchParams("native proxy search", mockCodexFetch("gpt-5.6-sol"), proxyModel("gpt-5.6-sol")),
			authStorage: proxyAuthStorage,
			modelRegistry: proxyModelRegistry,
		});

		expect(capturedRequest?.url).toBe("https://proxy.example/backend-api/codex/alpha/search");
		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-proxy-key");
		expect(headers.get("accept")).toBe("application/json");
		expect(headers.get("x-proxy-tenant")).toBe("tenant-1");
		expect(capturedRequest?.body).toEqual({
			id: expect.any(String),
			model: "gpt-5.6-sol",
			commands: {
				search_query: [{ q: "native proxy search" }],
			},
			settings: {
				search_context_size: "high",
				allowed_callers: ["direct"],
				external_web_access: true,
			},
		});
		expect(result).toEqual(
			expect.objectContaining({
				answer: "Example Article (https://example.com/article)\nSearch result snippet.",
				model: "gpt-5.6-sol",
				sources: [
					{
						title: "Example Article",
						url: "https://example.com/article",
						snippet: "Search result snippet.",
					},
				],
			}),
		);
	});

	it.each(["oauth", "env"] as const)(
		"refuses to send official %s credentials to a configured Codex endpoint",
		async kind => {
			const fetchMock = vi.fn();
			vi.spyOn(oauthOnlyAuthStorage.keys, "source").mockReturnValue({ kind, concrete: true });

			await expect(
				searchCodex({
					...makeSearchParams("unsafe proxy", fetchMock, proxyCodexModel),
					authStorage: oauthOnlyAuthStorage,
					modelRegistry: oauthModelRegistry,
				}),
			).rejects.toThrow("Refusing to send official Codex OAuth credentials");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("validates the credential origin from the registry storage that supplies the key", async () => {
		const fetchMock = vi.fn();

		await expect(
			searchCodex({
				...makeSearchParams("registry oauth leak", fetchMock, proxyCodexModel),
				authStorage: proxyAuthStorage,
				modelRegistry: oauthModelRegistry,
			}),
		).rejects.toThrow("Refusing to send official Codex OAuth credentials");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("prefers a command-backed proxy key over stored OAuth on a custom endpoint", async () => {
		vi.spyOn(oauthModelRegistry, "hasCommandBackedApiKey").mockReturnValue(true);
		vi.spyOn(oauthModelRegistry, "resolver").mockReturnValue(async () => "command-proxy-key");

		const result = await searchCodex({
			...makeSearchParams("command proxy key", mockCodexFetch("gpt-5.4"), proxyCodexModel),
			authStorage: oauthOnlyAuthStorage,
			modelRegistry: oauthModelRegistry,
		});

		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer command-proxy-key");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(result.answer).toBe("Codex answer");
	});

	it("uses the selected hosted model even when a legacy environment override conflicts", async () => {
		const previousOverride = process.env.PI_CODEX_WEB_SEARCH_MODEL;
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.6-luna";
		try {
			const result = await searchCodex(
				makeSearchParams("explicit hosted model", mockCodexFetch("gpt-5.5"), codexModel("gpt-5.5")),
			);

			expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
			expect(capturedRequest?.body?.model).toBe("gpt-5.5");
			expect(capturedRequest?.body?.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
			expect(capturedRequest?.body?.tool_choice).toEqual({ type: "web_search" });
			expect(new Headers(capturedRequest?.headers).has("x-openai-internal-codex-responses-lite")).toBe(false);
			expect(result.model).toBe("gpt-5.5");
		} finally {
			if (previousOverride === undefined) delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
			else process.env.PI_CODEX_WEB_SEARCH_MODEL = previousOverride;
		}
	});

	it("rejects a native response without structured search evidence", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(JSON.stringify({ output: "Plain model answer without search results." }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await expect(
			searchCodex(makeSearchParams("native evidence guard", fetchMock, codexModel("gpt-5.6-sol"))),
		).rejects.toThrow(/missing output or structured search result evidence/);
	});

	it("surfaces an unsupported selected model without reselecting a bundled default", async () => {
		let calls = 0;
		capturedRequest = null;
		const fetchMock: FetchImpl = (url, init) => {
			calls += 1;
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};

			expect(capturedRequest.body?.model).toBe("gpt-5.5");
			return Promise.resolve(
				new Response(
					JSON.stringify({
						detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		await expect(
			searchCodex(makeSearchParams("explicit unsupported model", fetchMock, codexModel("gpt-5.5"))),
		).rejects.toThrow("gpt-5.5");
		expect(calls).toBe(1);
	});

	it("forces web_search tool choice and extracts markdown link citations when annotations are absent", async () => {
		const result = await searchCodex(
			makeSearchParams("markdown citations", mockCodexFetch("gpt-5.4", makeMarkdownLinkSseResponse("gpt-5.4"))),
		);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.tool_choice).toEqual({ type: "web_search" });
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("requests and merges web-search action sources with citation metadata", async () => {
		const answer = "The Responses API supports hosted web search.";
		const citationStart = answer.indexOf("hosted web search");
		const sse = [
			`data: ${JSON.stringify({
				type: "response.created",
				response: { id: "resp_created_id", model: "gpt-5.4" },
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "web_search_call",
					action: {
						sources: [
							{
								url: "https://example.com/article?utm_source=openai",
								title: "Search result title",
							},
						],
					},
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [
						{
							type: "output_text",
							text: answer,
							annotations: [
								{
									type: "url_citation",
									url: "https://example.com/article?utm_source=openai",
									title: "Example Article",
									start_index: citationStart,
									end_index: citationStart + "hosted web search".length,
								},
							],
						},
					],
				},
			})}`,
			"",
		].join("\n");

		const result = await searchCodex(makeSearchParams("action sources", mockCodexFetch("gpt-5.4", sse)));

		expect(capturedRequest?.body?.include).toEqual(["web_search_call.action.sources"]);
		expect(result.requestId).toBe("resp_created_id");
		expect(result.sources).toEqual([
			{
				title: "Search result title",
				url: "https://example.com/article",
				snippet: answer,
			},
		]);
	});

	it("extracts plain text URLs when annotations are absent", async () => {
		const result = await searchCodex(
			makeSearchParams("plain url citations", mockCodexFetch("gpt-5.4", makePlainUrlSseResponse("gpt-5.4"))),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
		]);
	});

	it("preserves markdown URLs that contain balanced parentheses", async () => {
		const result = await searchCodex(
			makeSearchParams(
				"markdown parentheses citations",
				mockCodexFetch("gpt-5.4", makeMarkdownParenthesesSseResponse("gpt-5.4")),
			),
		);

		expect(result.sources).toEqual([
			{ title: "Function", url: "https://en.wikipedia.org/wiki/Function_(mathematics)" },
		]);
	});

	it("strips trailing prose punctuation from plain text URLs", async () => {
		const result = await searchCodex(
			makeSearchParams(
				"plain url punctuation",
				mockCodexFetch("gpt-5.4", makePlainUrlPunctuationSseResponse("gpt-5.4")),
			),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
			{
				title: "https://en.wikipedia.org/wiki/Function_(mathematics)",
				url: "https://en.wikipedia.org/wiki/Function_(mathematics)",
			},
		]);
	});

	it("prefers streamed text when the final item only contains an image placeholder", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(makeImagePlaceholderSseResponse("gpt-5.4-mini"), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);

		const result = await searchCodex(makeSearchParams("responses api store semantics", fetchMock));

		expect(result.answer).toBe("OpenAI Responses API defaults `store` to false unless you opt in.");
		expect(result.sources).toEqual([
			{
				title: "https://platform.openai.com/docs/api-reference/responses",
				url: "https://platform.openai.com/docs/api-reference/responses",
			},
		]);
	});

	it("throws to advance the chain when both streamed and final answers are image placeholders without sources", async () => {
		const sse = [
			WEB_SEARCH_CALL_EVENT,
			"",
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "[Attached image]",
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [{ type: "output_text", text: "See image above.", annotations: [] }],
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_codex_placeholder_only", model: "gpt-5.5" },
			})}`,
			"",
		].join("\n");

		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("image only", fetchMock))).rejects.toThrow(/image-only response/);
	});

	it("drops placeholder prose from the answer but keeps annotation sources when both are placeholders", async () => {
		const sse = [
			WEB_SEARCH_CALL_EVENT,
			"",
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "(see attached image)",
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [
						{
							type: "output_text",
							text: "(See attached image.)",
							annotations: [{ type: "url_citation", url: "https://example.com/docs", title: "Docs" }],
						},
					],
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_codex_placeholder_with_sources", model: "gpt-5.5" },
			})}`,
			"",
		].join("\n");

		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		const result = await searchCodex(makeSearchParams("image with sources", fetchMock));
		expect(result.answer).toBeUndefined();
		expect(result.sources).toEqual([{ title: "Docs", url: "https://example.com/docs" }]);
	});

	it("fails a selected hosted model that answers without running web search (#6988)", async () => {
		const hostedModel = codexModel("gpt-5.5");
		const sse = [
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [
						{
							type: "output_text",
							text: "July 28, 2026 is still in the future, so OpenAI has not announced anything yet.",
						},
					],
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_no_search", model: hostedModel.id },
			})}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("no search performed", fetchMock, hostedModel))).rejects.toThrow(
			/without running web search/,
		);
	});

	it("preserves a nested type:error code and message instead of Unknown error (#7200)", async () => {
		const sse = [
			`data: ${JSON.stringify({
				type: "error",
				error: {
					code: "unsupported_region",
					message: "web_search is not available for this workspace's data residency region.",
				},
			})}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("nested error envelope", fetchMock))).rejects.toThrow(
			"Codex error (unsupported_region): web_search is not available for this workspace's data residency region.",
		);
	});

	it("preserves a structured response.failed error code and message (#7200)", async () => {
		const sse = [
			`data: ${JSON.stringify({
				type: "response.failed",
				response: {
					id: "resp_failed",
					error: { code: "model_snapshot_unavailable", message: "The requested model snapshot is unavailable." },
				},
			})}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("structured failure", fetchMock))).rejects.toThrow(
			"Codex request failed (model_snapshot_unavailable): The requested model snapshot is unavailable.",
		);
	});

	it("classifies rate-limit failures delivered inside a successful SSE response", async () => {
		const sse = [
			`data: ${JSON.stringify({
				type: "response.failed",
				response: {
					error: { code: "rate_limit_exceeded", message: "Too many requests" },
				},
			})}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("rate-limited search", fetchMock))).rejects.toMatchObject({
			status: 429,
		});
	});
});
