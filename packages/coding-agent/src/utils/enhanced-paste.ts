import type { ImageContent } from "@oh-my-pi/pi-ai";

const OSC5522_PREFIX = "\x1b]5522;";
const OSC_TERMINATOR_ST = "\x1b\\";
const OSC_TERMINATOR_BEL = "\x07";
const PASTE_EVENT_NAME_BASE64 = Buffer.from("Paste event", "utf8").toString("base64");

const IMAGE_MIME_PRIORITY = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const TEXT_MIME_TYPE = "text/plain";
/** Kitty's "give me the list of available MIME types" sentinel — see `TARGETS_MIME` in `kitty/clipboard.py`. */
const MIME_LISTING_TARGET = ".";

type PasteReadKind = "image" | "text";

export interface Osc5522Packet {
	metadata: Map<string, string>;
	payload: string;
}

interface PasteListingState {
	mimes: string[];
	kittyDotPayload?: true;
	pw?: string;
	loc?: string;
	finish?: (text: string | undefined) => boolean;
}

interface PasteReadState {
	id: string;
	phase: "reading" | "applying" | "cancelled";
	kind: PasteReadKind;
	mimeType: string;
	chunks: string[];
	finish?: (text: string | undefined) => boolean;
}

export interface EnhancedPasteHandlers {
	write(data: string): void;
	/** Reserve ordered delivery from the paste notification through the clipboard read. */
	beginPaste?(): ((text: string | undefined) => boolean) | undefined;
	pasteText(text: string): void;
	pasteImage(image: ImageContent): void | Promise<void>;
	showStatus(message: string): void;
}

export function isOsc5522Packet(data: string): boolean {
	return data.startsWith(OSC5522_PREFIX) && (data.endsWith(OSC_TERMINATOR_ST) || data.endsWith(OSC_TERMINATOR_BEL));
}

function decodeBase64Utf8(value: string): string | undefined {
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

function parseMetadata(raw: string): Map<string, string> {
	const metadata = new Map<string, string>();
	for (const part of raw.split(":")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		metadata.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return metadata;
}

export function parseOsc5522Packet(data: string): Osc5522Packet | undefined {
	if (!isOsc5522Packet(data)) return undefined;
	const bodyEnd = data.endsWith(OSC_TERMINATOR_BEL) ? data.length - 1 : data.length - OSC_TERMINATOR_ST.length;
	const body = data.slice(OSC5522_PREFIX.length, bodyEnd);
	const separator = body.indexOf(";");
	const metadataRaw = separator === -1 ? body : body.slice(0, separator);
	const payload = separator === -1 ? "" : body.slice(separator + 1);
	return { metadata: parseMetadata(metadataRaw), payload };
}

function choosePasteMime(mimes: readonly string[]): { kind: PasteReadKind; mimeType: string } | undefined {
	for (const mimeType of IMAGE_MIME_PRIORITY) {
		if (mimes.includes(mimeType)) return { kind: "image", mimeType };
	}
	return mimes.includes(TEXT_MIME_TYPE) ? { kind: "text", mimeType: TEXT_MIME_TYPE } : undefined;
}

export class EnhancedPasteController {
	#listing: PasteListingState | undefined;
	#pending: PasteListingState[] = [];
	#read: PasteReadState | undefined;
	#nextReadId = 0;
	#handlers: EnhancedPasteHandlers;

	constructor(handlers: EnhancedPasteHandlers) {
		this.#handlers = handlers;
	}

	enable(): void {
		this.#handlers.write("\x1b[?5522h");
	}

	disable(): void {
		this.#handlers.write("\x1b[?5522l");
		this.cancel();
		const read = this.#read;
		this.#read = undefined;
		const finish = read?.finish;
		if (read) read.finish = undefined;
		finish?.(undefined);
	}

	/** Cancel pending pastes, draining any outstanding read reply before starting another. */
	cancel(): void {
		const listing = this.#listing;
		this.#listing = undefined;
		const pending = this.#pending.splice(0);
		const read = this.#read;
		if (read?.phase === "reading") {
			read.phase = "cancelled";
			read.chunks = [];
			const finish = read.finish;
			read.finish = undefined;
			finish?.(undefined);
		}
		listing?.finish?.(undefined);
		for (const paste of pending) paste.finish?.(undefined);
	}

	handleInput(data: string): boolean {
		const packet = parseOsc5522Packet(data);
		if (!packet) return false;
		void this.#handlePacket(packet);
		return true;
	}

	async #handlePacket(packet: Osc5522Packet): Promise<void> {
		if (packet.metadata.get("type") !== "read") return;
		const status = packet.metadata.get("status");
		const id = packet.metadata.get("id");
		if (id !== undefined) {
			const read = this.#read;
			if (!read || read.id !== id || read.phase === "applying") return;
			if (status === "DATA") {
				const mime = packet.metadata.get("mime");
				if (read.phase === "reading" && mime && decodeBase64Utf8(mime) === read.mimeType && packet.payload) {
					read.chunks.push(packet.payload);
				}
			} else if (status === "DONE") {
				await this.#finishRead(read);
			} else if (status && status !== "OK") {
				this.#handlers.showStatus(`Enhanced paste failed: ${status}`);
				this.#endRead(read);
			}
			return;
		}

		// Unsolicited paste notifications have no id; explicit read replies echo their request's id.
		if (status === "OK") {
			const loc = packet.metadata.get("loc");
			this.#listing = {
				mimes: [],
				pw: packet.metadata.get("pw"),
				loc: loc === "primary" ? loc : undefined,
				finish: this.#handlers.beginPaste?.(),
			};
			return;
		}
		const listing = this.#listing;
		if (!listing) return;
		if (status === "DATA") {
			this.#appendMime(listing, packet);
		} else if (status === "DONE") {
			this.#listing = undefined;
			this.#pending.push(listing);
			this.#startRead();
		} else if (status) {
			this.#listing = undefined;
			this.#handlers.showStatus(`Enhanced paste failed: ${status}`);
			listing.finish?.(undefined);
		}
	}

	#appendMime(listing: PasteListingState, packet: Osc5522Packet): void {
		const encodedMime = packet.metadata.get("mime");
		if (!encodedMime) return;
		const mimeType = decodeBase64Utf8(encodedMime);
		if (!mimeType) return;
		// Kitty lists MIME types in a "." payload; older terminals send one empty DATA packet per MIME.
		if (mimeType === MIME_LISTING_TARGET) {
			if (!packet.payload) return;
			const mimes = decodeBase64Utf8(packet.payload);
			if (!mimes) return;
			listing.kittyDotPayload = true;
			for (const candidate of mimes.split(/\s+/)) {
				if (candidate && candidate !== MIME_LISTING_TARGET) listing.mimes.push(candidate);
			}
			return;
		}
		listing.mimes.push(mimeType);
	}

	async #finishRead(read: PasteReadState): Promise<void> {
		if (read.phase === "cancelled") {
			this.#endRead(read);
			return;
		}
		read.phase = "applying";
		try {
			const bytes = Buffer.concat(read.chunks.map(chunk => Buffer.from(chunk, "base64")));
			if (bytes.byteLength === 0) {
				this.#handlers.showStatus("Clipboard paste was empty");
				return;
			}
			if (read.kind === "text") {
				const finish = read.finish;
				read.finish = undefined;
				if (finish) finish(bytes.toString("utf8"));
				else this.#handlers.pasteText(bytes.toString("utf8"));
			} else {
				await this.#handlers.pasteImage({
					type: "image",
					data: bytes.toString("base64"),
					mimeType: read.mimeType,
				});
			}
		} finally {
			this.#endRead(read);
		}
	}

	#endRead(read: PasteReadState): void {
		if (this.#read !== read) return;
		this.#read = undefined;
		const finish = read.finish;
		read.finish = undefined;
		finish?.(undefined);
		this.#startRead();
	}

	#startRead(): void {
		if (this.#read) return;
		let listing: PasteListingState | undefined;
		while ((listing = this.#pending.shift())) {
			const selected = choosePasteMime(listing.mimes);
			if (!selected) {
				this.#handlers.showStatus("Clipboard paste has no supported text or image data");
				listing.finish?.(undefined);
				continue;
			}
			const id = `paste-${++this.#nextReadId}`;
			this.#read = {
				id,
				phase: "reading",
				kind: selected.kind,
				mimeType: selected.mimeType,
				chunks: [],
				finish: listing.finish,
			};
			const encodedMime = Buffer.from(selected.mimeType, "utf8").toString("base64");
			const metadata = ["type=read", `id=${id}`];
			if (listing.loc) metadata.push(`loc=${listing.loc}`);
			if (listing.pw) metadata.push(`pw=${listing.pw}`, `name=${PASTE_EVENT_NAME_BASE64}`);
			if (listing.kittyDotPayload) {
				this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")};${encodedMime}${OSC_TERMINATOR_BEL}`);
			} else {
				metadata.push(`mime=${encodedMime}`);
				this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")}${OSC_TERMINATOR_BEL}`);
			}
			return;
		}
	}
}
