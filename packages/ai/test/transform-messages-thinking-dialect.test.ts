import { describe, expect, it } from "bun:test";
import { getDialectDefinition, renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { Api, AssistantMessage, Message, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Cross-provider model switches (e.g. Anthropic → Gemini mid-session) cannot
 * replay a prior turn's `thinking` block natively: the target's reasoning slot
 * either rejects a foreign signature or — verified end-to-end against Gemini 3 —
 * silently discards unsigned thought content (a replayed `thought:true` part is
 * neither recalled nor influences generation). `transformMessages` therefore
 * demotes the reasoning to a `text` block so it survives as conversation
 * context, usually wrapping it in the TARGET model's own canonical
 * thinking-block dialect (e.g. a ```thinking fence for Gemini). The
 * Anthropic/Claude dialect is the exception: every Claude model
 * (Opus / Sonnet / Haiku / Fable / Mythos, etc.) receives bare assistant prose,
 * because Anthropic's `reasoning_extraction` classifier flags `<thinking>` /
 * `antml:thinking` tags in prior turn history — refusing (Fable) or leaking
 * the wrapped chain-of-thought as visible reasoning on the others. Same-model
 * continuations keep the native `thinking` block untouched.
 */
const REASONING = "The user wants the Paris weather; I will call get_weather with city=Paris.";

function makeModel<T extends Api>(api: T, provider: string, id: string): Model<T> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} as ModelSpec<T>);
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

/** A prior assistant turn authored by an Anthropic model: signed thinking + a text reply. */
function anthropicThinkingTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: REASONING, thinkingSignature: "anthropic-sig" },
			{ type: "text", text: "Checking the forecast." },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** A prior assistant turn authored by a Gemini model: foreign thinking + a text reply. */
function geminiThinkingTurn(): AssistantMessage {
	return {
		...anthropicThinkingTurn(),
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-3-pro-preview",
		content: [
			{ type: "thinking", thinking: REASONING, thinkingSignature: "google-sig" },
			{ type: "text", text: "Checking the forecast." },
		],
	};
}

function transformedAssistant(messages: Message[], target: Model<Api>): AssistantMessage {
	const out = transformMessages(messages, target);
	const assistant = out.find((m): m is AssistantMessage => m.role === "assistant");
	if (!assistant) throw new Error("expected an assistant message in the transformed output");
	return assistant;
}

describe("transformMessages cross-provider thinking demotion → canonical dialect", () => {
	it("renders Anthropic reasoning as a Gemini ```thinking fence when switching to a Gemini target", () => {
		const gemini = makeModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const assistant = transformedAssistant([user("weather in Paris?"), anthropicThinkingTurn()], gemini);

		// No native thinking block survives the cross-provider hop.
		expect(assistant.content.some(b => b.type === "thinking")).toBe(false);

		// The reasoning is demoted in place to a text block wrapped in Gemini's
		// canonical thinking dialect, ahead of the original reply text.
		const first = assistant.content[0];
		expect(first?.type).toBe("text");
		// Demoted reasoning is wrapped in Gemini's canonical thinking fence.
		expect(first && first.type === "text" ? first.text : "").toBe(
			getDialectDefinition("gemini").renderThinking(REASONING),
		);
		expect(first && first.type === "text" ? first.text : "").toContain("```thinking");
		// The original reply text survives as its own block, after the fence.
		const reply = assistant.content[1];
		expect(reply?.type).toBe("text");
		expect(reply && reply.type === "text" ? reply.text : "").toBe("Checking the forecast.");
	});

	it("falls back to a neutral <think> block (no chat-template control tokens) for control-token dialects", () => {
		// A GPT (openai-responses) target resolves to the harmony dialect, whose
		// renderThinking emits `<|channel|>` control tokens. Those MUST NOT leak
		// into structured history — demotion falls back to a neutral `<think>`
		// block instead, while still preserving the reasoning.
		const gpt = makeModel("openai-responses", "openai", "gpt-5");
		const assistant = transformedAssistant([user("weather in Paris?"), anthropicThinkingTurn()], gpt);

		const first = assistant.content[0];
		expect(first?.type).toBe("text");
		const text = first && first.type === "text" ? first.text : "";
		expect(text).toBe(renderDemotedThinking("gpt-5", REASONING));
		// No harmony chat-template control tokens leaked, and the unsafe native
		// renderThinking output was explicitly NOT used.
		expect(text).not.toContain("<|");
		expect(text).not.toBe(getDialectDefinition("harmony").renderThinking(REASONING));
		// Reasoning is still preserved inside the neutral block.
		expect(text).toContain("<think>");
		expect(text).toContain(REASONING);
	});

	it("leaves GPT's native reasoning to Responses and keeps foreign plaintext after a prefix edit", () => {
		const before = { type: "reasoning" as const, id: "rs_before", encrypted_content: "before", summary: [] };
		const after = { ...before, id: "rs_after", encrypted_content: "after" };
		for (const target of [
			makeModel("openai-responses", "openai", "gpt-6.2-sol"),
			makeModel("openai-codex-responses", "openai-codex", "gpt-6.2-sol"),
		]) {
			const gptTurn = (item: typeof before): AssistantMessage => ({
				...anthropicThinkingTurn(),
				api: target.api,
				provider: target.provider,
				model: target.id,
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) },
					{ type: "text", text: "GPT answer." },
				],
			});
			const context = {
				messages: [
					gptTurn(before),
					{ ...user("Rewritten earlier input"), historyRewriteAt: 100 },
					gptTurn(after),
					user("What did Claude say?"),
					anthropicThinkingTurn(),
					user("Continue"),
				],
			};
			const input =
				target.api === "openai-codex-responses"
					? convertCodexResponsesMessages(target, context)
					: buildResponsesInput({
							model: target,
							context,
							strictResponsesPairing: true,
							supportsImageDetailOriginal: false,
						});
			expect(input.filter(item => item.type === "reasoning")).toEqual([before, after]);
			expect(input).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					content: [{ type: "output_text", text: renderDemotedThinking(target.id, REASONING), annotations: [] }],
				}),
			);
		}
	});

	it("still drops invalidated Claude thinking when a gateway serves Claude over Responses", () => {
		const target = makeModel("openai-responses", "gateway", "claude-fable-5-1");
		const input = buildResponsesInput({
			model: target,
			context: {
				messages: [{ ...user("Edited"), historyRewriteAt: 100 }, anthropicThinkingTurn(), user("Continue")],
			},
			strictResponsesPairing: true,
			supportsImageDetailOriginal: false,
		});
		expect(input.filter(item => "role" in item && item.role === "assistant")).toEqual([
			expect.objectContaining({
				content: [{ type: "output_text", text: "Checking the forecast.", annotations: [] }],
			}),
		]);
	});

	it("renders demoted foreign reasoning as bare assistant prose for every Anthropic-dialect Claude target", () => {
		// The Anthropic reasoning_extraction classifier flags `<thinking>` and
		// `antml:thinking` tags in prior turn history for the whole Claude family
		// — Fable refuses outright, Opus/Sonnet/Haiku/Mythos leak the wrapped
		// chain-of-thought as visible reasoning. Every Anthropic-dialect target
		// therefore receives bare prose, not the dialect's canonical thinking
		// tags.
		const targets = [
			{ name: "Claude Opus", id: "claude-opus-4-8" },
			{ name: "Claude Sonnet", id: "claude-sonnet-4-6" },
			{ name: "Claude Haiku", id: "claude-haiku-4-5" },
			{ name: "Claude Fable", id: "claude-fable-5" },
			{ name: "Claude Mythos", id: "claude-mythos-5" },
			// Bedrock cross-region inference profiles exercise dotted-prefix
			// structured identity classification.
			{ name: "Claude Haiku (Bedrock US)", id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
			{ name: "Claude Haiku (Bedrock EU)", id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" },
			{ name: "Claude Opus (Bedrock Global)", id: "global.anthropic.claude-opus-4-8" },
		] as const;

		for (const target of targets) {
			const model = makeModel("anthropic-messages", "anthropic", target.id);
			const assistant = transformedAssistant(
				[user(`weather in Paris for ${target.name}?`), geminiThinkingTurn()],
				model,
			);

			expect(assistant.content.some(b => b.type === "thinking")).toBe(false);

			const first = assistant.content[0];
			expect(first?.type).toBe("text");
			const text = first && first.type === "text" ? first.text : "";
			expect(text).toBe(REASONING);
			expect(text).toBe(renderDemotedThinking(target.id, REASONING));
			expect(text).not.toContain("<thinking>");
			expect(text).not.toContain("</thinking>");
			expect(text).not.toContain("<think>");
			expect(text).not.toContain("</think>");
			expect(text).not.toContain("_Hmm.");

			const reply = assistant.content[1];
			expect(reply?.type).toBe("text");
			expect(reply && reply.type === "text" ? reply.text : "").toBe("Checking the forecast.");
		}
	});

	it("trims a demoted block that becomes final after following empty thinking blocks are dropped", () => {
		const claude = makeModel("anthropic-messages", "anthropic", "claude-sonnet-4-6");
		const turn: AssistantMessage = {
			...geminiThinkingTurn(),
			content: [
				{ type: "thinking", thinking: `${REASONING}\n`, thinkingSignature: "google-sig" },
				{ type: "thinking", thinking: " \n\t", thinkingSignature: "" },
			],
		};

		const assistant = transformedAssistant([user("weather in Paris?"), turn], claude);

		expect(assistant.content).toHaveLength(1);
		const first = assistant.content[0];
		expect(first?.type).toBe("text");
		const text = first && first.type === "text" ? first.text : "";
		expect(text).toBe(REASONING);
		expect(/\s$/.test(text)).toBe(false);
	});

	it("trimEnds trailing whitespace already present in bare Anthropic-dialect demoted thinking", () => {
		const claude = makeModel("anthropic-messages", "anthropic", "claude-sonnet-4-6");
		const reasoningWithTrailingWhitespace = "The plan is complete.\n \t";
		const turn: AssistantMessage = {
			...geminiThinkingTurn(),
			content: [
				{
					type: "thinking",
					thinking: reasoningWithTrailingWhitespace,
					thinkingSignature: "google-sig",
				},
			],
		};

		const assistant = transformedAssistant([user("weather in Paris?"), turn], claude);

		expect(assistant.content).toHaveLength(1);
		const first = assistant.content[0];
		expect(first?.type).toBe("text");
		const text = first && first.type === "text" ? first.text : "";
		expect(text).toBe("The plan is complete.");
		expect(/\s$/.test(text)).toBe(false);
	});

	it("keeps the native thinking block for a same-provider/same-model continuation", () => {
		const gemini = makeModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const sameModelTurn: AssistantMessage = {
			...anthropicThinkingTurn(),
			content: [{ type: "thinking", thinking: REASONING, thinkingSignature: "g-sig" }],
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-3-pro-preview",
		};
		const assistant = transformedAssistant([user("weather in Paris?"), sameModelTurn], gemini);

		const first = assistant.content[0];
		expect(first?.type).toBe("thinking");
		expect(first && first.type === "thinking" ? first.thinking : "").toBe(REASONING);
	});
});
