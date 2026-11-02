import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptPane } from "@oh-my-pi/pi-tui/chat/chat-transcript-pane";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ClipboardImage } from "@oh-my-pi/pi-natives/clipboard";
import type { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as externalEditor from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import { TempDir } from "@oh-my-pi/pi-utils";

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
		showWarning: vi.fn(),
		keybindings: KeybindingsManager.inMemory(),
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "image", path: `${process.cwd()}/image.png`, displayPath: "image.png" }),
		},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx, { readImage, readText });
	return {
		ctx,
		ui,
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

describe("independent native pane editor bindings", () => {
	function nativeUi(editor: CustomEditor) {
		let focused = editor;
		const listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
		const ui = {
			getFocused: () => focused,
			requestRender: vi.fn(),
			addInputListener: vi.fn((listener: (data: string) => { consume?: boolean } | undefined) => {
				listeners.push(listener);
				return () => {};
			}),
			addStartListener: vi.fn(),
			terminal: { write: vi.fn() },
			stop: vi.fn(),
			start: vi.fn(),
		} as unknown as TUI;
		return {
			ui,
			focus: (target: CustomEditor) => {
				focused = target;
			},
			press: (data: string) => {
				for (const listener of listeners) if (listener(data)?.consume) return;
				focused.handleInput(data);
			},
		};
	}

	function sideSession(dir: TempDir) {
		const manager = SessionManager.inMemory(dir.path());
		vi.spyOn(manager, "getArtifactsDir").mockReturnValue(path.join(dir.path(), "artifacts"));
		const putBlob = vi.spyOn(manager, "putBlob").mockImplementation(async () => ({
			hash: "side-image",
			path: path.join(dir.path(), "side-image.png"),
			displayPath: path.join(dir.path(), "side-image.png"),
			ref: "blob:sha256:side-image",
		}));
		return { session: { sessionManager: manager } as AgentSession, manager, putBlob };
	}

	it("lands image bytes and chip links in the captured native session while Main remains focused", async () => {
		using dir = TempDir.createSync("native-pane-paste-");
		const read = Promise.withResolvers<ClipboardImage | null>();
		const h = fixture(() => read.promise);
		const side = new CustomEditor(getEditorTheme());
		const native = nativeUi(side);
		const { session, putBlob } = sideSession(dir);
		const mainPaste = vi.fn(async () => {});
		const mainCopy = vi.fn();
		h.ui.onAppViewportPasteRequest = mainPaste;
		h.ui.onAppViewportSelectionCopy = mainCopy;
		h.focus(h.main);
		h.controller.setupPaneEditor({ editor: side, session, ui: native.ui });
		h.controller.setupPaneEditor({ editor: side, session, ui: native.ui });
		const paste = native.ui.onAppViewportPasteRequest!();
		native.focus(new CustomEditor(getEditorTheme()));
		read.resolve({ data: png, mimeType: "image/png" });
		await paste;

		expect(side.pendingImages[0]?.data).toBe(png.toBase64());
		expect(side.pendingImageLinks).toEqual([path.join(dir.path(), "side-image.png")]);
		expect(putBlob.mock.calls[0]?.[0]).toEqual(png);
		expect(h.main.pendingImages).toEqual([]);
		expect(h.ui.onAppViewportPasteRequest).toBe(mainPaste);
		expect(h.ui.onAppViewportSelectionCopy).toBe(mainCopy);
		expect(native.ui.addInputListener).toHaveBeenCalledTimes(1);
		h.pane.dispose();
	});

	it("preserves raw clipboard text on its source editor after native focus and thread change", async () => {
		using dir = TempDir.createSync("native-pane-raw-");
		const read = Promise.withResolvers<string>();
		const h = fixture(
			async () => null,
			() => read.promise,
		);
		const source = new CustomEditor(getEditorTheme());
		const other = new CustomEditor(getEditorTheme());
		const native = nativeUi(source);
		const { session } = sideSession(dir);
		h.controller.setupPaneEditor({ editor: source, session, ui: native.ui });
		h.controller.setupPaneEditor({ editor: other, session, ui: native.ui });
		h.main.setText("Main");
		const paste = source.onPasteTextRaw!();
		native.focus(other);
		read.resolve("line one\nline two");
		await paste;

		expect(source.getText()).toBe("line one\nline two");
		expect(other.getText()).toBe("");
		expect(h.main.getText()).toBe("Main");
		h.pane.dispose();
	});

	it("does not apply a pending image to an editor rebound to another session", async () => {
		using firstDir = TempDir.createSync("native-pane-first-");
		using secondDir = TempDir.createSync("native-pane-second-");
		const read = Promise.withResolvers<ClipboardImage | null>();
		const h = fixture(() => read.promise);
		const editor = new CustomEditor(getEditorTheme());
		const native = nativeUi(editor);
		const first = sideSession(firstDir);
		const second = sideSession(secondDir);
		h.controller.setupPaneEditor({ editor, session: first.session, ui: native.ui });
		const paste = editor.pasteFromClipboard();
		h.controller.setupPaneEditor({ editor, session: second.session, ui: native.ui });
		read.resolve({ data: png, mimeType: "image/png" });

		expect(await paste).toBe(false);
		expect(editor.pendingImages).toEqual([]);
		expect(first.putBlob).not.toHaveBeenCalled();
		expect(second.putBlob).not.toHaveBeenCalled();
		h.pane.dispose();
	});

	it("resolves a pasted file against the native editor's session cwd", async () => {
		using dir = TempDir.createSync("native-pane-file-");
		await Bun.write(path.join(dir.path(), "source.png"), png);
		const h = fixture(async () => null);
		const source = new CustomEditor(getEditorTheme());
		const native = nativeUi(source);
		const { session } = sideSession(dir);
		h.focus(h.main);
		h.controller.setupPaneEditor({ editor: source, session, ui: native.ui });
		await source.onPasteImagePath!("source.png");

		expect(source.pendingImages[0]?.data).toBe(png.toBase64());
		expect(source.pendingImageLinks).toEqual([path.resolve(dir.path(), "source.png")]);
		expect(h.main.pendingImages).toEqual([]);
		h.pane.dispose();
	});

	it("captures enhanced-paste image delivery before focus switches and releases the source submit barrier", async () => {
		using dir = TempDir.createSync("native-pane-enhanced-");
		const h = fixture(async () => null);
		const source = new CustomEditor(getEditorTheme());
		const other = new CustomEditor(getEditorTheme());
		const native = nativeUi(source);
		const { session } = sideSession(dir);
		h.controller.setupPaneEditor({ editor: source, session, ui: native.ui });
		h.controller.setupPaneEditor({ editor: other, session, ui: native.ui });
		const submitted = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		source.onSubmit = text => submitted.resolve({ text, images: [...source.pendingImages] });
		const mime = Buffer.from("image/png").toString("base64");
		const packet = (metadata: string, payload = "") => `\x1b]5522;type=read:${metadata}${payload}\x1b\\`;
		native.press(packet("status=OK"));
		native.press(packet(`status=DATA:mime=${mime}`));
		native.press(packet("status=DONE"));
		source.handleInput("\r");
		native.focus(other);
		native.press(packet(`status=DATA:id=paste-1:mime=${mime}`, `;${png.toBase64()}`));
		native.press(packet("status=DONE:id=paste-1"));
		const result = await submitted.promise;

		expect(result.text).toContain("[Image #1");
		expect(result.images[0]?.data).toBe(png.toBase64());
		expect(other.pendingImages).toEqual([]);
		expect(h.main.pendingImages).toEqual([]);
		h.pane.dispose();
	});

	it("rejects external editing in an independent native UI without borrowing Main stdio or changing its draft", async () => {
		using dir = TempDir.createSync("native-pane-no-editor-channel-");
		const h = fixture(async () => null);
		const source = new CustomEditor(getEditorTheme());
		const native = nativeUi(source);
		const { session } = sideSession(dir);
		const open = vi.spyOn(externalEditor, "openInEditor").mockResolvedValue("must not apply");
		h.controller.setupPaneEditor({ editor: source, session, ui: native.ui });
		const image: ImageContent = { type: "image", data: png.toBase64(), mimeType: "image/png" };
		source.pendingImages = [image];
		source.pendingImageLinks = ["local://original.png"];
		source.imageLinks = source.pendingImageLinks;
		source.setCollapsedText("Original [Image #1]");
		native.press("\x07");

		expect(open).not.toHaveBeenCalled();
		expect(native.ui.stop).not.toHaveBeenCalled();
		expect(source.getExpandedText()).toBe("Original [Image #1]");
		expect(source.pendingImages).toEqual([image]);
		expect(source.pendingImageLinks).toEqual(["local://original.png"]);
		expect(h.ctx.showWarning).toHaveBeenCalledWith("This pane has no external-editor terminal channel");
		h.pane.dispose();
	});

	it("restores external edits to a shared-TUI pane draft without replacing newer text or attachments", async () => {
		using dir = TempDir.createSync("native-pane-external-");
		const h = fixture(async () => null);
		const source = new CustomEditor(getEditorTheme());
		const other = new CustomEditor(getEditorTheme());
		const native = nativeUi(source);
		h.ctx.ui = native.ui;
		const { session } = sideSession(dir);
		const edited = Promise.withResolvers<string | null>();
		const entered = Promise.withResolvers<void>();
		vi.spyOn(externalEditor, "getEditorCommand").mockReturnValue("editor");
		vi.spyOn(externalEditor, "openInEditor").mockImplementation(async (_command, text) => {
			expect(text).toBe("Original [Image #1]");
			entered.resolve();
			return edited.promise;
		});
		h.controller.setupPaneEditor({ editor: source, session, ui: native.ui });
		const image: ImageContent = { type: "image", data: png.toBase64(), mimeType: "image/png" };
		source.pendingImages = [image];
		source.pendingImageLinks = ["local://original.png"];
		source.imageLinks = source.pendingImageLinks;
		source.setCollapsedText("Original [Image #1]");
		h.main.setText("Main draft");
		const open = vi.spyOn(h.controller, "openExternalEditor");
		native.press("\x07");
		const editing = open.mock.results[0]!.value;
		await entered.promise;
		const newer: ImageContent = { type: "image", data: "bmV3ZXI=", mimeType: "image/jpeg" };
		source.pendingImages = [newer];
		source.pendingImageLinks = ["local://newer.jpg"];
		source.imageLinks = source.pendingImageLinks;
		source.setCollapsedText("Newer [Image #1]");
		native.focus(other);
		edited.resolve("Revised [Image #1]");
		await editing;

		expect(source.getExpandedText()).toBe("Revised [Image #2]\n\nNewer [Image #1]");
		expect(source.pendingImages).toEqual([newer, image]);
		expect(source.pendingImageLinks).toEqual(["local://newer.jpg", "local://original.png"]);
		expect(other.getText()).toBe("");
		expect(h.main.getText()).toBe("Main draft");
		expect(native.ui.stop).toHaveBeenCalledTimes(1);
		expect(native.ui.start).toHaveBeenCalledTimes(1);
		h.pane.dispose();
	});
});
