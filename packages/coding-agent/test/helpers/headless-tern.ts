import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { $which, isEnoent, type TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const element = type({ "text?": "string", "title?": "string", rect: ["number", "number", "number", "number"] });
const reply = type({ ok: "boolean", "error?": "string", "nodes?": element.array() });
export type TernElement = typeof element.infer;

const tern = $which("tern");
const available = Boolean(tern) && process.platform !== "win32";
export const skipWithoutTern = !available && Bun.env.OMP_REQUIRE_TERN !== "1";

/** Starts a private Tern, without inheriting the user's pane, desktop or credentials. */
export async function startHeadlessTern(dir: TempDir) {
	if (!tern || !available) throw new Error("test:tern requires Tern with `serve` and `ctl` on PATH and a POSIX shell");
	const socket = dir.join("control.sock");
	const env = {
		PATH: Bun.env.PATH,
		LANG: "en_US.UTF-8",
		SHELL: "/bin/sh",
		HOME: dir.join("home"),
		TERN_CONFIG_DIR: dir.join("tern"),
	};
	await fs.mkdir(env.HOME);
	const log = Bun.file(dir.join("server.log"));
	const server = Bun.spawn([tern, "serve", "--control", socket, "--out", dir.path()], {
		cwd: dir.path(),
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: log,
		timeout: 90_000,
	});

	async function ctl(...args: string[]) {
		const response = await $`${tern} ctl --control ${socket} ${args}`.env(env).quiet();
		const data = reply.assert(response.json());
		if (!data.ok) throw new Error(`${args[0]}: ${data.error}`);
		return data;
	}
	async function close() {
		if (server.exitCode === null) await ctl("quit").catch(() => server.kill());
		await server.exited;
	}
	try {
		const deadline = performance.now() + 10_000;
		for (;;) {
			try {
				await fs.access(socket);
				break;
			} catch (error) {
				if (!isEnoent(error) || performance.now() >= deadline || server.exitCode !== null) throw error;
				await Bun.sleep(25);
			}
		}
		await ctl("size", "1200", "800", "2");
		await ctl("ready");
	} catch (error) {
		await close();
		throw error;
	}

	return {
		env,
		log,
		server,
		ctl,
		async visible(
			selector: string,
			match: (node: TernElement) => boolean,
			description: string,
		): Promise<TernElement> {
			const deadline = performance.now() + 10_000;
			let nodes: TernElement[] = [];
			do {
				nodes = (await ctl("tree", selector)).nodes ?? [];
				const found = nodes.find(match);
				if (found) return found;
				await Bun.sleep(25);
			} while (performance.now() < deadline && server.exitCode === null);
			throw new Error(`Expected ${description}; visible ${selector}: ${JSON.stringify(nodes).slice(0, 1000)}`);
		},
		click({ rect: [x, y, w, h] }: TernElement, button?: "right") {
			return ctl("click", String(x + w / 2), String(y + h / 2), ...(button ? [button] : []));
		},
		enterText: (text: string) => ctl("type", JSON.stringify(text)),
		[Symbol.asyncDispose]: close,
	};
}
