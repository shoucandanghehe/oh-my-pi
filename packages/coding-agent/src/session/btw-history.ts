import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	acquireFileLock,
	type FileLockHandle,
	getBlobsDir,
	isEnoent,
	isRecord,
	logger,
	toError,
} from "@oh-my-pi/pi-utils";
import { type BtwHistoryRecord, type BtwHistoryTurn, getBtwLatestTurn, getBtwTurns } from "./btw-history-model";
import { writeFileAtomically } from "../utils/atomic-file";
import { BlobStore, resolveImageData } from "./blob-store";
import type { LegacyRestoredBtwThread } from "./btw-thread";
import type { BtwTurnCheckpoint } from "./btw-turn";
import { assistantMessageWithReplyText } from "./messages";
import { resolveBlobRefsInEntries } from "./session-loader";

export {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwRecordInject,
	getBtwTurns,
	getBtwTurnKey,
} from "./btw-history-model";

const imageSchema = type({ type: "'image'", data: "string", mimeType: "string" });
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const turnFields = {
	question: "string",
	"images?": imageSchema.array(),
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
	// `title` lives in the `entry-<id>.title` sidecar: older builds reject unknown record keys.
	"followUps?": turnSchema.array(),
	"+": "reject",
});

const conversationSchema = type({
	answers: "string[]",
	baseMessages: "object[]",
	"trailingMessages?": "object[] | undefined",
	turns: type({
		input: "string",
		"images?": imageSchema.array().or("undefined"),
		assistantMessage: "object",
		"intermediateMessages?": "object[] | undefined",
		"prefixMessages?": "object[] | undefined",
		replyText: "string",
		timestamp: "number",
	}).array(),
	sideSessionId: "string",
	model: { provider: "string", id: "string" },
});

const legacyThreadSchema = conversationSchema.omit("answers").merge(
	type({
		version: "1",
		id: "string",
		title: "string",
		"titleExplicit?": "boolean",
		createdAt: "0 <= number <= 8640000000000000",
		anchorLeafId: "string > 0",
		draft: "string",
		draftImages: imageSchema.array(),
		draftImageLinks: type("string | null").array(),
		readThrough: "number.integer >= 0",
		phase: "'ready' | 'running' | 'error'",
		"error?": "string",
		"pausedRequest?": {
			input: "string",
			timestamp: "number",
			"images?": imageSchema.array(),
		},
	}),
);

interface StoredBtwTurnCheckpoint extends BtwTurnCheckpoint {
	/** Last saved display replies identify user edits without rewriting untouched native turns. */
	answers: string[];
}

function parseRecord(value: unknown): BtwHistoryRecord {
	const result = recordSchema(value);
	if (result instanceof type.errors) {
		throw new Error(`Invalid BTW history record: ${result.summary}`);
	}
	if (!ID_PATTERN.test(result.id)) {
		throw new Error("Invalid BTW history record id");
	}
	return result;
}

function snapshotRecord(record: BtwHistoryRecord, recover = false): BtwHistoryRecord {
	const snapshotTurn = (turn: BtwHistoryTurn): BtwHistoryTurn =>
		Object.freeze({ ...turn, status: recover && turn.status === "running" ? "interrupted" : turn.status });
	return Object.freeze({
		...record,
		status: recover && record.status === "running" ? "interrupted" : record.status,
		...(record.followUps ? { followUps: Object.freeze(record.followUps.map(snapshotTurn)) } : {}),
	});
}

function recordFileName(id: string): string {
	// The prefix also prevents Windows device names (CON, NUL, etc.).
	return `entry-${id}.json`;
}

/** Older builds only read `.json` names, so the title sidecar never breaks their history. */
function titleFileName(id: string): string {
	return `entry-${id}.title`;
}

interface StoredRecord {
	record: BtwHistoryRecord;
	revision: string;
}

async function readRecord(filePath: string, ignoreLegacy = false): Promise<StoredRecord | undefined> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error("Expected a regular file");
		const bytes = await fs.readFile(filePath);
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		if (ignoreLegacy && isRecord(value) && value.version === 1) return undefined;
		const record = parseRecord(value);
		if (path.basename(filePath) !== recordFileName(record.id)) {
			throw new Error("Record id does not match its filename");
		}
		return { record, revision: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read BTW history ${filePath}: ${toError(error).message}`, { cause: error });
	}
}

/** The first sidecar format stored full thread checkpoints next to lightweight history. */
export async function readLegacyBtwThreadSidecars(artifactsDir: string): Promise<LegacyRestoredBtwThread[]> {
	const directory = historyDirectory(artifactsDir, undefined);
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const result: LegacyRestoredBtwThread[] = [];
	const blobs = new BlobStore(getBlobsDir());
	for (const name of names) {
		if (!name.startsWith("entry-") || !name.endsWith(".json")) continue;
		const file = path.join(directory, name);
		if (!(await fs.lstat(file)).isFile()) continue;
		const value: unknown = JSON.parse(await Bun.file(file).text());
		if (!isRecord(value) || value.version !== 1) continue;
		const parsed = legacyThreadSchema(value);
		if (parsed instanceof type.errors) throw new Error(`Invalid legacy BTW thread ${file}: ${parsed.summary}`);
		if (!ID_PATTERN.test(parsed.id) || name !== recordFileName(parsed.id)) {
			throw new Error(`Legacy BTW thread id does not match ${file}`);
		}
		await resolveBlobRefsInEntries(
			[
				{
					type: "custom",
					customType: "btw-history",
					data: parsed,
					id: parsed.id,
					parentId: null,
					timestamp: new Date(parsed.createdAt).toISOString(),
				},
			],
			blobs,
		);
		await Promise.all(
			parsed.draftImages.map(async image => {
				image.data = await resolveImageData(blobs, image.data);
			}),
		);
		const { id, version: _version, phase, ...fields } = parsed;
		const interrupted = phase === "running" && !fields.pausedRequest;
		result.push({
			...fields,
			key: id,
			draftImageLinks: fields.draftImageLinks.map(link => link ?? undefined),
			phase: interrupted || phase === "error" ? "error" : "ready",
			error: interrupted ? "Reply interrupted before completion" : fields.error,
		} as LegacyRestoredBtwThread);
	}
	return result;
}

/** A missing or unreadable title only loses the heading; the topic still opens under its question. */
async function readTitle(filePath: string): Promise<string | undefined> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error("Expected a regular file");
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Ignoring unreadable BTW history title", { path: filePath, error: toError(error).message });
		}
		return undefined;
	}
}

function historyDirectory(artifactsDir: string, scope: string | undefined): string {
	const root = path.join(artifactsDir, "btw-history");
	if (scope === undefined) return root;
	// Session ids come from session headers; never let one escape the history root.
	const segment = /^[\w-]+$/.test(scope) ? scope : new Bun.CryptoHasher("sha256").update(scope).digest("hex");
	return path.join(root, "sessions", segment);
}

/** The topic on disk is missing or was rewritten since this store read it; retrying the same write can never succeed. */
export class BtwHistoryConflictError extends Error {
	constructor(readonly recordId: string) {
		super(`BTW history conflict for ${recordId}; reopen history before retrying`);
		this.name = "BtwHistoryConflictError";
	}
}

/** Session-local sidecar storage; never reads or writes the main session journal. */
export class BtwHistoryStore {
	readonly #directory: string | undefined;
	readonly #records = new Map<string, BtwHistoryRecord>();
	readonly #revisions = new Map<string, string>();
	readonly #conversations = new Map<string, BtwTurnCheckpoint>();
	readonly #conversationAnswers = new Map<string, string[]>();
	readonly #leases = new Map<string, FileLockHandle>();
	#snapshot: readonly BtwHistoryRecord[] = Object.freeze([]);
	#pending: Promise<void> = Promise.resolve();
	#writeError: Error | undefined;

	constructor(directory: string | undefined) {
		this.#directory = directory;
	}

	/**
	 * Open the BTW history for an artifacts directory. Subagents share their
	 * parent's artifacts directory, so a `scope` (the owning session id) keeps
	 * each focused agent's side conversations apart from main and its siblings.
	 */
	static async open(artifactsDir: string | undefined, scope?: string): Promise<BtwHistoryStore> {
		const store = new BtwHistoryStore(artifactsDir === undefined ? undefined : historyDirectory(artifactsDir, scope));
		if (store.#directory === undefined) return store;
		let names: string[];
		try {
			names = await fs.readdir(store.#directory);
		} catch (error) {
			if (isEnoent(error)) return store;
			throw error;
		}
		// Only titled topics have a sidecar; skip the lookup for the rest.
		const titleNames = new Set(names.filter(name => name.endsWith(".title")));
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const stored = await readRecord(path.join(store.#directory, name), true);
			if (!stored) continue;
			const titleName = titleFileName(stored.record.id);
			const title = titleNames.has(titleName) ? await readTitle(path.join(store.#directory, titleName)) : undefined;
			// Recovery is only a view. CAS must compare the original disk bytes,
			// and the live writer's lease prevents a recovered view stealing a turn.
			store.#records.set(
				stored.record.id,
				snapshotRecord(title === undefined ? stored.record : { ...stored.record, title }, true),
			);
			store.#revisions.set(stored.record.id, stored.revision);
		}
		store.#refreshSnapshot();
		return store;
	}

	getRecords(): readonly BtwHistoryRecord[] {
		return this.#snapshot;
	}

	/** Native context stays outside the lightweight UI/wire record and survives focus/process changes. */
	async readConversation(recordId: string): Promise<BtwTurnCheckpoint | undefined> {
		if (!ID_PATTERN.test(recordId)) throw new Error("Invalid BTW history record id");
		await this.#pending;
		return this.#loadConversation(recordId);
	}

	async #loadConversation(recordId: string): Promise<BtwTurnCheckpoint | undefined> {
		const cached = this.#conversations.get(recordId);
		if (cached || !this.#directory) return cached;
		try {
			const value: unknown = JSON.parse(
				await Bun.file(path.join(this.#directory, `entry-${recordId}.conversation`)).text(),
			);
			const parsed = conversationSchema(value);
			if (parsed instanceof type.errors) throw new Error(`Invalid BTW conversation: ${parsed.summary}`);
			const { answers, ...checkpoint } = parsed as StoredBtwTurnCheckpoint;
			this.#conversationAnswers.set(recordId, answers);
			this.#conversations.set(recordId, checkpoint);
			return checkpoint;
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
	}

	stageConversation(recordId: string, checkpoint: BtwTurnCheckpoint): void {
		if (!ID_PATTERN.test(recordId)) throw new Error("Invalid BTW history record id");
		this.#conversations.set(recordId, structuredClone(checkpoint));
	}

	upsert(record: BtwHistoryRecord): Promise<void> {
		return this.#upsert(record, false);
	}

	/** Retry a failed checkpoint against the original revision, without rebasing onto disk changes. */
	retry(record: BtwHistoryRecord): Promise<void> {
		return this.#upsert(record, true);
	}

	async #upsert(record: BtwHistoryRecord, retry: boolean): Promise<void> {
		if (this.#writeError && !retry) throw this.#writeError;
		// Capture before yielding: callers may keep mutating their streaming record.
		const { title, ...fields } = record;
		const saved = snapshotRecord(parseRecord(fields));
		const snapshot = title === undefined ? saved : Object.freeze({ ...saved, title });
		if (this.#directory === undefined) {
			this.#records.set(snapshot.id, snapshot);
			this.#refreshSnapshot();
			return;
		}
		const directory = this.#directory;
		const content = `${JSON.stringify(saved)}\n`;
		const write = this.#pending.then(async () => {
			// Reset only at this queue boundary: earlier attempts and their error
			// handlers must settle before an explicit retry can recover the store.
			if (retry) this.#writeError = undefined;
			if (this.#writeError) throw this.#writeError;
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			if (process.platform !== "win32") await fs.chmod(directory, 0o700);
			const filePath = path.join(directory, recordFileName(snapshot.id));
			let lease = this.#leases.get(snapshot.id);
			if (!lease) {
				lease = await acquireFileLock(filePath);
				this.#leases.set(snapshot.id, lease);
			}
			// Compare while holding the topic lease, including on owner checkpoints.
			// Missing records and new-id collisions are conflicts, not blind inserts.
			const stored = await readRecord(filePath);
			if (stored?.revision !== this.#revisions.get(snapshot.id)) {
				throw new BtwHistoryConflictError(snapshot.id);
			}
			if (!stored) {
				// The title never changes, so it is written once, before the record is
				// visible; a stale sidecar from a vanished record must not title a new one.
				const titlePath = path.join(directory, titleFileName(snapshot.id));
				if (title === undefined) await fs.rm(titlePath, { force: true });
				else await writeFileAtomically(titlePath, title);
			}
			let checkpoint = await this.#loadConversation(snapshot.id);
			const completed = getBtwTurns(saved).filter(turn => turn.status === "complete");
			const answers = completed.map(turn => turn.answer);
			const previousAnswers = this.#conversationAnswers.get(snapshot.id);
			if (checkpoint) {
				checkpoint = {
					...checkpoint,
					turns: checkpoint.turns.map((turn, index) => {
						const source = completed[index];
						if (!source || previousAnswers?.[index] === undefined || previousAnswers[index] === source.answer)
							return turn;
						return {
							...turn,
							replyText: source.answer,
							assistantMessage: assistantMessageWithReplyText(turn.assistantMessage, source.answer),
						};
					}),
				};
				this.#conversations.set(snapshot.id, checkpoint);
				await writeFileAtomically(
					path.join(directory, `entry-${snapshot.id}.conversation`),
					`${JSON.stringify({ ...checkpoint, answers })}\n`,
				);
			}
			await writeFileAtomically(filePath, content);
			this.#revisions.set(snapshot.id, new Bun.CryptoHasher("sha256").update(content).digest("hex"));
			this.#conversationAnswers.set(snapshot.id, answers);
			this.#records.set(snapshot.id, snapshot);
			this.#refreshSnapshot();
			if (getBtwLatestTurn(snapshot).status !== "running") this.#release(snapshot.id);
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
					throw new BtwHistoryConflictError(id);
				}
				await fs.unlink(filePath).catch(error => {
					if (!isEnoent(error)) throw error;
				});
				await fs.rm(path.join(this.#directory, titleFileName(id)), { force: true });
				await fs.rm(path.join(this.#directory, `entry-${id}.conversation`), { force: true });
			}
			this.#revisions.delete(id);
			this.#records.delete(id);
			this.#conversations.delete(id);
			this.#conversationAnswers.delete(id);
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
