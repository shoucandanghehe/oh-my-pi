// Contract: models.yml providers with audio/video declarations survive runtime
// schema validation. Invalid input union members previously filtered providers
// out, losing both their custom model definitions and model overrides.
import { describe, expect, test } from "bun:test";
import { ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

describe("models.yml media input modalities", () => {
	test("retains all four modalities in custom model definitions", () => {
		const checked = ModelsConfigSchema({
			providers: {
				"my-gateway": {
					baseUrl: "https://example.invalid",
					api: "openai-completions",
					models: [{ id: "media-model", input: ["text", "image", "audio", "video"] }],
				},
			},
		});

		expect(checked).toMatchObject({
			providers: {
				"my-gateway": {
					models: [{ id: "media-model", input: ["text", "image", "audio", "video"] }],
				},
			},
		});
	});

	test("retains all four modalities in model overrides", () => {
		const checked = ModelsConfigSchema({
			providers: {
				"my-gateway": {
					baseUrl: "https://example.invalid",
					api: "openai-completions",
					modelOverrides: { "some-model": { input: ["text", "image", "audio", "video"] } },
				},
			},
		});

		expect(checked).toMatchObject({
			providers: {
				"my-gateway": {
					modelOverrides: { "some-model": { input: ["text", "image", "audio", "video"] } },
				},
			},
		});
	});
});
