/** Mount the real BTW pane in headless Tern's private PTY without a workspace daemon or provider. */
import { signal } from "@oh-my-pi/pi-tui";
import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import { encodeHelloQuery, NativeSurfaces, TspConnection } from "@oh-my-pi/pi-tui/native/index";
import { KeybindingsManager } from "../../src/config/keybindings/keybindings";
import { BtwThread } from "../../src/session/btw-manager";
import { EphemeralConversation, type EphemeralConversationTurn } from "../../src/session/ephemeral-conversation";
import { SessionManager } from "../../src/session/session-manager";
import { BtwConversationPane } from "../../src/ui/overlays/panels/btw-conversation-pane";
import { createAssistantMessage } from "./agent-session-setup";

function thread(key: string, title: string, prompt?: string) {
	const turns: EphemeralConversationTurn[] = [];
	if (prompt) {
		const replyText = `${title} saved answer.`;
		turns.push({ input: prompt, timestamp: 1, replyText, assistantMessage: createAssistantMessage(replyText) });
	}
	const conversation = new EphemeralConversation({
		snapshotBaseMessages: () => [],
		checkpoint: { sideSessionId: key, turns },
		sideSessionId: key,
		sessionManager: SessionManager.inMemory(process.cwd()),
		async createSession() {
			throw new Error("This fixture renders saved turns without a provider");
		},
	});
	conversation.freeze();
	return new BtwThread({
		key,
		title,
		createdAt: Date.now(),
		anchorLeafId: "anchor",
		model: { provider: "anthropic", id: "tray-fixture-model" },
		conversation,
	});
}

const driver = createTerminalDriver({ hello: encodeHelloQuery() });
const connecting = TspConnection.connect(driver, { queried: true, timeout: 3000 });
await driver.start();
const connection = await connecting;
if (!connection) throw new Error("The BTW fixture did not negotiate TSP with headless Tern");

const first = thread("geometry", "Geometry thread", "First thread question.");
first.phase = "running";
const threads = [first, thread("notes", "Notes thread", "Second thread question.")];
const selected = signal(first);
const revision = signal(0);
const size = signal({ rows: driver.rows, columns: driver.columns });
driver.onResize((columns, rows) => size.set({ columns, rows }));
function select(key: string) {
	selected.set(threads.find(thread => thread.key === key)!);
	revision.update(n => n + 1);
	pane.syncDraft();
}
const pane = new BtwConversationPane({
	cwd: process.cwd(),
	rows: () => size().rows,
	columns: () => size().columns,
	nativeSupports: name =>
		name === "scroll" || name === "tray" ? connection.hasFeature(name) : connection.supports(name),
	keybindings: KeybindingsManager.inMemory(),
	revision,
	threads: () => threads,
	selected,
	select,
	loadPresentation() {},
	setDraft(key, draft) {
		const current = threads.find(thread => thread.key === key)!;
		current.draft = draft.text;
		current.draftImages = draft.images;
		current.draftImageLinks = draft.imageLinks;
	},
	persistDraft() {},
	newThread() {
		const index = threads.length - 1;
		const created = thread(`new-${index}`, `Created thread ${index}`);
		threads.push(created);
		select(created.key);
	},
	submit: () => false,
	cancel(key) {
		const current = threads.find(thread => thread.key === key)!;
		current.phase = "ready";
		revision.update(n => n + 1);
		void Bun.write("cancelled-thread", key);
	},
	retry() {},
	dequeue() {},
	editQueued() {},
	delete() {},
	copy(key) {
		const answer = threads.find(thread => thread.key === key)?.turns.at(-1)?.replyText;
		if (answer) void Bun.write("clipboard", answer);
	},
	copyText: async answer => {
		await Bun.write("clipboard", answer);
	},
	canPromote: () => false,
	promote() {},
	close() {},
	showError(error) {
		throw error;
	},
	hideThinking: () => false,
	proseOnlyThinking: () => false,
});
// Match the actual native workspace surface role (a separate omp.session terminal).
const renderer = new NativeSurfaces({ ...pane, role: "omp.session", title: "BTW" });
renderer.start(connection);
await Promise.withResolvers<void>().promise;
