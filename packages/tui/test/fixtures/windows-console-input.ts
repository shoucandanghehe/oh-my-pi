import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { ProcessTerminalInput } from "../../src/driver/process/terminal-input";
import {
	runWindowsConsoleInputWorker,
	WINDOWS_CONSOLE_INPUT_WORKER_ARG,
} from "../../src/driver/process/windows-console-input";

if (process.argv[2] === WINDOWS_CONSOLE_INPUT_WORKER_ARG) {
	runWindowsConsoleInputWorker();
} else {
	declareWorkerHostEntry();
	const terminal = new ProcessTerminalInput({ write: text => process.stdout.write(text) });
	let pasted: string | undefined;
	let arrow = false;
	let restarted = false;
	const announce = (phase: string): void => {
		if (process.stdin.listenerCount("data") !== 0) throw new Error("Bun stdin is competing for console input");
		process.stdout.write(`\n${phase}\n`);
	};
	terminal.onInput(event => {
		if (event.type === "paste") pasted = event.paste.text;
		if (event.type !== "key") return;
		if (event.key.id === "left") arrow = true;
		if (!restarted && event.key.text === "!") {
			terminal.stop();
			process.stdout.write(`\nPASTE:${pasted?.length}:${pasted?.slice(-2)}:${arrow}\n`);
			restarted = true;
			void terminal.start().then(() => announce("RESUMED"));
		}
		if (restarted && event.key.id === "q") {
			terminal.stop();
			process.stdout.write("\nAFTER:q\n");
		}
	});
	terminal.onResize((cols, rows) => {
		if (cols === 96 && rows === 32) process.stdout.write("\nRESIZED\n");
	});
	void terminal.start().then(() => announce("READY"));
}
