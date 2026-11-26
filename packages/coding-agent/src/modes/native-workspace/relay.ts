import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import type { NativePaneToHost, NativePaneToRelay } from "./protocol";

/** Own only this pane's PTY. The parent process owns TSP and the UI; no session is loaded here. */
export async function runNativePaneRelay(endpoint: string): Promise<void> {
	const driver = createTerminalDriver();
	const socket = new WebSocket(endpoint);
	const done = Promise.withResolvers<void>();
	let stopping: Promise<void> | undefined;
	let ready = false;
	const send = (message: NativePaneToHost): void => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};
	const stop = (error?: unknown): void => {
		stopping ??= (async () => {
			try {
				await driver.stop();
				if (error === undefined) done.resolve();
				else done.reject(error);
			} catch (stopError) {
				done.reject(error ?? stopError);
			} finally {
				socket.close();
			}
		})();
	};
	driver.onInput(event => send({ type: "input", event }));
	driver.onResize((columns, rows) => {
		if (ready) send({ type: "resize", columns, rows });
	});
	driver.onCapabilities(capabilities => {
		if (ready) send({ type: "capabilities", capabilities });
	});
	driver.onDisconnect(() => stop());
	socket.addEventListener("open", () => {
		void driver
			.start()
			.then(() => {
				if (stopping) return;
				const { columns, rows, capabilities } = driver;
				ready = true;
				send({ type: "ready", state: { columns, rows, capabilities } });
			})
			.catch(stop);
	});
	socket.addEventListener("message", event => {
		if (stopping) return;
		try {
			const message: NativePaneToRelay = JSON.parse(String(event.data));
			switch (message.type) {
				case "write":
					driver.writeRaw(message.data);
					break;
				case "title":
					driver.setTitle(message.title);
					break;
				case "stop":
					stop();
					break;
			}
		} catch (error) {
			stop(error);
		}
	});
	socket.addEventListener("close", () => stop());
	socket.addEventListener("error", () => stop(new Error("Native workspace pane could not connect to Main")));
	await done.promise;
}
