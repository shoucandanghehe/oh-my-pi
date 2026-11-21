import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { ProcessTerminal } from "../../src/terminal";
import { runWindowsConsoleInputWorker, WINDOWS_CONSOLE_INPUT_WORKER_ARG } from "../../src/windows-console-input";

if (process.argv[2] === WINDOWS_CONSOLE_INPUT_WORKER_ARG) {
	runWindowsConsoleInputWorker();
} else {
	declareWorkerHostEntry();
	const terminal = new ProcessTerminal();
	let pasted: string | undefined;
	let arrow = false;
	terminal.start(
		sequence => {
			if (sequence.startsWith("\x1b[200~") && sequence.endsWith("\x1b[201~")) {
				pasted = sequence.slice(6, -6);
			}
			if (sequence === "\x1b[D") arrow = true;
			if (sequence !== "!") return;
			terminal.stop();
			process.stdout.write(`\nPASTE:${pasted?.length}:${pasted?.slice(-2)}:${arrow}\n`);
			terminal.start(
				key => {
					if (key !== "q") return;
					terminal.stop();
					process.stdout.write(`\nAFTER:${key}\n`);
				},
				() => {},
			);
			terminal.write("\nRESUMED\n");
		},
		() => {
			if (terminal.columns === 96 && terminal.rows === 32) terminal.write("\nRESIZED\n");
		},
	);
	terminal.write("\nREADY\n");
}
