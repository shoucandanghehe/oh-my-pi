import * as path from "node:path";
import { $ } from "bun";
import { $which, isWsl, windowsPathToWslMount } from "@oh-my-pi/pi-utils";
import { resolveCliEntryCmd } from "../../../subprocess/worker-client";
import { NATIVE_PANE_WORKER_ARG } from "../../../cli/worker-selectors";
import type { TernPane } from "./kind";

export interface TernSplitResult {
	session: number;
	tab: number;
	block: number;
}

export interface TernPanePlacement {
	block: number;
	dir: "right" | "down";
}

interface TernPaneListing {
	sessions: {
		shown: boolean;
		tabs: {
			shown: boolean;
			blocks: {
				id: number;
				focused: boolean;
				pip?: { owner: number; corner: string; stashed: string | null };
			}[];
		}[];
	}[];
}

/** Tern runs a launch through its configured shell, not directly as an argv vector. */
export function formatTernWindowsLaunch(command: readonly string[]): string {
	const invocation = `& ${command.map(argument => `'${argument.replaceAll("'", "''")}'`).join(" ")}; exit $LASTEXITCODE`;
	const encoded = Buffer.from(invocation, "utf16le").toString("base64");
	return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/**
 * Targeted pane controls, distinct from the browser/fork socket API.
 * Empty stdin prevents WSL interop from consuming the host pane's terminal input.
 */
export class TernPaneClient {
	constructor(
		readonly pane: TernPane,
		readonly cwd: string,
		readonly executable?: string,
		readonly launchPrefix?: readonly string[],
	) {}

	async open(
		endpoint: string,
		placement: TernPanePlacement = { block: this.pane.pane, dir: "right" },
	): Promise<TernSplitResult> {
		const executable = await this.#executable();
		const windows = process.platform === "win32" || (isWsl() && /\.(exe|com)$/i.test(executable));
		let command = this.launchPrefix ? [...this.launchPrefix] : resolveCliEntryCmd();
		if (!this.launchPrefix && isWsl() && windows) {
			command = ["wsl.exe", "--distribution", process.env.WSL_DISTRO_NAME!, "--cd", this.cwd, "--exec", ...command];
		}
		const launch = [...command, NATIVE_PANE_WORKER_ARG, endpoint];
		const result =
			await $`${executable} split ${String(placement.block)} ${placement.dir} --json -- ${windows ? [formatTernWindowsLaunch(launch)] : launch} < ${new Uint8Array()}`
				.cwd(this.cwd)
				.quiet()
				.nothrow();
		if (result.exitCode !== 0)
			throw new Error(result.stderr.toString().trim() || "Tern could not open the workspace pane");
		return JSON.parse(result.text()) as TernSplitResult;
	}

	async focus(block: number): Promise<void> {
		const executable = await this.#executable();
		const result = await $`${executable} focus ${String(block)} < ${new Uint8Array()}`
			.cwd(this.cwd)
			.quiet()
			.nothrow();
		if (result.exitCode !== 0)
			throw new Error(result.stderr.toString().trim() || "Tern could not focus the workspace pane");
	}

	async focused(): Promise<number | undefined> {
		const listing = await this.#listing();
		return listing.sessions
			.find(session => session.shown)
			?.tabs.find(tab => tab.shown)
			?.blocks.find(block => block.focused)?.id;
	}

	async isSplitPane(block: number): Promise<boolean> {
		const listing = await this.#listing();
		return listing.sessions.some(session =>
			session.tabs.some(tab => tab.blocks.some(candidate => candidate.id === block && candidate.pip === undefined)),
		);
	}

	async close(block: number): Promise<void> {
		const executable = await this.#executable();
		const result = await $`${executable} close ${String(block)} < ${new Uint8Array()}`
			.cwd(this.cwd)
			.quiet()
			.nothrow();
		if (result.exitCode !== 0)
			throw new Error(result.stderr.toString().trim() || "Tern could not close the workspace pane");
	}

	async #listing(): Promise<TernPaneListing> {
		const executable = await this.#executable();
		const result = await $`${executable} ls --json < ${new Uint8Array()}`.cwd(this.cwd).quiet().nothrow();
		if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Tern could not list panes");
		return JSON.parse(result.text()) as TernPaneListing;
	}

	async #executable(): Promise<string> {
		const executable = this.executable ?? $which("tern") ?? $which("tern.exe") ?? $which("tern.com");
		if (executable) return executable;
		if ((process.platform === "win32" || isWsl()) && process.env.LOCALAPPDATA) {
			const localAppData = isWsl()
				? (windowsPathToWslMount(process.env.LOCALAPPDATA) ?? process.env.LOCALAPPDATA)
				: process.env.LOCALAPPDATA;
			const installed = path.join(localAppData, "Programs", "Tern", "tern.exe");
			if (await Bun.file(installed).exists()) return installed;
		}
		throw new Error(
			isWsl()
				? "Native workspace requires the Tern CLI on PATH or LOCALAPPDATA forwarded through WSLENV (LOCALAPPDATA/pu)"
				: "Native workspace requires the Tern CLI on PATH",
		);
	}
}
