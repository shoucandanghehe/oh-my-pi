import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { type FileLockHandle, isEnoent, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { writeFileAtomically } from "../utils/atomic-file";
import { readLegacyBtwThreadSidecars } from "./btw-history";
import {
	type BtwThreadEvent,
	type LegacyRestoredBtwThread,
	type RestoredBtwThread,
	restoreLegacyBtwJournal,
} from "./btw-thread";
import { projectBtwConversation, seedBtwConversation } from "./ephemeral-conversation";
import {
	AGENTS_PAUSED_CUSTOM_TYPE,
	createInterruptedToolResults,
	hasRestorableTurn,
	readAgentsPaused,
} from "./exit-diagnostics";
import type { SessionEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

const BTW_THREAD_METADATA = "btw:thread";
const imageSchema = type({ type: "'image'", data: "string", mimeType: "string" });
const eventBase = { version: "1", key: "string" } as const;
const eventSchema = type({
	...eventBase,
	op: "'create'",
	title: "string",
	"titleExplicit?": "boolean | undefined",
	createdAt: "number",
	anchorLeafId: "string",
	model: { provider: "string", id: "string" },
})
	.or({ ...eventBase, op: "'title'", title: "string" })
	.or({
		...eventBase,
		op: "'draft'",
		text: "string",
		"images?": imageSchema.array().or("undefined"),
		"imageLinks?": type("string | null").array().or("undefined"),
	})
	.or({ ...eventBase, op: "'read'", through: "number" })
	.or({
		...eventBase,
		op: "'request'",
		"input?": "string | undefined",
		"images?": imageSchema.array().or("undefined"),
		"timestamp?": "number | undefined",
	})
	.or({ ...eventBase, op: "'terminal'", "error?": "string | undefined" })
	.or({ ...eventBase, op: "'remove'", reason: "'deleted' | 'promoted'" });

type MetadataEvent = typeof eventSchema.infer;
type CreateEvent = Extract<MetadataEvent, { op: "create" }>;

interface ThreadMetadata {
	create: CreateEvent;
	title: string;
	draft: string;
	draftImages: RestoredBtwThread["draftImages"];
	draftImageLinks: RestoredBtwThread["draftImageLinks"];
	readThrough: number;
	error: string | undefined;
	request: (Extract<MetadataEvent, { op: "request" }> & { entryId: string }) | undefined;
	removed: boolean;
}

function threadMetadata(manager: SessionManager): ThreadMetadata | undefined {
	let metadata: ThreadMetadata | undefined;
	for (const entry of manager.getEntries()) {
		if (entry.type === "reset_boundary" && metadata) {
			metadata.request = undefined;
			metadata.error = undefined;
		}
		if (entry.type !== "custom" || entry.customType !== BTW_THREAD_METADATA) continue;
		const event = eventSchema(entry.data);
		if (event instanceof type.errors) throw new Error(`Invalid BTW session metadata: ${event.summary}`);
		if (event.op === "create") {
			if (metadata) {
				metadata.create = event;
				metadata.title = event.title;
				metadata.removed = false;
				continue;
			}
			metadata = {
				create: event,
				title: event.title,
				draft: "",
				draftImages: [],
				draftImageLinks: [],
				readThrough: 0,
				error: undefined,
				request: undefined,
				removed: false,
			};
			continue;
		}
		if (!metadata) throw new Error("BTW session metadata has no creation entry");
		switch (event.op) {
			case "title":
				metadata.title = event.title;
				break;
			case "draft":
				metadata.draft = event.text;
				metadata.draftImages = event.images ?? [];
				metadata.draftImageLinks = event.imageLinks?.map(link => link ?? undefined) ?? [];
				break;
			case "read":
				metadata.readThrough = event.through;
				break;
			case "request":
				metadata.request = { ...event, entryId: entry.id };
				metadata.error = undefined;
				break;
			case "terminal":
				metadata.request = undefined;
				metadata.error = event.error;
				break;
			case "remove":
				metadata.removed = true;
				break;
		}
	}
	return metadata;
}

/** Standard session journals own BTW history; these events only record thread presentation and membership. */
export class BtwSessionStore {
	readonly #managers = new Map<string, SessionManager>();
	readonly #cwd: string;
	readonly #directory: string | undefined;
	#lease: FileLockHandle | undefined;
	#pending = Promise.resolve();

	constructor(cwd: string, directory?: string) {
		this.#cwd = cwd;
		this.#directory = directory;
	}

	static async open(
		artifactsDir: string | undefined,
		cwd: string,
		legacyEntries: readonly SessionEntry[] = [],
	): Promise<BtwSessionStore> {
		const directory = artifactsDir === undefined ? undefined : path.join(artifactsDir, "btw-history", "threads");
		const store = new BtwSessionStore(cwd, directory);
		if (!directory || !artifactsDir) {
			await store.#importLegacyThreads(undefined, legacyEntries);
			return store;
		}
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		store.#lease = tryAcquireFileLock(path.join(directory, "workspace")) ?? undefined;
		if (!store.#lease) throw new Error("This BTW workspace is already open in another session");
		try {
			await store.#loadManagers();
			await store.#importLegacyThreads(artifactsDir, legacyEntries);
			await store.#recoverInterruptedRequests();
			return store;
		} catch (error) {
			await store.close().catch(() => {});
			throw error;
		}
	}

	static async readRecords(
		artifactsDir: string,
		cwd: string,
		legacyEntries: readonly SessionEntry[] = [],
	): Promise<readonly RestoredBtwThread[]> {
		const store = new BtwSessionStore(cwd, path.join(artifactsDir, "btw-history", "threads"));
		try {
			await store.#loadManagers();
			const legacy = await store.#legacyCandidates(artifactsDir, legacyEntries);
			return [...store.getRecords(), ...legacy.filter(thread => !store.#managers.has(thread.key))].sort(
				(left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key),
			);
		} finally {
			await store.close();
		}
	}

	#legacyReceipt(key: string): string | undefined {
		if (this.#directory) {
			const digest = new Bun.CryptoHasher("sha256").update(key).digest("hex");
			return path.join(this.#directory, `import-${digest}`);
		}
	}

	async #legacyCandidates(
		artifactsDir: string | undefined,
		entries: readonly SessionEntry[],
	): Promise<LegacyRestoredBtwThread[]> {
		// Older builds could migrate out of Main without deleting its original journal events.
		const migrated =
			artifactsDir && (await Bun.file(path.join(artifactsDir, "btw-history", ".migrated-v1")).exists());
		const legacy = new Map((migrated ? [] : restoreLegacyBtwJournal(entries)).map(thread => [thread.key, thread]));
		if (artifactsDir) {
			for (const thread of await readLegacyBtwThreadSidecars(artifactsDir)) legacy.set(thread.key, thread);
		}
		const candidates: LegacyRestoredBtwThread[] = [];
		for (const [key, thread] of legacy) {
			const receipt = this.#legacyReceipt(key);
			if (!receipt || !(await Bun.file(receipt).exists())) candidates.push(thread);
		}
		return candidates;
	}

	async #importLegacyThreads(artifactsDir: string | undefined, entries: readonly SessionEntry[]): Promise<void> {
		for (const thread of await this.#legacyCandidates(artifactsDir, entries)) {
			const { key } = thread;
			if (!this.#managers.has(key)) {
				const manager = this.getSessionManager(key);
				seedBtwConversation(manager, {
					baseMessages: thread.baseMessages,
					turns: thread.turns,
					trailingMessages: thread.trailingMessages,
					sideSessionId: thread.sideSessionId,
				});
				this.appendEvent({
					version: 1,
					key,
					op: "create",
					title: thread.title,
					titleExplicit: thread.titleExplicit,
					createdAt: thread.createdAt,
					anchorLeafId: thread.anchorLeafId,
					model: thread.model,
				});
				this.appendEvent({
					version: 1,
					key,
					op: "draft",
					text: thread.draft,
					images: thread.draftImages,
					imageLinks: thread.draftImageLinks,
				});
				this.appendEvent({ version: 1, key, op: "read", through: thread.readThrough });
				if (thread.error) this.appendEvent({ version: 1, key, op: "terminal", error: thread.error });
				if (thread.pausedRequest) {
					const { input, images, timestamp } = thread.pausedRequest;
					this.appendEvent({ version: 1, key, op: "request", input, images, timestamp });
					manager.appendCustomEntry(AGENTS_PAUSED_CUSTOM_TYPE, {
						pausedAt: new Date(timestamp).toISOString(),
						agentIds: [MAIN_AGENT_ID],
						pendingPrompt: { text: input, images, attribution: "agent" },
					});
				}
				await this.#pending;
				await manager.flush();
			}
			// Leave old history intact without resurrecting deleted or promoted topics.
			const receipt = this.#legacyReceipt(key);
			if (receipt) await writeFileAtomically(receipt, key);
		}
	}

	async #loadManagers(): Promise<void> {
		if (!this.#directory) return;
		let names: string[];
		try {
			names = await fs.readdir(this.#directory);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const manager = await SessionManager.open(path.join(this.#directory, name), this.#directory, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			const metadata = threadMetadata(manager);
			if (!metadata) {
				await manager.close();
				continue;
			}
			const key = metadata.create.key;
			if (this.#managers.has(key)) {
				await manager.close();
				throw new Error(`Duplicate BTW session: ${key}`);
			}
			this.#managers.set(key, manager);
		}
	}

	async #recoverInterruptedRequests(): Promise<void> {
		for (const [key, manager] of this.#managers) {
			const metadata = threadMetadata(manager);
			const request = metadata?.request;
			const branch = manager.getBranch();
			if (!request || metadata?.removed || readAgentsPaused(branch)) continue;
			const requestIndex = branch.findIndex(entry => entry.id === request.entryId);
			if (requestIndex < 0) continue;
			const recorded = branch
				.slice(requestIndex + 1)
				.some(entry => entry.type === "message" && entry.message.role === "user");
			if (!recorded && request.input === undefined) continue;
			const last = manager.buildSessionContext().messages.at(-1);
			if (
				recorded &&
				!hasRestorableTurn(branch) &&
				!(last?.role === "assistant" && last.stopDetails?.type === "pause_turn")
			) {
				this.appendEvent({
					version: 1,
					key,
					op: "terminal",
					error: last?.role === "assistant" ? last.errorMessage : undefined,
				});
			} else {
				for (const result of createInterruptedToolResults(branch)) manager.appendMessage(result);
				manager.appendCustomEntry(AGENTS_PAUSED_CUSTOM_TYPE, {
					pausedAt: new Date().toISOString(),
					agentIds: [MAIN_AGENT_ID],
					...(!recorded
						? {
								pendingPrompt: { text: request.input, images: request.images, attribution: "agent" },
							}
						: {}),
				});
			}
			await manager.flush();
		}
	}

	getSessionManager(key: string): SessionManager {
		let manager = this.#managers.get(key);
		if (manager) return manager;
		manager = this.#directory
			? SessionManager.create(this.#cwd, this.#directory, undefined, { suppressBreadcrumb: true })
			: SessionManager.inMemory(this.#cwd);
		this.#managers.set(key, manager);
		return manager;
	}

	getRecords(): readonly RestoredBtwThread[] {
		const records: RestoredBtwThread[] = [];
		for (const [key, manager] of this.#managers) {
			const metadata = threadMetadata(manager);
			if (!metadata || metadata.removed) continue;
			const checkpoint = projectBtwConversation(manager);
			const error =
				metadata.error ??
				(metadata.request && !readAgentsPaused(manager.getBranch())
					? "Reply interrupted before completion"
					: undefined);
			records.push({
				key,
				title: metadata.title,
				titleExplicit: metadata.create.titleExplicit,
				createdAt: metadata.create.createdAt,
				anchorLeafId: metadata.create.anchorLeafId,
				model: metadata.create.model,
				...checkpoint,
				draft: metadata.draft,
				draftImages: metadata.draftImages,
				draftImageLinks: metadata.draftImageLinks,
				readThrough: Math.min(metadata.readThrough, checkpoint.turns.length),
				phase: error ? "error" : "ready",
				error,
			});
		}
		return records.sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
	}

	appendEvent(event: BtwThreadEvent): void {
		// A failed physical deletion must leave the thread discoverable.
		if (event.op === "remove" && event.reason === "deleted") return;
		const manager = this.getSessionManager(event.key);
		const metadata: MetadataEvent =
			event.op === "draft" ? { ...event, imageLinks: event.imageLinks?.map(link => link ?? null) } : event;
		manager.appendCustomEntry(BTW_THREAD_METADATA, metadata);
		if (event.op === "create") {
			this.#pending = this.#pending.then(() => manager.ensureOnDisk());
			void this.#pending.catch(() => {});
		}
	}

	async flush(): Promise<void> {
		await this.#pending;
		await Promise.all([...this.#managers.values()].map(manager => manager.flush()));
	}

	async close(): Promise<void> {
		try {
			await this.#pending;
		} finally {
			try {
				await Promise.all([...this.#managers.values()].map(manager => manager.close()));
			} finally {
				this.#lease?.release();
				this.#lease = undefined;
			}
		}
	}

	async removeSession(key: string): Promise<void> {
		await this.#pending;
		const manager = this.#managers.get(key);
		if (!manager) return;
		const file = manager.getSessionFile();
		if (file) await manager.dropSession(file);
		this.#managers.delete(key);
	}

	adoptClosedSession(key: string, manager: SessionManager): void {
		if (this.#managers.get(key) === manager) this.#managers.set(key, manager.cloneCurrentSession());
	}
}
