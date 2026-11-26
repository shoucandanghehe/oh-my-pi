/** Fenwick index of block extents (body plus preceding separator). Unknown blocks share an estimate. */
export class TranscriptRows {
	readonly #weights: (number | undefined)[];
	readonly #sums: number[];
	readonly #unknown: number[];
	estimate: number;

	constructor(weights: (number | undefined)[], estimate: number) {
		this.#weights = weights;
		this.estimate = estimate;
		this.#sums = [0];
		this.#unknown = [0];
		for (const weight of weights) {
			this.#sums.push(weight ?? 0);
			this.#unknown.push(weight === undefined ? 1 : 0);
		}
		for (let i = 1; i <= weights.length; i++) {
			const parent = i + (i & -i);
			if (parent > weights.length) continue;
			this.#sums[parent]! += this.#sums[i]!;
			this.#unknown[parent]! += this.#unknown[i]!;
		}
	}

	get end(): number {
		return this.start(this.#weights.length);
	}

	weight(index: number): number {
		return this.#weights[index] ?? this.estimate;
	}

	set(index: number, weight: number): void {
		const previous = this.#weights[index];
		if (previous === weight) return;
		this.#weights[index] = weight;
		const delta = weight - (previous ?? 0);
		for (let i = index + 1; i <= this.#weights.length; i += i & -i) {
			this.#sums[i]! += delta;
			if (previous === undefined) this.#unknown[i]!--;
		}
	}

	/** First row of a block, inclusive of its separator. */
	start(index: number): number {
		let row = 0;
		for (let i = index; i > 0; i -= i & -i) row += this.#sums[i]! + this.#unknown[i]! * this.estimate;
		return row;
	}

	/** Block containing `row`, or the number of blocks after the last row. Skips empty blocks. */
	find(row: number): number {
		if (row < 0) return -1;
		let index = 0;
		for (let step = 2 ** Math.floor(Math.log2(this.#weights.length || 1)); step >= 1; step /= 2) {
			const next = index + step;
			if (next > this.#weights.length) continue;
			const weight = this.#sums[next]! + this.#unknown[next]! * this.estimate;
			if (weight > row) continue;
			row -= weight;
			index = next;
		}
		return index;
	}
}
