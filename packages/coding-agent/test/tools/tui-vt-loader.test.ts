import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadVt } from "../../../../.omp/tools/tui";

test("VT loading recovers after a missing dependency is restored in the same module lifecycle", async () => {
	const dir = await fs.mkdtemp(path.join(import.meta.dir, ".vt-loader-"));
	const modulePath = path.join(dir, "index.js");
	try {
		const first = loadVt(modulePath);
		const concurrent = loadVt(modulePath);
		expect(concurrent).toBe(first);
		await expect(first).rejects.toThrow();
		await expect(concurrent).rejects.toThrow();

		const installedModule = path.resolve(import.meta.dir, "../../../../node_modules/kitty-vt-wasm/dist/index.js");
		await Bun.write(modulePath, `export * from ${JSON.stringify(installedModule)};`);
		const retry = loadVt(modulePath);
		expect(loadVt(modulePath)).toBe(retry);
		const vt = await retry;
		const terminal = await vt.KittyTerminal.create({ columns: 20, rows: 2 });
		try {
			terminal.write(new TextEncoder().encode("recovered"));
			expect(terminal.line(0).trimEnd()).toBe("recovered");
			await expect(first).rejects.toThrow("run `bun install` in the project root");
			await expect(first).rejects.toThrow(modulePath);
		} finally {
			terminal.dispose();
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
