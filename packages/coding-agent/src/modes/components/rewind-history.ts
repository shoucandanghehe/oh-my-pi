import type { Usage } from "@oh-my-pi/pi-ai";
import { Container, type Component, type VirtualViewportProvider } from "@oh-my-pi/pi-tui";
import { settings } from "../../config/settings";
import type { SessionMessageEntry } from "../../session/session-entries";
import { ChatTranscriptBuilder, type ChatTranscriptBuilderDeps } from "./chat-transcript-builder";
import { TranscriptContainer } from "./transcript-container";
import {
	appendOutlineEntries,
	type OutlineTarget,
	VirtualOutlineColumn,
	type ViewportOutlineColumn,
} from "./transcript-outline";

export interface RewindPoint {
	chunk: number;
	target: number;
}

/** Layout hints only; visible turns always replace them with their real measured rows. */
const UNMEASURED_ENTRY_ROWS = 4;

/** A user turn is a replay boundary: tool grouping and snapshot displacement stay inside it. */
class RewindChunk {
	#builder: ChatTranscriptBuilder | undefined;
	#targets: OutlineTarget[] = [];
	#expanded = false;
	#ranges = new Map<string, TranscriptContainer>();

	constructor(
		readonly entries: SessionMessageEntry[],
		readonly from: number,
		readonly to: number,
		private readonly deps: ChatTranscriptBuilderDeps,
		private readonly previousUsage: Usage | undefined,
	) {}

	get loaded(): boolean {
		return this.#builder !== undefined;
	}

	get builder(): ChatTranscriptBuilder {
		if (this.#builder) return this.#builder;
		const builder = new ChatTranscriptBuilder(this.deps, this.previousUsage);
		builder.setExpanded(this.#expanded);
		builder.container.setExpanded(this.#expanded);
		this.#targets = appendOutlineEntries(builder, this.entries.slice(this.from, this.to));
		if (this.to < this.entries.length) {
			builder.finishReplayTurn();
			const last = this.#targets.at(-1);
			if (last) last.end = builder.container.children.length;
		}
		this.#builder = builder;
		return builder;
	}

	get targets(): readonly OutlineTarget[] {
		void this.builder;
		return this.#targets;
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#builder?.setExpanded(expanded);
		this.#builder?.container.setExpanded(expanded);
		for (const range of this.#ranges.values()) range.setExpanded(expanded);
	}

	invalidate(): void {
		this.#builder?.container.invalidate();
		for (const range of this.#ranges.values()) range.invalidate();
	}

	dispose(): void {
		// Range ledgers borrow the builder's components; they never dispose them.
		this.#ranges.clear();
		this.#builder?.dispose();
	}

	column(
		width: number,
		from: number | undefined,
		to: number | undefined,
		selected: number | undefined,
		gap: boolean,
	): VirtualOutlineColumn {
		const builder = this.builder;
		const start = from === undefined ? 0 : this.#targets[from]!.start;
		const end = to === undefined ? builder.container.children.length : this.#targets[to]!.start;
		let container = builder.container;
		if (start !== 0 || end !== container.children.length) {
			const key = `${start}:${end}`;
			let range = this.#ranges.get(key);
			if (!range) {
				range = new TranscriptContainer();
				range.setExpanded(this.#expanded);
				range.setToolActivityVisible(!settings.get("display.hideToolActivity"));
				for (let index = start; index < end; index++) range.addChild(container.children[index]!);
				// Only the active fork needs split-width ledgers. Drop old ledgers, not their components.
				if (this.#ranges.size >= 2) this.#ranges.delete(this.#ranges.keys().next().value!);
				this.#ranges.set(key, range);
			}
			container = range;
		}
		const target = selected === undefined ? undefined : this.#targets[selected];
		return new VirtualOutlineColumn(
			container,
			0,
			container.children.length,
			target ? { ...target, start: target.start - start, end: target.end - start } : undefined,
			width,
			gap ? [""] : [],
		);
	}
}

/** Lightweight whole-branch index. Components and exact layouts exist only for visited user turns. */
export class RewindHistory {
	#chunks: RewindChunk[] = [];
	#selected: RewindPoint | undefined;
	#prepared = false;
	#view:
		| {
				width: number;
				from: RewindPoint | undefined;
				to: RewindPoint | undefined;
				selected: RewindPoint | undefined;
				header: string;
				value: ViewportOutlineColumn;
		  }
		| undefined;

	constructor(
		readonly entries: SessionMessageEntry[],
		deps: ChatTranscriptBuilderDeps,
		private readonly initial: "first" | "last" = "last",
	) {
		// Never split an interleaved user prompt away from a preceding call whose
		// result comes later. Unresolved calls without a persisted result don't span a cut.
		const results = new Map<string, number>();
		for (let index = 0; index < entries.length; index++) {
			const message = entries[index]!.message;
			if (message.role === "toolResult") results.set(message.toolCallId, index);
		}
		let start = 0;
		let callEnd = -1;
		let previousUsage: Usage | undefined;
		let chunkUsage: Usage | undefined;
		for (let index = 0; index < entries.length; index++) {
			const message = entries[index]!.message;
			if (index > start && index > callEnd && message.role === "user" && message.attribution !== "agent") {
				this.#chunks.push(new RewindChunk(entries, start, index, deps, chunkUsage));
				start = index;
				chunkUsage = previousUsage;
			}
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall") callEnd = Math.max(callEnd, results.get(block.id) ?? index);
			}
			if (message.usage.input + message.usage.cacheRead + message.usage.cacheWrite > 0)
				previousUsage = message.usage;
		}
		if (start < entries.length) this.#chunks.push(new RewindChunk(entries, start, entries.length, deps, chunkUsage));
	}

	get point(): RewindPoint | undefined {
		this.#prepare();
		return this.#selected;
	}

	get target(): OutlineTarget | undefined {
		const point = this.point;
		return point ? this.#chunks[point.chunk]!.targets[point.target] : undefined;
	}

	get position(): number {
		const point = this.point;
		const target = this.target;
		if (!point || !target) return 0;
		return this.entries.indexOf(target.entries.at(-1)!, this.#chunks[point.chunk]!.from) + 1;
	}

	resetSelection(): void {
		this.#prepared = false;
		this.#selected = undefined;
	}

	#prepare(): void {
		if (this.#prepared) return;
		this.#prepared = true;
		const delta = this.initial === "last" ? -1 : 1;
		for (
			let chunk = delta < 0 ? this.#chunks.length - 1 : 0;
			chunk >= 0 && chunk < this.#chunks.length;
			chunk += delta
		) {
			const targets = this.#chunks[chunk]!.targets;
			if (targets.length > 0) {
				this.#selected = { chunk, target: delta < 0 ? targets.length - 1 : 0 };
				return;
			}
		}
	}

	ensureVisible(width: number): void {
		const point = this.point;
		if (!point || this.#visible(point, width)) return;
		if (!this.move(-1, false, width)) this.move(1, false, width);
	}

	#visible(point: RewindPoint, width: number): boolean {
		const chunk = this.#chunks[point.chunk]!;
		const target = chunk.targets[point.target]!;
		return (
			chunk.builder.container.getVirtualRowRange(Math.max(10, width - 4), target.start, target.end) !== undefined
		);
	}

	move(delta: -1 | 1, userOnly: boolean, width: number): boolean {
		const current = this.point;
		if (!current) return false;
		let target = current.target + delta;
		for (let chunk = current.chunk; chunk >= 0 && chunk < this.#chunks.length; chunk += delta) {
			const targets = this.#chunks[chunk]!.targets;
			if (chunk !== current.chunk) target = delta < 0 ? targets.length - 1 : 0;
			for (; target >= 0 && target < targets.length; target += delta) {
				const next = { chunk, target };
				if ((!userOnly || targets[target]!.isUserTurn) && this.#visible(next, width)) {
					this.#selected = next;
					return true;
				}
			}
		}
		return false;
	}

	setExpanded(expanded: boolean): void {
		for (const chunk of this.#chunks) chunk.setExpanded(expanded);
	}

	invalidate(): void {
		this.#view = undefined;
		for (const chunk of this.#chunks) chunk.invalidate();
	}

	dispose(): void {
		this.#view = undefined;
		for (const chunk of this.#chunks) chunk.dispose();
	}

	column(
		width: number,
		options: { from?: RewindPoint; to?: RewindPoint; selected?: RewindPoint; header?: readonly string[] } = {},
	): ViewportOutlineColumn {
		const { from, to, selected } = options;
		const header = options.header ?? [];
		const headerKey = header.join("\n");
		const cached = this.#view;
		if (
			cached &&
			cached.width === width &&
			cached.from === from &&
			cached.to === to &&
			cached.selected === selected &&
			cached.header === headerKey
		)
			return cached.value;
		const root = new Container();
		if (header.length) root.addChild({ render: () => header });
		const providers: Array<Component & VirtualViewportProvider> = [];
		const first = from?.chunk ?? 0;
		const last = to?.chunk ?? this.#chunks.length - 1;
		let selectedColumn: (() => VirtualOutlineColumn) | undefined;
		let selectedIndex = -1;
		for (let index = first; index <= last; index++) {
			const chunk = this.#chunks[index]!;
			const lower = index === from?.chunk ? from.target : undefined;
			const upper = index === to?.chunk ? to.target : undefined;
			const active = index === selected?.chunk ? selected.target : undefined;
			const column = () => chunk.column(width, lower, upper, active, index > first);
			const provider: Component & VirtualViewportProvider = {
				hasVirtualViewport: () => true,
				getEstimatedVirtualRows: () =>
					chunk.loaded ? column().length : Math.max(1, (chunk.to - chunk.from) * UNMEASURED_ENTRY_ROWS),
				render: () => {
					const value = column();
					return value.renderVirtualViewport(width, { offset: 0, rows: value.length, followBottom: false }).lines;
				},
				renderVirtualViewport: (_width, request) => column().renderVirtualViewport(width, request),
			};
			providers.push(provider);
			root.addChild(provider);
			if (active !== undefined) {
				selectedColumn = column;
				selectedIndex = providers.length - 1;
			}
		}
		const selectionOffset = (): number => {
			let offset = header.length;
			for (let index = 0; index < selectedIndex; index++) offset += providers[index]!.getEstimatedVirtualRows(width);
			return offset;
		};
		const value: ViewportOutlineColumn = {
			get length() {
				return root.getEstimatedVirtualRows(width);
			},
			get selStart() {
				const start = selectedColumn?.().selStart ?? -1;
				return start < 0 ? -1 : selectionOffset() + start;
			},
			get selEnd() {
				const end = selectedColumn?.().selEnd ?? -1;
				return end < 0 ? -1 : selectionOffset() + end;
			},
			hasVirtualViewport: () => true,
			getEstimatedVirtualRows: () => root.getEstimatedVirtualRows(width),
			renderVirtualViewport: (_width, request) => root.renderVirtualViewport(width, request),
		};
		this.#view = { width, from, to, selected, header: headerKey, value };
		return value;
	}
}
