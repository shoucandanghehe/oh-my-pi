import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { type FileLockHandle, isEnoent, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { BtwThreadEvent, RestoredBtwThread } from "./btw-thread";
import { projectBtwConversation } from "./ephemeral-conversation";
import {
	AGENTS_PAUSED_CUSTOM_TYPE,
	createInterruptedToolResults,
	hasRestorableTurn,
	readAgentsPaused,
} from "./exit-diagnostics";
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

	static async open(artifactsDir: string | undefined, cwd: string): Promise<BtwSessionStore> {
		const directory = artifactsDir === undefined ? undefined : path.join(artifactsDir, "btw-history", "threads");
		const store = new BtwSessionStore(cwd, directory);
		if (!directory || !artifactsDir) return store;
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		store.#lease = tryAcquireFileLock(path.join(directory, "workspace")) ?? undefined;
		if (!store.#lease) throw new Error("This BTW workspace is already open in another session");
		try {
			await store.#loadManagers();
			await store.#recoverInterruptedRequests();
			return store;
		} catch (error) {
			await store.close().catch(() => {});
			throw error;
		}
	}

	static async readRecords(artifactsDir: string, cwd: string): Promise<readonly RestoredBtwThread[]> {
		const store = new BtwSessionStore(cwd, path.join(artifactsDir, "btw-history", "threads"));
		try {
			await store.#loadManagers();
			return store.getRecords();
		} finally {
			await store.close();
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
		let metadata: MetadataEvent;
		if (event.op === "create") {
			const { baseMessages: _base, turns: _turns, sideSessionId: _lineage, ...create } = event;
			metadata = create;
		} else if (event.op === "turn") {
			metadata = { version: 1, key: event.key, op: "terminal" };
		} else if (event.op === "request") {
			metadata = event;
		} else if (event.op === "draft") {
			metadata = { ...event, imageLinks: event.imageLinks?.map(link => link ?? null) };
		} else {
			metadata = event;
		}
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
