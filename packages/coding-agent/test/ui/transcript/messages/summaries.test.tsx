/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, expect, test } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { getKeybindings, KeybindingsManager, setKeybindings } from "../../../../src/config/keybindings/keybindings";
import { Settings } from "../../../../src/config/settings";
import { messageFace } from "../../../../src/modes/interactive/messages";
import { createBtwSummaryMessage } from "../../../../src/session/messages";
import { setKeyHintPlatform } from "../../../../src/ui/keys/format";
import { Shell } from "../../../../src/ui/shell/index";
import {
	BranchSummaryBlock,
	type CompactionSummary,
	CompactionSummaryBlock,
	HandoffSummaryBlock,
} from "../../../../src/ui/transcript/messages/summaries";
import { nativeShell } from "../../../helpers/native-shell";
import { screenSuite, single } from "./harness";

let originalBindings: KeybindingsManager | undefined;
afterEach(() => {
	if (originalBindings) setKeybindings(originalBindings);
	originalBindings = undefined;
	setKeyHintPlatform(undefined);
});

test("a summary divider shows the rebound expand key in the painter's preset", () => {
	originalBindings = getKeybindings();
	setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+x" }));
	setKeyHintPlatform("darwin");
	const node = single(<BranchSummaryBlock summary="Changes on the branch" expanded={false} />);
	for (const symbolPreset of ["ascii", "nerd"] as const) {
		const theme = loadThemeSync("dark", { symbolPreset });
		const rows = paintNode(staticEnvironment(theme), node, 80).rows.map(stripEscapes);
		const key = symbolPreset === "ascii" ? "Option+X" : `${theme.symbols.symbol("key.altMac")} X`;
		expect(rows.find(row => row.includes("branch"))).toContain(`${theme.symbols.symbol("sep.dot").trim()} ${key}`);
	}
});

test("Main displays BTW sources as separate cards without exposing the model message", async () => {
	await Settings.init({ inMemory: true });
	const shell = new Shell();
	const message = createBtwSummaryMessage([
		{ threadKey: "private-one", threadTitle: "\x1b[31mCache\x1b[0m &\tlatency\n", summary: "Keep `a < b` intact." },
		{ threadKey: "private-two", threadTitle: "Approval <review>", summary: "**Wait** for approval." },
	]);
	const face = messageFace(message, {
		expanded: () => true,
		activityVisible: () => true,
		advisorCollapsedLines: () => 0,
		renderer: () => () => undefined,
		onRenderError: () => {},
		imageLinks: () => undefined,
		skillPath: () => undefined,
		actions: () => false,
		hour12: () => undefined,
		promptZones: () => false,
		magicKeywords: () => [],
		onUserAction: () => {},
	})!;
	await using ui = await nativeShell(shell);
	shell.dock.slot("btw").set(face.face);
	const cards = ui.children(ui.surface().dock[0]!);
	expect(cards.map(node => node.p.head)).toEqual([
		[{ t: "From BTW · Cache & latency", s: "customMessageLabel strong" }],
		[{ t: "From BTW · Approval <review>", s: "customMessageLabel strong" }],
	]);
	expect(cards.map(node => ui.children(node)[0]?.p.text)).toEqual([
		"Keep `a < b` intact.",
		"**Wait** for approval.",
	]);
	const rendered = JSON.stringify(ui.tree(ui.surface().dock[0]!.id));
	expect(rendered).not.toMatch(/<btw-summary|private-one|private-two/);
	expect(message.content).toContain('thread-key="private-one"');
});

function toggled(expanded: { set(value: boolean): void }, label: string): void {
	if (label === "expanded") expanded.set(true);
	else if (label === "collapsed") expanded.set(false);
	else throw new Error(`unknown stage ${label}`);
}

screenSuite("compaction-summary", corpusCase => {
	const inputs = corpusCase.inputs as { message: CompactionSummary };
	const expanded = signal(false);
	return {
		node: single(<CompactionSummaryBlock message={inputs.message} expanded={expanded} />),
		apply: label => toggled(expanded, label),
	};
});

screenSuite("handoff-summary", corpusCase => {
	// The capture created the block expanded (its `display` flag).
	const inputs = corpusCase.inputs as {
		message: { content: string | { type: string; text?: string }[] };
		display: boolean;
	};
	const expanded = signal(inputs.display);
	return {
		node: single(<HandoffSummaryBlock content={inputs.message.content} expanded={expanded} />),
		apply: label => toggled(expanded, label),
	};
});

screenSuite("branch-summary", corpusCase => {
	const inputs = corpusCase.inputs as { message: { summary: string } };
	const expanded = signal(false);
	return {
		node: single(<BranchSummaryBlock summary={inputs.message.summary} expanded={expanded} />),
		apply: label => toggled(expanded, label),
	};
});
