import type { Server, ServerWebSocket } from "bun";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import { getCellDimensions } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { resolveTernPane } from "../../tools/browser/tern/kind";
import { TernPaneClient, type TernSplitPane } from "../../tools/browser/tern/panes";
import type { NativePaneToHost } from "./protocol";
import { RemoteTerminal } from "./remote-terminal";
import { SplitLayout } from "./split-layout";

export interface NativeWorkspaceView {
	ui: TUI;
	component: Component;
}

interface PaneEntry {
	key: string;
	token: string;
	terminal: RemoteTerminal;
	socket?: ServerWebSocket<PaneEntry>;
	block?: number;
	view?: NativeWorkspaceView;
	opening: Promise<NativeWorkspaceView>;
	onClose: () => void;
	closed: Promise<void>;
	onClosed: () => void;
}

/** One Main-owned component tree per native pane; relays never load an agent session. */
export class NativeWorkspace {
	readonly #panes = new Map<string, PaneEntry>();
	#server: Server<PaneEntry> | undefined;
	#placementTail: Promise<void> | undefined;
	#layout: SplitLayout | undefined;
	#balanceScheduled = false;

	constructor(
		readonly client: Pick<TernPaneClient, "open" | "focus" | "focused" | "splitPanes" | "close" | "balance">,
		readonly main: number,
	) {}

	static fromEnvironment(cwd: string): NativeWorkspace | undefined {
		const pane = resolveTernPane();
		return pane ? new NativeWorkspace(new TernPaneClient(pane, cwd), pane.pane) : undefined;
	}

	async open(
		key: string,
		title: string,
		create: (ui: TUI, close: () => void) => Component,
		onClose: () => void,
		preserveFocus = false,
	): Promise<NativeWorkspaceView> {
		const existing = this.#panes.get(key);
		if (existing) {
			const view = await existing.opening;
			if (this.#panes.get(key) !== existing) throw new Error("Native workspace view closed while focusing");
			const block = existing.block;
			if (!preserveFocus && block !== undefined) {
				await this.#mutate(existing, () => this.client.focus(block));
			}
			return view;
		}
		const pending = Promise.withResolvers<NativeWorkspaceView>();
		const terminal = new RemoteTerminal(message => entry.socket?.send(JSON.stringify(message)));
		const closed = Promise.withResolvers<void>();
		const entry: PaneEntry = {
			key,
			token: crypto.randomUUID(),
			terminal,
			opening: pending.promise,
			onClose,
			closed: closed.promise,
			onClosed: closed.resolve,
		};
		this.#panes.set(key, entry);
		const server = this.#listen();
		let timer: Timer | undefined;
		const connected = terminal.ready.promise.finally(() => clearTimeout(timer));
		// Attach the rejection handler before launching, since a failed relay can close immediately.
		void connected.catch(() => {});
		try {
			await this.#mutate(entry, async () => {
				const previousFocus = preserveFocus ? await this.client.focused() : undefined;
				const layout = this.#layoutFor(await this.client.splitPanes());
				const placement = layout.next();
				if (this.#panes.get(key) !== entry) throw new Error("Native workspace view was closed while opening");
				// Queueing and placement queries are not part of this relay's connection budget.
				timer = setTimeout(
					() => terminal.ready.reject(new Error("Native workspace pane did not connect within 10 seconds")),
					10_000,
				);
				timer.unref();
				const result = await this.client.open(`ws://127.0.0.1:${server.port}/${entry.token}`, placement);
				entry.block = result.block;
				layout.add(placement, result.block);
				if (this.#panes.get(key) !== entry) {
					throw new Error("Native workspace view was closed while opening");
				}
				if (previousFocus !== undefined) await this.client.focus(previousFocus);
				else if (!preserveFocus) await this.client.focus(result.block);
				this.#scheduleBalance();
			});
			await connected;
			if (this.#panes.get(key) !== entry) throw new Error("Native workspace view was closed while connecting");
			const ui = new TUI(terminal, undefined, { debugServer: false });
			const component = create(ui, () => this.close(key));
			entry.view = { ui, component };
			const focused: Component = preserveFocus
				? {
						render: width => component.render(width),
						describe: () => node("col", { grow: 1 }, [component]),
						describeSurface: cx => component.describeSurface?.(cx) ?? { main: [component], dock: [] },
						handleInput: data => component.handleInput?.(data),
					}
				: component;
			ui.addChild(focused);
			ui.setFocus(focused);
			ui.start();
			terminal.setTitle(title);
			pending.resolve(entry.view);
			return entry.view;
		} catch (error) {
			pending.reject(error);
			void pending.promise.catch(() => {});
			if (this.#panes.get(key) === entry) this.close(key);
			else if (entry.block !== undefined) {
				this.#layout?.remove(entry.block);
				this.#closePane(entry.block);
			}
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
		if (!entry) return;
		this.#panes.delete(key);
		if (entry.block !== undefined) this.#layout?.remove(entry.block);
		entry.onClosed();
		entry.terminal.ready.reject(new Error("Native workspace view closed"));
		entry.view?.component.dispose?.();
		entry.view?.ui.stop();
		entry.terminal.stop();
		entry.onClose();
		if (entry.block !== undefined) this.#closePane(entry.block);
		if (this.#panes.size === 0) {
			this.#server?.stop();
			this.#server = undefined;
		}
	}

	dispose(): void {
		for (const key of this.#panes.keys()) this.close(key);
	}

	/** Hidden tabs retain old split sizes; re-measure empty layouts only while Main is shown. */
	#layoutFor(listed: readonly TernSplitPane[]): SplitLayout {
		const present = new Set(listed.map(pane => pane.block));
		for (const block of this.#layout?.agents ?? []) {
			if (!present.has(block)) this.#layout?.remove(block);
		}
		if (this.#layout?.agents.length) return this.#layout;
		const main = listed.find(pane => pane.block === this.main);
		if (!main) throw new Error("Tern did not list the Main pane");
		if (!this.#layout || main.shown) {
			this.#layout = new SplitLayout(this.main, main, this.#layout?.cell ?? getCellDimensions());
		}
		return this.#layout;
	}

	#closePane(block: number): void {
		void this.#mutate(undefined, () => this.client.close(block))
			.then(() => this.#scheduleBalance())
			.catch(error => logger.warn("Could not close native pane", { error: String(error) }));
	}

	#scheduleBalance(): void {
		if (this.#balanceScheduled) return;
		this.#balanceScheduled = true;
		setImmediate(() => {
			void this.#mutate(undefined, async () => {
				this.#balanceScheduled = false;
				await this.client.balance();
			}).catch(error => {
				this.#balanceScheduled = false;
				logger.warn("Could not balance native workspace panes", { error: String(error) });
			});
		});
	}

	/** Serialize Tern mutations, not relay connection; cancellation releases the next launch. */
	async #mutate(entry: PaneEntry | undefined, change: () => Promise<void>): Promise<void> {
		const previous = this.#placementTail;
		const finished = Promise.withResolvers<void>();
		const released = entry ? Promise.race([finished.promise, entry.closed]) : finished.promise;
		const tail = previous ? previous.then(() => released) : released;
		this.#placementTail = tail;
		try {
			if (previous) await previous;
			if (entry && this.#panes.get(entry.key) !== entry)
				throw new Error("Native workspace view closed before placement");
			await change();
		} finally {
			finished.resolve();
			if (this.#placementTail === tail) this.#placementTail = undefined;
		}
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
					socket.data.socket = socket;
				},
				message: (socket, payload) => {
					const message: NativePaneToHost = JSON.parse(String(payload));
					socket.data.terminal.accept(message);
				},
				close: socket => {
					socket.data.terminal.disconnect();
					if (this.#panes.get(socket.data.key) === socket.data) this.close(socket.data.key);
				},
			},
		});
		return this.#server;
	}
}
