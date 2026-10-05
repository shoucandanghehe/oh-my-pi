import { PtySession } from "@oh-my-pi/pi-natives";
import { filterProcessEnv } from "@oh-my-pi/pi-utils";
import { NATIVE_PANE_WORKER_ARG } from "../../cli/worker-selectors";
import { resolveCliEntryCmd, SMOKE_TEST_TIMEOUT_MS } from "../../subprocess/worker-client";
import type { NativePaneToHost, NativePaneToRelay } from "./protocol";

/** Exercise CLI re-entry, the relay module graph, PTY output and graceful shutdown. */
export async function smokeTestNativePaneRelay(): Promise<void> {
	const marker = "native-pane-relay-smoke-output";
	const token = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).pathname !== `/${token}`) return new Response(null, { status: 404 });
			if (server.upgrade(request)) return undefined;
			return new Response(null, { status: 400 });
		},
		websocket: {
			message(socket, payload) {
				const message: NativePaneToHost = JSON.parse(String(payload));
				if (message.type !== "state") return;
				const write: NativePaneToRelay = { type: "write", data: `${marker}\n` };
				const stop: NativePaneToRelay = { type: "stop" };
				socket.send(JSON.stringify(write));
				socket.send(JSON.stringify(stop));
			},
		},
	});
	const terminal = new PtySession();
	const [application, ...args] = resolveCliEntryCmd();
	let output = "";
	try {
		const result = await terminal.startArgv(
			{
				application: application!,
				args: [...args, NATIVE_PANE_WORKER_ARG, `ws://127.0.0.1:${server.port}/${token}`],
				// PtySession overlays env on the parent rather than replacing it.
				// Explicitly clear the test marker so the real terminal emits output.
				env: filterProcessEnv({ ...process.env, PI_TEST_RUNTIME: "0" }),
				cols: 100,
				rows: 30,
				timeoutMs: SMOKE_TEST_TIMEOUT_MS,
			},
			(error, chunk) => {
				if (error) throw error;
				output += chunk;
			},
		);
		if (result.exitCode !== 0 || !output.includes(marker)) {
			throw new Error(`Native pane relay smoke failed (${result.exitCode}): ${output}`);
		}
	} finally {
		server.stop(true);
	}
}
