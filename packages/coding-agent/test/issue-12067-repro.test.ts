/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/12067
 *
 * Headless `omp -p` could exit successfully with no output while first-turn
 * mnemopi recall awaited an embedding response. The embeddings subprocess was
 * unref'd while idle, and a pending Promise is not an event-loop handle. Keep
 * the worker referenced for the exact lifetime of each pending request so the
 * caller can receive its result, then unref it again for interactive/daemon
 * shutdown behavior.
 */
import { describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	MnemopiEmbedClient,
	mnemopiEmbedClient,
	type MnemopiEmbedWorkerHandle,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as sharedWorker from "../src/subprocess/shared-worker";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";

class DelayedEmbedWorker implements MnemopiEmbedWorkerHandle {
	readonly firstRequest = Promise.withResolvers<MnemopiEmbedWorkerInbound>();
	readonly secondRequest = Promise.withResolvers<MnemopiEmbedWorkerInbound>();
	refCalls = 0;
	unrefCalls = 0;
	#requestCount = 0;
	#messageHandler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;

	send(message: MnemopiEmbedWorkerInbound): void {
		(this.#requestCount++ === 0 ? this.firstRequest : this.secondRequest).resolve(message);
	}

	onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void {
		this.#messageHandler = handler;
		return () => {
			if (this.#messageHandler === handler) this.#messageHandler = undefined;
		};
	}

	onError(): () => void {
		return () => {};
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emit(message: MnemopiEmbedWorkerOutbound): void {
		this.#messageHandler?.(message);
	}

	async terminate(): Promise<void> {
		this.#messageHandler = undefined;
	}
}

describe("issue #12067 — pending mnemopi requests keep print mode alive", () => {
	it("keeps a shared pending embed alive when a BTW child or another Main session is disposed", async () => {
		using directory = TempDir.createSync("@mnemopi-shared-session-owner-");
		const worker = new DelayedEmbedWorker();
		await mnemopiEmbedClient.terminate();
		const transport = vi.spyOn(sharedWorker, "connectSharedWorker").mockResolvedValue(worker as never);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
			"mnemopi.dbPath": directory.join("other-session.db"),
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
		const common = {
			settings,
			modelRegistry: { resolver: () => async () => "key", getAvailable: () => [model] } as never,
		};
		const main = new AgentSession({
			...common,
			agent: new Agent({ initialState: { model } }),
			sessionManager: SessionManager.inMemory(directory.path()),
		});
		const otherMain = new AgentSession({
			...common,
			agent: new Agent({ initialState: { model } }),
			sessionManager: SessionManager.inMemory(directory.path()),
		});
		const child = main.createEphemeralConversation("Read-only investigation");
		try {
			await Promise.all([loadMnemopi(), loadMnemopiCore()]);
			setMnemopiSessionState(
				otherMain,
				new MnemopiSessionState({
					session: otherMain,
					sessionId: otherMain.sessionId,
					config: loadMnemopiConfig(settings, directory.path()),
				}),
			);
			await child.initializeExtensionRuntime();
			const childSession = child.session;
			if (!childSession) throw new Error("Expected initialized BTW child");
			const loading = mnemopiEmbedClient.load("fast-bge-base-en-v1.5", directory.path());
			const init = await worker.firstRequest.promise;
			expect(init.type).toBe("init");
			worker.emit({ type: "ready", id: init.id });
			expect(await loading).toBeUndefined();
			const embedding = mnemopiEmbedClient.embed(
				"fast-bge-base-en-v1.5",
				directory.path(),
				["Main recall"],
				undefined,
			);
			void embedding.catch(() => {});
			const request = await worker.secondRequest.promise;
			expect(request.type).toBe("embed");
			await child.disposeExtensionRuntime();
			await otherMain.dispose();
			worker.emit({ type: "vectors", id: request.id, vectors: [[0.25, 0.75]] });
			expect(await embedding).toEqual([[0.25, 0.75]]);
			await expect(childSession.disposeForPausedExit()).rejects.toThrow(
				"Only the main agent session can coordinate a paused exit",
			);
		} finally {
			await child.disposeExtensionRuntime();
			await otherMain.dispose();
			await main.dispose();
			await mnemopiEmbedClient.terminate();
			transport.mockRestore();
		}
	});

	it("references the embed worker until first-turn recall receives its result", async () => {
		const worker = new DelayedEmbedWorker();
		const client = new MnemopiEmbedClient(() => worker);

		try {
			const initializing = client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			const init = await worker.firstRequest.promise;

			expect(init.type).toBe("init");
			expect(worker.refCalls).toBe(1);
			expect(worker.unrefCalls).toBe(0);

			worker.emit({ type: "ready", id: init.id });
			const model = await initializing;
			expect(model).not.toBeNull();
			expect(worker.unrefCalls).toBe(1);

			const embedding = (async () => {
				for await (const vectors of model!.embed(["recall query"])) return vectors;
				throw new Error("embedding worker returned no vectors");
			})();
			const embed = await worker.secondRequest.promise;

			expect(embed.type).toBe("embed");
			expect(worker.refCalls).toBe(2);
			expect(worker.unrefCalls).toBe(1);
			worker.emit({ type: "vectors", id: embed.id, vectors: [[0.25, 0.75]] });

			expect(await embedding).toEqual([[0.25, 0.75]]);
			expect(worker.unrefCalls).toBe(2);
		} finally {
			await client.terminate();
		}
	});
});
