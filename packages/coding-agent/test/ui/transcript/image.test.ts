import { afterEach, expect, test } from "bun:test";
import {
	createRoot,
	isUiNode,
	nativeRendering,
	setNativeRenderingForTest,
	signal,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { getBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { CONSERVATIVE_EMOJI } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { bindEffects } from "../../../src/config/registry";
import { Settings } from "../../../src/config/settings";
import { cfgTuiMaxInlineImageColumns, cfgTuiMaxInlineImageRows } from "../../../src/modes/settings";
import "../../../src/ui/styles/figures/figure";
import "../../../src/ui/styles/tools/block";
import "../../../src/ui/styles/tools/read";
import "../../../src/ui/styles/transcript/exec-run";
import { readPresenter } from "../../../src/ui/tools/read";
import { ExecRun, ExecRunBlock } from "../../../src/ui/transcript/exec-run";
import { EmbedFigure } from "../../../src/ui/transcript/figures/embed";
import { followInlineImageLimits, ImageNode } from "../../../src/ui/transcript/messages/image";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";
import { applyFileLinkSetting, fileUriForTerminal } from "../../../src/utils/file-links";

const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const caps: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: false,
	images: "iterm",
	kittyKeyboard: true,
	bracketedPaste: true,
	background: null,
	dark: true,
	cell: { w: 10, h: 20 },
	multiplexer: null,
	textSizing: false,
	tsp: false,
	emoji: CONSERVATIVE_EMOJI,
};

let cleanup: (() => void) | undefined;
let restoreNative: boolean | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	if (restoreNative !== undefined) setNativeRenderingForTest(restoreNative);
	restoreNative = undefined;
});

function sizingSettings(viewport: () => number): Settings {
	const settings = Settings.isolated();
	const release = bindEffects(settings);
	const unfollow = followInlineImageLimits(viewport);
	cleanup = () => {
		cfgTuiMaxInlineImageColumns.override(settings, cfgTuiMaxInlineImageColumns.default);
		cfgTuiMaxInlineImageRows.override(settings, cfgTuiMaxInlineImageRows.default);
		unfollow();
		release();
	};
	return settings;
}

async function largeImage() {
	const data = await new Bun.Image(Buffer.from(RED_PNG, "base64")).resize(1200, 600).png().toBase64();
	return { data, mimeType: "image/png" };
}

function paintRows(node: UiNode): () => readonly string[] {
	const capabilities = () => caps;
	const images = new TerminalImages({ capabilities, placeholders: () => false });
	const env = staticEnvironment(currentTheme(), { images: driverImages(images, capabilities) });
	return () => paintNode(env, node, 160).rows;
}

function expectPicture(rows: readonly string[], columns: number, height: number): void {
	expect(rows).toHaveLength(height);
	expect(rows.at(-1)).toContain(`File=inline=1;width=${columns};height=${height}:`);
}

test("a mounted transcript picture follows both configured caps without remounting", async () => {
	const image = await largeImage();
	const settings = sizingSettings(() => 60);
	createRoot(dispose => {
		try {
			const node = ImageNode({ image });
			if (!isUiNode(node)) throw new Error("expected an image node");
			const rows = paintRows(node);
			expectPicture(rows(), 80, 20);

			cfgTuiMaxInlineImageColumns.override(settings, 40);
			cfgTuiMaxInlineImageRows.override(settings, 10);
			expectPicture(rows(), 40, 10);

			cfgTuiMaxInlineImageRows.override(settings, 8);
			expectPicture(rows(), 32, 8);
			cfgTuiMaxInlineImageRows.override(settings, 20);
			expectPicture(rows(), 40, 10);
			cfgTuiMaxInlineImageColumns.override(settings, 0);
			expectPicture(rows(), 80, 20);
		} finally {
			dispose();
		}
	});
});

test("a read picture draws once beneath the details card and only while images are on", async () => {
	const image = await largeImage();
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageColumns.override(settings, 40);
	cfgTuiMaxInlineImageRows.override(settings, 10);
	createRoot(dispose => {
		try {
			const path = "/tmp/read.png";
			const call = new ToolCall({ id: "read", name: "read", args: { path }, presenter: readPresenter });
			call.updateResult(
				{
					content: [
						{ type: "image", ...image },
						{ type: "text", text: "Picture detail" },
					],
				},
				false,
			);
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("expected a tool node");
			const rows = paintRows(node);
			const drawn = rows();
			const graphics = drawn.findIndex(row => row.includes("File=inline=1;width=40;height=10:"));
			expect(graphics).toBeGreaterThan(0);
			expect(drawn.slice(0, graphics).join("\n")).toContain("Picture detail");
			expect(drawn.filter(row => row.includes("File=inline=1;"))).toHaveLength(1);

			call.setShowImages(false);
			const hidden = rows().join("\n");
			expect(hidden).toContain("Picture detail");
			expect(hidden).not.toContain("File=inline=1;");
		} finally {
			dispose();
		}
	});
});

test("a bash run paints a capped picture or its placeholder according to the terminal and display setting", async () => {
	const image = await largeImage();
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageColumns.override(settings, 40);
	cfgTuiMaxInlineImageRows.override(settings, 10);
	createRoot(dispose => {
		try {
			const run = new ExecRun({ kind: "bash", source: "print-picture" });
			run.setComplete(0, false, { images: [image] });
			const node = ExecRunBlock({ run });
			if (!isUiNode(node)) throw new Error("expected a bash run node");
			const rows = paintRows(node);
			const drawn = rows().join("\n");
			expect(drawn).toContain("File=inline=1;width=40;height=10:");
			expect(drawn).not.toContain("[Image:");

			const plain = paintNode(staticEnvironment(currentTheme()), node, 160).rows.join("\n");
			expect(plain).toContain("[Image: [image/png] 1200x600]");
			expect(plain).not.toContain("File=inline=1;");

			run.setComplete(0, false, { images: [image], showImages: false });
			const hidden = rows().join("\n");
			expect(hidden).toContain("[Image: [image/png] 1200x600]");
			expect(hidden).not.toContain("File=inline=1;");
		} finally {
			dispose();
		}
	});
});

test("a native file preview has a height limit but its fallback blob has no max box", () => {
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageColumns.override(settings, 40);
	cfgTuiMaxInlineImageRows.override(settings, 10);
	restoreNative = nativeRendering();
	setNativeRenderingForTest(true);
	createRoot(dispose => {
		try {
			const path = "/tmp/read.png";
			const call = new ToolCall({ id: "read", name: "read", args: { path }, presenter: readPresenter });
			call.updateResult(
				{ content: [{ type: "image", mimeType: "image/png", data: RED_PNG }], details: { mediaPath: path } },
				false,
			);
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("expected a tool node");
			const env = staticEnvironment(currentTheme());

			expect(describeTree(node, env)).toMatchObject({
				c: [expect.objectContaining({ k: "media", p: { max: { h: "10lines" }, path } })],
			});
			cfgTuiMaxInlineImageRows.override(settings, 0);
			expect(describeTree(node, env)).toMatchObject({
				c: [expect.objectContaining({ k: "media", p: { max: { h: "30lines" }, path } })],
			});

			setNativeRenderingForTest(false);
			const [image] = node.children();
			if (!image) throw new Error("expected a fallback image");
			expect(describeTree(image, env)).toEqual({
				k: "image",
				p: { role: "omp.tool.read.image", alt: expect.any(String), blob: expect.any(String), w: 1, h: 1 },
			});
		} finally {
			dispose();
		}
	});
});

test.skipIf(process.platform !== "linux")("Windows Tern receives WSL links and previews with image bytes", () => {
	const previousSocket = Bun.env.TERN_PANE_SOCKET;
	const previousDistro = Bun.env.WSL_DISTRO_NAME;
	Bun.env.TERN_PANE_SOCKET = "\\\\.\\pipe\\omp-test-tern";
	Bun.env.WSL_DISTRO_NAME = "Ubuntu-24.04";
	restoreNative = nativeRendering();
	setNativeRenderingForTest(true);
	applyFileLinkSetting({});
	try {
		createRoot(dispose => {
			try {
				const path = "/home/alice/a#b?c% 中文.png";
				const call = new ToolCall({ id: "read", name: "read", args: { path }, presenter: readPresenter });
				call.updateResult(
					{
						content: [{ type: "image", mimeType: "image/png", data: RED_PNG }],
						details: { mediaPath: path, resolvedPath: path },
					},
					false,
				);
				const node = ToolBlock({ call });
				if (!isUiNode(node)) throw new Error("expected a tool node");
				const file = "file://wsl.localhost/Ubuntu-24.04/home/alice/a%23b%3Fc%25%20%E4%B8%AD%E6%96%87.png";
				const id = new Bun.CryptoHasher("sha256").update(Buffer.from(RED_PNG, "base64")).digest("hex");
				const env = staticEnvironment(currentTheme(), { hyperlinks: true });
				expect(describeTree(node, env)).toMatchObject({ p: { href: file } });
				expect(node.children().map(child => child.kind)).toEqual(["image", "text"]);
				expect(describeTree(node.children()[0]!, env)).toMatchObject({ p: { blob: id } });
				expect(getBlob(id)?.bytes).toEqual(new Uint8Array(Buffer.from(RED_PNG, "base64")));
				expect(fileUriForTerminal(path, { line: 42 }, "base")).toBe(file);
				expect(fileUriForTerminal("/home/alice/note.md", { line: 42, col: 7 }, "vscode")).toBe(
					"vscode://file/home/alice/note.md:42:7",
				);
				const embed = EmbedFigure({
					embed: { kind: "iframe", src: "./a #1.html", label: "Page" },
					showImages: true,
					host: { cwd: () => "/home/alice" },
				});
				const page = typeof embed === "function" ? embed() : embed;
				if (!isUiNode(page)) throw new Error("expected a page node");
				const pageHref = "file://wsl.localhost/Ubuntu-24.04/home/alice/a%20%231.html";
				expect(describeTree(page, env)).toMatchObject({ k: "web", p: { url: pageHref } });
				expect(paintNode(env, page, 80).rows.join("\n")).toContain(pageHref);
			} finally {
				dispose();
			}
		});
		applyFileLinkSetting({ scheme: "omp-open", host: "linux.example" });
		expect(fileUriForTerminal("/home/alice/note.md", { line: 42 }, "tern")).toBe(
			"omp-open://linux.example/home/alice/note.md?line=42",
		);
		applyFileLinkSetting({});
		Bun.env.TERN_PANE_SOCKET = "/run/user/1000/omp-test-tern.sock";
		expect(fileUriForTerminal("/home/alice/note.md", undefined, "tern")).toBe("file:///home/alice/note.md");
	} finally {
		if (previousSocket === undefined) delete Bun.env.TERN_PANE_SOCKET;
		else Bun.env.TERN_PANE_SOCKET = previousSocket;
		if (previousDistro === undefined) delete Bun.env.WSL_DISTRO_NAME;
		else Bun.env.WSL_DISTRO_NAME = previousDistro;
		applyFileLinkSetting();
	}
});

test("a native read puts the capped non-image file preview before its content and footer", () => {
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageRows.override(settings, 12);
	restoreNative = nativeRendering();
	setNativeRenderingForTest(true);
	createRoot(dispose => {
		try {
			const path = "/tmp/report.pdf";
			const call = new ToolCall({ id: "pdf", name: "read", args: { path }, presenter: readPresenter });
			call.updateResult(
				{
					content: [{ type: "text", text: "Extracted page" }],
					details: { mediaPath: path, resolvedPath: path },
				},
				false,
			);
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("expected a tool node");
			const env = staticEnvironment(currentTheme());

			expect(node.children().map(child => child.kind)).toEqual(["media", "code", "text"]);
			expect(describeTree(node.children()[0]!, env)).toEqual({
				k: "media",
				key: "media",
				p: { path, max: { h: "12lines" } },
			});

			setNativeRenderingForTest(false);
			expect(node.children().map(child => child.kind)).toEqual(["code", "text"]);
		} finally {
			dispose();
		}
	});
});

test("a row cap of zero follows sixty percent of the viewport", async () => {
	const image = await largeImage();
	const viewport = signal(21);
	const settings = sizingSettings(viewport);
	cfgTuiMaxInlineImageRows.override(settings, 0);
	createRoot(dispose => {
		try {
			const node = ImageNode({ image });
			if (!isUiNode(node)) throw new Error("expected an image node");
			const rows = paintRows(node);
			expectPicture(rows(), 48, 12);

			viewport.set(34);
			expectPicture(rows(), 80, 20);
			cfgTuiMaxInlineImageRows.override(settings, 30);
			expectPicture(rows(), 80, 20);
		} finally {
			dispose();
		}
	});
});
