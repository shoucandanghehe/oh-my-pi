import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptPane } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-pane";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ClipboardImage } from "@oh-my-pi/pi-natives/clipboard";
import type { TUI } from "@oh-my-pi/pi-tui";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	await initTheme(false);
});
afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function fixture(readImage: () => Promise<ClipboardImage | null>, readText = async () => "") {
	const main = new CustomEditor(getEditorTheme());
	const submitted: { text: string; images?: ImageContent[]; key?: string }[] = [];
	let focused: unknown;
	const ui = {
		getFocused: () => focused,
		requestRender: () => {},
		requestComponentRender: () => {},
	} as unknown as TUI;
	const pane = new ChatTranscriptPane({
		builder: { ui, cwd: process.cwd(), requestRender: () => {} },
		editor: {
			label: "Side",
			placeholder: "Side",
			images: true,
			onSubmit: (text, images, key) => {
				submitted.push({ text, images, key });
				return true;
			},
		},
		expandKeys: [],
		getPlaceholder: () => "",
		onClose: () => {},
	});
	focused = pane;
	const showStatus = vi.fn();
	const ctx = {
		editor: main,
		ui,
		showStatus,
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "image", path: `${process.cwd()}/image.png`, displayPath: "image.png" }),
		},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx, { readImage, readText });
	return {
		main,
		pane,
		controller,
		submitted,
		showStatus,
		focus: (target: unknown) => {
			focused = target;
		},
	};
}

describe("pane clipboard ownership", () => {
	it("keeps a delayed image on its source thread after switching panes and submits real image content", async () => {
		const clipboard = Promise.withResolvers<ClipboardImage | null>();
		const { main, pane, controller, submitted, focus } = fixture(() => clipboard.promise);
		try {
			pane.selectEditor("first", "Question ");
			const paste = controller.handleImagePaste();
			pane.selectEditor("second", "Other draft");
			focus(main);
			clipboard.resolve({ data: png, mimeType: "image/png" });
			expect(await paste).toBe(true);
			expect(main.getText()).toBe("");
			expect(main.pendingImages).toEqual([]);
			expect(pane.getEditorText()).toBe("Other draft");
			pane.handleInput("\r");
			expect(submitted[0]).toEqual({ text: "Other draft", images: undefined, key: "second" });
			pane.selectEditor("first", "");
			pane.handleInput("\r");
			expect(submitted[1]?.key).toBe("first");
			expect(submitted[1]?.text).toContain("[Image #1");
			expect(submitted[1]?.images).toMatchObject([{ type: "image", data: png.toBase64(), mimeType: "image/png" }]);
			expect(pane.getPasteTarget()?.pendingImages).toEqual([]);
		} finally {
			pane.dispose();
		}
	});

	it.each(["keyboard", "right-click"] as const)(
		"holds a submit behind %s clipboard reads instead of attaching to the next draft",
		async transport => {
			const clipboard = Promise.withResolvers<ClipboardImage | null>();
			const { pane, controller, submitted } = fixture(() => clipboard.promise);
			try {
				const editor = pane.getPasteTarget()!;
				let paste: Promise<boolean> | undefined;
				editor.onPasteImage = () => {
					paste = controller.handleImagePaste(editor);
					return paste;
				};
				if (transport === "keyboard") pane.handleInput("\x16");
				else void editor.pasteFromClipboard();
				pane.handleInput("\r");
				expect(submitted).toEqual([]);
				clipboard.resolve({ data: png, mimeType: "image/png" });
				await paste;
				expect(submitted[0]?.images?.[0]?.data).toBe(png.toBase64());
				expect(pane.getEditorText()).toBe("");
			} finally {
				pane.dispose();
			}
		},
	);

	it("does not fall back to Main when a read-only pane owns focus", async () => {
		const readImage = vi.fn(async () => ({ data: png, mimeType: "image/png" }));
		const { pane, main, controller, focus } = fixture(readImage);
		try {
			focus({ getPasteTarget: () => undefined });
			expect(await controller.handleImagePaste()).toBe(false);
			expect(readImage).not.toHaveBeenCalled();
			expect(main.pendingImages).toEqual([]);
			expect(main.getText()).toBe("");
		} finally {
			pane.dispose();
		}
	});

	it("keeps delayed clipboard text on the captured editor and rejects unsupported images", async () => {
		const text = Promise.withResolvers<string>();
		const { pane, main, controller, focus } = fixture(
			async () => null,
			() => text.promise,
		);
		try {
			const paste = controller.handleImagePaste();
			focus(main);
			text.resolve("side text");
			expect(await paste).toBe(true);
			expect(pane.getEditorText()).toBe("side text");
			expect(main.getText()).toBe("");
			focus(pane);
			pane.getPasteTarget()!.acceptsImagePaste = false;
			await controller.handleImagePathPaste("/unreachable.png");
			expect(pane.getEditorText()).toBe("side text");
			expect(main.pendingImages).toEqual([]);
		} finally {
			pane.dispose();
		}
	});
});
