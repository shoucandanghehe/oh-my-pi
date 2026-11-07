import { describe, expect, it } from "bun:test";
import { EnhancedPasteController } from "@oh-my-pi/pi-coding-agent/utils/enhanced-paste";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { defaultEditorTheme } from "../../../tui/test/test-themes";

const ST = "\x1b\\";
const BEL = "\x07";
const OSC = "\x1b]5522;";

function packet(metadata: string, payload?: string): string {
	return `${OSC}${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
}

function unexpectedNativePaste(): never {
	throw new Error("unexpected native clipboard paste");
}

function readReply(metadata: string, payload?: string, read = 1): string {
	return packet(`${metadata}:id=paste-${read}`, payload);
}

describe("EnhancedPasteController", () => {
	it("requests image data from an OSC 5522 paste event and preserves chunk boundaries", () => {
		const writes: string[] = [];
		const pastedImages: Array<{ data: string; mimeType: string }> = [];
		const statuses: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => statuses.push("unexpected text paste"),
			pasteImage: image => {
				pastedImages.push({ data: image.data, mimeType: image.mimeType });
			},
			showStatus: message => statuses.push(message),
			pasteNative: unexpectedNativePaste,
		});

		controller.enable();
		expect(writes).toEqual(["\x1b[?5522h"]);

		const imageMime = Buffer.from("image/png", "utf8").toString("base64");
		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret123", "utf8").toString("base64");
		controller.handleInput(packet(`type=read:status=OK:pw=${password}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${imageMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");
		expect(writes.at(-1)).toBe(
			`${OSC}type=read:id=paste-1:pw=${password}:name=${pasteEventName}:mime=${imageMime}${BEL}`,
		);

		controller.handleInput(readReply("type=read:status=OK"));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("image-", "utf8").toString("base64")),
		);
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("bytes", "utf8").toString("base64")),
		);
		controller.handleInput(readReply("type=read:status=DONE"));

		expect(pastedImages).toEqual([
			{
				data: Buffer.from("image-bytes", "utf8").toString("base64"),
				mimeType: "image/png",
			},
		]);
		expect(statuses).toEqual([]);
	});

	it("falls back to text/plain and carries primary-selection location into the read request", () => {
		const writes: string[] = [];
		const pastedText: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: text => pastedText.push(text),
			pasteImage: () => {
				throw new Error("unexpected image paste");
			},
			showStatus: message => pastedText.push(`status:${message}`),
			pasteNative: unexpectedNativePaste,
		});

		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret456", "utf8").toString("base64");
		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");
		expect(controller.handleInput("plain text")).toBe(false);
		controller.handleInput(packet(`type=read:status=OK:loc=primary:pw=${password}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		expect(writes).toEqual([
			`${OSC}type=read:id=paste-1:loc=primary:pw=${password}:name=${pasteEventName}:mime=${textMime}${BEL}`,
		]);

		controller.handleInput(readReply("type=read:status=OK"));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${textMime}`, Buffer.from("hello ", "utf8").toString("base64")),
		);
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${textMime}`, Buffer.from("world", "utf8").toString("base64")),
		);
		controller.handleInput(readReply("type=read:status=DONE"));

		expect(pastedText).toEqual(["hello world"]);
	});

	it("falls back to the native clipboard reader when the listing has no supported MIME type", () => {
		const writes: string[] = [];
		const statuses: string[] = [];
		let nativeAvailable = true;
		let nativePastes = 0;
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => {},
			pasteImage: () => {},
			showStatus: message => statuses.push(message),
			pasteNative: () => {
				nativePastes++;
				return nativeAvailable;
			},
		});

		// macOS screenshots copied straight to the clipboard list only `image/tiff` (#17696).
		const tiffMime = Buffer.from("image/tiff", "utf8").toString("base64");
		expect(controller.handleInput(packet("type=read:status=OK"))).toBe(true);
		expect(controller.handleInput(packet(`type=read:status=DATA:mime=${tiffMime}`))).toBe(true);
		expect(controller.handleInput(packet("type=read:status=DONE"))).toBe(true);

		expect(nativePastes).toBe(1);
		expect(writes).toEqual([]);
		expect(statuses).toEqual([]);

		// Remote session: the native clipboard is not the user's, so report the unsupported listing.
		nativeAvailable = false;
		const htmlMime = Buffer.from("text/html", "utf8").toString("base64");
		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(packet(`type=read:status=DATA:mime=${htmlMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		expect(nativePastes).toBe(2);
		expect(writes).toEqual([]);
		expect(statuses).toEqual(["Clipboard paste has no supported text or image data"]);
	});

	it("does not paste the regular clipboard for an unsupported primary-selection listing", () => {
		const statuses: string[] = [];
		const controller = new EnhancedPasteController({
			write: () => {},
			pasteText: () => {},
			pasteImage: () => {},
			showStatus: message => statuses.push(message),
			pasteNative: unexpectedNativePaste,
		});

		const tiffMime = Buffer.from("image/tiff", "utf8").toString("base64");
		controller.handleInput(packet("type=read:status=OK:loc=primary"));
		controller.handleInput(packet(`type=read:status=DATA:mime=${tiffMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		expect(statuses).toEqual(["Clipboard paste has no supported text or image data"]);
	});

	it("decodes Kitty's dot-listing DATA payload to discover plain-text and request it", () => {
		const writes: string[] = [];
		const pastedText: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: text => pastedText.push(text),
			pasteImage: () => {
				throw new Error("unexpected image paste");
			},
			showStatus: message => pastedText.push(`status:${message}`),
			pasteNative: unexpectedNativePaste,
		});

		const dot = Buffer.from(".", "utf8").toString("base64");
		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret-token-123", "utf8").toString("base64");
		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");

		// Kitty bundles the available MIME types into a single DATA packet
		// whose `mime` field is the literal `.` and whose payload carries a
		// whitespace-separated, base64-encoded list (e.g. "text/plain\n").
		controller.handleInput(packet(`type=read:status=OK:pw=${password}`));
		controller.handleInput(
			packet(
				`type=read:status=DATA:mime=${dot}:pw=${password}`,
				Buffer.from("text/plain\n", "utf8").toString("base64"),
			),
		);
		controller.handleInput(packet(`type=read:status=DONE:pw=${password}`));

		expect(writes.at(-1)).toBe(`${OSC}type=read:id=paste-1:pw=${password}:name=${pasteEventName};${textMime}${BEL}`);

		controller.handleInput(readReply("type=read:status=OK"));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${textMime}`, Buffer.from("hello", "utf8").toString("base64")),
		);
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${textMime}`, Buffer.from(" world", "utf8").toString("base64")),
		);
		controller.handleInput(readReply("type=read:status=DONE"));

		expect(pastedText).toEqual(["hello world"]);
	});

	it("prefers images when Kitty's dot-listing payload advertises multiple MIME types", () => {
		const writes: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => {
				throw new Error("unexpected text paste");
			},
			pasteImage: () => {},
			showStatus: () => {},
			pasteNative: unexpectedNativePaste,
		});

		const dot = Buffer.from(".", "utf8").toString("base64");
		const imageMime = Buffer.from("image/png", "utf8").toString("base64");

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(
				`type=read:status=DATA:mime=${dot}`,
				Buffer.from("text/plain image/png text/html\n", "utf8").toString("base64"),
			),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(writes.at(-1)).toBe(`${OSC}type=read:id=paste-1;${imageMime}${BEL}`);
	});

	it("queues consecutive paste notifications without ending the active image read or reordering attachments", async () => {
		const editor = new CustomEditor(defaultEditorTheme);
		const writes: string[] = [];
		const statuses: string[] = [];
		const firstImageReady = Promise.withResolvers<void>();
		const delivered = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		let started = 0;
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			beginPaste: () => {
				const completion = delivered[started++]!;
				const finish = editor.beginPaste();
				return text => {
					const accepted = finish(text);
					completion.resolve();
					return accepted;
				};
			},
			pasteText: text => editor.pasteText(text),
			pasteImage: async image => {
				const label = Buffer.from(image.data, "base64").toString();
				if (label === "first") await firstImageReady.promise;
				editor.pasteText(`${label} `);
			},
			showStatus: message => statuses.push(message),
			pasteNative: unexpectedNativePaste,
		});
		const dot = Buffer.from(".").toString("base64");
		const imageMime = Buffer.from("image/png").toString("base64");
		const mimeList = Buffer.from("image/png\n").toString("base64");
		for (const password of ["first", "second", undefined]) {
			const token = password ? `:pw=${Buffer.from(password).toString("base64")}` : "";
			controller.handleInput(packet(`type=read:status=OK${token}`));
			controller.handleInput(packet(`type=read:status=DATA:mime=${dot}`, mimeList));
			controller.handleInput(packet("type=read:status=DONE"));
		}
		editor.handleInput("tail");
		expect(statuses).toEqual([]);
		expect(writes).toHaveLength(1);
		expect(editor.getText()).toBe("");

		controller.handleInput(readReply("type=read:status=OK"));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("first").toString("base64")),
		);
		controller.handleInput(readReply("type=read:status=DONE"));
		expect(writes).toHaveLength(1);
		firstImageReady.resolve();
		await delivered[0]!.promise;
		expect(writes).toHaveLength(2);
		expect(writes[1]).toContain(`:pw=${Buffer.from("second").toString("base64")}:`);

		controller.handleInput(readReply("type=read:status=OK", undefined, 2));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("second").toString("base64"), 2),
		);
		controller.handleInput(readReply("type=read:status=DONE", undefined, 2));
		await delivered[1]!.promise;
		expect(writes).toHaveLength(3);
		expect(writes[2]).not.toContain(":pw=");

		controller.handleInput(readReply("type=read:status=OK", undefined, 3));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("third").toString("base64"), 3),
		);
		controller.handleInput(readReply("type=read:status=DONE", undefined, 3));
		await delivered[2]!.promise;
		expect(editor.getText()).toBe("first second third tail");
		expect(statuses).toEqual([]);
	});

	it("keeps later keys behind an enhanced image paste until its attachment work finishes", async () => {
		const editor = new CustomEditor(defaultEditorTheme);
		const imageReady = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const controller = new EnhancedPasteController({
			write: () => {},
			beginPaste: () => {
				const finish = editor.beginPaste();
				return text => {
					const accepted = finish(text);
					delivered.resolve();
					return accepted;
				};
			},
			pasteText: text => editor.pasteText(text),
			pasteImage: async () => {
				await imageReady.promise;
				editor.pasteText("image ");
			},
			showStatus: () => {},
			pasteNative: unexpectedNativePaste,
		});
		const imageMime = Buffer.from("image/png").toString("base64");
		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(packet(`type=read:status=DATA:mime=${imageMime}`));
		controller.handleInput(packet("type=read:status=DONE"));
		controller.handleInput(readReply("type=read:status=OK"));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("image").toString("base64")),
		);
		controller.handleInput(readReply("type=read:status=DONE"));
		editor.handleInput("abc");
		expect(editor.getText()).toBe("");

		imageReady.resolve();
		await delivered.promise;
		expect(editor.getText()).toBe("image abc");
	});

	it("keeps queued image responses with each notification's captured editor after focus changes", async () => {
		const first = new CustomEditor(defaultEditorTheme);
		const second = new CustomEditor(defaultEditorTheme);
		let focused = first;
		const completions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let nextCompletion = 0;
		const controller = new EnhancedPasteController({
			write: () => {},
			beginPaste: () => {
				const target = focused;
				const finish = target.beginPaste();
				const completion = completions[nextCompletion++]!;
				return {
					finish: text => {
						const accepted = finish(text);
						completion.resolve();
						return accepted;
					},
					pasteImage: image => target.pasteText(Buffer.from(image.data, "base64").toString()),
				};
			},
			pasteText: text => focused.pasteText(text),
			pasteImage: image => focused.pasteText(Buffer.from(image.data, "base64").toString()),
			showStatus: () => {},
			pasteNative: unexpectedNativePaste,
		});
		const mime = Buffer.from("image/png").toString("base64");
		for (const target of [first, second]) {
			focused = target;
			controller.handleInput(packet("type=read:status=OK"));
			controller.handleInput(packet(`type=read:status=DATA:mime=${mime}`));
			controller.handleInput(packet("type=read:status=DONE"));
		}
		first.handleInput(" first tail");
		second.handleInput(" second tail");
		controller.handleInput(readReply(`type=read:status=DATA:mime=${mime}`, Buffer.from("one").toString("base64")));
		controller.handleInput(readReply("type=read:status=DONE"));
		await completions[0]!.promise;
		focused = first;
		controller.handleInput(readReply(`type=read:status=DATA:mime=${mime}`, Buffer.from("two").toString("base64"), 2));
		controller.handleInput(readReply("type=read:status=DONE", undefined, 2));
		await completions[1]!.promise;

		expect(first.getText()).toBe("one first tail");
		expect(second.getText()).toBe("two second tail");
	});

	it("releases later keys when disabled with an active read, queued paste and unfinished notification", () => {
		const editor = new CustomEditor(defaultEditorTheme);
		const controller = new EnhancedPasteController({
			write: () => {},
			beginPaste: () => editor.beginPaste(),
			pasteText: text => editor.pasteText(text),
			pasteImage: () => {},
			showStatus: () => {},
			pasteNative: unexpectedNativePaste,
		});
		controller.handleInput(packet("type=read:status=OK"));
		const textMime = Buffer.from("text/plain").toString("base64");
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet("type=read:status=DONE"));
		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet("type=read:status=DONE"));
		controller.handleInput(packet("type=read:status=OK"));
		editor.handleInput("abc");
		controller.disable();
		expect(editor.getText()).toBe("abc");
		controller.handleInput(readReply("type=read:status=OK"));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${textMime}`, Buffer.from("late").toString("base64")),
		);
		controller.handleInput(readReply("type=read:status=DONE"));
		expect(editor.getText()).toBe("abc");
	});
});
