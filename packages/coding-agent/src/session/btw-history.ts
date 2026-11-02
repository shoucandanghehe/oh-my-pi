import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwLatestTurn,
	getBtwTurns,
} from "@oh-my-pi/pi-tui/overlays/btw-history";
import { acquireFileLock, type FileLockHandle, isEnoent, logger, toError } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import type { BtwTurnCheckpoint } from "./btw-turn";
import { assistantMessageWithReplyText } from "./messages";

export {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwRecordInject,
	getBtwTurns,
	getBtwTurnKey,
} from "@oh-my-pi/pi-tui/overlays/btw-history";

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

interface StoredBtwTurnCheckpoint extends BtwTurnCheckpoint {
	/** Last saved display replies identify user edits without rewriting untouched native turns. */
	answers: string[];
}

function parseRecord(value: unknown): BtwHistoryRecord {
	const result = recordSchema(value);
	if (result instanceof type.errors) throw new Error(`Invalid BTW history record: ${result.summary}`);
	if (!ID_PATTERN.test(result.id)) throw new Error("Invalid BTW history record id");
	return result;
}

/** Capture before yielding, so later streaming mutations cannot change a queued write. */
function snapshotRecord(record: BtwHistoryRecord, recover = false): BtwHistoryRecord {
	const snapshotTurn = (turn: BtwHistoryTurn): BtwHistoryTurn =>
		Object.freeze({ ...turn, status: recover && turn.status === "running" ? "interrupted" : turn.status });
	return Object.freeze({
		...record,
		status: recover && record.status === "running" ? "interrupted" : record.status,
		...(record.followUps ? { followUps: Object.freeze(record.followUps.map(snapshotTurn)) } : {}),
	}) as BtwHistoryRecord;
}

function recordFileName(id: string): string {
	// The prefix prevents Windows device names (CON, NUL, etc.).
	return `entry-${id}.json`;
}

/** Older builds only read `.json` names, so the title sidecar never breaks their history. */
function titleFileName(id: string): string {
	return `entry-${id}.title`;
}

function hash(bytes: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

interface StoredRecord {
	record: BtwHistoryRecord;
	revision: string;
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
	const segment = /^[\w-]+$/.test(scope) ? scope : hash(scope);
	return path.join(root, "sessions", segment);
}

/** The topic on disk is missing or was rewritten since this store read it; retrying the same write can never succeed. */
export class BtwHistoryConflictError extends Error {
	constructor(readonly recordId: string) {
		super(`BTW history conflict for ${recordId}; reopen history before retrying`);
		this.name = "BtwHistoryConflictError";
	}
}

/** CAS, leases, and write queue for lightweight history-panel entries. */
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

	private constructor(directory: string | undefined) {
		this.#directory = directory;
	}

	/** Focused sessions share parent artifacts; scope their lightweight history by session id. */
	static async open(artifactsDir: string | undefined, scope?: string): Promise<BtwHistoryStore> {
		const directory = artifactsDir === undefined ? undefined : historyDirectory(artifactsDir, scope);
		const store = new BtwHistoryStore(directory);
		if (directory === undefined) return store;
		let names: string[];
		try {
			names = await fs.readdir(directory);
		} catch (error) {
			if (isEnoent(error)) return store;
			throw error;
		}
		// Only titled topics have a sidecar; skip the lookup for the rest.
		const titleNames = new Set(names.filter(name => name.endsWith(".title")));
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const stored = await readRecord(path.join(directory, name));
			if (!stored) continue;
			const titleName = titleFileName(stored.record.id);
			const title = titleNames.has(titleName) ? await readTitle(path.join(directory, titleName)) : undefined;
			if (title !== undefined) stored.record = { ...stored.record, title };
			// Recovery is a view. CAS still compares original on-disk bytes.
			store.#records.set(stored.record.id, snapshotRecord(stored.record, true));
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

	/** Retry against the original revision rather than silently rebasing onto disk changes. */
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
		const content = `${JSON.stringify(saved)}\n`;
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
					throw new BtwHistoryConflictError(snapshot.id);
				}
				if (!stored) {
					const titlePath = path.join(this.#directory, titleFileName(snapshot.id));
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
						path.join(this.#directory, `entry-${snapshot.id}.conversation`),
						`${JSON.stringify({ ...checkpoint, answers })}\n`,
					);
				}
				await writeFileAtomically(filePath, content);
				this.#revisions.set(snapshot.id, hash(content));
				this.#conversationAnswers.set(snapshot.id, answers);
			}

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
					throw new Error(`BTW history conflict for ${id}; reopen history before retrying`);
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
