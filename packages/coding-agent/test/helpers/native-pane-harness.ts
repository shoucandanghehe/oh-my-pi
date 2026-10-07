import type { TerminalStartOptions } from "@oh-my-pi/pi-tui/terminal";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { NativeWorkspace } from "../../src/modes/native-workspace/workspace";
import { runNativePaneRelay } from "../../src/modes/native-workspace/relay";
import type { TernPanePlacement, TernSplitResult } from "../../src/tools/browser/tern/panes";
import { TspTestTerminal, tspEvent } from "../../../tui/test/native/tsp-harness";

export class RelayTestTerminal extends TspTestTerminal {
	#disconnect: (() => void) | undefined;

	override start(
		input: (data: string) => void,
		resize?: () => void,
		disconnect?: () => void,
		options?: TerminalStartOptions,
	): void {
		super.start(input, resize, disconnect, options);
		this.#disconnect = disconnect;
		this.answerProbe();
	}

	override send(data: string): void {
		super.send(data);
		queueMicrotask(() => {
			while (this.deliver()) {}
		});
	}

	closeInput(): void {
		this.#disconnect?.();
	}
}

export class NativePaneHarness {
	readonly terminals = new Map<number, RelayTestTerminal>();
	readonly placements: (TernPanePlacement | undefined)[] = [];
	readonly workspace: NativeWorkspace;
	readonly #relays: Promise<void>[] = [];
	focused = 1;
	#next = 2;

	constructor() {
		this.workspace = new NativeWorkspace({
			open: async (endpoint, placement): Promise<TernSplitResult> => {
				const block = this.#next++;
				const terminal = new RelayTestTerminal({ cols: 100, rows: 32, features: ["scroll"] });
				this.terminals.set(block, terminal);
				this.placements.push(placement);
				this.focused = block;
				const relay = runNativePaneRelay(endpoint, terminal);
				this.#relays.push(relay);
				return { session: 1, tab: 1, block };
			},
			focus: async block => {
				this.focused = block;
			},
			focused: async () => this.focused,
			isSplitPane: async block => this.terminals.has(block),
			close: async block => {
				this.terminals.get(block)?.closeInput();
			},
		});
	}

	nodes(block = this.focused): TspNode[] {
		const terminal = this.terminals.get(block)!;
		const root = terminal.surface && terminal.docs.get(terminal.surface)?.snapshot();
		if (!root) return [];
		const nodes: TspNode[] = [];
		const visit = (node: TspNode): void => {
			nodes.push(node);
			for (const child of node.c ?? []) visit(child);
		};
		visit(root);
		return nodes;
	}

	action(block: number, act: string): void {
		const terminal = this.terminals.get(block)!;
		const target = this.nodes(block).find(node => node.p?.actions?.click === act)!;
		terminal.send(tspEvent({ ev: "action", sf: terminal.surface!, id: target.id, act }));
	}

	async until(predicate: () => boolean | Promise<boolean>): Promise<void> {
		const deadline = Date.now() + 5000;
		while (!(await predicate())) {
			if (Date.now() >= deadline) throw new Error("Native pane did not reach its expected state");
			await Bun.sleep(5);
		}
	}

	async dispose(): Promise<void> {
		this.workspace.dispose();
		await Promise.all(this.#relays);
	}
}
