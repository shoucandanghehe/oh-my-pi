import { expect, test } from "bun:test";

test.skipIf(process.platform !== "win32")(
	"keeps a large console paste, its trailing keys, and input after a terminal restart intact",
	async () => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const decode = new TextDecoder();
		let output = "";
		let phase = "start";
		const proc = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/windows-console-input.ts`], {
			env: {
				...process.env,
				PI_TEST_RUNTIME: undefined,
				BUN_ENV: undefined,
				NODE_ENV: undefined,
				TERM_PROGRAM: undefined,
				TERM: "xterm-256color",
				PI_TUI_NATIVE: "0",
			},
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
					}
					if (phase === "resumed" && /AFTER:.*\r?\n/u.test(output)) resolve();
				},
			},
		});
		// Bound the real ConPTY child as well as the test runner.
		const deadline = setTimeout(() => {
			reject(new Error(`Console did not finish ${phase}: ${output}`));
			proc.kill();
		}, 15_000);
		void proc.exited.then(code => {
			if (code !== 0) reject(new Error(`Console exited early (${code}): ${output}`));
		});
		try {
			await promise;
			expect(output).toContain("PASTE:1000000:xx:true");
			expect(output).toContain("AFTER:q");
			expect(await proc.exited).toBe(0);
		} finally {
			clearTimeout(deadline);
			if (proc.exitCode === null) proc.kill();
			proc.terminal?.close();
			await proc.exited;
		}
	},
	20_000,
);
