import type { AnsiWorkspace } from "@oh-my-pi/pi-tui";
import { type NativeClock, SYSTEM_CLOCK } from "@oh-my-pi/pi-tui/native/connection";
import type { RegistryEvent } from "../../registry/agent-registry";
import type { AgentWorkspaceSurface } from "../agent-workspace-pane";
import type { NativeWorkspace } from "../native-workspace/workspace";

interface AgentPane {
	manual: boolean;
	protect?: () => boolean;
	cancelClose?: () => void;
}

interface NativeAgentPaneOptions {
	workspace: Pick<NativeWorkspace, "open" | "get" | "isFocused" | "close"> | AnsiWorkspace;
	create(id: string, close: () => void, rows: () => number, writeRaw?: (data: string) => void): AgentWorkspaceSurface;
	isRunning(id: string): boolean;
	error(error: unknown): void;
	clock?: NativeClock;
}

const CLOSE_GRACE_MS = 3000;

/** Follow the running roster without reopening a dismissed pane or auto-closing a pinned one. */
export class NativeAgentPanes {
	readonly #panes = new Map<string, AgentPane>();
	readonly #dismissed = new Set<string>();
	#generation = 0;

	constructor(readonly options: NativeAgentPaneOptions) {}

	handle(event: RegistryEvent): void {
		const { ref } = event;
		if (ref.kind !== "sub" || event.type === "metadata_changed") return;
		const pane = this.#panes.get(ref.id);
		const running = event.type !== "removed" && ref.status === "running";
		if (running) {
			if (pane) {
				pane.cancelClose?.();
				pane.cancelClose = undefined;
			} else if (!this.#dismissed.has(ref.id)) {
				void this.#open(ref.id, false).catch(this.options.error);
			}
			return;
		}
		this.#dismissed.delete(ref.id);
		if (pane) this.#scheduleClose(ref.id, pane);
	}

	open(id: string): Promise<void> {
		return this.#open(id, true);
	}

	async #open(id: string, manual: boolean): Promise<void> {
		let pane = this.#panes.get(id);
		if (pane) {
			if (!manual) return;
			pane.manual = true;
			pane.cancelClose?.();
			pane.cancelClose = undefined;
		} else {
			pane = { manual };
			this.#panes.set(id, pane);
		}
		const entry = pane;
		const generation = this.#generation;
		const { workspace } = this.options;
		const key = `agent:${id}`;
		try {
			const onClose = () => {
				if (this.#panes.get(id) !== entry) return;
				entry.cancelClose?.();
				this.#panes.delete(id);
				if (this.options.isRunning(id)) this.#dismissed.add(id);
			};
			if ("get" in workspace) {
				await workspace.open(
					key,
					id,
					close => {
						const mounted = this.options.create(
							id,
							close,
							() => workspace.get(key)?.driver.rows ?? 24,
							data => workspace.get(key)?.driver.writeRaw(data),
						);
						entry.protect = mounted.protectedFromAutoClose;
						return mounted;
					},
					onClose,
					!manual,
				);
			} else {
				const opened = workspace.open(
					key,
					(close, rows) => {
						const mounted = this.options.create(id, close, rows);
						entry.protect = mounted.protectedFromAutoClose;
						return {
							...mounted,
							dispose: () => {
								try {
									mounted.dispose?.();
								} finally {
									onClose();
								}
							},
						};
					},
					{ label: id, focus: manual, minWidth: manual ? 24 : 36, minHeight: 6 },
				);
				if (!opened) {
					if (!entry.protect) this.#panes.delete(id);
					if (manual) throw new Error("The terminal is too small to open the agent pane");
					return;
				}
			}
			if (!this.options.isRunning(id) && this.#panes.get(id) === entry) this.#scheduleClose(id, entry);
		} catch (error) {
			const active = this.#panes.get(id);
			if (active === entry) this.#panes.delete(id);
			if (manual || generation === this.#generation) throw error;
		}
	}

	#scheduleClose(id: string, pane: AgentPane): void {
		if (pane.manual || !pane.protect || pane.protect() || pane.cancelClose) return;
		const { workspace } = this.options;
		const key = `agent:${id}`;
		const eligible = () =>
			this.#panes.get(id) === pane && !pane.manual && !pane.protect?.() && !this.options.isRunning(id);
		const focused = () => ("isFocused" in workspace ? workspace.isFocused(key) : workspace.active() === key);
		const arm = async (): Promise<void> => {
			if ((await focused()) || !eligible() || pane.cancelClose) return;
			pane.cancelClose = (this.options.clock ?? SYSTEM_CLOCK).setTimeout(() => {
				pane.cancelClose = undefined;
				void Promise.resolve(focused()).then(isFocused => {
					if (!isFocused && eligible()) workspace.close(key);
				}, this.options.error);
			}, CLOSE_GRACE_MS);
		};
		void arm().catch(this.options.error);
	}

	reset(): void {
		this.#generation++;
		const open = [...this.#panes];
		this.#panes.clear();
		this.#dismissed.clear();
		for (const [id, pane] of open) {
			pane.cancelClose?.();
			this.options.workspace.close(`agent:${id}`);
		}
	}
}
