import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isWsl, TempDir, windowsPathToWslMount } from "@oh-my-pi/pi-utils";
import { formatTernWindowsLaunch, TernPaneClient } from "../../src/tools/browser/tern/panes";

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const cmd = path.win32.join(systemRoot, "System32", "cmd.exe");
const powershellHost = process.platform === "win32" ? powershell : windowsPathToWslMount(powershell)!;
const cmdHost = process.platform === "win32" ? cmd : windowsPathToWslMount(cmd)!;
const windowsAvailable = (process.platform === "win32" || isWsl()) && (await Bun.file(powershellHost).exists());

it("encodes executable paths and literal arguments as a PowerShell invocation", () => {
	const command = formatTernWindowsLaunch([
		"C:\\Program Files\\O'MP\\omp.exe",
		"__omp_worker_native_pane",
		"ws://127.0.0.1:1234/token?$literal&value='kept'",
	]);
	const encoded = command.split(" ").at(-1)!;
	expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
		"& 'C:\\Program Files\\O''MP\\omp.exe' '__omp_worker_native_pane' 'ws://127.0.0.1:1234/token?$literal&value=''kept'''; exit $LASTEXITCODE",
	);
});

describe.skipIf(!windowsAvailable)("Windows launch shell", () => {
	for (const shell of ["powershell", "cmd"] as const) {
		it(`executes the worker and surfaces its failure through ${shell}`, async () => {
			const script = "[Console]::Write('worker-started'); exit 7";
			const command = formatTernWindowsLaunch([
				powershell,
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(script, "utf16le").toString("base64"),
			]);
			const args =
				shell === "powershell"
					? [powershellHost, "-NoProfile", "-NonInteractive", "-Command", command]
					: [cmdHost, "/d", "/s", "/c", command];
			const result = Bun.spawn(args, {
				cwd: process.platform === "win32" ? systemRoot : windowsPathToWslMount(systemRoot),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(result.stdout).text(),
				new Response(result.stderr).text(),
				result.exited,
			]);
			expect(stderr).toBe("");
			expect(stdout).toBe("worker-started");
			expect(exitCode).not.toBe(0);
		});
	}
});

it.skipIf(process.platform === "win32")(
	"finds the Windows Tern installation from forwarded LOCALAPPDATA in WSL without a PATH entry",
	async () => {
		await using temp = await TempDir.create("@omp-tern-install-");
		const installed = temp.join("Programs", "Tern", "tern.exe");
		await Bun.write(
			installed,
			`#!/bin/sh\nprintf '%s\\n' '{"sessions":[{"shown":true,"tabs":[{"shown":true,"blocks":[{"id":73,"focused":true}]}]}]}'\n`,
		);
		await fs.chmod(installed, 0o755);
		const probe = temp.join("probe.ts");
		await Bun.write(
			probe,
			`import { TernPaneClient } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/tern/panes.ts"))};\nconst client = new TernPaneClient({ pane: 1, socketPath: "test-socket" }, process.cwd());\nconsole.log(await client.focused());\n`,
		);
		const result = Bun.spawn([process.execPath, probe], {
			env: { ...process.env, PATH: "", WSL_DISTRO_NAME: "test-distro", LOCALAPPDATA: temp.path() },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(result.stdout).text(),
			new Response(result.stderr).text(),
			result.exited,
		]);
		expect(stderr).toBe("");
		expect(stdout.trim()).toBe("73");
		expect(exitCode).toBe(0);
	},
);

it.skipIf(process.platform === "win32")("pane control commands leave terminal input for the host", async () => {
	await using temp = await TempDir.create("@omp-tern-stdin-");
	const executable = temp.join("tern");
	await Bun.write(
		executable,
		`#!${process.execPath}
const command = process.argv[2];
await Bun.write(${JSON.stringify(temp.path())} + "/" + command + ".stdin", await Bun.stdin.text());
if (command === "split") console.log(JSON.stringify({ session: 1, tab: 2, block: 3 }));
if (command === "ls") console.log(JSON.stringify({ sessions: [{ shown: true, tabs: [{ shown: true, blocks: [{ id: 3, focused: true }] }] }] }));
if (command === "plugin") console.log(JSON.stringify({ plugins: [{ id: "omp-workspace", version: "0.2.0", status: "ready" }] }));
if (command === "ctl") {
	await Bun.write(${JSON.stringify(temp.path())} + "/notification.json", JSON.stringify(process.argv.slice(2)));
	console.log(JSON.stringify({ ok: true }));
}
`,
	);
	await fs.chmod(executable, 0o755);
	const probe = temp.join("probe.ts");
	await Bun.write(
		probe,
		`import { TernPaneClient } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/tern/panes.ts"))};
const client = new TernPaneClient({ pane: 1, socketPath: "test-socket" }, process.cwd(), ${JSON.stringify(executable)}, ["omp"]);
await client.open("ws://127.0.0.1:1234/test");
await client.focus(3);
await client.focused();
await client.close(3);
await client.balance();
process.stdout.write(await Bun.stdin.text());
`,
	);
	const input = '\x1b]877;tsp;e;{"ev":"resize","cols":101,"cell":{"w":8,"h":17},"visible":true}\x1b\\';
	const child = Bun.spawn([process.execPath, probe], {
		stdin: Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(stdout).toBe(input);
	expect(await Bun.file(temp.join("notification.json")).json()).toEqual([
		"ctl",
		"open-url",
		"omp-workspace://balance/1",
	]);
	for (const command of ["split", "focus", "ls", "close", "plugin", "ctl"]) {
		expect(await Bun.file(temp.join(`${command}.stdin`)).text()).toBe("");
	}
});

it.skipIf(process.platform === "win32")(
	"lists split pane sizes and active-tab visibility without floating or live detached blocks",
	async () => {
		await using temp = await TempDir.create("@omp-tern-membership-");
		const executable = temp.join("tern");
		await Bun.write(
			executable,
			`#!${process.execPath}
console.log(JSON.stringify({ sessions: [{ shown: true, tabs: [{ shown: true, blocks: [{ id: 3, cols: 80, rows: 50, focused: true }, { id: 4, cols: 40, rows: 20, focused: false, pip: { owner: 3, corner: "tr", stashed: null } }] }, { shown: false, blocks: [{ id: 7, cols: 64, rows: 59, focused: true }] }] }, { shown: false, tabs: [{ shown: true, blocks: [{ id: 8, cols: 80, rows: 120, focused: true }] }] }], detached: [{ id: 5, live: true, exited: null }] }));
`,
		);
		await fs.chmod(executable, 0o755);
		const probe = temp.join("probe.ts");
		await Bun.write(
			probe,
			`import { TernPaneClient } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/tern/panes.ts"))};
const client = new TernPaneClient({ pane: 1, socketPath: "test-socket" }, process.cwd(), ${JSON.stringify(executable)});
console.log(JSON.stringify(await client.splitPanes()));
`,
		);
		const child = Bun.spawn([process.execPath, probe], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual([
			{ block: 3, columns: 80, rows: 50, shown: true },
			{ block: 7, columns: 64, rows: 59, shown: false },
			{ block: 8, columns: 80, rows: 120, shown: false },
		]);
	},
);

for (const plugin of [
	undefined,
	{ id: "omp-workspace", version: "0.2.0", status: "disabled" },
	{ id: "omp-workspace", version: "0.1.0", status: "ready" },
]) {
	it.skipIf(process.platform === "win32")(
		`does not dispatch a workspace URL when the plugin is ${plugin ? `${plugin.status} at ${plugin.version}` : "absent"}`,
		async () => {
			await using temp = await TempDir.create("@omp-tern-plugin-");
			const executable = temp.join("tern");
			const called = temp.join("dispatched");
			await Bun.write(
				executable,
				`#!${process.execPath}
if (process.argv[2] === "plugin") console.log(${JSON.stringify(JSON.stringify({ plugins: plugin ? [plugin] : [] }))});
else {
	await Bun.write(${JSON.stringify(called)}, "dispatched");
	console.log(JSON.stringify({ ok: true }));
}
`,
			);
			await fs.chmod(executable, 0o755);
			const client = new TernPaneClient({ pane: 73, socketPath: "test-socket" }, temp.path(), executable);
			await client.balance();
			expect(await Bun.file(called).exists()).toBe(false);
		},
	);
}

it.skipIf(process.platform === "win32")(
	"accepts an already-closed pane without hiding a failed close of a live pane",
	async () => {
		await using temp = await TempDir.create("@omp-tern-close-");
		const executable = temp.join("tern");
		const closed = temp.join("closed");
		await Bun.write(
			executable,
			`#!${process.execPath}
const block = Number(process.argv[3]);
if (process.argv[2] === "close") {
	if (block === 3 && !(await Bun.file(${JSON.stringify(closed)}).exists())) {
		await Bun.write(${JSON.stringify(closed)}, "closed");
	} else {
		process.stderr.write("could not close " + block);
		process.exitCode = 1;
	}
} else {
	console.log(JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 7 }] }] }], detached: [] }));
}
`,
		);
		await fs.chmod(executable, 0o755);
		const client = new TernPaneClient({ pane: 1, socketPath: "test-socket" }, temp.path(), executable);
		await client.close(3);
		await client.close(3);
		await expect(client.close(7)).rejects.toThrow("could not close 7");
	},
);
