import { describe, expect, it } from "bun:test";
import { EnhancedPasteController } from "@oh-my-pi/pi-coding-agent/utils/enhanced-paste";

const ST = "\x1b\\";
const BEL = "\x07";
const OSC = "\x1b]5522;";

function packet(metadata: string, payload?: string): string {
	return `${OSC}${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
}

function unexpectedNativePaste(): never {
	throw new Error("unexpected native clipboard paste");
}

function unexpectedHtmlPaste(): never {
	throw new Error("unexpected HTML paste");
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
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
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
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
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
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
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
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
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
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
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
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
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
		const pasted: string[] = [];
		const writes: string[] = [];
		const statuses: string[] = [];
		const firstImageReady = Promise.withResolvers<void>();
		const delivered = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		let started = 0;
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			beginPaste: () => {
				const completion = delivered[started++]!;
				return { isCurrent: () => true, finish: () => completion.resolve() };
			},
			pasteText: text => pasted.push(text),
			pasteImage: async image => {
				const label = Buffer.from(image.data, "base64").toString();
				if (label === "first") await firstImageReady.promise;
				pasted.push(label);
			},
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
			pasteNative: unexpectedNativePaste,
			showStatus: message => statuses.push(message),
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
		expect(statuses).toEqual([]);
		expect(writes).toHaveLength(1);
		expect(pasted).toEqual([]);

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
		expect(pasted).toEqual(["first", "second", "third"]);
		expect(statuses).toEqual([]);
	});

	it("delivers fallback, image and HTML to the host that reserved each notification, in order", async () => {
		const nativeReady = Promise.withResolvers<boolean>();
		const finished = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		const deliveries: string[] = [];
		const writes: string[] = [];
		let next = 0;
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			acceptsHtml: () => true,
			showStatus: message => deliveries.push(message),
			pasteText: () => deliveries.push("global text"),
			pasteImage: () => void deliveries.push("global image"),
			pasteHtml: () => void deliveries.push("global HTML"),
			pasteNative: () => {
				deliveries.push("global fallback");
				return true;
			},
			beginPaste: () => {
				const index = next++;
				return {
					isCurrent: () => true,
					finish: () => finished[index]!.resolve(),
					pasteImage: () => void deliveries.push(`${index} image`),
					pasteHtml: (html: string) => void deliveries.push(`${index} HTML: ${html}`),
					pasteNative: () => {
						deliveries.push(`${index} fallback`);
						return nativeReady.promise;
					},
				};
			},
		});
		const [tiff, png, html] = ["image/tiff", "image/png", "text/html"].map(mime =>
			Buffer.from(mime).toString("base64"),
		);
		for (const mime of [tiff, png, html]) {
			controller.handleInput(packet("type=read:status=OK"));
			controller.handleInput(packet(`type=read:status=DATA:mime=${mime}`));
			controller.handleInput(packet("type=read:status=DONE"));
		}
		expect(deliveries).toEqual(["0 fallback"]);
		expect(writes).toEqual([]);

		nativeReady.resolve(true);
		await finished[0]!.promise;
		expect(writes).toHaveLength(1);
		const payload = Buffer.from("<b>sample</b>").toString("base64");
		controller.handleInput(readReply(`type=read:status=DATA:mime=${png}`, payload));
		controller.handleInput(readReply("type=read:status=DONE"));
		await finished[1]!.promise;
		expect(writes).toHaveLength(2);
		controller.handleInput(readReply(`type=read:status=DATA:mime=${html}`, payload, 2));
		controller.handleInput(readReply("type=read:status=DONE", undefined, 2));
		await finished[2]!.promise;
		expect(deliveries).toEqual(["0 fallback", "1 image", "2 HTML: <b>sample</b>"]);
	});

	it("holds the reservation until the asynchronous attachment has finished", async () => {
		let released = false;
		const imageReady = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const controller = new EnhancedPasteController({
			write: () => {},
			beginPaste: () => {
				return {
					isCurrent: () => true,
					finish: () => {
						released = true;
						delivered.resolve();
					},
				};
			},
			pasteText: () => {
				throw new Error("unexpected plain-text paste");
			},
			pasteImage: () => imageReady.promise,
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
			pasteNative: unexpectedNativePaste,
			showStatus: () => {},
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
		expect(released).toBe(false);

		imageReady.resolve();
		await delivered.promise;
		expect(released).toBe(true);
	});

	it("releases the active, queued and listing reservations and ignores late clipboard replies on disable", () => {
		const pasted: string[] = [];
		let reservations = 0;
		const controller = new EnhancedPasteController({
			write: () => {},
			beginPaste: () => {
				reservations++;
				return {
					isCurrent: () => true,
					finish: () => {
						reservations--;
					},
				};
			},
			pasteText: text => pasted.push(text),
			pasteImage: () => {},
			acceptsHtml: () => false,
			pasteHtml: unexpectedHtmlPaste,
			pasteNative: unexpectedNativePaste,
			showStatus: () => {},
		});
		controller.handleInput(packet("type=read:status=OK"));
		const textMime = Buffer.from("text/plain").toString("base64");
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet("type=read:status=DONE"));
		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet("type=read:status=DONE"));
		controller.handleInput(packet("type=read:status=OK"));
		expect(reservations).toBe(3);
		controller.disable();
		expect(reservations).toBe(0);
		controller.handleInput(readReply("type=read:status=OK"));
		controller.handleInput(
			readReply(`type=read:status=DATA:mime=${textMime}`, Buffer.from("late").toString("base64")),
		);
		controller.handleInput(readReply("type=read:status=DONE"));
		expect(pasted).toEqual([]);
	});

	it("reads HTML over plain text only where styled text goes", () => {
		const htmlMime = Buffer.from("text/html", "utf8").toString("base64");
		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const listing = Buffer.from("text/plain text/html", "utf8").toString("base64");
		const dot = Buffer.from(".", "utf8").toString("base64");
		for (const composer of [true, false]) {
			const writes: string[] = [];
			const pasted: string[] = [];
			const controller = new EnhancedPasteController({
				write: data => writes.push(data),
				pasteText: text => pasted.push(`text:${text}`),
				pasteImage: () => {
					throw new Error("unexpected image paste");
				},
				acceptsHtml: () => composer,
				pasteHtml: html => {
					pasted.push(`html:${html}`);
				},
				showStatus: message => pasted.push(`status:${message}`),
				pasteNative: unexpectedNativePaste,
			});
			controller.handleInput(packet("type=read:status=OK"));
			controller.handleInput(packet(`type=read:status=DATA:mime=${dot}`, listing));
			controller.handleInput(packet("type=read:status=DONE"));
			const mime = composer ? htmlMime : textMime;
			expect(writes.at(-1)).toBe(`${OSC}type=read:id=paste-1;${mime}${BEL}`);

			const body = composer ? "<b>hi</b>" : "hi";
			controller.handleInput(readReply("type=read:status=OK"));
			controller.handleInput(
				readReply(`type=read:status=DATA:mime=${mime}`, Buffer.from(body, "utf8").toString("base64")),
			);
			controller.handleInput(readReply("type=read:status=DONE"));
			expect(pasted).toEqual([composer ? "html:<b>hi</b>" : "text:hi"]);
		}
	});
});
