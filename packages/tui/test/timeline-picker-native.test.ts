import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TspKind, TspPickerProps, TspProps } from "@oh-my-pi/pi-wire";
import type { SessionMessageEntryLike } from "../src/chat/transcript-entry";
import { span, text } from "../src/native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { TUI } from "../src/index";
import { CopySelectorComponent } from "../src/overlays/copy-selector";
import { type BranchVariantPath, RewindSelectorComponent } from "../src/overlays/rewind-selector";
import { TreeSelectorComponent, type TreeSelectorNode } from "../src/overlays/tree-selector";
import { initTheme } from "../src/theme";

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const genericCx: DescribeContext = { ...pickerCx, supports: (kind: TspKind) => kind !== "picker" };
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

beforeAll(async () => {
	await initTheme(false);
});

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntryLike {
	return { type: "message", id, parentId, timestamp: "2026-09-28T09:05:00", message } as SessionMessageEntryLike;
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;

function assistant(content: unknown[]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "demo",
		model: "demo",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
	} as unknown as AgentMessage;
}

const toolResult = (callId: string, text: string) =>
	({
		role: "toolResult",
		toolCallId: callId,
		toolName: "grep",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	}) as unknown as AgentMessage;

/** u1 → a1 (grep call) → t1 → a2 (prose with a code block) → u2. */
function transcript(): SessionMessageEntryLike[] {
	return [
		entry("u1", null, user("find the ack")),
		entry("a1", "u1", assistant([{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "ack" } }])),
		entry("t1", "a1", toolResult("c1", "src/frame.rs:12: ack")),
		entry("a2", "t1", assistant([{ type: "text", text: "Found it:\n\n```rust\nfn ack() {}\n```" }])),
		entry("u2", "a2", user("thanks")),
	];
}

function props(root: NativeNode): TspPickerProps {
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

const typeText = (component: { handleInput(data: string): void }, text: string) => {
	for (const ch of text) component.handleInput(ch);
};

describe("rewind page", () => {
	const selectors: RewindSelectorComponent[] = [];
	beforeEach(() => setNativeRendering(true));
	afterEach(() => {
		for (const selector of selectors) selector.dispose();
		selectors.length = 0;
		setNativeRendering(false);
	});

	function rewind(deps: { selected?: string[]; cancelled?: { count: number }; siblings?: BranchVariantPath[] } = {}) {
		const selector = new RewindSelectorComponent(transcript(), {
			ui,
			cwd: "/tmp",
			requestRender: () => {},
			siblingPaths: id => (id === "u2" ? (deps.siblings ?? []) : []),
			onSelect: id => deps.selected?.push(id),
			onCancel: () => {
				if (deps.cancelled) deps.cancelled.count++;
			},
		});
		selectors.push(selector);
		return selector;
	}

	const UP = "\x1b[A";
	const RIGHT = "\x1b[C";

	/** One entry per page child: a caption's key, a node's role, else the block's mark (`-` unmarked); runs of equal marks collapse. */
	function marks(children: readonly NativeChild[]): string[] {
		const out: string[] = [];
		for (const child of children) {
			const entry =
				"k" in child
					? child.p?.role === "omp.rewind.here"
						? (child.key ?? "here")
						: (child.p?.role ?? child.k)
					: (child.describe?.(pickerCx)?.p?.mark ?? "-");
			if (out.at(-1) !== entry) out.push(entry);
		}
		return out;
	}

	function captionText(children: readonly NativeChild[]): string {
		const caption = children.find(child => "k" in child && child.p?.role === "omp.rewind.here");
		return JSON.stringify(caption);
	}

	function pageText(children: readonly NativeChild[]): string {
		return children
			.map(child => {
				const described = "k" in child ? child : child.describe?.(pickerCx);
				return described ? `${JSON.stringify(described.p)}\n${pageText(described.c ?? [])}` : "";
			})
			.join("\n");
	}

	test("opens on the newest turn: the transcript as blocks, the turn picked under its caption", () => {
		const page = rewind().describeScreen(pickerCx);
		expect(page.role).toBe("omp.rewind");
		expect(marks(page.main)).toEqual(["-", "here:main:u2", "pick"]);
		expect(captionText(page.main)).toContain("nothing below to drop");
		expect(pageText(page.main)).toContain("find the ack");
		expect(pageText(page.main)).toContain("thanks");
		expect(page.dock).toHaveLength(1);
		expect(JSON.stringify((page.dock[0] as RewindSelectorComponent).describe(pickerCx))).toContain("4/4");
	});

	test("stepping up moves the pick and drops everything below it", () => {
		const selector = rewind();
		for (let i = 0; i < 3; i++) selector.handleInput(UP);
		const { main } = selector.describeScreen(pickerCx);
		expect(marks(main)).toEqual(["here:main:u1", "pick", "drop"]);
		const caption = main.find(child => "k" in child && child.p?.role === "omp.rewind.here");
		expect(caption && "k" in caption ? caption.reveal : undefined).toBe("start");
		// A user turn rewinds past itself: its prompt returns to the editor.
		expect(captionText(main)).toContain("the prompt returns to the editor");
		expect(captionText(main)).toContain("3 turns below dropped");
	});

	test("Enter and the bar's Rewind button rewind to the outlined turn; Cancel closes", () => {
		const selected: string[] = [];
		const cancelled = { count: 0 };
		const selector = rewind({ selected, cancelled });
		selector.handleInput(UP);
		selector.handleInput(UP);
		selector.handleInput("\r");
		// The tool result folds into its call's turn: rewinding there keeps the output.
		expect(selected).toEqual(["t1"]);
		selector.handleInput(UP);
		selector.handleNativeEvent({ type: "action", key: "rewind", act: "rewind", mods: [] });
		expect(selected).toEqual(["t1", "u1"]);
		selector.handleNativeEvent({ type: "action", key: "cancel", act: "cancel", mods: [] });
		expect(cancelled.count).toBe(1);
	});

	test("filtering shows only matching turns; Cancel leaves the filter before closing", () => {
		const cancelled = { count: 0 };
		const selector = rewind({ cancelled });
		selector.handleInput("f");
		// Under TSP the filter matches turn text, not rendered rows.
		typeText(selector, "thanks");
		expect(marks(selector.describeScreen(pickerCx).main)).toEqual(["here:main:u2", "pick"]);
		typeText(selector, "zzz");
		expect(marks(selector.describeScreen(pickerCx).main)).toEqual(["omp.rewind.empty"]);
		selector.handleNativeEvent({ type: "action", key: "cancel", act: "cancel", mods: [] });
		expect(cancelled.count).toBe(0);
		expect(marks(selector.describeScreen(pickerCx).main)).toEqual(["-", "here:main:u2", "pick"]);
		selector.handleNativeEvent({ type: "action", key: "cancel", act: "cancel", mods: [] });
		expect(cancelled.count).toBe(1);
	});

	test("at a fork the branches sit side by side and Right moves the pick into the next one", () => {
		const selected: string[] = [];
		const siblings: BranchVariantPath[] = [
			{
				rootId: "u3",
				entries: [
					entry("u3", "a2", user("never mind")),
					entry("a3", "u3", assistant([{ type: "text", text: "ok" }])),
				],
			},
		];
		const selector = rewind({ selected, siblings });
		let { main } = selector.describeScreen(pickerCx);
		const strip = main.at(-1);
		if (!strip || !("k" in strip) || strip.p?.role !== "omp.rewind.strip")
			throw new Error("expected the branch strip last");
		const [current, other] = (strip.c ?? []) as NativeNode[];
		expect([current?.p?.tone, other?.p?.tone]).toEqual(["accent", undefined]);
		expect(marks(current?.c ?? [])).toEqual(["omp.rewind.branch.head", "here:main:u2", "pick"]);
		expect(marks(other?.c ?? [])).toEqual(["omp.rewind.branch.head", "-"]);

		selector.handleInput(RIGHT);
		main = selector.describeScreen(pickerCx).main;
		const [, next] = ((main.at(-1) as NativeNode).c ?? []) as NativeNode[];
		expect(next?.p?.tone).toBe("accent");
		expect(marks(next?.c ?? [])).toEqual(["omp.rewind.branch.head", "here:u3:u3", "pick", "drop"]);
		selector.handleInput("\r");
		expect(selected).toEqual(["u3"]);
		selector.handleInput("\x1b[B");
		const [, moved] = ((selector.describeScreen(pickerCx).main.at(-1) as NativeNode).c ?? []) as NativeNode[];
		expect(captionText(moved?.c ?? [])).toContain("here:u3:a3");
		selector.describeScreen(pickerCx);
		selector.describe(pickerCx);
		selector.handleNativeEvent({ type: "action", key: "rewind", act: "rewind", mods: [] });
		selector.handleInput("\x1b[D");
		selector.describeScreen(pickerCx);
		selector.handleInput("\r");
		expect(selected).toEqual(["u3", "a3", "u2"]);
		selector.dispose();
	});

	test("describing and invalidating the page never changes the folded rewind point", () => {
		const selected: string[] = [];
		const selector = rewind({ selected });
		try {
			selector.handleInput(UP);
			selector.handleInput(UP);
			const first = selector.describeScreen(pickerCx).main;
			expect(marks(first)).toEqual(["-", "here:main:a1", "pick", "drop"]);
			const picked = first.filter(child => !("k" in child) && child.describe?.(pickerCx)?.p?.mark === "pick");
			selector.invalidate();
			const second = selector.describeScreen(pickerCx).main;
			const pickedAgain = second.filter(child => !("k" in child) && child.describe?.(pickerCx)?.p?.mark === "pick");
			expect(pickedAgain).toHaveLength(picked.length);
			for (let index = 0; index < picked.length; index++) expect(pickedAgain[index]).toBe(picked[index]);
			selector.describe(pickerCx);
			selector.handleInput("\r");
			expect(selected).toEqual(["t1"]);
		} finally {
			selector.dispose();
		}
	});

	test("editing inside the filter preserves its caret and only rewinds matching turns", () => {
		const selected: string[] = [];
		const selector = rewind({ selected });
		const inputProps = () => {
			const bar = selector.describe(pickerCx);
			const input = bar.c?.find(child => !("k" in child));
			if (!input || "k" in input) throw new Error("expected the docked filter Input");
			const described = input.describe?.(pickerCx);
			if (described?.k !== "input") throw new Error("expected a described filter Input");
			return described.p;
		};
		try {
			selector.handleInput("f");
			typeText(selector, "ack");
			selector.handleInput("\x01");
			typeText(selector, "find ");
			expect([inputProps()?.text, inputProps()?.cursor]).toEqual(["find ack", 5]);
			expect(marks(selector.describeScreen(pickerCx).main)).toEqual(["here:main:u1", "pick"]);
			selector.handleInput("\x02");
			expect(inputProps()?.cursor).toBe(4);
			selector.handleInput("\x7f");
			expect([inputProps()?.text, inputProps()?.cursor]).toEqual(["fin ack", 3]);
			expect(marks(selector.describeScreen(pickerCx).main)).toEqual(["omp.rewind.empty"]);
			selector.handleInput("\r");
			selector.handleNativeEvent({ type: "action", key: "rewind", act: "rewind", mods: [] });
			expect(selected).toEqual([]);
			selector.handleInput("d");
			selector.handleInput("\r");
			expect(selected).toEqual(["u1"]);
		} finally {
			selector.dispose();
		}
	});

	test("stepping above the native tail broadens the page without changing the rewind point", () => {
		const selected: string[] = [];
		const selector = new RewindSelectorComponent(
			Array.from({ length: 640 }, (_, index) =>
				entry(`u${index}`, index ? `u${index - 1}` : null, user(`prompt ${index}`)),
			),
			{ ui, cwd: "/tmp", requestRender() {}, onSelect: id => selected.push(id), onCancel() {} },
		);
		try {
			const tail = selector.describeScreen(pickerCx).main;
			expect(marks(tail)).toEqual(["omp.rewind.earlier", "-", "here:main:u639", "pick"]);
			expect(tail).toHaveLength(602);
			for (let index = 0; index < 600; index++) selector.handleInput(UP);
			expect(marks(selector.describeScreen(pickerCx).main)).toEqual(["-", "here:main:u39", "pick", "drop"]);
			selector.handleInput("\r");
			expect(selected).toEqual(["u39"]);
		} finally {
			selector.dispose();
		}
	});

	test("native pages replay only the recent chunks; Earlier and raw search reach old turns without ANSI", () => {
		let constructed = 0;
		let rendered = 0;
		let measured = 0;
		const entries = Array.from({ length: 800 }, (_, index) => [
			entry(`u${index}`, index ? `c${index - 1}` : null, user(`prompt ${index}`)),
			entry(`c${index}`, `u${index}`, {
				role: "custom",
				customType: "native-history",
				content: index === 0 ? "ancient needle" : `answer ${index}`,
				display: true,
				timestamp: index,
			} as AgentMessage),
		]).flat();
		const selected: string[] = [];
		const create = () =>
			new RewindSelectorComponent(entries, {
				ui,
				cwd: "/tmp",
				requestRender() {},
				getMessageRenderer: () => () => {
					constructed++;
					return {
						render: () => {
							rendered++;
							return ["not the raw text"];
						},
						measureRows: () => {
							measured++;
							return 1;
						},
						describe: () => text([span("native custom answer")]),
					};
				},
				onSelect: id => selected.push(id),
				onCancel() {},
			});
		const selector = create();
		try {
			expect(marks(selector.describeScreen(pickerCx).main)).toEqual([
				"omp.rewind.earlier",
				"-",
				"here:main:c799",
				"pick",
			]);
			expect(pageText(selector.describeScreen(pickerCx).main)).toContain("native custom answer");
			expect(constructed).toBeGreaterThan(0);
			expect(constructed).toBeLessThan(400);
			selector.handleInput(UP);
			selector.handleInput("a");
			expect(marks(selector.describeScreen(pickerCx).main)).toEqual(["-", "here:main:u799", "pick", "drop"]);
			expect(constructed).toBe(800);
			selector.handleInput("\r");
			expect(selected).toEqual(["u799"]);
		} finally {
			selector.dispose();
		}
		const searched = create();
		try {
			searched.describeScreen(pickerCx);
			searched.handleInput("f");
			typeText(searched, "needle");
			expect(marks(searched.describeScreen(pickerCx).main)).toEqual(["here:main:c0", "pick"]);
			expect(pageText(searched.describeScreen(pickerCx).main)).toContain("native custom answer");
			searched.handleInput("\r");
			searched.handleInput("\x1b");
			searched.handleInput("\x1b[B");
			expect(captionText(searched.describeScreen(pickerCx).main)).toContain("here:main:u1");
			searched.handleInput("\r");
			expect(selected).toEqual(["u799", "c0", "u1"]);
			expect([rendered, measured]).toEqual([0, 0]);
		} finally {
			searched.dispose();
		}
	});
});

describe("copy picker", () => {
	function copy(picks: string[]) {
		return new CopySelectorComponent(transcript(), {
			ui,
			cwd: "/tmp",
			requestRender: () => {},
			onPick: (content, label) => picks.push(`${label}:${content}`),
			onCancel: () => {},
		});
	}

	test("the preview stacks the whole message and its blocks; Blocks focuses the first", () => {
		const selector = copy([]);
		selector.handleNativeEvent({ type: "select", key: "", item: "a2" });
		let root = selector.describe(pickerCx);
		expect(props(root).focus).toBe("list");
		const sections = () => (root.c ?? []) as NativeNode[];
		expect(
			sections().map(section => [section.key, (section.p as TspProps<"section">).head, section.p?.role]),
		).toEqual([
			["whole", "Whole message", "omp.picker.block"],
			["b0", expect.stringContaining("rust"), "omp.picker.block"],
		]);
		expect(sections()[1]?.p?.actions?.click).toBe("copy");

		selector.handleNativeEvent({ type: "action", key: "", act: "blocks", mods: [] });
		root = selector.describe(pickerCx);
		expect(props(root).focus).toBe("preview");
		expect(sections()[1]?.p?.role).toBe("omp.picker.block.focused");
		expect(props(root).actions?.find(action => action.id === "close")?.label).toBe("Back");
	});

	test("the Copy action picks the focused block, activate picks a whole turn", () => {
		const picks: string[] = [];
		const selector = copy(picks);
		selector.handleNativeEvent({ type: "select", key: "", item: "a2" });
		selector.handleInput("\x1b[C");
		selector.handleNativeEvent({ type: "action", key: "", act: "pick", mods: [] });
		expect(picks).toEqual(["rust code:fn ack() {}"]);

		selector.handleNativeEvent({ type: "activate", key: "", item: "u1" });
		expect(picks.at(-1)).toBe("user message:find the ack");
		expect(props(selector.describe(pickerCx)).focus).toBe("list");
	});
});

describe("session tree picker", () => {
	/** u1 → a1 → {u2 → a3 (active leaf), u3 (labeled "idea")}. */
	function tree(): TreeSelectorNode[] {
		const node = (e: SessionMessageEntryLike, children: TreeSelectorNode[] = [], label?: string) =>
			({ entry: e, children, label }) as TreeSelectorNode;
		return [
			node(entry("u1", null, user("find the ack")), [
				node(entry("a1", "u1", assistant([{ type: "text", text: "Found it." }])), [
					node(entry("u2", "a1", user("rewrite it")), [
						node(entry("a3", "u2", assistant([{ type: "text", text: "done" }]))),
					]),
					node(entry("u3", "a1", user("explain it")), [], "idea"),
				]),
			]),
		];
	}

	function treeSelector(switched: string[] = [], cancelled: { count: number } = { count: 0 }) {
		return new TreeSelectorComponent(
			tree(),
			"a3",
			40,
			(id, options) => switched.push(`${id}${options.summarize ? "+summary" : ""}`),
			() => cancelled.count++,
			undefined,
			"default",
			"Frame acks",
		);
	}

	function treeProps(selector: TreeSelectorComponent): TspPickerProps {
		const root = selector.describe(pickerCx);
		const sheet = root.c?.[0] as NativeNode | undefined;
		if (root.k !== "col" || sheet?.key !== "picker") throw new Error("expected a column holding the picker");
		return props(sheet);
	}

	test("describes the tree picker when supported: depth, active path, label badge, current leaf", () => {
		const selector = treeSelector();
		expect(selector.describe(genericCx).k).toBe("card");
		const p = treeProps(selector);
		expect([p.layout, p.icon, p.subtitle, p.tab]).toEqual(["tree", "git-branch", "Frame acks", "default"]);
		expect(p.current).toEqual(["a3"]);
		const byId = new Map(p.items?.map(item => [item.id, item]));
		expect(byId.get("a1")?.open).toBe(true);
		expect(byId.get("u2")?.dot).toBe("accent");
		expect(byId.get("u3")?.dot).toBeUndefined();
		expect(byId.get("u3")?.badges).toEqual([{ text: "idea", tone: "warning" }]);
		expect((byId.get("u2")?.depth ?? 0) > (byId.get("a1")?.depth ?? 0)).toBe(true);
		expect(p.selected).toBe("a3");
	});

	test("typing and filter tabs change the order, never the catalogue", () => {
		const selector = treeSelector();
		const { items } = treeProps(selector);
		typeText(selector, "explain");
		const searched = treeProps(selector);
		expect(searched.items).toBe(items);
		expect(searched.query).toBe("explain");
		expect(searched.order).toEqual(["u3"]);

		selector.handleInput("\x1b");
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "tab", value: "user-only", mods: [] });
		const users = treeProps(selector);
		expect(users.tab).toBe("user-only");
		expect(users.order).toEqual(["u1", "u2", "u3"]);
		expect(users.items).toBe(items);
	});

	test("pointer events take the keys' paths: select, Summarize & switch, Close", () => {
		const switched: string[] = [];
		const cancelled = { count: 0 };
		const selector = treeSelector(switched, cancelled);
		selector.handleNativeEvent({ type: "select", key: "^picker", item: "u3" });
		expect(treeProps(selector).selected).toBe("u3");
		expect(switched).toEqual([]);

		selector.handleNativeEvent({ type: "action", key: "^picker", act: "summarize", mods: [] });
		expect(switched).toEqual(["u3+summary"]);
		selector.handleNativeEvent({ type: "activate", key: "^picker", item: "u1" });
		expect(switched).toEqual(["u3+summary", "u1"]);
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "close", mods: [] });
		expect(cancelled.count).toBe(1);
	});

	test("the Label action edits in the preview and the saved label becomes a badge", () => {
		const labels: string[] = [];
		const selector = new TreeSelectorComponent(
			tree(),
			"a3",
			40,
			() => {},
			() => {},
			(id, label) => labels.push(`${id}=${label}`),
		);
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "label", mods: [] });
		expect(treeProps(selector).focus).toBe("preview");
		typeText(selector, "ship");
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "label-save", mods: [] });
		expect(labels).toEqual(["a3=ship"]);
		const p = treeProps(selector);
		expect(p.focus).toBe("list");
		expect(p.items?.find(item => item.id === "a3")?.badges).toEqual([{ text: "ship", tone: "warning" }]);
	});
});
