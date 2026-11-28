/** Drive an installed Tern by screen coordinates; no user panes, credentials, or model requests. */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { quotePosixArgv } from "../src/utils/shell-quote";
import { skipWithoutTern, startHeadlessTern, type TernElement } from "./helpers/headless-tern";

test.skipIf(skipWithoutTern)(
	"real Tern pointer controls change the model without losing the composed draft",
	async () => {
		await using dir = await TempDir.create("@omp-tern-");
		const agent = dir.join("agent");
		await Bun.write(dir.join("sample-note.txt"), "Local completion target\n");
		await Bun.write(
			path.join(agent, "models.yml"),
			JSON.stringify({
				providers: {
					smoke: {
						baseUrl: "http://127.0.0.1:1/v1",
						apiKey: "unused",
						api: "openai-completions",
						models: ["alpha", "beta"].map(id => ({
							id,
							name: `Smoke ${id}`,
							reasoning: true,
							input: ["text"],
							contextWindow: 32768,
							maxTokens: 4096,
						})),
					},
				},
			}),
		);
		await using ui = await startHeadlessTern(dir);
		const { ctl, visible, click, enterText, env, server, log } = ui;
		const draft = (text: string) =>
			visible(".sf-editor", n => n.text === text, `composer draft ${JSON.stringify(text)}`);
		const chip = (name: string) =>
			visible(".sf-row.sf-act", n => n.text === `Smoke ${name}`, `model chip Smoke ${name}`);

		try {
			await enterText(
				`${quotePosixArgv(["cd", dir.path()])} && exec ${quotePosixArgv([
					"env",
					"-i",
					`PATH=${env.PATH}`,
					`HOME=${env.HOME}`,
					`LANG=${env.LANG}`,
					`PI_CODING_AGENT_DIR=${agent}`,
					"TERM=xterm-256color",
					"TERM_PROGRAM=tern",
					"OMP_SKIP_SETUP=1",
					// Test runtime: keeps omp off the OS keychain.
					"PI_TEST_RUNTIME=1",
					process.execPath,
					path.resolve(import.meta.dir, "../src/cli.ts"),
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"--no-lsp",
					"--no-session",
					"--model",
					"smoke/alpha",
					"--thinking",
					"high",
				])}`,
			);
			await ctl("key", "Enter");
			await chip("alpha");
			await enterText("discard me");
			const singleLine = await draft("discard me");
			await ctl("key", "Ctrl+Enter");
			await visible(
				".sf-editor",
				n => n.text === "discard me" && n.rect[3] > singleLine.rect[3],
				"draft on two lines after Ctrl+Enter",
			);
			await ctl("key", process.platform === "darwin" ? "Meta+a" : "Ctrl+a");
			await enterText("keep @sample-no");
			await click(await visible(".pk-row", n => n.text?.includes("sample-note.txt") === true, "file suggestion"));
			const kept = "keep @sample-note.txt";
			await draft(kept);

			// The nested ring is a different target from the model name, despite sharing its chip.
			const effort = await visible(".sf-effort.sf-act", n => Boolean(n.title), "interactive effort ring");
			await click(effort);
			await visible(".sf-effort.sf-act", n => Boolean(n.title) && n.title !== effort.title, "changed effort level");
			await click(await chip("alpha"));
			await visible(".sf-layer > .sf-picker", n => n.rect[2] > 0 && n.rect[3] > 0, "visible session model picker");
			await enterText("smoke/beta");
			// Beta is visible in the unfiltered list too, at a different coordinate. Wait until
			// the new query is displayed and the filtered row is selected before clicking it.
			await visible(".pk-search", n => n.text === "smoke/beta", "rendered model search");
			await click(await visible(".pk-row.sel", n => n.text?.includes("beta") === true, "selected beta result"));
			await chip("beta");
			await visible(".sf-editor.focused", n => n.text === kept, "draft focused again after changing the model");
			// The chip update and closing the native picker are separate frames.
			const closeDeadline = performance.now() + 10_000;
			let pickers = (await ctl("tree", ".sf-layer > .sf-picker")).nodes;
			while (pickers?.length && performance.now() < closeDeadline && server.exitCode === null) {
				await Bun.sleep(25);
				pickers = (await ctl("tree", ".sf-layer > .sf-picker")).nodes;
			}
			expect(pickers).toEqual([]);
		} catch (error) {
			if (await log.exists()) console.error((await log.text()).slice(-1600));
			throw error;
		}
	},
	100_000,
);

const TRAY = ".sf-dock .sf-tray";
const CARD = `${TRAY} .sf-tray-card`;
const COMPOSER = ".sf-dock [data-role^='omp.editor']";
const NEW_THREAD = `${COMPOSER} [data-role='omp.composer.bar'] button`;
const LEGACY_ACTIONS = ".sf-dock button, .sf-dock [data-role='omp.btn']";
const MESSAGE = ".sf-main .sf-md";

function only(nodes: TernElement[] | undefined, description: string): TernElement {
	if (nodes?.length !== 1) throw new Error(`Expected one rendered ${description}; found ${nodes?.length ?? 0}`);
	const [node] = nodes;
	if (!node || node.rect[2] <= 0 || node.rect[3] <= 0) throw new Error(`Rendered ${description} has no area`);
	return node;
}

function bottom({ rect: [, y, , h] }: TernElement) {
	return y + h;
}

/** Await the observed clipboard or cancel write from the real PTY; its I/O is outside Bun's clock. */
async function fixtureOutput(file: Bun.BunFile, description: string): Promise<string> {
	const deadline = performance.now() + 5000;
	do {
		try {
			const text = await file.text();
			if (text) return text;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		await Bun.sleep(25);
	} while (performance.now() < deadline);
	throw new Error(`Missing fixture output: ${description}`);
}

async function startBtwFixture(dir: TempDir) {
	const ui = await startHeadlessTern(dir);
	const log = Bun.file(dir.join("fixture.log"));
	try {
		await ui.enterText(
			`exec ${quotePosixArgv([
				"env",
				"-i",
				`PATH=${ui.env.PATH}`,
				`HOME=${ui.env.HOME}`,
				`LANG=${ui.env.LANG}`,
				"PI_TEST_RUNTIME=1",
				"TERM=xterm-256color",
				"TERM_PROGRAM=tern",
				process.execPath,
				path.join(import.meta.dir, "helpers/tern-btw-fixture.ts"),
			])} 2>${quotePosixArgv([log.name!])}`,
		);
		await ui.ctl("key", "Enter");
		await ui.visible(COMPOSER, node => node.text?.includes("tray-fixture-model") === true, "BTW dock composer");
		await ui.visible(MESSAGE, node => node.text === "Geometry thread saved answer.", "selected thread transcript");
		return ui;
	} catch (error) {
		const stderr = (await log.exists()) ? await log.text() : "";
		await ui[Symbol.asyncDispose]();
		throw new Error(`Headless BTW fixture did not render${stderr ? `:\n${stderr}` : ""}`, { cause: error });
	}
}

test.skipIf(skipWithoutTern)(
	"real Tern BTW renders its thread cards in the dock above the composer",
	async () => {
		await using dir = await TempDir.create("@omp-tern-btw-");
		await using ui = await startBtwFixture(dir);
		const tray = only((await ui.ctl("tree", `${TRAY} .sf-tray-strip`)).nodes, "BTW tray card strip in the dock");
		const composer = only((await ui.ctl("tree", COMPOSER)).nodes, "BTW dock composer");
		expect(bottom(tray)).toBeLessThanOrEqual(composer.rect[1]);
		const cards = (await ui.ctl("tree", CARD)).nodes ?? [];
		expect(cards).toHaveLength(2);
		expect(cards[0]!.text).toContain("Geometry thread");
		expect(cards[1]!.text).toContain("Notes thread");
		expect(cards[0]!.rect[0]).toBeLessThan(cards[1]!.rect[0]);
		expect(cards[0]!.rect[1]).toBeCloseTo(cards[1]!.rect[1]);
		expect(cards.every(card => card.rect[3] > 0 && bottom(card) <= composer.rect[1])).toBe(true);
	},
	35_000,
);

test.skipIf(skipWithoutTern)(
	"real Tern BTW activates a different thread by clicking its card or pressing Enter after an arrow key",
	async () => {
		await using dir = await TempDir.create("@omp-tern-btw-open-");
		await using ui = await startBtwFixture(dir);
		const notes = only((await ui.ctl("tree", `${CARD}:nth-child(2)`)).nodes, "Notes thread card");
		expect(notes.text).toContain("Notes thread");
		await ui.click(notes);
		await ui.visible(
			MESSAGE,
			node => node.text === "Notes thread saved answer.",
			"Notes thread transcript after clicking its card",
		);
		await ui.ctl("key", "Left");
		await ui.visible(
			`${CARD}[aria-selected='true']`,
			node => node.text?.includes("Geometry thread") === true,
			"keyboard cursor on the first card without activating it",
		);
		expect((await ui.ctl("tree", MESSAGE)).nodes?.map(node => node.text)).toContain("Notes thread saved answer.");
		await ui.ctl("key", "Enter");
		await ui.visible(MESSAGE, node => node.text === "Geometry thread saved answer.", "first transcript after Enter");
	},
	35_000,
);

test.skipIf(skipWithoutTern)(
	"real Tern BTW creates a thread through the + next to the composer model chip",
	async () => {
		await using dir = await TempDir.create("@omp-tern-btw-new-");
		await using ui = await startBtwFixture(dir);
		const add = only(
			(await ui.ctl("tree", NEW_THREAD)).nodes?.filter(node => node.text?.trim() === "+"),
			"+ new thread button in the composer bar",
		);
		const model = only(
			(await ui.ctl("tree", `${COMPOSER} [data-role='omp.composer.model']`)).nodes,
			"composer model chip",
		);
		expect(add.rect[0]).toBeGreaterThanOrEqual(model.rect[0] + model.rect[2]);
		expect(add.rect[1]).toBeLessThan(bottom(model));
		expect(bottom(add)).toBeGreaterThan(model.rect[1]);
		await ui.click(add);
		await ui.visible(
			CARD,
			node => node.text?.includes("Created thread 1") === true && node.text.includes("Current"),
			"new thread selected in the tray",
		);
		expect((await ui.ctl("tree", CARD)).nodes).toHaveLength(3);
	},
	35_000,
);

test.skipIf(skipWithoutTern)(
	"real Tern BTW right-click Copy answer acts on the card's thread without selecting it",
	async () => {
		await using dir = await TempDir.create("@omp-tern-btw-menu-");
		await using ui = await startBtwFixture(dir);
		const notes = only((await ui.ctl("tree", `${CARD}:nth-child(2)`)).nodes, "right-clickable Notes thread card");
		await ui.click(notes, "right");
		const copy = await ui.visible(
			"[role='menuitem']",
			node => node.text?.trim() === "Copy answer",
			"card context menu's Copy answer",
		);
		await ui.click(copy);
		const clipboard = Bun.file(dir.join("clipboard"));
		expect(await fixtureOutput(clipboard, "right-clicked card's copied reply")).toBe("Notes thread saved answer.");
		expect((await ui.ctl("tree", MESSAGE)).nodes?.map(node => node.text)).toContain("Geometry thread saved answer.");
	},
	35_000,
);

test.skipIf(skipWithoutTern)(
	"real Tern BTW swaps the tray for Threads / New / Close when Agents tray is disabled",
	async () => {
		await using dir = await TempDir.create("@omp-tern-btw-settings-");
		await using ui = await startBtwFixture(dir);
		const fallbackButtons = () =>
			ui
				.ctl("tree", LEGACY_ACTIONS)
				.then(reply =>
					reply.nodes
						?.filter(node => node.rect[2] > 0 && node.rect[3] > 0)
						.flatMap(node => (node.text && ["Threads", "New", "Close"].includes(node.text) ? [node.text] : [])),
				);
		expect(await fallbackButtons()).toEqual([]);
		only((await ui.ctl("tree", TRAY)).nodes, "BTW tray before disabling it");
		await ui.ctl("prefs", "search", "Agents tray");
		const toggle = only(
			(await ui.ctl("tree", "button.pf-sw.on[role='switch']")).nodes,
			"enabled Agents tray preference",
		);
		await ui.click(toggle);
		await ui.ctl("prefs", "close");
		await ui.visible(
			LEGACY_ACTIONS,
			node => node.text === "Threads",
			"fallback Threads button after turning the tray off",
		);
		expect(await fallbackButtons()).toEqual(expect.arrayContaining(["Threads", "New", "Close"]));
		expect((await ui.ctl("tree", TRAY)).nodes ?? []).toEqual([]);
	},
	35_000,
);

test.skipIf(skipWithoutTern)(
	"real Tern BTW MAIN is inert and Escape cancels a reply without creating a thread",
	async () => {
		await using dir = await TempDir.create("@omp-tern-btw-escape-");
		await using ui = await startBtwFixture(dir);
		const main = only((await ui.ctl("tree", `${TRAY} .sf-tray-main`)).nodes, "inert MAIN label on the BTW tray");
		expect(main.text?.toUpperCase()).toBe("MAIN");
		expect(main.title ?? "").not.toMatch(/back to main/i);
		await ui.click(main);
		const field = only((await ui.ctl("tree", `${COMPOSER} .sf-editor`)).nodes, "BTW editor before Escape");
		await ui.click(field);
		await ui.visible(`${COMPOSER} .sf-editor.focused`, node => node.rect[3] > 0, "focused BTW editor");
		await ui.ctl("key", "Escape");
		const cancelled = Bun.file(dir.join("cancelled-thread"));
		expect(await fixtureOutput(cancelled, "selected thread cancelled by Escape")).toBe("geometry");
		const cards = (await ui.ctl("tree", CARD)).nodes ?? [];
		expect(cards).toHaveLength(2);
		expect(cards.some(node => node.text?.includes("Created thread"))).toBe(false);
	},
	35_000,
);

test.skipIf(skipWithoutTern)(
	"real Tern BTW draws no Read-only label when a thread is selected",
	async () => {
		await using dir = await TempDir.create("@omp-tern-btw-label-");
		await using ui = await startBtwFixture(dir);
		const labels = (await ui.ctl("tree", ".sf-main .sf, .sf-dock .sf, .sf-layer .sf")).nodes ?? [];
		expect(labels.filter(node => node.text === "Read-only" && node.rect[2] > 0 && node.rect[3] > 0)).toEqual([]);
	},
	35_000,
);
