import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// A private ConPTY, not the desktop terminal or system clipboard.
test.skipIf(process.platform !== "win32")(
	"compiled console worker reads resize, paste and keys, then hands back the console",
	async () => {
		using temp = TempDir.createSync("@omp-console-worker-");
		const binary = path.join(temp.path(), "console.exe");
		const fixture = path.resolve(import.meta.dir, "../fixtures/windows-console-input.ts");
		const build = Bun.spawn(
			[process.execPath, "build", "--compile", "--target=bun", `--outfile=${binary}`, fixture],
			{
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		const [buildExit, buildError] = await Promise.all([build.exited, new Response(build.stderr).text()]);
		expect(buildExit, buildError).toBe(0);

		let phase = "start";
		let output = "";
		const decode = new TextDecoder();
		const drained = Promise.withResolvers<void>();
		const proc = Bun.spawn([binary], {
			env: {
				...process.env,
				PI_TEST_RUNTIME: undefined,
				BUN_ENV: undefined,
				NODE_ENV: undefined,
				TERM_PROGRAM: undefined,
				TERM: "xterm-256color",
				PI_TUI_NATIVE: "0",
			},
			signal: AbortSignal.timeout(20_000),
			terminal: {
				cols: 80,
				rows: 25,
				data(terminal, bytes) {
					output += decode.decode(bytes, { stream: true });
					if (phase === "start" && output.includes("READY")) {
						phase = "resize";
						terminal.resize(96, 32);
					}
					if (phase === "resize" && output.includes("RESIZED")) {
						phase = "paste";
						const paste = `\x1b[200~${"x".repeat(1_000_000)}\x1b[201~\x1b[D!`;
						for (let offset = 0; offset < paste.length; offset += 8192) {
							terminal.write(paste.slice(offset, offset + 8192));
						}
					}
					if (phase === "paste" && output.includes("RESUMED")) {
						phase = "resumed";
						terminal.write("q");
						return;
					}
					if (phase === "resumed" && output.includes("AFTER:q")) drained.resolve();
				},
				exit() {
					drained.resolve();
				},
			},
		});
		try {
			expect(await proc.exited, `${phase}: ${output.slice(-1000)}`).toBe(0);
			await drained.promise;
			expect(output).toContain("PASTE:1000000:xx:true");
			expect(output).toContain("AFTER:q");
		} finally {
			proc.terminal?.close();
		}
	},
	60_000,
);
