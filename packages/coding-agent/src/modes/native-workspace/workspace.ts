import { createRoot, HELLO_CONFIRM_MS, type Host, type UiNode, type WorkspaceSurface } from "@oh-my-pi/pi-tui";
import type { InputEvent, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import { CURSOR_HIDE } from "@oh-my-pi/pi-tui/driver/output/ansi";
import { NativeSurfaces, TspConnection } from "@oh-my-pi/pi-tui/native/index";
import { logger } from "@oh-my-pi/pi-utils";
import type { Server, ServerWebSocket } from "bun";
import { resolveTernPane } from "../../tools/browser/tern/kind";
import type { NativePaneToHost } from "./protocol";
import { RemoteTerminal } from "./remote-terminal";
import { type CellSize, SplitLayout } from "./split-layout";
import { TernPaneClient, type TernPaneControls, type TernPanePlacement, type TernSplitPane } from "./tern-panes";

export type NativeWorkspaceSurface = WorkspaceSurface;

export interface NativeWorkspaceView extends NativeWorkspaceSurface {
	readonly driver: TerminalDriver;
	/** Route an event directly, bypassing the pane's intercept (as in Host.dispatch). */
	dispatch(event: InputEvent): void;
	redescribe(node: UiNode): void;
}

interface PaneEntry {
	key: string;
	token: string;
	driver: RemoteTerminal;
	opening: Promise<NativeWorkspaceView>;
	onClose: () => void;
	block?: number;
	socket?: ServerWebSocket<PaneEntry>;
	connection?: TspConnection;
	mount?: NativeWorkspaceSurface;
	view?: NativeWorkspaceView;
	stopRenderer?: () => void;
}

const DEFAULT_CELL: CellSize = { w: 9, h: 18 };
const RELAY_TIMEOUT_MS = 10_000;

/** Main owns every surface; each relay owns only its pane's process terminal. */
export class NativeWorkspace {
	readonly #panes = new Map<string, PaneEntry>();
	#server: Server<PaneEntry> | undefined;
	#placementTail = Promise.resolve();
	#layout: SplitLayout | undefined;
	#balanceScheduled = false;

	constructor(
		readonly client: TernPaneControls,
		readonly main: number,
		readonly mainCell: () => CellSize = () => DEFAULT_CELL,
	) {}

	static fromEnvironment(cwd: string, mainHost?: Pick<Host, "driver">): NativeWorkspace | undefined {
		const pane = resolveTernPane();
		return pane
			? new NativeWorkspace(
					new TernPaneClient(pane, cwd),
					pane.pane,
					() => mainHost?.driver.capabilities.cell ?? DEFAULT_CELL,
				)
			: undefined;
	}

	async open(
		key: string,
		title: string,
		create: (
			close: () => void,
			supports: (kind: string) => boolean,
			driver: TerminalDriver,
		) => NativeWorkspaceSurface,
		onClose: () => void,
		preserveFocus = false,
	): Promise<NativeWorkspaceView> {
		const existing = this.#panes.get(key);
		if (existing) {
			const view = await existing.opening;
			if (!preserveFocus)
				await this.#mutate(async () => {
					this.#requireOpen(existing);
					await this.client.focus(existing.block!);
				});
			this.#requireOpen(existing);
			return view;
		}
		const entry: PaneEntry = {
			key,
			token: crypto.randomUUID(),
			driver: new RemoteTerminal(message => entry.socket?.send(JSON.stringify(message))),
			opening: Promise.resolve().then(() => this.#open(entry, title, create, preserveFocus)),
			onClose,
		};
		this.#panes.set(key, entry);
		return entry.opening;
	}

	async #open(
		entry: PaneEntry,
		title: string,
		create: (
			close: () => void,
			supports: (kind: string) => boolean,
			driver: TerminalDriver,
		) => NativeWorkspaceSurface,
		preserveFocus: boolean,
	): Promise<NativeWorkspaceView> {
		let timer: Timer | undefined;
		const driver = entry.driver;
		const connected = driver.start().finally(() => clearTimeout(timer));
		// A relay can disconnect before the split command returns.
		void connected.catch(() => {});
		try {
			this.#requireOpen(entry);
			const server = this.#listen();
			await this.#mutate(async () => {
				this.#requireOpen(entry);
				const previousFocus = preserveFocus ? await this.client.focused() : undefined;
				const listed = await this.client.splitPanes();
				const layout = this.#layoutFor(listed);
				const aboveMain = entry.key === "btw" && listed.filter(pane => pane.block !== this.main).length >= 2;
				const placement: TernPanePlacement = aboveMain ? { block: this.main, dir: "down" } : layout.next();
				this.#requireOpen(entry);
				// Waiting for other panes' placement does not consume this relay's connection budget.
				timer = setTimeout(() => {
					void driver.stop(new Error("Native workspace pane did not connect within 10 seconds"));
				}, RELAY_TIMEOUT_MS);
				timer.unref();
				const { block } = await this.client.open(`ws://127.0.0.1:${server.port}/${entry.token}`, placement);
				if (this.#panes.get(entry.key) !== entry) {
					this.#closePane(block);
					this.#requireOpen(entry);
				}
				entry.block = block;
				const moves = aboveMain
					? [{ block, target: this.main, dir: "above" as const }]
					: layout.add(placement, block);
				for (const move of moves) await this.client.move(move);
				this.#requireOpen(entry);
				if (previousFocus !== undefined) await this.client.focus(previousFocus);
				else if (!preserveFocus) await this.client.focus(block);
				this.#scheduleBalance();
			});

			await connected;
			this.#requireOpen(entry);
			const connection = await TspConnection.connect(driver, {
				timeout: HELLO_CONFIRM_MS,
				settled: listener => driver.onClose(listener),
			});
			if (!connection) throw new Error("The workspace pane did not negotiate TSP");
			entry.connection = connection;
			this.#requireOpen(entry);

			const mount = create(
				() => this.#close(entry),
				capability =>
					capability === "scroll" ? connection.hasFeature(capability) : connection.supports(capability),
				driver,
			);
			if (this.#panes.get(entry.key) !== entry) {
				mount.surface.dispose();
				mount.dispose?.();
				this.#requireOpen(entry);
			}
			entry.mount = mount;
			const renderer = createRoot(dispose => {
				// Each pane shows a session: Tern styles it as it styles Main's (`omp.session`).
				const surfaces = new NativeSurfaces({ ...mount, title, role: "omp.session" });
				entry.stopRenderer = () => {
					try {
						surfaces.stop(false);
					} finally {
						dispose();
					}
				};
				return surfaces;
			});
			const view: NativeWorkspaceView = {
				...mount,
				driver,
				dispatch: event => {
					if (this.#panes.get(entry.key) === entry) renderer.dispatch(event);
				},
				redescribe: node => renderer.redescribe(node),
			};
			entry.view = view;
			renderer.start(connection);
			driver.writeRaw(CURSOR_HIDE);
			driver.setTitle(title);
			driver.releaseInput();
			this.#requireOpen(entry);
			return view;
		} catch (error) {
			this.#close(entry);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	has(key: string): boolean {
		return this.#panes.has(key);
	}

	get(key: string): NativeWorkspaceView | undefined {
		return this.#panes.get(key)?.view;
	}

	async isFocused(key: string): Promise<boolean> {
		const block = this.#panes.get(key)?.block;
		return block !== undefined && (await this.client.focused()) === block;
	}

	close(key: string): void {
		const entry = this.#panes.get(key);
		if (entry) this.#close(entry);
	}

	dispose(): void {
		for (const entry of this.#panes.values()) this.#close(entry);
	}

	#requireOpen(entry: PaneEntry): void {
		if (this.#panes.get(entry.key) !== entry)
			throw new Error("Native workspace view closed while opening or focusing");
	}

	#close(entry: PaneEntry): void {
		if (this.#panes.get(entry.key) !== entry) return;
		this.#panes.delete(entry.key);
		const block = entry.block;
		if (block !== undefined) this.#closePane(block);
		try {
			entry.stopRenderer?.();
		} finally {
			entry.connection?.close();
			void entry.driver.stop();
			if (this.#panes.size === 0) {
				this.#server?.stop();
				this.#server = undefined;
			}
			try {
				entry.mount?.surface.dispose();
				entry.mount?.dispose?.();
			} finally {
				entry.onClose();
			}
		}
	}

	/** Re-measure visible Main only after its workspace panes have closed. */
	#layoutFor(listed: readonly TernSplitPane[]): SplitLayout {
		const present = new Set(listed.map(pane => pane.block));
		for (const block of this.#layout?.agents ?? []) {
			if (!present.has(block)) this.#layout?.remove(block);
		}
		const btw = this.#panes.get("btw")?.block;
		if (this.#layout && (this.#layout.agents.length || (btw !== undefined && present.has(btw)))) return this.#layout;
		const main = listed.find(pane => pane.block === this.main);
		if (!main) throw new Error("Tern did not list the Main pane");
		if (!this.#layout || main.shown) this.#layout = new SplitLayout(this.main, main, this.mainCell());
		return this.#layout;
	}

	#closePane(block: number): void {
		void this.#mutate(async () => {
			this.#layout?.remove(block);
			await this.client.close(block);
			this.#scheduleBalance();
		}).catch(error => logger.warn("Could not close native pane", { error: String(error) }));
	}

	#scheduleBalance(): void {
		if (this.#balanceScheduled) return;
		this.#balanceScheduled = true;
		setImmediate(() => {
			void this.#mutate(async () => {
				this.#balanceScheduled = false;
				const moves = this.#layout?.reflow() ?? [];
				if (moves.length > 0) {
					const focused = await this.client.focused();
					try {
						for (const move of moves) await this.client.move(move);
					} finally {
						if (focused !== undefined) await this.client.focus(focused);
					}
				}
				await this.client.balance();
			}).catch(error => logger.warn("Could not balance native workspace panes", { error: String(error) }));
		});
	}

	/** Serialize changes to Tern's block tree, but not handshakes and surface mounts. */
	#mutate(change: () => Promise<void>): Promise<void> {
		const pending = this.#placementTail.then(change);
		this.#placementTail = pending.catch(() => {});
		return pending;
	}

	#listen(): Server<PaneEntry> {
		this.#server ??= Bun.serve<PaneEntry>({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request, server) => {
				const token = new URL(request.url).pathname.slice(1);
				const entry = [...this.#panes.values()].find(pane => pane.token === token);
				if (!entry || entry.socket) return new Response(null, { status: 404 });
				if (server.upgrade(request, { data: entry })) return undefined;
				return new Response(null, { status: 400 });
			},
			websocket: {
				open: socket => {
					const entry = socket.data;
					if (this.#panes.get(entry.key) !== entry || entry.socket) socket.close();
					else entry.socket = socket;
				},
				message: (socket, payload) => {
					if (socket.data.socket !== socket) return;
					const message: NativePaneToHost = JSON.parse(String(payload));
					socket.data.driver.accept(message);
				},
				close: socket => {
					const entry = socket.data;
					if (entry.socket !== socket) return;
					entry.socket = undefined;
					entry.driver.disconnect(new Error("Native workspace pane disconnected"));
					this.#close(entry);
				},
			},
		});
		return this.#server;
	}
}
