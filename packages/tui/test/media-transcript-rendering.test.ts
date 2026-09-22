import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, MediaContent, UserMessage } from "@oh-my-pi/pi-ai";
import { Text, TUI, type Component } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import type { FileMentionMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { buildFileMentionBlock, userMessageDisplayText } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

const audio: MediaContent = { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" };
const video: MediaContent = { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" };
const image: MediaContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

function entries(messages: AgentMessage[]): TranscriptEntryLike[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `message-${index}`,
		parentId: index === 0 ? null : `message-${index - 1}`,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	}));
}

function makeBuilder(tool?: AgentTool): ChatTranscriptBuilder {
	return new ChatTranscriptBuilder({
		ui: new TUI(new VirtualTerminal(120, 40)),
		cwd: process.cwd(),
		requestRender() {},
		getTool: () => tool,
	});
}

function plain(component: Component): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

function toolTurn(toolName: string, content: MediaContent[]): AgentMessage[] {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "media-call", name: toolName, arguments: { command: "decode media" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
	return [
		assistant,
		{ role: "toolResult", toolCallId: "media-call", toolName, content, isError: false, timestamp: 2 },
	];
}

beforeAll(async () => {
	await initTheme(false);
});

describe("media transcript rendering", () => {
	it.each([
		{ content: [audio], marker: "[audio attachment]" },
		{ content: [video], marker: "[video attachment]" },
		{ content: [audio, video], marker: "[audio and video attachments]" },
	])("keeps $marker visible after a media-only user turn is rebuilt", ({ content, marker }) => {
		const message: UserMessage = { role: "user", content: [...content], timestamp: 1 };
		const live = new UserMessageComponent(userMessageDisplayText(message));
		const builder = makeBuilder();
		try {
			expect(plain(live)).toContain(marker);
			builder.append(entries([message]));
			expect(plain(builder.container)).toContain(marker);
			builder.rebuild(entries([message]));
			expect(plain(builder.container)).toContain(marker);
		} finally {
			live.dispose();
			builder.reset();
		}
	});

	it("keeps captions rather than replacing text-plus-media turns with attachment markers", () => {
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Describe the attached scene" }, image, audio],
			timestamp: 1,
		};
		const builder = makeBuilder();
		try {
			builder.rebuild(entries([message]));
			const rendered = plain(builder.container);
			expect(rendered).toContain("Describe the attached scene");
			expect(rendered).not.toContain("[audio attachment]");
		} finally {
			builder.reset();
		}
	});

	it("labels each file mention with its actual media kind in live and rebuilt transcripts", () => {
		const message: FileMentionMessage = {
			role: "fileMention",
			files: [
				{ path: "sound.wav", content: "", image: audio },
				{ path: "clip.mp4", content: "", image: video },
				{ path: "photo.png", content: "", image },
				{ path: "notes.txt", content: "one\ntwo", lineCount: 2 },
			],
			timestamp: 1,
		};
		const live = buildFileMentionBlock(message.files, 0);
		const builder = makeBuilder();
		try {
			builder.rebuild(entries([message]));
			for (const component of [live, builder.container]) {
				const rendered = plain(component);
				expect(rendered).toMatch(/sound\.wav[^\n]*\(audio\)/);
				expect(rendered).toMatch(/clip\.mp4[^\n]*\(video\)/);
				expect(rendered).toMatch(/photo\.png[^\n]*\(image\)/);
				expect(rendered).toMatch(/notes\.txt[^\n]*\(2 lines\)/);
			}
		} finally {
			live.dispose();
			builder.reset();
		}
	});

	it.each(["generic", "bash", "custom"])("shows media-only %s results once across updates and rebuilds", toolName => {
		// Rich renderers may consume only text; the component still owns media visibility.
		const tool =
			toolName === "custom"
				? ({
						name: "custom",
						label: "Custom",
						renderResult: () => new Text("decoded", 0, 0),
					} as unknown as AgentTool)
				: undefined;
		const component = new ToolExecutionComponent(toolName, { command: "decode media" }, { showImages: false }, tool, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		const builder = makeBuilder(tool);
		try {
			component.updateResult({ content: [audio] }, true);
			expect(plain(component)).toContain("[audio attachment: audio/wav]");
			component.updateResult({ content: [audio, video] }, false);
			component.invalidate();
			component.setExpanded(true);
			builder.rebuild(entries(toolTurn(toolName, [audio, video])));
			for (const rendered of [plain(component), plain(builder.container)]) {
				expect(rendered.match(/\[audio attachment: audio\/wav\]/g)).toHaveLength(1);
				expect(rendered).not.toContain("(no output)");
				expect(rendered.match(/\[video attachment: video\/mp4\]/g)).toHaveLength(1);
			}
			component.updateResult({ content: [{ type: "text", text: "replacement" }] }, false);
			expect(plain(component)).not.toContain("attachment:");
		} finally {
			component.dispose();
			builder.reset();
		}
	});

	it("sanitizes MIME markers before styling and keeps image fallbacks alongside media", () => {
		const component = new ToolExecutionComponent("generic", {}, { showImages: false }, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		try {
			component.updateResult(
				{
					content: [
						image,
						{ ...audio, mimeType: "audio/wav\x1b]52;c;PAYLOAD\x07\t\r\nextra\x00" },
						{ type: "video" },
					],
				},
				false,
			);
			const raw = component.render(120).join("\n");
			expect(raw).not.toContain("\x1b]52");
			expect(raw).not.toContain("PAYLOAD");
			expect(raw).not.toMatch(/[\t\r\x00\x07]/);
			const rendered = Bun.stripANSI(raw);
			expect(rendered).toMatch(/\[audio attachment: audio\/wav +extra\]/);
			expect(rendered).toContain("[video attachment]");
			expect(rendered).toContain("image/png");
		} finally {
			component.dispose();
		}
	});
});
