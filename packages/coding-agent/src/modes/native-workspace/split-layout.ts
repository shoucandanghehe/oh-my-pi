import type { TernPaneMove, TernPanePlacement } from "../../tools/browser/tern/panes";

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
 * Keep Main whole beside up to two agent lanes. Fill the first lane with two panes before
 * opening the second, then grow the shorter lane. Landscape windows use columns, portrait rows.
 */
export class SplitLayout {
	readonly #main: number;
	/** Direction that adds a lane, and the one that adds a pane to a lane. */
	readonly #lane: SplitDir;
	readonly #stack: SplitDir;
	#lanes: number[][] = [];

	/** Capture Main's cell scale before child TUIs overwrite the process-wide value. */
	constructor(
		main: number,
		extent: Extent,
		readonly cell: CellSize,
	) {
		this.#main = main;
		const wide = extent.columns * cell.widthPx >= extent.rows * cell.heightPx;
		this.#lane = wide ? "right" : "down";
		this.#stack = wide ? "down" : "right";
	}

	/** Panes opened beside Main, in lane order. */
	get agents(): readonly number[] {
		return this.#lanes.flat();
	}

	/** Stack the first pair before opening another lane, then fill the shortest lane. */
	next(): TernPanePlacement {
		const last = this.#lanes.at(-1);
		if (!last) return { block: this.#main, dir: this.#lane };
		if (this.#lanes.length < LANES && last.length >= 2) return { block: last[0]!, dir: this.#lane };
		let shortest = this.#lanes[0]!;
		for (const lane of this.#lanes) if (lane.length < shortest.length) shortest = lane;
		return { block: shortest.at(-1)!, dir: this.#stack };
	}

	add(placement: TernPanePlacement, block: number): TernPaneMove[] {
		const lane = this.#lanes.find(candidate => candidate.includes(placement.block));
		if (lane && placement.dir === this.#stack) {
			lane.push(block);
			return [];
		}
		this.#lanes.push([block]);
		// Splitting a lane's first pane only splits that leaf; reattach the rest under it.
		return (
			lane?.slice(1).map((pane, index) => ({
				block: pane,
				target: lane[index]!,
				dir: this.#stack === "down" ? "below" : "right-of",
			})) ?? []
		);
	}

	/** A lane left empty gives its space to its neighbour. */
	remove(block: number): void {
		this.#lanes = this.#lanes.map(lane => lane.filter(agent => agent !== block)).filter(lane => lane.length > 0);
	}
}
