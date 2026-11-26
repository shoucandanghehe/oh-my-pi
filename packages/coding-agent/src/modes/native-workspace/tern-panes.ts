import * as path from "node:path";
import { $which, isWsl, windowsPathToWslMount } from "@oh-my-pi/pi-utils";
import { compareVersions } from "@oh-my-pi/pi-utils/version";
import { $ } from "bun";
import { resolveCliEntryCmd } from "../../subprocess/worker-client";
import type { TernPane } from "../../tools/browser/tern/kind";
import { NATIVE_PANE_WORKER_ARG } from "./protocol";

export interface TernPanePlacement {
	block: number;
	dir: "right" | "down";
}

export interface TernPaneMove {
	block: number;
	target: number;
	dir: "above" | "below" | "left-of" | "right-of";
}

export interface TernSplitPane {
	block: number;
	columns: number;
	rows: number;
	shown: boolean;
}

export interface TernPaneControls {
	open(endpoint: string, placement: TernPanePlacement): Promise<{ block: number }>;
	focus(block: number): Promise<void>;
	move(move: TernPaneMove): Promise<void>;
	focused(): Promise<number | undefined>;
	splitPanes(): Promise<TernSplitPane[]>;
	close(block: number): Promise<void>;
	balance(): Promise<void>;
}

interface TernPaneListing {
	sessions: {
		shown: boolean;
		tabs: {
			shown: boolean;
			blocks: { id: number; cols: number; rows: number; focused: boolean; pip?: object }[];
		}[];
	}[];
	detached: { id: number }[];
}

interface TernPluginCatalog {
	plugins: { id: string; version: string; status: "ready" | "disabled" | { failed: string } }[];
}

/** Tern runs a launch through the configured shell, not directly as an argv vector. */
export function formatTernWindowsLaunch(command: readonly string[]): string {
	const invocation = `& ${command.map(argument => `'${argument.replaceAll("'", "''")}'`).join(" ")}; exit $LASTEXITCODE`;
	const encoded = Buffer.from(invocation, "utf16le").toString("base64");
	return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/** Window-targeted controls not exposed by the browser/fork daemon transport. */
export class TernPaneClient implements TernPaneControls {
	constructor(
		readonly pane: TernPane,
		readonly cwd: string,
		readonly executable?: string,
		readonly launchPrefix?: readonly string[],
	) {}

	async open(endpoint: string, placement: TernPanePlacement): Promise<{ block: number }> {
		const executable = await this.#executable();
		const windows = process.platform === "win32" || (isWsl() && /\.(exe|com)$/i.test(executable));
		let command = this.launchPrefix ? [...this.launchPrefix] : resolveCliEntryCmd();
		if (!this.launchPrefix && isWsl() && windows) {
			command = ["wsl.exe", "--distribution", process.env.WSL_DISTRO_NAME!, "--cd", this.cwd, "--exec", ...command];
		}
		const launch = [...command, NATIVE_PANE_WORKER_ARG, endpoint];
		const result = await this.#run(executable, [
			"split",
			String(placement.block),
			placement.dir,
			"--json",
			"--",
			...(windows ? [formatTernWindowsLaunch(launch)] : launch),
		]);
		if (result.exitCode !== 0)
			throw new Error(result.stderr.toString().trim() || "Tern could not open the workspace pane");
		return result.json() as { block: number };
	}

	async focus(block: number): Promise<void> {
		const result = await this.#run(await this.#executable(), ["focus", String(block)]);
		if (result.exitCode !== 0)
			throw new Error(result.stderr.toString().trim() || "Tern could not focus the workspace pane");
	}

	async move({ block, target, dir }: TernPaneMove): Promise<void> {
		const result = await this.#run(await this.#executable(), ["move", String(block), dir, String(target)]);
		if (result.exitCode !== 0)
			throw new Error(result.stderr.toString().trim() || "Tern could not move the workspace pane");
	}

	async focused(): Promise<number | undefined> {
		const listing = await this.#listing();
		return listing.sessions
			.find(session => session.shown)
			?.tabs.find(tab => tab.shown)
			?.blocks.find(block => block.focused)?.id;
	}

	async splitPanes(): Promise<TernSplitPane[]> {
		const listing = await this.#listing();
		return listing.sessions.flatMap(session =>
			session.tabs
				.filter(tab => tab.blocks.some(block => block.id === this.pane.pane))
				.flatMap(tab =>
					tab.blocks
						.filter(block => block.pip === undefined)
						.map(block => ({
							block: block.id,
							columns: block.cols,
							rows: block.rows,
							shown: session.shown && tab.shown,
						})),
				),
		);
	}

	async close(block: number): Promise<void> {
		const result = await this.#run(await this.#executable(), ["close", String(block)]);
		if (result.exitCode === 0) return;
		// A relay exit or another window may already have removed the pane.
		const listing = await this.#listing();
		const present =
			listing.sessions.some(session => session.tabs.some(tab => tab.blocks.some(pane => pane.id === block))) ||
			listing.detached.some(pane => pane.id === block);
		if (present) throw new Error(result.stderr.toString().trim() || "Tern could not close the workspace pane");
	}

	async balance(): Promise<void> {
		const executable = await this.#executable();
		const catalog = await this.#run(executable, ["plugin", "list", "--json"]);
		if (catalog.exitCode !== 0) throw new Error(catalog.stderr.toString().trim() || "Tern could not list plugins");
		const plugin = (catalog.json() as TernPluginCatalog).plugins.find(plugin => plugin.id === "omp-workspace");
		if (plugin?.status !== "ready" || compareVersions(plugin.version, "0.2.0") < 0) return;
		const result = await this.#run(executable, ["ctl", "open-url", `omp-workspace://balance/${this.pane.pane}`]);
		if (result.exitCode !== 0)
			throw new Error(
				result.stderr.toString().trim() || result.text().trim() || "Tern could not balance workspace panes",
			);
	}

	async #listing(): Promise<TernPaneListing> {
		const result = await this.#run(await this.#executable(), ["ls", "--json"]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Tern could not list panes");
		return result.json() as TernPaneListing;
	}

	#run(executable: string, args: readonly string[]) {
		// WSL interop must not consume Main's own terminal input.
		return $`${executable} ${args} < ${new Uint8Array()}`.cwd(this.cwd).quiet().nothrow();
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
