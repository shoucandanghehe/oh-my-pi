import { signal } from "@oh-my-pi/pi-tui/reactive";
import type { InputEvent, TerminalCapabilities, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import type { NativePaneToHost, NativePaneToRelay } from "./protocol";

/** The native backend's driver on Main; the real process terminal driver lives in the relay. */
export class RemoteTerminal implements TerminalDriver {
	readonly #connected = Promise.withResolvers<void>();
	readonly #size = signal({ columns: 0, rows: 0 });
	readonly #inputs = new Set<(event: InputEvent) => void>();
	readonly #resizes = new Set<(columns: number, rows: number) => void>();
	readonly #appearances = new Set<(capabilities: TerminalCapabilities) => void>();
	readonly #closings = new Set<() => void>();
	#capabilities!: TerminalCapabilities;
	#earlyInput: InputEvent[] | undefined = [];
	#closed: Error | undefined;

	constructor(readonly send: (message: NativePaneToRelay) => void) {}

	async start(): Promise<void> {
		await this.#connected.promise;
		if (this.#closed) throw this.#closed;
	}

	stop(error = new Error("Native workspace view closed")): Promise<void> {
		if (!this.#closed) {
			this.send({ type: "stop" });
			this.disconnect(error);
		}
		return Promise.resolve();
	}

	disconnect(error: Error): void {
		if (this.#closed) return;
		this.#closed = error;
		this.#connected.resolve();
		this.#earlyInput = undefined;
		for (const close of this.#closings) close();
		this.#closings.clear();
		this.#inputs.clear();
		this.#resizes.clear();
		this.#appearances.clear();
	}

	accept(message: NativePaneToHost): void {
		if (this.#closed) return;
		switch (message.type) {
			case "ready":
				this.#capabilities = message.state.capabilities;
				this.#size.set({ columns: message.state.columns, rows: message.state.rows });
				this.#connected.resolve();
				break;
			case "resize":
				this.#size.set({ columns: message.columns, rows: message.rows });
				for (const resize of this.#resizes) resize(message.columns, message.rows);
				break;
			case "capabilities":
				this.#capabilities = message.capabilities;
				for (const changed of this.#appearances) changed(message.capabilities);
				break;
			case "input": {
				const event = message.event;
				if (this.#earlyInput && (event.type === "key" || event.type === "paste")) this.#earlyInput.push(event);
				else this.#deliver(event);
				break;
			}
		}
	}

	/** Deliver startup keys and pastes only after the destination surface subscribes. */
	releaseInput(): void {
		const early = this.#earlyInput;
		this.#earlyInput = undefined;
		for (const event of early ?? []) this.#deliver(event);
	}

	#deliver(event: InputEvent): void {
		// As in the process driver, a dispatch that mounts another surface must not deliver the same event twice.
		for (const listener of Array.from(this.#inputs)) if (this.#inputs.has(listener)) listener(event);
	}

	get columns(): number {
		return this.#size().columns;
	}
	get rows(): number {
		return this.#size().rows;
	}
	get capabilities(): TerminalCapabilities {
		return this.#capabilities;
	}

	writeRaw(data: string): void {
		if (!this.#closed) this.send({ type: "write", data });
	}
	setTitle(title: string): void {
		if (!this.#closed) this.send({ type: "title", title });
	}
	onInput(listener: (event: InputEvent) => void): () => void {
		this.#inputs.add(listener);
		return () => this.#inputs.delete(listener);
	}
	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resizes.add(listener);
		return () => this.#resizes.delete(listener);
	}
	onCapabilities(listener: (capabilities: TerminalCapabilities) => void): () => void {
		this.#appearances.add(listener);
		return () => this.#appearances.delete(listener);
	}
	onClose(listener: () => void): () => void {
		this.#closings.add(listener);
		return () => this.#closings.delete(listener);
	}
	onReplay(): () => void {
		return () => {};
	}
	present(): never {
		throw new Error("A native pane does not present terminal frames");
	}
	resetDisplay(): never {
		throw new Error("A native pane does not own a terminal viewport");
	}
}
