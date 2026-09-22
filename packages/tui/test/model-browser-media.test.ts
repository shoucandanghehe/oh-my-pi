import { beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildBrowserItems, ModelBrowser, type ModelBrowserSource } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const source: ModelBrowserSource = {
	defaultThinkingLevel: "off",
	modelProviderOrder: [],
	knownRoleIds: [],
	mruOrder: [],
	modelPerf: new Map(),
	getModelRole: () => undefined,
	getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
};

function detail(model: Model): string {
	const browser = new ModelBrowser(source);
	browser.setItems(buildBrowserItems([model]));
	const lines = browser.render(180);
	return Bun.stripANSI(lines[lines.length - 2] ?? "");
}

beforeAll(async () => {
	await initTheme(false);
});

describe("model browser effective media capabilities", () => {
	it("does not advertise user-only media as valid tool results", () => {
		const model = buildModel({
			id: "media-fixture",
			name: "Media fixture",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text", "image", "audio", "video"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const rendered = detail(model);
		expect(rendered).toContain("user: text/image/audio/video");
		expect(rendered).toContain("tools: text/image");
		expect(rendered).not.toContain("tools: text/image/audio");
	});

	it("preserves explicit empty modality sets instead of borrowing user capabilities", () => {
		const model = buildModel({
			id: "empty-fixture",
			name: "Empty fixture",
			api: "google-generative-ai",
			provider: "fixture",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text", "audio"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		model.toolResultInput = [];
		expect(detail(model)).toContain("user: text/audio · tools: none");
		model.input = [];
		expect(detail(model)).toContain("user: none · tools: none");
		// Legacy/custom model objects predate toolResultInput: only absence falls back.
		model.input = ["text", "image"];
		delete model.toolResultInput;
		expect(detail(model)).toContain("user: text/image · tools: text/image");
	});
});
