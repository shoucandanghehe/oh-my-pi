import { describe, expect, test } from "bun:test";
import { UnsupportedMediaError } from "@oh-my-pi/pi-ai/error";
import { validateContextMedia } from "@oh-my-pi/pi-ai/media-input";
import { convertMessages as convertGoogleMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import { convertMessages as convertOpenAIChatMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { InputModality, KnownApi, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function model<TApi extends KnownApi>(
	api: TApi,
	input: readonly InputModality[] = ["text", "image", "audio", "video"],
) {
	return buildModel({
		id: `${api}-test`,
		name: api,
		api,
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: [...input],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	} as ModelSpec<TApi>);
}

const wav = { type: "audio" as const, data: "UklGRg==", mimeType: "audio/wav" };
const userWav: Context = {
	messages: [
		{ role: "user", content: [{ type: "text", text: "before" }, wav, { type: "text", text: "after" }], timestamp: 1 },
	],
};

describe("media request preflight", () => {
	test("throws structured route-qualified error before credentials or fetch", () => {
		let credentialCalls = 0;
		let fetchCalls = 0;
		const context: Context = {
			messages: [{ role: "user", content: [{ type: "video", data: "AAAA", mimeType: "video/mp4" }], timestamp: 1 }],
		};
		expect(() =>
			streamSimple(model("anthropic-messages"), context, {
				apiKey: async () => {
					credentialCalls++;
					return "secret";
				},
				fetch: async () => {
					fetchCalls++;
					return new Response();
				},
			}),
		).toThrow(UnsupportedMediaError);
		expect(credentialCalls).toBe(0);
		expect(fetchCalls).toBe(0);
		try {
			validateContextMedia(model("anthropic-messages"), context);
		} catch (error) {
			expect(error).toMatchObject({
				provider: "test",
				wireModel: "anthropic-messages-test",
				mediaType: "video",
				mimeType: "video/mp4",
				position: { kind: "message", messageIndex: 0, contentIndex: 0, role: "user" },
			});
		}
	});

	for (const api of ["openai-responses", "azure-openai-responses", "openrouter", "apple-foundation-models"] as const) {
		test(`${api} rejects audio before credentials or fetch`, () => {
			let credentialCalls = 0;
			let fetchCalls = 0;
			let failure: unknown;
			try {
				streamSimple(model(api), userWav, {
					apiKey: async () => {
						credentialCalls++;
						return "secret";
					},
					fetch: async () => {
						fetchCalls++;
						return new Response();
					},
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(UnsupportedMediaError);
			expect(failure).toMatchObject({
				provider: "test",
				wireModel: `${api}-test`,
				mediaType: "audio",
				mimeType: "audio/wav",
				position: { kind: "message", messageIndex: 0, contentIndex: 1, role: "user" },
				supportedForms: [],
			});
			expect(credentialCalls).toBe(0);
			expect(fetchCalls).toBe(0);
		});
	}

	test("uses toolResultInput independently from user input", () => {
		expect(() => validateContextMedia(model("openai-completions"), userWav)).not.toThrow();
		const tool: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "record",
					content: [wav],
					isError: false,
					timestamp: 1,
				},
			],
		};
		expect(() => validateContextMedia(model("openai-completions"), tool)).toThrow(UnsupportedMediaError);
	});

	test("rejects unsupported MIME even when the modality is effective", () => {
		const context: Context = {
			messages: [{ role: "user", content: [{ type: "audio", data: "T2dn", mimeType: "audio/ogg" }], timestamp: 1 }],
		};
		try {
			validateContextMedia(model("openai-completions"), context);
			throw new Error("expected preflight failure");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedMediaError);
			expect((error as UnsupportedMediaError).supportedForms.flatMap(form => form.mimeTypes)).toEqual([
				"audio/wav",
				"audio/x-wav",
				"audio/mpeg",
				"audio/mp3",
			]);
		}
	});
});

describe("OpenAI audio wire placement", () => {
	test.each([
		{ mimeType: "audio/wav", data: "UklGRg==", format: "wav" },
		{ mimeType: "audio/mpeg", data: "SUQz", format: "mp3" },
	])("Chat Completions serializes $mimeType as input_audio", ({ mimeType, data, format }) => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "before" },
						{ type: "audio", data, mimeType },
						{ type: "text", text: "after" },
					],
					timestamp: 1,
				},
			],
		};
		const built = validateContextMedia(model("openai-completions"), context);
		expect(convertOpenAIChatMessages(built, context, built.compat)).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "before" },
					{ type: "input_audio", input_audio: { data, format } },
					{ type: "text", text: "after" },
				],
			},
		]);
	});

	test("Responses converter rejects audio rather than emitting an undocumented top-level item", () => {
		expect(() =>
			buildResponsesInput({
				model: model("openai-responses"),
				context: userWav,
				supportsImageDetailOriginal: false,
				strictResponsesPairing: false,
			}),
		).toThrow("Responses has no audio input encoder");
	});
});

describe("Gemini audio/video wire placement", () => {
	for (const api of ["google-generative-ai", "google-vertex"] as const) {
		test(`${api} preserves mixed audio/video ordering as inlineData`, () => {
			const context: Context = {
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "before" },
							wav,
							{ type: "video", data: "AAAA", mimeType: "video/mp4" },
							{ type: "text", text: "after" },
						],
						timestamp: 1,
					},
				],
			};
			const built = validateContextMedia(model(api), context);
			expect(convertGoogleMessages(built, context)).toEqual([
				{
					role: "user",
					parts: [
						{ text: "before" },
						{ inlineData: { mimeType: "audio/wav", data: "UklGRg==" } },
						{ inlineData: { mimeType: "video/mp4", data: "AAAA" } },
						{ text: "after" },
					],
				},
			]);
		});
	}
});
