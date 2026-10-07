import type { Server, ServerWebSocket } from "bun";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import { resolveTernPane } from "../../tools/browser/tern/kind";
import { TernPaneClient } from "../../tools/browser/tern/panes";
import type { NativePaneToHost } from "./protocol";
import { RemoteTerminal } from "./remote-terminal";

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

	constructor(readonly client: Pick<TernPaneClient, "open" | "focus" | "focused" | "isSplitPane" | "close">) {}

	static fromEnvironment(cwd: string): NativeWorkspace | undefined {
		const pane = resolveTernPane();
		return pane ? new NativeWorkspace(new TernPaneClient(pane, cwd)) : undefined;
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
				await this.#place(existing, () => this.client.focus(block));
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
		const timer = setTimeout(
			() => terminal.ready.reject(new Error("Native workspace pane did not connect within 10 seconds")),
			10_000,
		);
		timer.unref();
		const connected = terminal.ready.promise.finally(() => clearTimeout(timer));
		// Attach the rejection handler before launching, since a failed relay can close immediately.
		void connected.catch(() => {});
		try {
			await this.#place(entry, async () => {
				const previousFocus = preserveFocus ? await this.client.focused() : undefined;
				let sibling: PaneEntry | undefined;
				for (const pane of this.#panes.values()) {
					if (pane !== entry && pane.block !== undefined && (await this.client.isSplitPane(pane.block))) {
						sibling = pane;
						break;
					}
				}
				if (this.#panes.get(key) !== entry) throw new Error("Native workspace view was closed while opening");
				const result = await this.client.open(
					`ws://127.0.0.1:${server.port}/${entry.token}`,
					sibling?.block === undefined ? undefined : { block: sibling.block, dir: "down" },
				);
				entry.block = result.block;
				if (this.#panes.get(key) !== entry) {
					throw new Error("Native workspace view was closed while opening");
				}
				if (previousFocus !== undefined) await this.client.focus(previousFocus);
				else if (!preserveFocus) await this.client.focus(result.block);
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
						handleInput: data => component.handleInput?.(data),
					}
				: component;
			const describeSurface = component.describeSurface;
			if (preserveFocus && describeSurface) {
				focused.describeSurface = cx => describeSurface.call(component, cx);
			}
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
			if (entry.block !== undefined && !entry.socket) {
				void this.client
					.close(entry.block)
					.catch(closeError => logger.warn("Could not close failed native pane", { error: String(closeError) }));
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
		entry.onClosed();
		entry.terminal.ready.reject(new Error("Native workspace view closed"));
		entry.view?.component.dispose?.();
		entry.view?.ui.stop();
		entry.terminal.stop();
		entry.onClose();
		if (this.#panes.size === 0) {
			this.#server?.stop();
			this.#server = undefined;
		}
	}

	dispose(): void {
		for (const key of this.#panes.keys()) this.close(key);
	}

	/** Serialize Tern mutations, not relay connection; cancellation releases the next launch. */
	async #place(entry: PaneEntry, change: () => Promise<void>): Promise<void> {
		const previous = this.#placementTail;
		const finished = Promise.withResolvers<void>();
		const released = Promise.race([finished.promise, entry.closed]);
		const tail = previous ? previous.then(() => released) : released;
		this.#placementTail = tail;
		try {
			if (previous) await previous;
			if (this.#panes.get(entry.key) !== entry) throw new Error("Native workspace view closed before placement");
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
