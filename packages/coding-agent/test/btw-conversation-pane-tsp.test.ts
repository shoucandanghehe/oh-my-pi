import { expect, test, vi } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { signal } from "@oh-my-pi/pi-tui";
import { NativeSurfaces, TspConnection } from "@oh-my-pi/pi-tui/native/index";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { FakeTern, ManualClock } from "../../tui/test/native/fake-tern";
import { KeybindingsManager } from "../src/config/keybindings/keybindings";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { BtwThread } from "../src/session/btw-manager";
import { EphemeralConversation, type EphemeralConversationTurn } from "../src/session/ephemeral-conversation";
import { SessionManager } from "../src/session/session-manager";
import {
	BtwConversationPane,
	type BtwPaneDraft,
	type BtwQueueEdit,
} from "../src/ui/overlays/panels/btw-conversation-pane";
import * as clipboard from "../src/utils/clipboard";
import { waitFor } from "./collab/helpers/throttled-host";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { keyEvent } from "./helpers/input-harness";

const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function topic(
	key: string,
	cwd: string,
	turns: readonly EphemeralConversationTurn[] = [],
	{
		title = key,
		createdAt = 0,
		baseMessages = [],
		createSession = async () => {
			throw new Error("This test only uses the persisted topic transcript");
		},
	}: {
		title?: string;
		createdAt?: number;
		baseMessages?: readonly AssistantMessage[];
		createSession?: (manager: SessionManager) => Promise<{ session: AgentSession }>;
	} = {},
): BtwThread {
	const conversation = new EphemeralConversation({
		snapshotBaseMessages: () => baseMessages,
		checkpoint: { sideSessionId: key, turns },
		sideSessionId: key,
		sessionManager: SessionManager.inMemory(cwd),
		createSession,
	});
	conversation.freeze();
	return new BtwThread({
		key,
		title,
		createdAt,
		anchorLeafId: "anchor",
		model: { provider: "anthropic", id: "mock" },
		conversation,
	});
}

const BASE_FEATURES = ["blobs", "settle", "adopt", "scroll"] as const;

async function mount(cwd: string, initialThreads: readonly BtwThread[], tray = false) {
	const tern = new FakeTern({ features: tray ? [...BASE_FEATURES, "tray"] : BASE_FEATURES });
	const threads = [...initialThreads];
	const clock = new ManualClock();
	const connecting = TspConnection.connect(tern, { clock });
	tern.pump();
	const connection = (await connecting)!;
	const revision = signal(0);
	let selected: BtwThread | undefined = threads[0];
	const submitted: { key: string | undefined; draft: BtwPaneDraft; mode: string }[] = [];
	const cancelled: string[] = [];
	const retried: string[] = [];
	const edited: { key: string; edit: BtwQueueEdit }[] = [];
	const copied: string[] = [];
	const copiedThreads: string[] = [];
	const deleted: string[] = [];
	const promoted: string[] = [];
	const errors: unknown[] = [];
	function select(key: string) {
		selected = threads.find(thread => thread.key === key);
		revision.update(n => n + 1);
		pane.syncDraft();
	}
	const pane = new BtwConversationPane({
		cwd,
		writeRaw: data => tern.writeRaw(data),
		rows: () => tern.rows,
		columns: () => tern.columns,
		nativeSupports: kind =>
			kind === "scroll" || kind === "tray" ? connection.hasFeature(kind) : connection.supports(kind),
		keybindings: new KeybindingsManager(),
		revision,
		threads: () => threads,
		selected: () => selected,
		select,
		loadPresentation() {},
		setDraft(key, draft) {
			const thread = threads.find(thread => thread.key === key)!;
			thread.draft = draft.text;
			thread.draftImages = draft.images;
			thread.draftImageLinks = draft.imageLinks;
		},
		persistDraft() {},
		submit(key, draft, mode) {
			submitted.push({ key, draft, mode });
			return true;
		},
		newThread() {
			const key = `new-${threads.length + 1}`;
			threads.push(topic(key, cwd));
			select(key);
		},
		cancel: key => void cancelled.push(key),
		retry: key => void retried.push(key),
		dequeue() {},
		editQueued: (key, edit) => void edited.push({ key, edit }),
		delete: key => void deleted.push(key),
		copy: key => void copiedThreads.push(key),
		copyText: async text => void copied.push(text),
		canPromote: key => key !== "failed",
		promote: key => void promoted.push(key),
		close() {},
		showError: error => void errors.push(error),
		hideThinking: () => false,
		proseOnlyThinking: () => false,
	});
	const renderer = new NativeSurfaces(pane);
	renderer.start(connection);
	const doc = [...tern.docs.values()][0]!;
	function refresh(): void {
		tern.pump();
		clock.advance(0);
		tern.pump();
	}
	const textMime = Buffer.from("text/plain").toString("base64");
	const actNode = (id: string) => {
		const action = doc.nodes.get(id)?.p.actions;
		if (!action || typeof action !== "object" || !("click" in action) || typeof action.click !== "string")
			throw new Error(`No native click action for ${id}`);
		tern.event({ ev: "action", sf: doc.root, id, act: action.click });
		refresh();
	};
	const oscPaste = (status: string, attrs = "", payload = "") => {
		tern.input({ type: "osc", raw: `\x1b]5522;type=read:status=${status}${attrs}${payload}\x07` });
		refresh();
	};
	function close() {
		pane.dispose();
		renderer.stop(false);
		connection.close();
		pane.surface.dispose();
	}
	return {
		submitted,
		cancelled,
		retried,
		edited,
		selected: () => selected?.key,
		copiedThreads,
		deleted,
		promoted,
		setTray(enabled: boolean) {
			tern.event({ ev: "features", features: enabled ? [...BASE_FEATURES, "tray"] : BASE_FEATURES });
			refresh();
		},
		sendAction(id: string, act: string, value?: string) {
			tern.event({ ev: "action", sf: doc.root, id, act, value });
			refresh();
		},
		approve: pane.approve.bind(pane),
		update() {
			revision.update(n => n + 1);
			pane.syncDraft();
			refresh();
		},
		actNode,
		copied,
		errors,
		doc,
		tern,
		refresh,
		draft: () => doc.nodes.get(doc.focus!)?.p.text,
		key(id: string) {
			tern.input({ type: "key", key: keyEvent(id) });
			refresh();
		},
		paste(text: string) {
			tern.input({ type: "paste", paste: { text } });
			refresh();
		},
		announcePaste() {
			oscPaste("OK");
			oscPaste("DATA", `:mime=${textMime}`);
			oscPaste("DONE");
		},
		finishPaste(id: number, text: string) {
			oscPaste("DATA", `:id=paste-${id}:mime=${textMime}`, `;${Buffer.from(text).toString("base64")}`);
			oscPaste("DONE", `:id=paste-${id}`);
		},
		act(act: string) {
			const node = [...doc.nodes.values()].find(
				({ p }) => p.actions && typeof p.actions === "object" && Reflect.get(p.actions, "click") === act,
			);
			if (!node) throw new Error(`No native action for ${act}`);
			tern.event({ ev: "action", sf: doc.root, id: node.id, act });
			refresh();
		},
		close,
		[Symbol.dispose]: close,
	};
}

test("enhanced paste returns to the originating BTW draft after switching topics", async () => {
	const a = topic("a", process.cwd());
	const b = topic("b", process.cwd());
	const ui = await mount(process.cwd(), [a, b]);
	try {
		ui.paste("left right");
		for (const _ of "right") ui.key("left");
		ui.announcePaste();
		ui.act("threads");
		const picker = [...ui.doc.nodes.values()].find(node => node.k === "picker")!;
		ui.tern.event({ ev: "activate", sf: ui.doc.root, id: picker.id, item: "b" });
		ui.refresh();
		ui.paste("B draft");
		ui.finishPaste(1, "pasted ");
		expect(ui.draft()).toBe("B draft");
		expect(a.draft).toBe("left pasted right");
	} finally {
		ui.close();
	}
});

test("the native BTW thread picker searches titles and exposes state and drafts", async () => {
	const a = topic("alpha", process.cwd());
	const b = topic("beta", process.cwd());
	b.phase = "error";
	b.draft = "Saved question";
	using ui = await mount(process.cwd(), [a, b]);
	ui.act("threads");
	const picker = () => [...ui.doc.nodes.values()].find(node => node.k === "picker")!;
	expect(picker().p.items).toContainEqual({ id: "beta", label: "beta", detail: "Error · Draft" });
	for (const key of "beta") ui.key(key);
	expect(picker().p.query).toBe("beta");
	expect(picker().p.order).toEqual(["beta"]);
	ui.key("enter");
	expect(ui.draft()).toBe("Saved question");
});

test("closing a BTW pane keeps saved attachments without text or a visible chip", async () => {
	using temp = TempDir.createSync("@pi-btw-close-draft-");
	const first = topic("image only", temp.path());
	const image = { type: "image", mimeType: "image/png", data: PIXEL_PNG } as const;
	first.draftImages = [image];
	const second = topic("link only", temp.path());
	second.draftImageLinks = ["saved-screenshot.png"];
	const ui = await mount(temp.path(), [first, second]);
	try {
		ui.key("tab");
		expect(ui.selected()).toBe("link only");
	} finally {
		ui.close();
	}
	expect(first.draftImages).toEqual([image]);
	expect(second.draftImageLinks).toEqual(["saved-screenshot.png"]);
});

test("Tern Ctrl+Enter edits the BTW draft; clear and scroll stay in that pane", async () => {
	const current = topic("current", process.cwd());
	const ui = await mount(process.cwd(), [current]);
	try {
		ui.paste("first");
		ui.key("ctrl+enter");
		ui.paste("second");
		expect(ui.submitted).toEqual([]);
		expect(ui.draft()).toBe("first\nsecond");
		ui.key("alt+shift+c");
		ui.key("alt+shift+l");
		expect(ui.copied).toEqual(["first\nsecond", "second"]);
		current.phase = "running";
		ui.announcePaste();
		ui.key("ctrl+c");
		expect(ui.cancelled).toEqual(["current"]);
		ui.finishPaste(1, "stale");
		expect(ui.draft()).toBe("first\nsecond");
		ui.announcePaste();
		ui.finishPaste(2, " fresh");
		expect(ui.draft()).toBe("first\nsecond fresh");
		current.phase = "ready";
		ui.key("ctrl+c");
		expect(ui.draft()).toBe("");
		const transcript = [...ui.doc.nodes.values()].find(node => node.p.role === "omp.btw.transcript")!;
		ui.key("pageUp");
		ui.key("home");
		expect(ui.doc.scrolls).toEqual([
			[transcript.id, "page-up"],
			[transcript.id, "start"],
		]);
		ui.tern.event({ ev: "features", features: [] });
		ui.refresh();
		ui.key("end");
		expect(ui.doc.scrolls).toHaveLength(2);
		expect(JSON.stringify(ui.doc.shape("dock"))).toContain("does not support keyboard transcript scrolling");
	} finally {
		ui.close();
	}
});

test("BTW submits a topic-relative image paste before later typing and Enter", async () => {
	using temp = TempDir.createSync("@pi-btw-pane-");
	const main = temp.path();
	const side = temp.join("side");
	const image = path.join(side, "source.png");
	await Bun.write(image, Buffer.from(PIXEL_PNG, "base64"));
	const ui = await mount(main, [topic("current", side)]);
	try {
		ui.paste("source.png");
		ui.key("x");
		ui.key("enter");
		await waitFor(() => ui.submitted.length !== 0, "BTW never submitted after loading the image");
		expect(ui.errors).toEqual([]);
		expect(ui.submitted).toEqual([
			{
				key: "current",
				mode: "steer",
				draft: {
					text: "[Image #1] x",
					images: [expect.objectContaining({ type: "image", mimeType: "image/png", data: PIXEL_PNG })],
					imageLinks: [image],
				},
			},
		]);
	} finally {
		ui.close();
	}
});

test("BTW pastes the original Finder images, falling back to the clipboard when none can be attached", async () => {
	using temp = TempDir.createSync("@pi-btw-finder-");
	const first = temp.join("first.png");
	const second = temp.join("second shot.png");
	for (const file of [first, second]) await Bun.write(file, Buffer.from(PIXEL_PNG, "base64"));
	const missing = temp.join("missing.png");
	const icon = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
		"base64",
	);
	const image = { data: icon, mimeType: "image/png" };
	using _blobs = vi.spyOn(dirs, "getBlobsDir").mockReturnValue(temp.join("blobs"));
	using _local = vi.spyOn(clipboard, "isClipboardTerminalLocal").mockReturnValue(true);
	using _clipboard = vi
		.spyOn(clipboard, "readClipboardContent")
		.mockResolvedValueOnce({
			image,
			text: "icon caption",
			fileUrls: [missing, first, url.pathToFileURL(second).href],
		})
		.mockResolvedValueOnce({ image, text: "", fileUrls: [missing] })
		.mockResolvedValueOnce({ image: null, text: "clipboard text", fileUrls: [temp.join("notes.txt")] });
	const ui = await mount(temp.path(), [topic("current", temp.path())]);
	try {
		for (let i = 0; i < 3; i++) {
			ui.key("ctrl+v");
			ui.key("enter");
			await waitFor(() => ui.submitted.length === i + 1, "BTW did not submit the clipboard paste");
		}
		expect(ui.submitted[0]?.draft.imageLinks).toEqual([first, second]);
		expect(ui.submitted[0]?.draft.images?.map(item => item.data)).toEqual([PIXEL_PNG, PIXEL_PNG]);
		expect(ui.submitted[0]?.draft.text.trimEnd()).toBe("[Image #1] [Image #2]");
		expect(ui.submitted[1]?.draft.images?.map(item => item.data)).toEqual([icon.toBase64()]);
		expect(ui.submitted[2]?.draft.text).toBe("clipboard text");
	} finally {
		ui.close();
	}
});

test("BTW transcript copies individual prompts, answers and errors and retries the selected topic", async () => {
	using temp = TempDir.createSync("@pi-btw-pane-links-");
	const main = temp.join("main");
	const side = temp.join("side");
	const note = path.join(side, "note.md");
	await Bun.write(path.join(main, "note.md"), "not this file");
	await Bun.write(note, "selected topic file");
	const answer = "Open [this file](./note.md).";
	const failure = "Provider temporarily unavailable";
	const thread = topic("topic", side, [
		{ input: "A first question", timestamp: 1, replyText: answer, assistantMessage: createAssistantMessage(answer) },
		{
			input: "A second question",
			timestamp: 2,
			replyText: "",
			assistantMessage: { ...createAssistantMessage(""), stopReason: "error", errorMessage: failure },
		},
	]);
	thread.phase = "error";
	thread.error = failure;
	const ui = await mount(main, [thread]);
	try {
		await waitFor(() => {
			ui.refresh();
			return JSON.stringify(ui.doc.shape("main")).includes(url.pathToFileURL(note).pathname);
		}, "BTW did not resolve the relative link against the selected topic's cwd");
		ui.act("copy-message");
		ui.act("copy-answer");
		ui.act("copy-error");
		ui.act("retry");
		ui.key("f5");
		expect(ui.copied).toEqual(["A first question", answer, failure]);
		expect(ui.retried).toEqual(["topic", "topic"]);
	} finally {
		ui.close();
	}
});

function* visibleNodes(node: TspNode): Generator<TspNode> {
	if (node.p?.hidden) return;
	yield node;
	for (const child of node.c ?? []) yield* visibleNodes(child);
}

function textValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return (value as readonly { t?: string }[]).map(span => span.t ?? "").join("");
	return undefined;
}

function visibleText(root: TspNode): string[] {
	return [...visibleNodes(root)].flatMap(({ p }) =>
		p ? ["text", "spans", "label", "detail"].flatMap(key => textValue(Reflect.get(p, key)) ?? []) : [],
	);
}

function findNode(root: TspNode, predicate: (node: TspNode) => boolean, description: string): TspNode {
	const node = [...visibleNodes(root)].find(predicate);
	if (!node) throw new Error(`Missing ${description} in the native BTW document`);
	return node;
}

function withRole(root: TspNode, role: string, description: string): TspNode {
	return findNode(root, node => node.p?.role === role, description);
}

function withLabel(root: TspNode, label: string): TspNode {
	return findNode(
		root,
		node => node.p?.actions?.click !== undefined && visibleText(node).includes(label),
		`${JSON.stringify(label)} click target`,
	);
}

function threadTray(dock: TspNode): TspNode {
	return withRole(dock, "omp.tray", "BTW thread tray");
}

function trayCards(dock: TspNode): Extract<TspNode, { k: "col" }>[] {
	return [...visibleNodes(threadTray(dock))].filter(
		(node): node is Extract<TspNode, { k: "col" }> => node.k === "col" && node.p?.role === "omp.tray.card",
	);
}

function question(input: string, replyText: string, timestamp: number): EphemeralConversationTurn {
	return { input, timestamp, replyText, assistantMessage: createAssistantMessage(replyText) };
}

function threadFixtures(cwd: string) {
	const today = new Date();
	today.setHours(14, 2, 0, 0);
	const running = topic("running", cwd, [question("Earlier question", "Earlier answer", 1)], {
		title: "Why no auto-retry",
		createdAt: today.valueOf(),
	});
	running.phase = "running";
	running.request = {
		input: "Question currently being answered",
		messages: [],
		streamMessage: undefined,
		timestamp: Date.now() - 42_000,
		admission: Promise.withResolvers<void>(),
		settled: Promise.withResolvers<void>(),
	};
	const done = topic(
		"done",
		cwd,
		[question("Older question", "First answer", 1), question("Latest saved question", "Latest answer", 2)],
		{
			title: "复盘分支",
			createdAt: new Date(2001, 10, 23, 6, 7).valueOf(),
		},
	);
	const draft = topic("draft", cwd, [], { title: "Release notes" });
	draft.draft = "Saved private draft";
	const failed = topic("failed", cwd, [], { title: "Provider error" });
	failed.phase = "error";
	failed.error = "Provider failed";
	return { running, done, draft, failed, empty: topic("empty", cwd, [], { title: "Untitled BTW" }) };
}

test("native BTW tray renders one direct-open card per thread with its status, question and unread count", async () => {
	const cwd = process.cwd();
	const { running, done, draft, failed, empty } = threadFixtures(cwd);
	using ui = await mount(cwd, [running, done, draft, failed, empty], true);
	const cards = trayCards(ui.doc.tree("dock"));
	expect(cards.map(card => [card.p?.ref, card.p?.status, card.p?.look])).toEqual([
		["running", "running", false],
		["done", "done", false],
		["draft", "queued", false],
		["failed", "failed", false],
		["empty", "queued", false],
	]);
	for (const [index, name] of [
		"Why no auto-retry",
		"复盘分支",
		"Release notes",
		"Provider error",
		"Untitled BTW",
	].entries())
		expect(visibleText(withRole(cards[index]!, "omp.tray.name", "thread card name"))).toContain(name);
	for (const [index, line] of ["Question currently being answered", "Latest saved question", "Draft"].entries())
		expect(visibleText(withRole(cards[index]!, "omp.tray.doing", "second card line"))).toContain(line);
	expect(visibleText(cards[0]!)).not.toContain("Earlier question");
	expect(visibleText(cards[1]!)).not.toContain("Older question");
	expect(visibleText(cards[2]!)).not.toContain("Saved private draft");
	expect(visibleText(withRole(cards[1]!, "omp.tray.unread", "completed thread's unread badge"))).toContain("2");
	for (const card of [cards[2]!, cards[3]!, cards[4]!])
		expect([...visibleNodes(card)].some(node => node.p?.role === "omp.tray.unread")).toBe(false);
	const elapsed = findNode(cards[0]!, node => node.k === "elapsed", "running thread's request clock");
	if (elapsed.k !== "elapsed") throw new Error("Expected an elapsed node");
	expect(elapsed.p?.age).toBeGreaterThanOrEqual(42_000);
	expect(elapsed.p?.age).toBeLessThan(60_000);
	for (const card of [cards[2]!, cards[4]!])
		expect([...visibleNodes(card)].some(node => node.k === "elapsed")).toBe(false);
});

test("native BTW keeps an all-idle tray visible and gives cards their frozen-context tooltip", async () => {
	const cwd = process.cwd();
	const { done, draft } = threadFixtures(cwd);
	const today = new Date();
	today.setHours(14, 2, 0, 0);
	const current = topic("today", cwd, [question("Question today", "Answer today", 1)], {
		title: "A full title long enough to be truncated on the card",
		createdAt: today.valueOf(),
	});
	using ui = await mount(cwd, [current, done, draft], true);
	const dock = ui.doc.tree("dock");
	const tray = threadTray(dock);
	expect(tray.k === "col" && tray.p?.quiet).not.toBe(true);
	const cards = trayCards(dock);
	expect(cards.map(card => card.p?.ref)).toEqual(["today", "done", "draft"]);
	expect(cards.every(card => card.p?.item !== "done")).toBe(true);
	const hover = (card: TspNode) => [card.p?.title, JSON.stringify(card.p?.hovercard)].filter(Boolean).join(" ");
	const currentHover = hover(cards[0]!);
	expect(currentHover).toContain(current.title);
	expect(currentHover).toMatch(/(?:ready|done|idle|complete)/i);
	expect(currentHover).toMatch(/Sees Main up to 14:02(?!\d)/);
	const olderHover = hover(cards[1]!);
	expect(olderHover).toContain("复盘分支");
	expect(olderHover).toMatch(/Sees Main up to.*06:07/);
	expect(olderHover).toMatch(/(?:11[-/.]23|23[-/.]11|Nov(?:ember)?\.?\s+23|23\s+Nov(?:ember)?\.?)/i);
	expect(hover(cards[2]!)).toMatch(/Release notes.*Draft|Draft.*Release notes/);
});

test("native BTW card metadata uses its own model, tokens and cost, not frozen Main usage", async () => {
	using temp = TempDir.createSync("@pi-btw-tray-usage-");
	await using live = await liveTopic(temp.path(), true);
	const unloaded = topic("unloaded", temp.path());
	using ui = await mount(temp.path(), [live.thread, unloaded], true);
	const [known, unknown] = trayCards(ui.doc.tree("dock"));
	const meta = visibleText(withRole(known!, "omp.tray.meta", "known card metadata")).join(" ");
	expect(meta).toContain("BTW fixture model");
	expect(meta).toMatch(/\b300\s*tok/);
	expect(meta).not.toMatch(/\b(?:9,?000|9(?:\.0+)?[kK])\s*tok|\$99\b/);
	expect(meta).toMatch(/\$0\.12[5-9]?|\$0\.13/);
	const unknownText = visibleText(unknown!).join(" ");
	expect(unknownText).not.toMatch(/\b0\s*tok|\$0/);
});

test("tray.open switches the BTW draft and moves the Current badge to exactly one card", async () => {
	const cwd = process.cwd();
	const { done, draft } = threadFixtures(cwd);
	using ui = await mount(cwd, [done, draft], true);
	const currentRefs = () =>
		trayCards(ui.doc.tree("dock"))
			.filter(card =>
				[...visibleNodes(withRole(card, "omp.tray.head", "card header"))].some(
					node => node.k === "badge" && node.p?.text === "Current",
				),
			)
			.map(card => card.p?.ref);
	expect(currentRefs()).toEqual(["done"]);
	ui.sendAction(threadTray(ui.doc.tree("dock")).id, "tray.open", "draft");
	expect(ui.draft()).toBe("Saved private draft");
	expect(ui.selected()).toBe("draft");
	expect(currentRefs()).toEqual(["draft"]);
});

test("native BTW card menus offer applicable actions and target the right-clicked thread", async () => {
	const cwd = process.cwd();
	const { running, done, failed } = threadFixtures(cwd);
	using ui = await mount(cwd, [done, running, failed], true);
	const [finishedCard, replyingCard, errorCard] = trayCards(ui.doc.tree("dock"));
	function menu(card: TspNode) {
		return new Map(
			(card.p?.actions?.menu ?? []).flatMap(item =>
				typeof item !== "string" && "id" in item ? [[item.label, item.id] as const] : [],
			),
		);
	}
	expect([...menu(finishedCard!).keys()].sort()).toEqual(["Copy answer", "Delete thread", "Promote"]);
	expect([...menu(replyingCard!).keys()].sort()).toEqual(["Copy answer", "Delete thread", "Promote", "Stop"]);
	expect([...menu(errorCard!).keys()].sort()).toEqual(["Delete thread"]);
	for (const [card, label] of [
		[replyingCard!, "Stop"],
		[replyingCard!, "Copy answer"],
		[replyingCard!, "Promote"],
		[errorCard!, "Delete thread"],
	] as const) {
		const action = menu(card).get(label)!;
		expect(action).toStartWith("btw.");
		ui.sendAction(card.id, action);
	}
	expect(ui.cancelled).toEqual(["running"]);
	expect(ui.copiedThreads).toEqual(["running"]);
	expect(ui.promoted).toEqual(["running"]);
	expect(ui.deleted).toEqual(["failed"]);
});

test("the + beside the model in the native BTW composer creates a thread without a separate row", async () => {
	const cwd = process.cwd();
	using ui = await mount(cwd, [topic("existing", cwd)], true);
	const bar = withRole(composer(ui.doc.tree("dock")), "omp.composer.bar", "composer bar");
	const model = withRole(bar, "omp.composer.model", "model chip");
	const add = withLabel(bar, "+");
	expect(add.p?.actions?.click).toStartWith("btw.");
	const controls = [...visibleNodes(bar)].map(node => node.id);
	expect(controls.indexOf(add.id)).toBeGreaterThan(controls.indexOf(model.id));
	ui.actNode(add.id);
	expect(ui.selected()).toBe("new-2");
	expect(trayCards(ui.doc.tree("dock")).map(card => card.p?.ref)).toEqual(["existing", "new-2"]);
});

test("with no BTW threads, the tray is absent but the composer + creates the first thread", async () => {
	using ui = await mount(process.cwd(), [], true);
	const dock = ui.doc.tree("dock");
	expect([...visibleNodes(dock)].some(node => node.p?.role === "omp.tray")).toBe(false);
	const bar = withRole(composer(dock), "omp.composer.bar", "composer bar");
	ui.actNode(withLabel(bar, "+").id);
	expect(ui.selected()).toBe("new-1");
	expect(trayCards(ui.doc.tree("dock")).map(card => card.p?.ref)).toEqual(["new-1"]);
});

test("live Tern feature changes swap the BTW tray for the working legacy thread picker and back", async () => {
	const cwd = process.cwd();
	const { done, draft } = threadFixtures(cwd);
	using ui = await mount(cwd, [done, draft], true);
	const dock = () => ui.doc.tree("dock");
	const legacy = () =>
		visibleText(dock()).filter(text => ["Threads", "New", "Close", "BTW · 复盘分支"].includes(text));
	expect(legacy()).toEqual([]);
	threadTray(dock());
	ui.setTray(false);
	expect(legacy()).toEqual(expect.arrayContaining(["Threads", "New", "Close", "BTW · 复盘分支"]));
	expect([...visibleNodes(dock())].some(node => node.p?.role === "omp.tray")).toBe(false);
	ui.actNode(withLabel(dock(), "Threads").id);
	const picker = findNode(ui.doc.tree("layer"), node => node.k === "picker", "legacy thread picker");
	ui.tern.event({ ev: "activate", sf: ui.doc.root, id: picker.id, item: "draft" });
	ui.refresh();
	expect(ui.draft()).toBe("Saved private draft");
	ui.setTray(true);
	expect(legacy()).toEqual([]);
	expect(trayCards(dock()).map(card => card.p?.ref)).toEqual(["done", "draft"]);
});

async function liveTopic(cwd: string, withFrozenMainUsage = false) {
	const auth = createInMemoryAuthStorage();
	const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"));
	const model = registry.find("anthropic", "claude-sonnet-4-5")!;
	const assistant = createAssistantMessage("One answer with accounted usage.");
	const inherited = createAssistantMessage("An answer from Main's frozen context.");
	const thread = topic(
		"live",
		cwd,
		[
			{
				input: "Question with accounted usage",
				timestamp: 1,
				replyText: "One answer with accounted usage.",
				assistantMessage: {
					...assistant,
					usage: {
						...assistant.usage,
						input: 300,
						totalTokens: 300,
						cost: { ...assistant.usage.cost, input: 0.125, total: 0.125 },
					},
				},
			},
		],
		{
			baseMessages: withFrozenMainUsage
				? [
						{
							...inherited,
							usage: {
								...inherited.usage,
								input: 9000,
								totalTokens: 9000,
								cost: { ...inherited.usage.cost, input: 99, total: 99 },
							},
						},
					]
				: undefined,
			createSession: async sessionManager => ({
				session: new AgentSession({
					agent: new Agent({
						initialState: {
							model: { ...model, name: "BTW fixture model", contextWindow: 1200 },
							thinkingLevel: ThinkingLevel.High,
						},
					}),
					sessionManager,
					settings: Settings.isolated(),
					modelRegistry: registry,
				}),
			}),
		},
	);
	try {
		await thread.conversation.initializeExtensionRuntime();
		const session = thread.conversation.session!;
		session.setThinkingLevel(ThinkingLevel.High);
		return {
			thread,
			session,
			async [Symbol.asyncDispose]() {
				try {
					await thread.conversation.disposeExtensionRuntime();
				} finally {
					auth.close();
				}
			},
		};
	} catch (error) {
		auth.close();
		throw error;
	}
}

function composer(root: TspNode): TspNode {
	return findNode(root, node => node.k === "col" && node.p?.role?.startsWith("omp.editor") === true, "composer frame");
}

test("the Tern BTW composer prompts for a side question and keeps its model, effort, context and cost inside", async () => {
	using temp = TempDir.createSync("@pi-btw-composer-");
	await using live = await liveTopic(temp.path());
	using ui = await mount(temp.path(), [live.thread], true);
	const frame = composer(ui.doc.tree(ui.doc.root));
	const editor = [...visibleNodes(frame)].find(node => node.k === "editor");
	expect(visibleText(withRole(frame, "omp.composer.model", "composer model"))).toContain("BTW fixture model");
	expect(visibleText(withRole(frame, "omp.composer.effort", "composer effort"))).toContain("high");
	expect(visibleText(withRole(frame, "omp.composer.context", "composer context"))).toContain("25%");
	expect(visibleText(withRole(frame, "omp.composer.usage", "composer cost")).join(" ")).toMatch(
		/\$0\.12[5-9]?|\$0\.13/,
	);
	expect(textValue(editor?.p?.placeholder)).toBe("Ask a side question…");
});

test("the Tern BTW fallback composer uses the side-question placeholder without Read-only", async () => {
	using ui = await mount(process.cwd(), [topic("fallback", process.cwd())]);
	const dock = ui.doc.tree("dock");
	withLabel(dock, "Threads");
	const frame = composer(dock);
	expect(visibleText(frame)).not.toContain("Read-only");
	const editor = [...visibleNodes(frame)].find(node => node.k === "editor");
	expect(textValue(editor?.p?.placeholder)).toBe("Ask a side question…");
});

test("while replying, Stop replaces Send in the BTW composer and cancels the selected thread", async () => {
	const idle = topic("idle", process.cwd());
	const replying = topic("replying", process.cwd());
	using ui = await mount(process.cwd(), [idle, replying]);
	const currentComposer = () => composer(ui.doc.tree(ui.doc.root));
	withRole(currentComposer(), "omp.composer.send", "idle Send control");
	ui.key("tab");
	replying.phase = "running";
	ui.update();
	const active = currentComposer();
	const stop = withRole(active, "omp.composer.stop", "replying Stop control in place of Send");
	expect(visibleText(stop)).toContain("Stop");
	expect([...visibleNodes(active)].some(node => node.p?.role === "omp.composer.send")).toBe(false);
	ui.actNode(stop.id);
	expect(ui.cancelled).toEqual(["replying"]);
	expect(ui.submitted).toEqual([]);
});

test("BTW keeps its queue above the tray, and denying summary approval restores the editable queued row", async () => {
	using temp = TempDir.createSync("@pi-btw-approval-");
	await using live = await liveTopic(temp.path());
	live.session.agent.followUp({ role: "user", content: "A queued follow-up", timestamp: 2 });
	using ui = await mount(temp.path(), [live.thread], true);
	ui.paste("keep this draft");
	const root = () => ui.doc.tree(ui.doc.root);
	const queue = () => withRole(root(), "omp.btw.queue", "queued follow-up row");
	expect(visibleText(queue())).toContain("After yield · A queued follow-up");
	const dock = ui.doc.tree("dock");
	const order = [...visibleNodes(dock)].map(node => node.id);
	expect(order.indexOf(queue().id)).toBeLessThan(order.indexOf(threadTray(dock).id));
	const approved = ui.approve(live.thread.title, "Exact draft summary for Main");
	await Promise.resolve();
	ui.refresh();
	const card = withRole(root(), "omp.btw.summary-approval", "summary approval card");
	expect(visibleText(card)).toContain("Send to Main from BTW · live?");
	expect(visibleText(root())).toContain("Exact draft summary for Main");
	withLabel(card, "Send");
	ui.actNode(withLabel(card, "Deny").id);
	expect(await approved).toBe(false);
	expect(ui.draft()).toBe("keep this draft");
	ui.actNode(withLabel(queue(), "Edit").id);
	expect(ui.edited).toEqual([
		{ key: "live", edit: expect.objectContaining({ kind: "followUp", text: "A queued follow-up" }) },
	]);
});
