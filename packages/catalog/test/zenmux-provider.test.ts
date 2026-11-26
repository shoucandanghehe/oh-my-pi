import { afterEach, describe, expect, test, vi } from "bun:test";
import { zenmuxModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { applyGlobalModelsDevFallback, buildGeneratedModel } from "../scripts/generate-models";
import { toModelSpec } from "../src/provider-models/bundled-references";

const originalZenMuxApiKey = Bun.env.ZENMUX_API_KEY;

afterEach(() => {
	if (originalZenMuxApiKey === undefined) {
		delete Bun.env.ZENMUX_API_KEY;
	} else {
		Bun.env.ZENMUX_API_KEY = originalZenMuxApiKey;
	}
	vi.restoreAllMocks();
});

describe("zenmux provider support", () => {
	test("routes Anthropic-owned models to anthropic-messages", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "anthropic/claude-opus-4.6",
								display_name: "Anthropic: Claude Opus 4.6",
								owned_by: "anthropic",
								input_modalities: ["text", "image"],
								capabilities: { reasoning: true },
								context_length: 200000,
								pricings: {
									prompt: [{ value: 15, unit: "perMTokens", currency: "USD" }],
									completion: [{ value: 75, unit: "perMTokens", currency: "USD" }],
									input_cache_read: [{ value: 1.5, unit: "perMTokens", currency: "USD" }],
									input_cache_write_1_h: [{ value: 18.75, unit: "perMTokens", currency: "USD" }],
								},
							},
							{
								id: "openai/gpt-5.2",
								display_name: "OpenAI: GPT-5.2",
								owned_by: "openai",
								input_modalities: ["text"],
								capabilities: { reasoning: true },
								context_length: 400000,
								pricings: {
									prompt: [{ value: 1.25, unit: "perMTokens", currency: "USD" }],
									completion: [{ value: 10, unit: "perMTokens", currency: "USD" }],
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = zenmuxModelManagerOptions({ apiKey: "zenmux-test-key", fetch: fetchMock });
		expect(options.providerId).toBe("zenmux");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://zenmux.ai/api/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		const anthropic = models?.find(model => model.id === "anthropic/claude-opus-4.6");
		expect(anthropic?.api).toBe("anthropic-messages");
		expect(anthropic?.baseUrl).toBe("https://zenmux.ai/api/anthropic");
		expect(anthropic?.input).toEqual(["text", "image"]);
		expect(anthropic?.cost.input).toBe(15);
		expect(anthropic?.cost.cacheWrite).toBe(18.75);

		const openai = models?.find(model => model.id === "openai/gpt-5.2");
		expect(openai?.api).toBe("openai-completions");
		expect(openai?.baseUrl).toBe("https://zenmux.ai/api/v1");
		expect(openai?.cost.output).toBe(10);
	});

	test("discovers models without an API key and sends no Authorization header", async () => {
		delete Bun.env.ZENMUX_API_KEY;
		let sentHeaders: RequestInit["headers"];
		const fetchMock: FetchImpl = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				sentHeaders = init?.headers;
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "anthropic/claude-fable-5-free",
								display_name: "Anthropic: Claude Fable 5 (Free)",
								owned_by: "anthropic",
								input_modalities: ["text", "image"],
								capabilities: { reasoning: true },
								context_length: 200000,
								pricings: {
									prompt: [{ value: 0, unit: "perMTokens", currency: "USD" }],
									completion: [{ value: 0, unit: "perMTokens", currency: "USD" }],
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);

		const options = zenmuxModelManagerOptions({ fetch: fetchMock });
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://zenmux.ai/api/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
		expect(sentHeaders).not.toHaveProperty("Authorization");

		const free = models?.find(model => model.id === "anthropic/claude-fable-5-free");
		expect(free?.api).toBe("anthropic-messages");
		expect(free?.baseUrl).toBe("https://zenmux.ai/api/anthropic");
		expect(free?.cost.input).toBe(0);
	});

	test("cross-provider catalog references cannot add or remove media from a ZenMux route", async () => {
		const { fetchDynamicModels } = zenmuxModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "meta/muse-spark-1.2", owned_by: "meta", input_modalities: ["text"] },
						{
							id: "meta/muse-spark-1.3",
							owned_by: "meta",
							input_modalities: ["text", "image", "file", "audio", "video"],
						},
					],
				}),
		});
		const [textRoute, audioRoute] = ((await fetchDynamicModels?.()) ?? []).map(model =>
			toModelSpec(buildGeneratedModel(model)),
		);
		const enriched = applyGlobalModelsDevFallback(
			[textRoute, audioRoute],
			[
				{ ...textRoute, provider: "kilo", input: ["text", "image", "audio", "video"], maxTokens: 943_718 },
				{ ...audioRoute, provider: "kilo", input: ["text", "image", "video"], maxTokens: 943_718 },
			],
		);

		const capabilities = enriched.map(spec => {
			const { input, vendorInput, toolResultInput, maxTokens } = buildGeneratedModel(spec);
			return { input, vendorInput, toolResultInput, maxTokens };
		});
		expect(capabilities).toEqual([
			{
				input: ["text", "image"],
				vendorInput: ["text", "image"],
				toolResultInput: ["text", "image"],
				maxTokens: 943_718,
			},
			{
				input: ["text", "image", "audio"],
				vendorInput: ["text", "image", "audio"],
				toolResultInput: ["text", "image"],
				maxTokens: 943_718,
			},
		]);
	});
});
