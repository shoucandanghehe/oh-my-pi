import { expect, test, vi } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { signal } from "@oh-my-pi/pi-tui";
import { NativeSurfaces, TspConnection } from "@oh-my-pi/pi-tui/native/index";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { FakeTern, ManualClock } from "../../tui/test/native/fake-tern";
import { KeybindingsManager } from "../src/config/keybindings/keybindings";
import { BtwThread } from "../src/session/btw-manager";
import { EphemeralConversation, type EphemeralConversationTurn } from "../src/session/ephemeral-conversation";
import { SessionManager } from "../src/session/session-manager";
import { BtwConversationPane, type BtwPaneDraft } from "../src/ui/overlays/panels/btw-conversation-pane";
import * as clipboard from "../src/utils/clipboard";
import { waitFor } from "./collab/helpers/throttled-host";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { keyEvent } from "./helpers/input-harness";

const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function topic(key: string, cwd: string, turns: readonly EphemeralConversationTurn[] = []): BtwThread {
	const conversation = new EphemeralConversation({
		snapshotBaseMessages: () => [],
		checkpoint: { sideSessionId: key, turns },
		sideSessionId: key,
		sessionManager: SessionManager.inMemory(cwd),
		async createSession() {
			throw new Error("This test only uses the persisted topic transcript");
		},
	});
	conversation.freeze();
	return new BtwThread({
		key,
		title: key,
		createdAt: 0,
		anchorLeafId: "anchor",
		model: { provider: "anthropic", id: "mock" },
		conversation,
	});
}

async function mount(cwd: string, threads: readonly BtwThread[]) {
	const tern = new FakeTern();
	const clock = new ManualClock();
	const connecting = TspConnection.connect(tern, { clock });
	tern.pump();
	const connection = (await connecting)!;
	const revision = signal(0);
	let selected: BtwThread | undefined = threads[0];
	const submitted: { key: string | undefined; draft: BtwPaneDraft; mode: string }[] = [];
	const cancelled: string[] = [];
	const retried: string[] = [];
	const copied: string[] = [];
	const errors: unknown[] = [];
	const pane = new BtwConversationPane({
		cwd,
		rows: () => tern.rows,
		columns: () => tern.columns,
		nativeSupports: kind => (kind === "scroll" ? connection.hasFeature(kind) : connection.supports(kind)),
		keybindings: new KeybindingsManager(),
		revision,
		threads: () => threads,
		selected: () => selected,
		select(key) {
			selected = threads.find(thread => thread.key === key);
			revision.update(n => n + 1);
			pane.syncDraft();
		},
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
		newThread() {},
		cancel: key => void cancelled.push(key),
		retry: key => void retried.push(key),
		dequeue() {},
		editQueued() {},
		delete() {},
		copy() {},
		copyText: async text => void copied.push(text),
		canPromote: () => false,
		promote() {},
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
	return {
		submitted,
		cancelled,
		retried,
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
		act(act: string) {
			const node = [...doc.nodes.values()].find(
				({ p }) => p.actions && typeof p.actions === "object" && Reflect.get(p.actions, "click") === act,
			);
			if (!node) throw new Error(`No native action for ${act}`);
			tern.event({ ev: "action", sf: doc.root, id: node.id, act });
			refresh();
		},
		close() {
			pane.dispose();
			renderer.stop(false);
			connection.close();
			pane.surface.dispose();
		},
	};
}

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
