// Contract: explicit video blocks use video_url data URLs on compatible Chat
// Completions routes; ordinary images keep image_url. Unsupported video input
// fails before fetch instead of disappearing from an otherwise successful call.
import { describe, expect, it } from "bun:test";
import { UnsupportedMediaError } from "@oh-my-pi/pi-ai/error";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Message, Model, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MP4_B64 = Buffer.from("not-actually-an-mp4, but bytes are opaque here").toString("base64");
const PNG_B64 = Buffer.from("not-actually-a-png, but bytes are opaque here").toString("base64");

function completionsModel(input: Model["input"] = ["text", "image", "video"]): Model<"openai-completions"> {
	return buildModel({
		id: "video-model",
		name: "Video model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

function captureFetch(model: Model<"openai-completions">, captured: { body?: unknown }): FetchImpl {
	return (async (_input: string | URL | Request, init?: RequestInit) => {
		captured.body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const sse =
			`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n` +
			`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
			"data: [DONE]\n\n";
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as FetchImpl;
}

function userMessage(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function toolResultMessages(): Message[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "screen_recorder", arguments: {} }],
			api: "openai-completions",
			provider: "test",
			model: "video-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "screen_recorder",
			content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
			isError: false,
			timestamp: 0,
		},
	];
}

type WirePart = { type: string; text?: string; image_url?: { url: string }; video_url?: { url: string } };

async function wireMessages(model: Model<"openai-completions">, messages: Message[]) {
	const captured: { body?: { messages?: Array<{ role: string; content: unknown }> } } = {};
	const context: Context = { messages };
	const result = await streamSimple(model, context, { apiKey: "test", fetch: captureFetch(model, captured) }).result();
	expect(result.stopReason).toBe("stop");
	return captured.body?.messages ?? [];
}

describe("video url parts", () => {
	it("ships inline video blocks as video_url data URLs", async () => {
		const messages = [
			userMessage([
				{ type: "text", text: "what happens in this clip?" },
				{ type: "video", data: MP4_B64, mimeType: "video/mp4" },
			]),
		];

		const parts = ((await wireMessages(completionsModel(), messages))[0]?.content as WirePart[]) ?? [];

		expect(parts.filter(part => part.type === "video_url")).toEqual([
			{ type: "video_url", video_url: { url: `data:video/mp4;base64,${MP4_B64}` } },
		]);
		expect(parts.some(part => part.type === "image_url")).toBe(false);
	});

	it("keeps image blocks on the image_url wire form", async () => {
		const messages = [
			userMessage([
				{ type: "text", text: "what is in these?" },
				{ type: "video", data: MP4_B64, mimeType: "video/mp4" },
				{ type: "image", data: PNG_B64, mimeType: "image/png" },
			]),
		];

		const parts = ((await wireMessages(completionsModel(), messages))[0]?.content as WirePart[]) ?? [];

		expect(parts.filter(part => part.type === "video_url")).toHaveLength(1);
		expect(parts.filter(part => part.type === "image_url")).toEqual([
			{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
		]);
	});

	it("keeps image-only tool results byte-for-byte", async () => {
		const wire = await wireMessages(completionsModel(), toolResultMessages());
		const attached = wire.find(
			message =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				(message.content as WirePart[]).some(part => part.type === "image_url"),
		);

		const parts = (attached?.content as WirePart[]) ?? [];
		expect(parts).toEqual([
			{ type: "text", text: "Attached image(s) from tool result:" },
			{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
		]);
	});

	it("rejects video for models that do not declare it before fetch", () => {
		const messages = [
			userMessage([
				{ type: "text", text: "what happens in this clip?" },
				{ type: "video", data: MP4_B64, mimeType: "video/mp4" },
			]),
		];
		let fetchCalls = 0;
		expect(() =>
			streamSimple(
				completionsModel(["text", "image"]),
				{ messages },
				{
					apiKey: "test",
					fetch: async () => {
						fetchCalls++;
						return new Response();
					},
				},
			),
		).toThrow(UnsupportedMediaError);
		expect(fetchCalls).toBe(0);
	});
});
