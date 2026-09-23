import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock, type FileLockHandle, getBlobsDir, isEnoent, toError } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import {
	BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	isBlobRef,
	isImageDataUrl,
	resolveImageData,
} from "./blob-store";
import type { RestoredBtwThread } from "./btw-thread";
import { resolveBlobRefsInEntries } from "./session-loader";
import { isExternalizableMediaPosition } from "./session-persistence";
import type { CustomEntry } from "./session-entries";

/** A complete BTW checkpoint, independent of the parent session journal. */
export interface BtwHistoryRecord extends Omit<RestoredBtwThread, "key" | "phase"> {
	version: 1;
	/** Filesystem-safe identity; consumer maps this to the thread key. */
	id: string;
	phase: "ready" | "running" | "error";
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const INTERRUPTED_ERROR = "Reply interrupted before completion";
const EXTERNALIZE_THRESHOLD = 1024;
const RECORD_FIELDS: Record<string, true> = {
	version: true,
	id: true,
	title: true,
	createdAt: true,
	anchorLeafId: true,
	model: true,
	sideSessionId: true,
	baseMessages: true,
	turns: true,
	draft: true,
	draftImages: true,
	draftImageLinks: true,
	readThrough: true,
	phase: true,
	error: true,
	pausedRequest: true,
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function isImages(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			image =>
				isObject(image) &&
				image.type === "image" &&
				typeof image.data === "string" &&
				typeof image.mimeType === "string",
		)
	);
}

function isMessage(value: unknown): boolean {
	return isObject(value) && typeof value.role === "string";
}

/** Validate the rich envelope without discarding opaque provider/tool message fields. */
function parseRecord(value: unknown): BtwHistoryRecord {
	if (!isObject(value)) throw new Error("Invalid BTW history record: expected an object");
	const r = value;
	if (
		r.version !== 1 ||
		typeof r.id !== "string" ||
		!ID_PATTERN.test(r.id) ||
		typeof r.title !== "string" ||
		!isTimestamp(r.createdAt) ||
		typeof r.anchorLeafId !== "string" ||
		!r.anchorLeafId ||
		!isObject(r.model) ||
		typeof r.model.provider !== "string" ||
		!r.model.provider ||
		typeof r.model.id !== "string" ||
		!r.model.id ||
		typeof r.sideSessionId !== "string" ||
		!r.sideSessionId ||
		!Array.isArray(r.baseMessages) ||
		!r.baseMessages.every(isMessage) ||
		!Array.isArray(r.turns) ||
		!r.turns.every(
			turn =>
				isObject(turn) &&
				typeof turn.input === "string" &&
				typeof turn.replyText === "string" &&
				isTimestamp(turn.timestamp) &&
				isObject(turn.assistantMessage) &&
				turn.assistantMessage.role === "assistant" &&
				(turn.images === undefined || isImages(turn.images)) &&
				(turn.prefixMessages === undefined ||
					(Array.isArray(turn.prefixMessages) && turn.prefixMessages.every(isMessage))) &&
				(turn.intermediateMessages === undefined ||
					(Array.isArray(turn.intermediateMessages) && turn.intermediateMessages.every(isMessage))),
		) ||
		typeof r.draft !== "string" ||
		!isImages(r.draftImages) ||
		!Array.isArray(r.draftImageLinks) ||
		!r.draftImageLinks.every(link => link === null || link === undefined || typeof link === "string") ||
		!Number.isInteger(r.readThrough) ||
		(r.readThrough as number) < 0 ||
		(r.readThrough as number) > r.turns.length ||
		(r.phase !== "ready" && r.phase !== "running" && r.phase !== "error") ||
		(r.error !== undefined && typeof r.error !== "string") ||
		(r.pausedRequest !== undefined &&
			(!isObject(r.pausedRequest) ||
				typeof r.pausedRequest.input !== "string" ||
				!isTimestamp(r.pausedRequest.timestamp) ||
				(r.pausedRequest.images !== undefined && !isImages(r.pausedRequest.images)) ||
				(!r.pausedRequest.input && !(Array.isArray(r.pausedRequest.images) && r.pausedRequest.images.length)))) ||
		Object.keys(r).some(key => !RECORD_FIELDS[key])
	) {
		throw new Error("Invalid BTW history record");
	}
	// JSON encodes undefined array slots as null; restore draft link positions for the manager.
	return {
		...r,
		draftImageLinks: r.draftImageLinks.map(link => (link === null ? undefined : link)),
	} as unknown as BtwHistoryRecord;
}

function freezeRecord(record: BtwHistoryRecord): BtwHistoryRecord {
	function freeze(value: unknown): void {
		if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	freeze(record);
	return record;
}

/** Serialization happens before the first await, so later mutations cannot change a queued write. */
function snapshotRecord(record: BtwHistoryRecord, recover = false): BtwHistoryRecord {
	const copy = parseRecord(JSON.parse(JSON.stringify(record)));
	if (recover && copy.phase === "running") {
		if (copy.pausedRequest) copy.phase = "ready";
		else {
			copy.phase = "error";
			copy.error = INTERRUPTED_ERROR;
		}
	}
	return freezeRecord(copy);
}

function recordFileName(id: string): string {
	// The prefix also avoids Windows reserved device names.
	return `entry-${id}.json`;
}

/** Apply the existing media/BlobStore rules without truncating complete BTW tool transcripts. */
function externalizeMedia(value: unknown, blobs: BlobStore, key?: string): void {
	if (Array.isArray(value)) {
		for (const child of value) externalizeMedia(child, blobs, key);
		return;
	}
	if (!isObject(value)) return;
	const record = value;
	if (
		isExternalizableMediaPosition(value, key === "draftImages" ? "images" : key) &&
		!isBlobRef(value.data) &&
		value.data.length >= EXTERNALIZE_THRESHOLD
	) {
		value.data = externalizeImageDataSync(blobs, value.data, value.mimeType);
		return;
	}
	if (
		record.type === "image_generation_call" &&
		typeof record.result === "string" &&
		!isBlobRef(record.result) &&
		record.result.length >= EXTERNALIZE_THRESHOLD
	) {
		record.result = externalizeImageDataSync(blobs, record.result);
	}
	if (
		typeof record.image_url === "string" &&
		isImageDataUrl(record.image_url) &&
		record.image_url.length >= EXTERNALIZE_THRESHOLD
	) {
		record.image_url = externalizeImageDataUrlSync(blobs, record.image_url);
	}
	for (const [childKey, child] of Object.entries(record)) externalizeMedia(child, blobs, childKey);
}

interface StoredRecord {
	record: BtwHistoryRecord;
	revision: string;
}

function hash(bytes: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function readRecord(filePath: string): Promise<StoredRecord | undefined> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error("Expected a regular file");
		const bytes = await fs.readFile(filePath);
		const record = parseRecord(JSON.parse(bytes.toString("utf8")));
		if (path.basename(filePath) !== recordFileName(record.id))
			throw new Error("Record id does not match its filename");
		return { record, revision: hash(bytes) };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read BTW history ${filePath}: ${toError(error).message}`, { cause: error });
	}
}

/** Session-local file-only BTW state; never modifies the Main session journal. */
export class BtwHistoryStore {
	readonly #directory: string | undefined;
	readonly #blobs: BlobStore;
	readonly #records = new Map<string, BtwHistoryRecord>();
	readonly #revisions = new Map<string, string>();
	readonly #leases = new Map<string, FileLockHandle>();
	#snapshot: readonly BtwHistoryRecord[] = Object.freeze([]);
	#pending: Promise<void> = Promise.resolve();
	#writeError: Error | undefined;

	constructor(directory: string | undefined, blobs: BlobStore = new BlobStore(getBlobsDir())) {
		this.#directory = directory;
		this.#blobs = blobs;
	}

	static async open(artifactsDir: string | undefined, blobs?: BlobStore): Promise<BtwHistoryStore> {
		const store = new BtwHistoryStore(
			artifactsDir === undefined ? undefined : path.join(artifactsDir, "btw-history"),
			blobs,
		);
		if (!store.#directory) return store;
		let names: string[];
		try {
			names = await fs.readdir(store.#directory);
		} catch (error) {
			if (isEnoent(error)) return store;
			throw error;
		}
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const stored = await readRecord(path.join(store.#directory, name));
			if (!stored) continue;
			// Resolve journal-compatible blob references in a disposable custom-entry envelope.
			const entry: CustomEntry<BtwHistoryRecord> = {
				type: "custom",
				customType: "btw-history",
				data: stored.record,
				id: stored.record.id,
				parentId: null,
				timestamp: new Date(stored.record.createdAt).toISOString(),
			};
			await resolveBlobRefsInEntries([entry], store.#blobs);
			// The journal resolver knows `images[]`; sidecar drafts use `draftImages[]`.
			await Promise.all(
				stored.record.draftImages.map(async image => {
					image.data = await resolveImageData(store.#blobs, image.data);
				}),
			);
			store.#records.set(stored.record.id, snapshotRecord(stored.record, true));
			// Recovery and blob hydration are a view; compare the original disk revision.
			store.#revisions.set(stored.record.id, stored.revision);
		}
		store.#refreshSnapshot();
		return store;
	}

	getRecords(): readonly BtwHistoryRecord[] {
		return this.#snapshot;
	}

	async upsert(record: BtwHistoryRecord): Promise<void> {
		if (this.#writeError) throw this.#writeError;
		const snapshot = snapshotRecord(record);
		const diskRecord = JSON.parse(JSON.stringify(snapshot)) as BtwHistoryRecord;
		if (this.#directory) externalizeMedia(diskRecord, this.#blobs);
		const content = `${JSON.stringify(diskRecord)}\n`;
		return this.#enqueue(snapshot.id, async (filePath, lease) => {
			if (filePath) {
				const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
				try {
					await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
					await replaceFileAtomically(temporaryPath, filePath);
				} finally {
					await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
				}
				this.#revisions.set(snapshot.id, hash(content));
			}
			this.#records.set(snapshot.id, snapshot);
			this.#refreshSnapshot();
			if (snapshot.phase !== "running" && lease) this.#release(snapshot.id, lease);
		});
	}

	async remove(id: string): Promise<void> {
		if (!ID_PATTERN.test(id)) throw new Error("Invalid BTW history record id");
		if (this.#writeError) throw this.#writeError;
		return this.#enqueue(id, async (filePath, lease) => {
			if (filePath) {
				await fs.unlink(filePath).catch(error => {
					if (!isEnoent(error)) throw error;
				});
			}
			this.#revisions.delete(id);
			this.#records.delete(id);
			this.#refreshSnapshot();
			if (lease) this.#release(id, lease);
		});
	}

	#release(id: string, lease: FileLockHandle): void {
		lease.release();
		this.#leases.delete(id);
	}

	#enqueue(
		id: string,
		action: (filePath: string | undefined, lease: FileLockHandle | undefined) => Promise<void>,
	): Promise<void> {
		const write = this.#pending.then(async () => {
			if (this.#writeError) throw this.#writeError;
			if (!this.#directory) {
				// In-memory writes use the same ordering, with no filesystem lease.
				await action(undefined, undefined);
				return;
			}
			await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
			if (process.platform !== "win32") await fs.chmod(this.#directory, 0o700);
			const filePath = path.join(this.#directory, recordFileName(id));
			let lease = this.#leases.get(id);
			if (!lease) {
				lease = await acquireFileLock(filePath);
				this.#leases.set(id, lease);
			}
			const stored = await readRecord(filePath);
			if (stored?.revision !== this.#revisions.get(id)) {
				throw new Error(`BTW history conflict for ${id}; reopen history before writing`);
			}
			await action(filePath, lease);
		});
		this.#pending = write.catch(error => {
			this.#writeError ??= toError(error);
			for (const lease of this.#leases.values()) lease.release();
			this.#leases.clear();
		});
		return write;
	}

	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.#pending;
			await pending;
		} while (pending !== this.#pending);
		if (this.#writeError) throw this.#writeError;
	}

	async close(): Promise<void> {
		try {
			await this.flush();
		} finally {
			for (const [id, lease] of this.#leases) this.#release(id, lease);
		}
	}

	#refreshSnapshot(): void {
		this.#snapshot = Object.freeze(
			[...this.#records.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
		);
	}
}
