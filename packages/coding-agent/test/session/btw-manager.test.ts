import { expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BtwManager } from "@oh-my-pi/pi-coding-agent/session/btw-manager";
import { BtwSessionStore } from "@oh-my-pi/pi-coding-agent/session/btw-session-store";
import { projectBtwMessages } from "@oh-my-pi/pi-coding-agent/session/ephemeral-conversation";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function userText(message: Message): string | undefined {
	if (message.role !== "user") return undefined;
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

it("reopens two independent child journals with their own drafts, frozen snapshots, and provider lineages", async () => {
	using temp = TempDir.createSync("@pi-btw-manager-");
	const cwd = temp.path();
	const auth = createInMemoryAuthStorage();
	const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"));
	auth.keys.setRuntime("anthropic", "test-key");
	const mock = createMockModel({ handler: context => ({ content: [`reply:${userText(context.messages.at(-1)!)}`] }) });
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected test model");
	const main = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Main instructions"] }, promptCacheKey: "main-cache" }),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: registry,
		sideStreamFn: mock.stream,
	});
	const modelRef = { provider: model.provider, id: model.id };
	let keySequence = 0;
	let manager: BtwManager | undefined;
	async function openWorkspace(): Promise<BtwManager> {
		const store = await BtwSessionStore.open(cwd, cwd);
		return new BtwManager({
			restoredThreads: store.getRecords(),
			appendEvent: event => store.appendEvent(event),
			flushEvents: () => store.flush(),
			closeEvents: () => store.close(),
			removeSession: key => store.removeSession(key),
			createConversation: (_ref, checkpoint, options) =>
				main.createEphemeralConversation("Side topic", checkpoint, model, options),
			createSideOptions: key => ({
				sessionManager: store.getSessionManager(key),
				onSessionClosed: closed => store.adoptClosedSession(key, closed),
			}),
			nextKey: () => `topic-${++keySequence}`,
			now: () => keySequence,
		});
	}
	try {
		manager = await openWorkspace();
		const initial = { role: "user", content: "Main snapshot one", timestamp: 1 } as const;
		main.agent.replaceMessages([initial, createAssistantMessage("Main response")]);
		const first = manager.createChild("first question", "main-anchor-1", modelRef, "First");
		const secondMain = { role: "user", content: "Main snapshot two", timestamp: 3 } as const;
		main.agent.replaceMessages([initial, createAssistantMessage("Main response"), secondMain]);
		const second = manager.createChild("another question", "main-anchor-2", modelRef, "Second");
		const mainMessages = structuredClone(main.messages);
		await manager.prompt(first, "first question");
		await manager.prompt(second, "another question");
		manager.setDraft(first, "draft for first");
		manager.setDraft(second, "draft for second");
		manager.markRead(first);
		await manager.dispose();
		manager = await openWorkspace();
		expect(manager.children.map(thread => [thread.title, thread.draft, thread.unread])).toEqual([
			["First", "draft for first", 0],
			["Second", "draft for second", 1],
		]);
		const child = await manager.session(first);
		expect(child).not.toBe(main);
		await manager.prompt(first, "follow-up question");
		expect(manager.thread(first)?.turns.map(turn => turn.replyText)).toEqual([
			"reply:first question",
			"reply:follow-up question",
		]);
		expect(manager.thread(second)?.draft).toBe("draft for second");
		expect(
			projectBtwMessages(child.sessionManager, child)
				.filter(message => message.role === "user")
				.map(userText),
		).toEqual(["first question", "follow-up question"]);
		expect(main.messages).toEqual(mainMessages);
		const [call1, call2, followUp] = mock.calls;
		expect(call1?.options?.sessionId).not.toBe(call2?.options?.sessionId);
		expect(followUp?.options?.sessionId).toBe(call1?.options?.sessionId);
		expect(followUp?.options?.parentSessionId).toBe(main.sessionId);
		expect(followUp?.options?.promptCacheKey).toBe("main-cache");
		const followUpUsers = followUp?.context.messages.flatMap(message => userText(message) ?? []);
		expect(followUpUsers).toContain("Main snapshot one");
		expect(followUpUsers).not.toContain("Main snapshot two");
		expect(followUpUsers).not.toContain("another question");
		await manager.remove(second, "deleted");
		const empty = manager.createChild("", "main-anchor-2", modelRef);
		const imageOnly = manager.createChild("", "main-anchor-2", modelRef);
		const image = { type: "image", mimeType: "image/png", data: "eA==" } as const;
		manager.setDraft(imageOnly, "", [image]);
		const linkOnly = manager.createChild("", "main-anchor-2", modelRef);
		manager.setDraft(linkOnly, "", [], ["screenshot.png"]);
		const cancelled = manager.createChild("", "main-anchor-2", modelRef);
		const prompt = manager.prompt(cancelled, "cancel before admission");
		const abort = manager.abort(cancelled);
		await expect(prompt).rejects.toThrow();
		await abort;
		expect(manager.thread(cancelled)?.turns).toHaveLength(0);
		await manager.dispose();
		manager = await openWorkspace();
		expect(manager.thread(cancelled)?.phase).toBe("ready");
		await manager.removeEmptyThreads(() => false);
		expect(manager.thread(empty)).toBeUndefined();
		await manager.dispose();
		manager = undefined;
		const persisted = await BtwSessionStore.readRecords(cwd, cwd);
		expect(persisted.map(thread => thread.key)).toEqual([first, imageOnly, linkOnly, cancelled]);
		expect(persisted.find(thread => thread.key === imageOnly)?.draftImages).toEqual([image]);
		expect(persisted.find(thread => thread.key === linkOnly)?.draftImageLinks).toEqual(["screenshot.png"]);
	} finally {
		await manager?.dispose();
		await main.dispose();
		auth.close();
	}
});

it("leaves legacy BTW history intact until a manual migration", async () => {
	using temp = TempDir.createSync("@pi-btw-legacy-migration-");
	const cwd = temp.path();
	const legacyPath = path.join(cwd, "btw-history", "entry-first.json");
	const input = JSON.stringify({
		version: 1,
		id: "first",
		title: "Old topic",
		createdAt: 1,
		anchorLeafId: "anchor",
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		sideSessionId: "old-side",
		baseMessages: [],
		turns: [
			{
				input: "Old question",
				timestamp: 2,
				replyText: "Old answer",
				assistantMessage: createAssistantMessage("Old answer"),
			},
		],
		draft: "Keep my draft",
		draftImages: [],
		draftImageLinks: [],
		readThrough: 1,
		phase: "ready",
	});
	await Bun.write(legacyPath, input);
	expect(await BtwSessionStore.readRecords(cwd, cwd)).toEqual([]);
	const store = await BtwSessionStore.open(cwd, cwd);
	try {
		expect(store.getRecords()).toEqual([]);
	} finally {
		await store.close();
	}
	const journals = Array.from(new Bun.Glob("*.jsonl").scanSync(path.join(cwd, "btw-history", "threads")));
	expect(journals).toEqual([]);
	expect(await Bun.file(legacyPath).text()).toBe(input);
});
