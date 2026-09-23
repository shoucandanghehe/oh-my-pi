import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { type BtwHistoryRecord, type BtwHistoryTurn, getBtwLatestTurn } from "@oh-my-pi/pi-tui/overlays/btw-history";
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

export {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
} from "@oh-my-pi/pi-tui/overlays/btw-history";

/** Full isolated BTW runtime checkpoint, unlike the lightweight history-panel record. */
export interface BtwThreadHistoryRecord extends Omit<RestoredBtwThread, "key" | "phase"> {
	version: 1;
	id: string;
	phase: "ready" | "running" | "error";
}

type HistoryRecord = BtwHistoryRecord | BtwThreadHistoryRecord;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const INTERRUPTED_ERROR = "Reply interrupted before completion";
const EXTERNALIZE_THRESHOLD = 1024;

const turnFields = {
	question: "string",
	answer: "string",
	status: "'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'",
	createdAt: "0 <= number <= 8640000000000000",
	updatedAt: "0 <= number <= 8640000000000000",
	"error?": "string",
} as const;
const turnSchema = type({ ...turnFields, "+": "reject" });
const recordSchema = type({
	...turnFields,
	id: "string > 0",
	leafId: "string | null",
	"followUps?": turnSchema.array(),
	"+": "reject",
});

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

/** Preserve opaque provider/tool message fields, validating the checkpoint envelope only. */
function parseThreadRecord(value: unknown): BtwThreadHistoryRecord {
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
				(!r.pausedRequest.input &&
					!(Array.isArray(r.pausedRequest.images) && r.pausedRequest.images.length)))) ||
		Object.keys(r).some(key => !RECORD_FIELDS[key])
	) {
		throw new Error("Invalid BTW history record");
	}
	// JSON encodes undefined array slots as null; restore draft link positions for the manager.
	return {
		...r,
		draftImageLinks: r.draftImageLinks.map(link => (link === null ? undefined : link)),
	} as unknown as BtwThreadHistoryRecord;
}

function parseRecord(value: unknown): HistoryRecord {
	if (isObject(value) && value.version === 1) return parseThreadRecord(value);
	const result = recordSchema(value);
	if (result instanceof type.errors) throw new Error(`Invalid BTW history record: ${result.summary}`);
	if (!ID_PATTERN.test(result.id)) throw new Error("Invalid BTW history record id");
	return result;
}

function isThreadRecord(record: HistoryRecord): record is BtwThreadHistoryRecord {
	return "version" in record;
}

function freezeRecord(record: BtwThreadHistoryRecord): BtwThreadHistoryRecord {
	function freeze(value: unknown): void {
		if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	freeze(record);
	return record;
}

/** Capture before yielding, so later streaming mutations cannot change a queued write. */
function snapshotRecord<T extends HistoryRecord>(record: T, recover = false): T {
	if (isThreadRecord(record)) {
		const copy = parseThreadRecord(JSON.parse(JSON.stringify(record)));
		if (recover && copy.phase === "running") {
			if (copy.pausedRequest) copy.phase = "ready";
			else {
				copy.phase = "error";
				copy.error = INTERRUPTED_ERROR;
			}
		}
		return freezeRecord(copy) as T;
	}
	const snapshotTurn = (turn: BtwHistoryTurn): BtwHistoryTurn =>
		Object.freeze({ ...turn, status: recover && turn.status === "running" ? "interrupted" : turn.status });
	return Object.freeze({
		...record,
		status: recover && record.status === "running" ? "interrupted" : record.status,
		...(record.followUps ? { followUps: Object.freeze(record.followUps.map(snapshotTurn)) } : {}),
	}) as T;
}

function recordFileName(id: string): string {
	// The prefix prevents Windows device names (CON, NUL, etc.).
	return `entry-${id}.json`;
}

function hash(bytes: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

interface StoredRecord {
	record: HistoryRecord;
	revision: string;
}

async function readRecord(filePath: string): Promise<StoredRecord | undefined> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error("Expected a regular file");
		const bytes = await fs.readFile(filePath);
		const record = parseRecord(JSON.parse(bytes.toString("utf8")));
		if (path.basename(filePath) !== recordFileName(record.id)) throw new Error("Record id does not match its filename");
		return { record, revision: hash(bytes) };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read BTW history ${filePath}: ${toError(error).message}`, { cause: error });
	}
}

function historyDirectory(artifactsDir: string, scope: string | undefined): string {
	const root = path.join(artifactsDir, "btw-history");
	if (scope === undefined) return root;
	const segment = /^[\w-]+$/.test(scope) ? scope : hash(scope);
	return path.join(root, "sessions", segment);
}

/** Apply journal-compatible media rules without truncating BTW tool transcripts. */
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

/** One CAS/lease/queue implementation for history-panel entries and isolated runtime checkpoints. */
export class BtwHistoryStore<T extends HistoryRecord = BtwHistoryRecord> {
	readonly #directory: string | undefined;
	readonly #blobs: BlobStore;
	readonly #format: "history" | "thread";
	readonly #records = new Map<string, T>();
	readonly #revisions = new Map<string, string>();
	readonly #leases = new Map<string, FileLockHandle>();
	#snapshot: readonly T[] = Object.freeze([]);
	#pending: Promise<void> = Promise.resolve();
	#writeError: Error | undefined;

	private constructor(directory: string | undefined, format: "history" | "thread", blobs: BlobStore) {
		this.#directory = directory;
		this.#format = format;
		this.#blobs = blobs;
	}

	/** Focused sessions share parent artifacts; scope their lightweight history by session id. */
	static open(artifactsDir: string | undefined, scope?: string): Promise<BtwHistoryStore<BtwHistoryRecord>> {
		return BtwHistoryStore.#open<BtwHistoryRecord>(
			artifactsDir === undefined ? undefined : historyDirectory(artifactsDir, scope),
			"history",
			new BlobStore(getBlobsDir()),
		);
	}

	/** Runtime checkpoints share the root sidecar directory but never appear as history-panel entries. */
	static openThreads(
		artifactsDir: string | undefined,
		blobs: BlobStore = new BlobStore(getBlobsDir()),
	): Promise<BtwHistoryStore<BtwThreadHistoryRecord>> {
		return BtwHistoryStore.#open<BtwThreadHistoryRecord>(
			artifactsDir === undefined ? undefined : historyDirectory(artifactsDir, undefined),
			"thread",
			blobs,
		);
	}

	static async #open<R extends HistoryRecord>(
		directory: string | undefined,
		format: "history" | "thread",
		blobs: BlobStore,
	): Promise<BtwHistoryStore<R>> {
		const store = new BtwHistoryStore<R>(directory, format, blobs);
		if (directory === undefined) return store;
		let names: string[];
		try {
			names = await fs.readdir(directory);
		} catch (error) {
			if (isEnoent(error)) return store;
			throw error;
		}
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const stored = await readRecord(path.join(directory, name));
			if (!stored || isThreadRecord(stored.record) !== (format === "thread")) continue;
			if (isThreadRecord(stored.record)) {
				const entry: CustomEntry<BtwThreadHistoryRecord> = {
					type: "custom",
					customType: "btw-history",
					data: stored.record,
					id: stored.record.id,
					parentId: null,
					timestamp: new Date(stored.record.createdAt).toISOString(),
				};
				await resolveBlobRefsInEntries([entry], blobs);
				await Promise.all(
					stored.record.draftImages.map(async image => {
						image.data = await resolveImageData(blobs, image.data);
					}),
				);
			}
			// Recovery/hydration are views. CAS still compares original on-disk bytes.
			store.#records.set(stored.record.id, snapshotRecord(stored.record, true) as R);
			store.#revisions.set(stored.record.id, stored.revision);
		}
		store.#refreshSnapshot();
		return store;
	}

	getRecords(): readonly T[] {
		return this.#snapshot;
	}

	upsert(record: T): Promise<void> {
		return this.#upsert(record, false);
	}

	/** Retry against the original revision rather than silently rebasing onto disk changes. */
	retry(record: T): Promise<void> {
		return this.#upsert(record, true);
	}

	async #upsert(record: T, retry: boolean): Promise<void> {
		if (this.#writeError && !retry) throw this.#writeError;
		const snapshot = snapshotRecord(parseRecord(record) as T);
		if (isThreadRecord(snapshot) !== (this.#format === "thread")) throw new Error("Wrong BTW history record format");
		if (this.#directory === undefined) {
			this.#records.set(snapshot.id, snapshot);
			this.#refreshSnapshot();
			return;
		}
		const diskRecord = JSON.parse(JSON.stringify(snapshot)) as T;
		if (isThreadRecord(diskRecord)) externalizeMedia(diskRecord, this.#blobs);
		const content = `${JSON.stringify(diskRecord)}\n`;
		const write = this.#pending.then(async () => {
			if (retry) this.#writeError = undefined;
			if (this.#writeError) throw this.#writeError;
			if (this.#directory) {
				await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
				if (process.platform !== "win32") await fs.chmod(this.#directory, 0o700);
				const filePath = path.join(this.#directory, recordFileName(snapshot.id));
				let lease = this.#leases.get(snapshot.id);
				if (!lease) {
					lease = await acquireFileLock(filePath);
					this.#leases.set(snapshot.id, lease);
				}
				const stored = await readRecord(filePath);
				if (stored?.revision !== this.#revisions.get(snapshot.id)) {
					throw new Error(`BTW history conflict for ${snapshot.id}; reopen history before retrying`);
				}
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
			const running = isThreadRecord(snapshot) ? snapshot.phase === "running" : getBtwLatestTurn(snapshot).status === "running";
			if (!running) this.#release(snapshot.id);
		});
		this.#track(write);
		await write;
	}

	remove(id: string): Promise<void> {
		if (!ID_PATTERN.test(id)) throw new Error("Invalid BTW history record id");
		if (this.#writeError) throw this.#writeError;
		const write = this.#pending.then(async () => {
			if (this.#writeError) throw this.#writeError;
			if (this.#directory) {
				await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
				if (process.platform !== "win32") await fs.chmod(this.#directory, 0o700);
				const filePath = path.join(this.#directory, recordFileName(id));
				if (!this.#leases.has(id)) this.#leases.set(id, await acquireFileLock(filePath));
				const stored = await readRecord(filePath);
				if (stored?.revision !== this.#revisions.get(id)) {
					throw new Error(`BTW history conflict for ${id}; reopen history before retrying`);
				}
				await fs.unlink(filePath).catch(error => {
					if (!isEnoent(error)) throw error;
				});
			}
			this.#revisions.delete(id);
			this.#records.delete(id);
			this.#refreshSnapshot();
			this.#release(id);
		});
		this.#track(write);
		return write;
	}

	#track(write: Promise<void>): void {
		this.#pending = write.catch(error => {
			this.#writeError ??= toError(error);
			for (const lease of this.#leases.values()) lease.release();
			this.#leases.clear();
		});
	}

	#release(id: string): void {
		this.#leases.get(id)?.release();
		this.#leases.delete(id);
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
			for (const id of this.#leases.keys()) this.#release(id);
		}
	}

	#refreshSnapshot(): void {
		this.#snapshot = Object.freeze(
			[...this.#records.values()].sort(
				(a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			),
		);
	}
}
