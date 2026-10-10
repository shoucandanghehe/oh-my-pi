import { describe, expect, it } from "bun:test";
import * as url from "node:url";
import { fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";

const windowsTernEnv = {
	WSL_DISTRO_NAME: "Ubuntu-24.04",
	TERN_PANE_SOCKET: "\\\\.\\pipe\\tern-test",
};

describe("Windows Tern file links from WSL", () => {
	it("addresses the WSL share even when pwsh did not forward TERM_PROGRAM", () => {
		const href = fileUriForTerminal("/home/alice/a#b?c% 中文.ts", { line: 42 }, "base", "linux", windowsTernEnv);
		expect(href).toBe("file://wsl.localhost/Ubuntu-24.04/home/alice/a%23b%3Fc%25%20%E4%B8%AD%E6%96%87.ts");
		expect(url.fileURLToPath(href, { windows: true })).toBe(
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\a#b?c% 中文.ts",
		);
	});

	it("keeps mounted paths on the same distro instead of assuming a Windows drive mapping", () => {
		expect(fileUriForTerminal("/mnt/c/Users/alice/note.md", undefined, "tern", "linux", windowsTernEnv)).toBe(
			"file://wsl.localhost/Ubuntu-24.04/mnt/c/Users/alice/note.md",
		);
	});

	it("keeps Linux Tern paths local when its endpoint is a Unix socket", () => {
		expect(
			fileUriForTerminal("/home/alice/note.md", undefined, "tern", "linux", {
				...windowsTernEnv,
				TERN_PANE_SOCKET: "/run/user/1000/tern.sock",
			}),
		).toBe(url.pathToFileURL("/home/alice/note.md").href);
	});

	it("preserves VS Code editor navigation rather than redirecting it to a file share", () => {
		expect(fileUriForTerminal("/home/alice/note.md", { line: 42, col: 7 }, "vscode", "linux", windowsTernEnv)).toBe(
			"vscode://file/home/alice/note.md:42:7",
		);
	});

	it.skipIf(process.platform !== "linux")(
		"emits Windows-readable targets in OSC 8 links, native file lists and tool heads",
		async () => {
			const script = `
			import { applyHyperlinkSetting, fileHyperlink, fileLinkSpan } from "@oh-my-pi/pi-tui/render/hyperlink";
			import { styledSpans } from "@oh-my-pi/pi-tui/native/spans";
			import { fileHref } from "@oh-my-pi/pi-tui/tools/native-view";
			applyHyperlinkSetting("always");
			const file = "/home/alice/note #1.md";
			const osc = fileHyperlink(file, "note #1.md", { line: 12 });
			const native = fileLinkSpan(file, "note #1.md");
			const head = fileHref(file);
			applyHyperlinkSetting("off");
			console.log(JSON.stringify({ osc: styledSpans(osc), native, head, off: fileLinkSpan(file, "note #1.md") }));
		`;
			const child = Bun.spawn([process.execPath, "-e", script], {
				cwd: import.meta.dir,
				env: { ...process.env, ...windowsTernEnv, TERM_PROGRAM: "tern", NO_COLOR: undefined },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			const href = "file://wsl.localhost/Ubuntu-24.04/home/alice/note%20%231.md";
			expect(JSON.parse(stdout)).toEqual({
				osc: [{ t: "note #1.md", href }],
				native: { t: "note #1.md", s: "path", href },
				head: href,
				off: { t: "note #1.md", s: "path" },
			});
		},
	);
});
