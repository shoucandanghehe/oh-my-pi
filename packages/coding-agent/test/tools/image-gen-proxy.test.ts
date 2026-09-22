import { expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

it("routes configured GPT Image 2.5 generation and edits through the proxy Images API", async () => {
	const temp = TempDir.createSync("image-gen-proxy-");
	const authStorage = createInMemoryAuthStorage();
	const imagePaths: string[] = [];
	try {
		const settings = Settings.isolated({ modelRoles: { image: "openai-codex/gpt-image-2.5" } });
		const modelsPath = temp.join("models.yml");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						baseUrl: "https://proxy.example/backend-api",
						api: "openai-codex-responses",
						apiKey: "proxy-key",
						models: ["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].map(id => ({
							id,
							api: "openai-images",
							baseUrl: "https://proxy.example/v1",
							input: ["text", "image"],
						})),
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath, { settings });
		const requests: Request[] = [];
		const data = Buffer.from("reference-image").toString("base64");
		const fetchMock: FetchImpl = async (input, init) => {
			requests.push(new Request(input.toString(), init));
			return Response.json({ data: [{ b64_json: data, media_type: "image/png" }] });
		};
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: SessionManager.inMemory(temp.path()),
			modelRegistry: registry,
			settings,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
		const generated = await imageGenTool.execute("default-image", { subject: "a blue circle" }, undefined, ctx);
		imagePaths.push(...(generated.details?.imagePaths ?? []));
		const selected = await imageGenTool.execute(
			"selected-image",
			{ subject: "a blue circle", model: "openai-codex/gpt-image-2.5-flare" },
			undefined,
			ctx,
		);
		imagePaths.push(...(selected.details?.imagePaths ?? []));
		const edited = await imageGenTool.execute(
			"edit-image",
			{
				subject: "change the circle to red",
				model: "openai-codex/gpt-image-2.5-sunburst",
				input: [{ data, mime_type: "image/png" }],
			},
			undefined,
			ctx,
		);
		imagePaths.push(...(edited.details?.imagePaths ?? []));

		expect(requests.map(request => request.url)).toEqual([
			"https://proxy.example/v1/images/generations",
			"https://proxy.example/v1/images/generations",
			"https://proxy.example/v1/images/edits",
		]);
		expect(await requests[0].json()).toMatchObject({ model: "gpt-image-2.5" });
		expect(await requests[1].json()).toMatchObject({ model: "gpt-image-2.5-flare" });
		const form = await requests[2].formData();
		expect(form.get("model")).toBe("gpt-image-2.5-sunburst");
		const reference = form.get("image");
		if (!(reference instanceof File)) throw new Error("Expected the edit reference as an uploaded file");
		expect(await reference.text()).toBe("reference-image");
		expect(generated.details?.model).toBe("gpt-image-2.5");
		expect(selected.details?.model).toBe("gpt-image-2.5-flare");
		expect(edited.details?.model).toBe("gpt-image-2.5-sunburst");
	} finally {
		authStorage.close();
		await Promise.all(imagePaths.map(imagePath => removeWithRetries(imagePath)));
		await temp.remove();
	}
});
