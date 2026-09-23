import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import type {
	Terminal,
	TerminalAppearance,
	TerminalAppearanceRequestToken,
	TspHelloHandler,
} from "@oh-my-pi/pi-tui/terminal";
import type { NativePaneTerminalState, NativePaneToHost, NativePaneToRelay } from "./protocol";

/** A TUI terminal whose real PTY belongs to a separate Tern pane. */
export class RemoteTerminal implements Terminal {
	readonly ready = Promise.withResolvers<void>();
	#state: NativePaneTerminalState | undefined;
	#hello: TspHello | null | undefined;
	#input: ((data: string) => void) | undefined;
	#resize: (() => void) | undefined;
	#disconnect: (() => void) | undefined;
	#pendingInputs: string[] = [];
	#appearanceListeners: ((appearance: TerminalAppearance, token?: TerminalAppearanceRequestToken) => void)[] = [];
	#helloListeners: TspHelloHandler[] = [];
	#stopped = false;

	constructor(readonly send: (message: NativePaneToRelay) => void) {}

	accept(message: NativePaneToHost): void {
		if (message.type === "state") {
			this.#state = message.state;
			this.#resize?.();
			this.#resolveReady();
		} else if (message.type === "hello") {
			this.#hello = message.hello;
			if (!message.hello) this.ready.reject(new Error("The workspace pane did not negotiate TSP"));
			for (const listener of this.#helloListeners) listener(message.hello);
			this.#resolveReady();
		} else if (message.type === "input") {
			if (this.#input) this.#input(message.data);
			else this.#pendingInputs.push(message.data);
		} else if (this.#state) {
			this.#state.appearance = message.appearance;
			for (const listener of this.#appearanceListeners) listener(message.appearance, message.token);
		}
	}

	#resolveReady(): void {
		if (this.#state && this.#hello) this.ready.resolve();
	}

	disconnect(): void {
		this.ready.reject(new Error("Native workspace pane disconnected"));
		this.#disconnect?.();
	}

	start(onInput: (data: string) => void, onResize: () => void, onDisconnect?: () => void): void {
		this.#input = onInput;
		this.#resize = onResize;
		this.#disconnect = onDisconnect;
		for (const data of this.#pendingInputs.splice(0)) onInput(data);
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.send({ type: "stop" });
		this.#input = undefined;
		this.#resize = undefined;
		this.#disconnect = undefined;
	}

	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.send({ type: "write", data });
	}
	get columns(): number {
		return this.#state!.columns;
	}
	get rows(): number {
		return this.#state!.rows;
	}
	get kittyProtocolActive(): boolean {
		return this.#state!.kittyProtocolActive;
	}
	get kittyEnableSequence(): string | null {
		return this.#state!.kittyEnableSequence;
	}
	get keyboardEnhancementEnterSequence(): string | null {
		return this.#state!.keyboardEnhancementEnterSequence;
	}
	get keyboardEnhancementExitSequence(): string | null {
		return this.#state!.keyboardEnhancementExitSequence;
	}
	get hostOwnsGridOnResize(): boolean {
		return this.#state!.hostOwnsGridOnResize;
	}
	get appearance(): TerminalAppearance | undefined {
		return this.#state?.appearance;
	}
	get tspProbePending(): boolean {
		return this.#hello === undefined;
	}
	get tspExpected(): boolean {
		return true;
	}
	moveBy(lines: number): void {
		this.send({ type: "move", lines });
	}
	hideCursor(force?: boolean): void {
		this.send({ type: "hide-cursor", force });
	}
	showCursor(force?: boolean): void {
		this.send({ type: "show-cursor", force });
	}
	clearLine(): void {
		this.send({ type: "clear-line" });
	}
	clearFromCursor(): void {
		this.send({ type: "clear-from-cursor" });
	}
	clearScreen(): void {
		this.send({ type: "clear-screen" });
	}
	setTitle(title: string): void {
		this.send({ type: "title", title });
	}
	setProgress(active: boolean): void {
		this.send({ type: "progress", active });
	}
	refreshAppearance(token?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | undefined {
		this.send({ type: "refresh-appearance", token });
		return token;
	}
	onAppearanceChange(
		listener: (appearance: TerminalAppearance, token?: TerminalAppearanceRequestToken) => void,
	): void {
		this.#appearanceListeners.push(listener);
		if (this.appearance) listener(this.appearance);
	}
	onTspHello(listener: TspHelloHandler): void {
		this.#helloListeners.push(listener);
		if (this.#hello !== undefined) listener(this.#hello);
	}
}
