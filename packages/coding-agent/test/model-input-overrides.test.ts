import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { UnsupportedMediaError } from "@oh-my-pi/pi-ai/error";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { applyModelPatch } from "@oh-my-pi/pi-coding-agent/config/model-patch";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

type WireMessage = { role: string; content?: string | Array<{ type: string; text?: string }> };
const requestSchema = type({
	messages: type({
		role: "string",
		"content?": type("string").or(type({ type: "string", "text?": "string" }).array()),
	}).array(),
});
const mediaContext: Context = {
	messages: [
		{
			role: "user",
			content: [
				{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
				{ type: "video", mimeType: "video/mp4", data: "AAAA" },
			],
			timestamp: 0,
		},
	],
};

async function captureRequest(model: Model, context: Context): Promise<WireMessage[]> {
	let wire: WireMessage[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		wire = requestSchema.assert(JSON.parse(String(init?.body))).messages;
		return new Response(
			`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	};
	const result = await streamSimple(model, context, { apiKey: "test", fetch }).result();
	expect(result.stopReason).toBe("stop");
	return wire;
}

function wireTypes(messages: WireMessage[]): string[] {
	return messages.flatMap(message => (Array.isArray(message.content) ? message.content.map(part => part.type) : []));
}

describe("explicit model input overrides", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	beforeEach(async () => {
		dir = TempDir.createSync("model-input-overrides-");
		auth = await AuthStorage.create(":memory:");
	});
	afterEach(() => {
		auth.close();
		dir.removeSync();
	});

	it.each(["models", "modelOverrides"] as const)(
		"keeps %s media declarations effective after text-only discovery",
		async declaration => {
			const input = ["text", "image", "audio", "video"];
			const configPath = path.join(dir.path(), "models.yml");
			await Bun.write(
				configPath,
				JSON.stringify({
					providers: {
						"media-proxy": {
							api: "openai-completions",
							baseUrl: "https://media.example/v1",
							auth: "none",
							discovery: { type: "openai-models-list" },
							...(declaration === "models"
								? { models: [{ id: "media-model", input }] }
								: { modelOverrides: { "media-model": { input } } }),
						},
					},
				}),
			);
			const registry = new ModelRegistry(auth, configPath, {
				settings: Settings.isolated(),
				fetch: async url => {
					if (String(url) !== "https://media.example/v1/models")
						throw new Error(`Unexpected discovery URL: ${url}`);
					return Response.json({ data: [{ id: "media-model" }] });
				},
			});
			await registry.refreshProvider("media-proxy", "online");
			const model = registry.find("media-proxy", "media-model");
			if (!model) throw new Error("Discovered model missing");
			const patchedAgain = applyModelPatch(model, { maxTokens: 2048 }, "merge");
			expect(wireTypes(await captureRequest(patchedAgain, mediaContext))).toEqual(["input_audio", "video_url"]);
			const imageContext: Context = {
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "image-call", name: "read", arguments: {} }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "toolUse",
						timestamp: 0,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
					{
						role: "toolResult",
						toolCallId: "image-call",
						toolName: "read",
						content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
						isError: false,
						timestamp: 1,
					},
				],
			};
			expect(wireTypes(await captureRequest(patchedAgain, imageContext))).toContain("image_url");
		},
	);

	it("does not restore image input from stale vendor facts after an explicit text-only override", async () => {
		const base = buildModel({
			id: "media-model",
			name: "Media",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		});
		const model = applyModelPatch(base, { input: ["text"] }, "merge");
		const messages = await captureRequest(model, {
			messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }], timestamp: 0 }],
		});
		expect(wireTypes(messages)).not.toContain("image_url");
		expect(messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER }] },
		]);
	});

	it("does not let an explicit audio declaration invent a Responses encoder", () => {
		const base = buildModel({
			id: "media-model",
			name: "Media",
			api: "openai-responses",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		});
		const model = applyModelPatch(base, { input: ["text", "audio"] }, "merge");
		let fetches = 0;
		expect(() =>
			streamSimple(model, mediaContext, {
				apiKey: "test",
				fetch: async () => {
					fetches++;
					throw new Error("Unexpected fetch");
				},
			}),
		).toThrow(UnsupportedMediaError);
		expect(fetches).toBe(0);
	});
});
