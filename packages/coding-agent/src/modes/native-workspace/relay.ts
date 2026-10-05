import { ProcessTerminal, type Terminal } from "@oh-my-pi/pi-tui/terminal";
import type { NativePaneTerminalState, NativePaneToHost, NativePaneToRelay } from "./protocol";

/** The pane process owns only its PTY; components and agent runtimes stay in Main. */
export async function runNativePaneRelay(endpoint: string, terminal: Terminal = new ProcessTerminal()): Promise<void> {
	const socket = new WebSocket(endpoint);
	const done = Promise.withResolvers<void>();
	let stopping: Promise<void> | undefined;
	const send = (message: NativePaneToHost): void => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};
	const state = (): NativePaneTerminalState => ({
		columns: terminal.columns,
		rows: terminal.rows,
		kittyProtocolActive: terminal.kittyProtocolActive,
		kittyEnableSequence: terminal.kittyEnableSequence,
		keyboardEnhancementEnterSequence: terminal.keyboardEnhancementEnterSequence ?? null,
		keyboardEnhancementExitSequence: terminal.keyboardEnhancementExitSequence ?? null,
		hostOwnsGridOnResize: terminal.hostOwnsGridOnResize ?? false,
		appearance: terminal.appearance,
	});
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			await terminal.drainInput();
			terminal.stop();
			socket.close();
			done.resolve();
		})();
		return stopping;
	};
	socket.addEventListener("open", () => {
		terminal.onTspHello?.(hello => send({ type: "hello", hello }));
		terminal.onAppearanceChange((appearance, token) => send({ type: "appearance", appearance, token }));
		terminal.start(
			data => send({ type: "input", data }),
			() => send({ type: "state", state: state() }),
			() => void stop(),
		);
		send({ type: "state", state: state() });
	});
	socket.addEventListener("message", event => {
		const message: NativePaneToRelay = JSON.parse(String(event.data));
		switch (message.type) {
			case "write":
				terminal.write(message.data);
				break;
			case "stop":
				void stop();
				break;
			case "move":
				terminal.moveBy(message.lines);
				break;
			case "hide-cursor":
				terminal.hideCursor(message.force);
				break;
			case "show-cursor":
				terminal.showCursor(message.force);
				break;
			case "clear-line":
				terminal.clearLine();
				break;
			case "clear-from-cursor":
				terminal.clearFromCursor();
				break;
			case "clear-screen":
				terminal.clearScreen();
				break;
			case "title":
				terminal.setTitle(message.title);
				break;
			case "progress":
				terminal.setProgress(message.active);
				break;
			case "refresh-appearance":
				terminal.refreshAppearance?.(message.token);
				break;
		}
	});
	socket.addEventListener("close", () => void stop());
	socket.addEventListener("error", () => {
		done.reject(new Error("Native workspace pane could not connect to Main"));
		void stop();
	});
	await done.promise;
}
