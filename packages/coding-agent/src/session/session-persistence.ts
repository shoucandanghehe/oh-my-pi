import { isAnthropicServerToolHistoryBlock } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { isRecord, stringifyJson } from "@oh-my-pi/pi-utils";
import { PRESERVE_KEY as SNAPCOMPACT_PRESERVE_KEY } from "@oh-my-pi/snapcompact";
import {
	type BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	isBlobRef,
	isImageDataUrl,
} from "./blob-store";
import type { FileEntry } from "./session-entries";

const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";
/** Minimum base64 length to externalize to blob store (skip tiny inline images) */
const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const TEXT_CONTENT_KEY = "content";
/** Snapcompact archive frames use the same blob externalization as message media. */
const SNAPCOMPACT_FRAMES_KEY = "frames";

/** Detect strings damaged by an older persistence pass so loaders can migrate them safely. */
export function isPersistenceTruncatedString(value: unknown): value is string {
	return typeof value === "string" && value.endsWith(TRUNCATION_NOTICE);
}

export function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value as { type?: string }).type === "image" &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string"
	);
}

export function isMediaBlock(
	value: unknown,
): value is { type: "image" | "audio" | "video"; data: string; mimeType?: string } {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || !("data" in value)) return false;
	const { type, data } = value;
	return (type === "image" || type === "audio" || type === "video") && typeof data === "string";
}

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

function isMediaMimeType(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const lowered = value.toLowerCase();
	return lowered.startsWith("image/") || lowered.startsWith("audio/") || lowered.startsWith("video/");
}

export function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string" &&
		(isImageBlock(value) || ("mimeType" in value && isImageMimeType((value as { mimeType?: unknown }).mimeType)))
	);
}

export function isMediaDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	if (typeof value !== "object" || value === null || !("data" in value)) return false;
	if (typeof value.data !== "string") return false;
	if (isMediaBlock(value)) return true;
	return "mimeType" in value && isMediaMimeType(value.mimeType);
}

/**
 * True when a media payload sits in a persistence position whose base64 is
 * externalized to the blob store instead of truncated as a generic string: a
 * `content` media block, a frozen summary's `blocks` media block, an `images[]`
 * entry, a file mention's legacy `image` field, or a snapcompact frame under
 * `frames[]`. The eager load path uses the same position check but deliberately
 * leaves snapcompact frames as references for lazy context rebuilding.
 */
export function isExternalizableMediaPosition(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isMediaDataPayload(value)) return false;
	return (
		((key === TEXT_CONTENT_KEY || key === "blocks") && isMediaBlock(value)) ||
		key === "image" ||
		key === "images" ||
		key === SNAPCOMPACT_FRAMES_KEY
	);
}

/** Compatibility alias for callers that predate audio/video media support. */
export function isExternalizableImagePosition(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	return isExternalizableMediaPosition(value, key);
}

function shouldExternalizeMediaPayload(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isExternalizableMediaPosition(value, key)) return false;
	if (isBlobRef(value.data) || value.data.length < BLOB_EXTERNALIZE_THRESHOLD) return false;
	return true;
}

/** True for a non-empty string — marks signature/encrypted fields whose block must persist verbatim. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

interface ExternalizedImage {
	readonly data: string;
	readonly mimeType: string | undefined;
	readonly ref: string;
}

/**
 * Blob refs already minted for live image payload objects, per blob store.
 * The persisted copy of an entry is structurally shared while the in-memory
 * entry keeps its base64, so without this every full rewrite would decode,
 * hash, and stat every image in the session again. A hit requires the
 * payload's current data and mime type, so a payload mutated in place is
 * externalized afresh; keying by store keeps a ref minted into one blob dir
 * from being reused for another.
 */
const externalizedImageRefs = new WeakMap<BlobStore, WeakMap<object, ExternalizedImage>>();

function externalizeImagePayloadSync(
	blobStore: BlobStore,
	payload: object,
	data: string,
	mimeType: string | undefined,
): string {
	let refs = externalizedImageRefs.get(blobStore);
	const cached = refs?.get(payload);
	if (cached && cached.data === data && cached.mimeType === mimeType) return cached.ref;
	const ref = externalizeImageDataSync(blobStore, data, mimeType);
	if (!refs) {
		refs = new WeakMap();
		externalizedImageRefs.set(blobStore, refs);
	}
	refs.set(payload, { data, mimeType, ref });
	return ref;
}

/**
 * Drop every image ref remembered for `blobStore`, so the next persist checks
 * each blob on disk again. Call when a session write failed: a ref whose line
 * never reached a session file is unreferenced, so `omp gc` may collect its blob.
 */
export function forgetExternalizedImages(blobStore: BlobStore): void {
	externalizedImageRefs.delete(blobStore);
}

/** True for the snapcompact archive slot, `preserveData[PRESERVE_KEY]`. */
function isSnapcompactArchiveSlot(
	key: string | undefined,
	childKey: string,
	value: unknown,
): value is Record<string, unknown> {
	return key === "preserveData" && childKey === SNAPCOMPACT_PRESERVE_KEY && isRecord(value);
}

/**
 * The snapcompact archive under `preserveData[PRESERVE_KEY]`: its frames
 * externalize to the blob store, and every other field persists verbatim. The
 * next compaction re-renders the archive from `text`, so a cut would drop the
 * newest history uncounted and render {@link TRUNCATION_NOTICE} into the frames.
 */
function persistSnapcompactArchive(archive: Record<string, unknown>, blobStore: BlobStore): Record<string, unknown> {
	const frames = prepareValueForPersistence(archive.frames, blobStore, SNAPCOMPACT_FRAMES_KEY);
	const persisted = frames === archive.frames ? archive : { ...archive, frames };
	const view = archive.withoutThinking;
	if (!isRecord(view) || !isRecord(view.archive)) return persisted;
	const viewArchive = persistSnapcompactArchive(view.archive, blobStore);
	return viewArchive === view.archive
		? persisted
		: { ...persisted, withoutThinking: { ...view, archive: viewArchive } };
}

function snapcompactArchiveNeedsRewrite(archive: Record<string, unknown>): boolean {
	if (persistenceNodeNeedsRewrite(archive.frames, SNAPCOMPACT_FRAMES_KEY)) return true;
	const view = archive.withoutThinking;
	return isRecord(view) && isRecord(view.archive) && snapcompactArchiveNeedsRewrite(view.archive);
}

/**
 * Externalize media and omit already-archived transient fields without shortening history.
 * Returns the original object when no storage projection is needed.
 *
 * Runs in one synchronous tick so an OOM/SIGKILL landing right after a persist
 * call returns cannot lose the entry. Image externalization happens via the
 * synchronous blob-store path (`fs.writeFileSync`), so blob bytes are in the
 * kernel page cache before the JSONL line referencing them is written.
 */
function prepareValueForPersistence(obj: unknown, blobStore: BlobStore, key?: string): unknown {
	if (obj === null || obj === undefined) return obj;
	if (
		typeof obj === "object" &&
		"type" in obj &&
		obj.type === "image_generation_call" &&
		"result" in obj &&
		typeof obj.result === "string" &&
		!isBlobRef(obj.result) &&
		obj.result.length >= BLOB_EXTERNALIZE_THRESHOLD
	) {
		return { ...obj, result: externalizeImagePayloadSync(blobStore, obj, obj.result, undefined) };
	}
	if (shouldExternalizeMediaPayload(obj, key)) {
		return { ...obj, data: externalizeImagePayloadSync(blobStore, obj, obj.data, obj.mimeType) };
	}
	// Signed provider blocks must stay byte-exact, including fields the generic
	// projection would otherwise omit or externalize.
	// Anthropic validates native web-search and tool-search history byte-for-byte
	// on replay. Keep the complete typed block atomic, including opaque content.
	if (typeof obj === "object" && "type" in obj && obj.type === "anthropicServerTool" && "block" in obj) {
		const block = obj.block;
		if (typeof block === "object" && block !== null && "type" in block && typeof block.type === "string") {
			const validationView = {
				type: block.type,
				...("name" in block ? { name: block.name } : {}),
				...("id" in block ? { id: block.id } : {}),
				...("tool_use_id" in block ? { tool_use_id: block.tool_use_id } : {}),
				...("content" in block ? { content: block.content } : {}),
			};
			if (isAnthropicServerToolHistoryBlock(validationView)) return obj;
		}
	}
	// Anthropic server-side compaction replay state: `encrypted_content` is
	// opaque provider state the API validates byte-for-byte on replay, so the
	// carrier persists atomically with its summary and metadata — both as a
	// message `providerPayload` (`type: "anthropicCompaction"`) and under the
	// preserveData slot, whose object carries no `type` marker of its own.
	// Cursor server records are addressed by the SHA-256 of their bytes and carry
	// signed reasoning, and Gemini native content replays its signed parts
	// byte-for-byte, so both persist atomically too.
	if (
		typeof obj === "object" &&
		obj !== null &&
		(("type" in obj &&
			(obj.type === "anthropicCompaction" || obj.type === "cursorHistory" || obj.type === "geminiNativeContent")) ||
			(key === "anthropicCompaction" && "content" in obj && typeof obj.content === "string"))
	) {
		return obj;
	}
	if (typeof obj === "object" && "type" in obj) {
		const signed =
			(obj.type === "thinking" && "thinkingSignature" in obj && isNonEmptyString(obj.thinkingSignature)) ||
			(obj.type === "text" && "textSignature" in obj && isNonEmptyString(obj.textSignature)) ||
			(obj.type === "toolCall" && "thoughtSignature" in obj && isNonEmptyString(obj.thoughtSignature));
		const redacted = obj.type === "redactedThinking" && "data" in obj && isNonEmptyString(obj.data);
		// OpenAI Responses reasoning items (providerPayload.items) carry
		// `encrypted_content`, server-validated on replay — atomic like signed blocks.
		const encryptedReasoning =
			obj.type === "reasoning" && "encrypted_content" in obj && isNonEmptyString(obj.encrypted_content);
		if (signed || redacted || encryptedReasoning) return obj;
	}

	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj)) {
			return externalizeImageDataUrlSync(blobStore, obj);
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		let changed = false;
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const result: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const item = obj[i];
			const newItem = prepareValueForPersistence(item, blobStore, key);
			if (newItem !== item) changed = true;
			result[i] = newItem;
		}
		return changed ? result : obj;
	}

	if (typeof obj === "object") {
		// Scan for media externalization and transient fields before allocating.
		// The common persisted entry is already clean and returns here with
		// zero array/tuple allocation; only a dirty node pays for the rebuild.
		if (!persistenceNodeNeedsRewrite(obj)) return obj;
		let changed = false;
		const entries: Array<readonly [string, unknown]> = [];
		for (const childKey in obj) {
			if (!Object.hasOwn(obj, childKey)) continue;
			const value = (obj as Record<string, unknown>)[childKey];
			// Strip transient/redundant properties that shouldn't be persisted.
			// - jsonlEvents: raw subprocess streaming events (already saved to artifact files)
			if (childKey === "jsonlEvents") {
				changed = true;
				continue;
			}
			const newValue = isSnapcompactArchiveSlot(key, childKey, value)
				? persistSnapcompactArchive(value, blobStore)
				: prepareValueForPersistence(value, blobStore, childKey);
			if (newValue !== value) changed = true;
			entries.push([childKey, newValue]);
		}
		if (!changed) return obj;

		return Object.fromEntries(entries);
	}

	return obj;
}

/**
 * Whether this value needs media externalization or transient-field removal.
 * Keep this scan aligned with prepareValueForPersistence's storage projection.
 */
function persistenceNodeNeedsRewrite(obj: unknown, key?: string): boolean {
	if (obj === null || obj === undefined) return false;
	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj)) return true;
		return false;
	}
	if (Array.isArray(obj)) {
		for (const item of obj) {
			if (
				item !== null && typeof item === "object"
					? persistenceNodeNeedsRewrite(item, key)
					: persistenceNodeNeedsRewrite(item, key)
			)
				return true;
		}
		return false;
	}
	if (typeof obj === "object") {
		if ("jsonlEvents" in obj) return true;
		// Externalize shapes rewrite (not verbatim): check before the
		// atomic/verbatim classification below.
		if (typeof obj === "object" && "type" in obj) {
			const typed = obj as Record<string, unknown>;
			if (
				typed.type === "image_generation_call" &&
				"result" in typed &&
				typeof typed.result === "string" &&
				!isBlobRef(typed.result) &&
				typed.result.length >= BLOB_EXTERNALIZE_THRESHOLD
			) {
				return true;
			}
		}
		if (shouldExternalizeMediaPayload(obj, key)) return true;
		if (isAtomicPersistenceNode(obj, key)) return false;
		for (const childKey in obj) {
			if (!Object.hasOwn(obj, childKey)) continue;
			const value = (obj as Record<string, unknown>)[childKey];
			if (isSnapcompactArchiveSlot(key, childKey, value)) {
				if (snapcompactArchiveNeedsRewrite(value)) return true;
				continue;
			}
			if (persistenceNodeNeedsRewrite(value, childKey)) return true;
		}
		return false;
	}
	return false;
}

/**
 * Nodes prepareValueForPersistence keeps verbatim without descending:
 * provider-native replay carriers and signed/encrypted blocks.
 * Must stay in sync with the early-return guards above the recursion.
 */
function isAtomicPersistenceNode(obj: object, key?: string): boolean {
	// Media payloads are handled before this check because they externalize.
	// Valid server-tool blocks stay atomic; unrecognized blocks still traverse
	// generic storage fields without losing their original strings.
	if ("type" in obj) {
		const typed = obj as Record<string, unknown>;
		if (typed.type === "anthropicServerTool" && "block" in typed) {
			const block = typed.block;
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				typeof (block as { type?: unknown }).type === "string"
			) {
				const asBlock = block as Record<string, unknown>;
				const validationView = {
					type: asBlock.type as string,
					...("name" in asBlock ? { name: asBlock.name } : {}),
					...("id" in asBlock ? { id: asBlock.id } : {}),
					...("tool_use_id" in asBlock ? { tool_use_id: asBlock.tool_use_id } : {}),
					...("content" in asBlock ? { content: asBlock.content } : {}),
				};
				if (isAnthropicServerToolHistoryBlock(validationView)) return true;
			}
			return false;
		}
		if (
			typed.type === "anthropicCompaction" ||
			typed.type === "cursorHistory" ||
			typed.type === "geminiNativeContent" ||
			(key === "anthropicCompaction" && "content" in typed && typeof typed.content === "string")
		)
			return true;
		const signed =
			(typed.type === "thinking" && "thinkingSignature" in typed && isNonEmptyString(typed.thinkingSignature)) ||
			(typed.type === "text" && "textSignature" in typed && isNonEmptyString(typed.textSignature)) ||
			(typed.type === "toolCall" && "thoughtSignature" in typed && isNonEmptyString(typed.thoughtSignature));
		const redacted = typed.type === "redactedThinking" && "data" in typed && isNonEmptyString(typed.data);
		const encryptedReasoning =
			typed.type === "reasoning" && "encrypted_content" in typed && isNonEmptyString(typed.encrypted_content);
		if (signed || redacted || encryptedReasoning) return true;
	}
	return false;
}

/**
 * Read the duplication-relevant fields of an OpenAI Responses reasoning item.
 * Returns `undefined` for anything that is not a `type: "reasoning"` object, so
 * non-reasoning payload entries and corrupt signatures are never matched.
 */
function readReasoningItem(item: unknown): { encrypted_content?: string; id?: string } | undefined {
	if (item === null || typeof item !== "object") return undefined;
	if (!("type" in item) || item.type !== "reasoning") return undefined;
	const reasoning: { encrypted_content?: string; id?: string } = {};
	if ("encrypted_content" in item && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
		reasoning.encrypted_content = item.encrypted_content;
	}
	if ("id" in item && typeof item.id === "string" && item.id.length > 0) reasoning.id = item.id;
	return reasoning;
}

/**
 * True when a `thinkingSignature` (a JSON-encoded reasoning item) is already
 * carried by a reasoning item in the message's provider payload — matched on
 * `encrypted_content` (the load-bearing blob) when present, else on item `id`.
 * A signature the payload does not cover is never reported as recoverable, so it
 * is always kept.
 */
function signatureCoveredByPayload(
	signature: string,
	encrypted: ReadonlySet<string>,
	ids: ReadonlySet<string>,
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return false;
	}
	const reasoning = readReasoningItem(parsed);
	if (!reasoning) return false;
	if (reasoning.encrypted_content) return encrypted.has(reasoning.encrypted_content);
	if (reasoning.id) return ids.has(reasoning.id);
	return false;
}

/**
 * Drop `thinkingSignature` from assistant thinking blocks whose reasoning item is
 * already carried, verbatim, in the message's OpenAI Responses `providerPayload`.
 *
 * Responses/Codex turns mint each reasoning item once and store it twice:
 * `providerPayload.items` (the authoritative native-history copy that replay and
 * remote compaction read) and `content[].thinkingSignature`, which is literally
 * `JSON.stringify(reasoningItem)` — including the large `encrypted_content` blob.
 * Replay only ever reads the payload; the signature is a no-payload fallback that
 * same-provider turns never reach and cross-model turns strip as untrustworthy.
 * Persisting both stores the encrypted reasoning twice for zero token or replay
 * benefit, so the on-disk copy drops the duplicate signature whenever its
 * reasoning item is recoverable from the payload. The in-memory entry is left
 * untouched; only the serialized line is slimmed.
 */
function stripReplayedReasoningSignatures(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
	const message = entry.message;
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return entry;
	const hasSignedThinking = message.content.some(
		block =>
			block.type === "thinking" && typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0,
	);
	if (!hasSignedThinking) return entry;

	const encrypted = new Set<string>();
	const ids = new Set<string>();
	for (const rawItem of payload.items) {
		const reasoning = readReasoningItem(rawItem);
		if (!reasoning) continue;
		if (reasoning.encrypted_content) encrypted.add(reasoning.encrypted_content);
		if (reasoning.id) ids.add(reasoning.id);
	}
	if (encrypted.size === 0 && ids.size === 0) return entry;

	let changed = false;
	const content = message.content.map(block => {
		if (
			block.type !== "thinking" ||
			typeof block.thinkingSignature !== "string" ||
			block.thinkingSignature.length === 0
		) {
			return block;
		}
		if (!signatureCoveredByPayload(block.thinkingSignature, encrypted, ids)) return block;
		changed = true;
		return { ...block, thinkingSignature: undefined };
	});
	if (!changed) return entry;
	return { ...entry, message: { ...message, content } };
}

/**
 * Spilled MCP text already includes the rendered structured payload in its
 * artifact. Keep the live object for eval, but omit the duplicate from the
 * serialized top-level tool result. Never mutate the in-memory message.
 */
function stripSpilledMcpStructuredContent(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return entry;
	const details = entry.message.details;
	if (
		!isRecord(details) ||
		typeof details.serverName !== "string" ||
		typeof details.mcpToolName !== "string" ||
		!Object.hasOwn(details, "structuredContent") ||
		!isRecord(details.meta) ||
		!isRecord(details.meta.truncation) ||
		typeof details.meta.truncation.artifactId !== "string" ||
		details.meta.truncation.artifactId.length === 0
	) {
		return entry;
	}
	const persistedDetails = { ...details };
	delete persistedDetails.structuredContent;
	return { ...entry, message: { ...entry.message, details: persistedDetails } };
}

export function prepareEntryForPersistence(entry: FileEntry, blobStore: BlobStore): FileEntry {
	const projected = stripSpilledMcpStructuredContent(stripReplayedReasoningSignatures(entry));
	try {
		return prepareValueForPersistence(projected, blobStore) as FileEntry;
	} catch (error) {
		// The walk probes fields such as `data` and `type` with `in` and plain
		// reads, so it also reaches non-enumerable and inherited accessors that
		// the JSONL line never holds. Tool `details` can keep a library object
		// whose getter throws (firecrawl-js `SearchData.data`). Left unhandled,
		// that latches a disk failure, and every later rewrite of the session
		// meets the same entry, so nothing persists for the rest of the process.
		// Retry once on the plain JSON of the entry: it holds the fields the
		// line would serialize, and no accessors.
		let json: string | undefined;
		try {
			json = stringifyJson(projected);
		} catch {
			throw error;
		}
		if (json === undefined) throw error;
		try {
			return prepareValueForPersistence(JSON.parse(json), blobStore) as FileEntry;
		} catch {
			// A cause the clone does not remove (blob I/O) fails again: keep the
			// first error so the logged cause stays stable.
			throw error;
		}
	}
}
