import type { TernPanePlacement } from "../../tools/browser/tern/panes";

export interface Extent {
	columns: number;
	rows: number;
}

export interface CellSize {
	widthPx: number;
	heightPx: number;
}

type SplitDir = TernPanePlacement["dir"];

const LANES = 2;

/**
 * Agent panes beside Main, kept as the shape Tern's equalize turns into equal shares: Main and
 * {@link LANES} lanes along one axis, each lane a stack of panes along the other. A wide window
 * gets columns, a tall one rows. Tern can only split an existing pane, so both lanes are created
 * before any of them is stacked.
 */
export class SplitLayout {
	readonly #main: number;
	/** Direction that adds a lane, and the one that adds a pane to a lane. */
	readonly #lane: SplitDir;
	readonly #stack: SplitDir;
	#lanes: number[][] = [];

	/** The window shape is read once: Tern lists stale sizes and the shared cell size changes as panes connect. */
	constructor(main: number, extent: Extent, cell: CellSize) {
		this.#main = main;
		const wide = extent.columns * cell.widthPx >= extent.rows * cell.heightPx;
		this.#lane = wide ? "right" : "down";
		this.#stack = wide ? "down" : "right";
	}

	/** Panes opened beside Main, oldest first. */
	get agents(): readonly number[] {
		return this.#lanes.flat();
	}

	/** A second lane while there is room for one, otherwise the end of the shortest lane (leftmost on ties). */
	next(): TernPanePlacement {
		const last = this.#lanes.at(-1);
		if (!last) return { block: this.#main, dir: this.#lane };
		if (this.#lanes.length < LANES && last.length === 1) return { block: last[0]!, dir: this.#lane };
		let shortest = this.#lanes[0]!;
		for (const lane of this.#lanes) if (lane.length < shortest.length) shortest = lane;
		return { block: shortest.at(-1)!, dir: this.#stack };
	}

	add(placement: TernPanePlacement, block: number): void {
		const lane = this.#lanes.find(candidate => candidate.at(-1) === placement.block);
		if (lane && placement.dir === this.#stack) lane.push(block);
		else this.#lanes.push([block]);
	}

	/** A lane left empty gives its space to its neighbour. */
	remove(block: number): void {
		this.#lanes = this.#lanes.map(lane => lane.filter(agent => agent !== block)).filter(lane => lane.length > 0);
	}
}
