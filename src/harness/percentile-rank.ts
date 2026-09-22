// ===========================================
// Within-run percentile ranks
// ===========================================
// A metric's raw magnitude means one thing in this repository and another in
// the next. Every `interlinked metrics` surface therefore reports, next to the
// raw value, where that value sits among the OTHER values measured in the SAME
// run: "this file's ΣCC is above 95% of this repository's files". The ruler is
// always the repository itself — never a cross-repository corpus, which does
// not exist and would mislead (an agent-hardened tree and human legacy fail in
// opposite directions).
//
// Rank = share of the population strictly below the value, 0–100, rounded.
// Ties share a rank; the top rank is below 100 unless the maximum is unique.

const PERCENT = 100;

/** Percentile rank of one value in a population; null for an empty population (no ruler). */
export function percentileOf(value: number, population: readonly number[]): number | null {
	if (population.length === 0) return null;
	let below = 0;
	for (const v of population) if (v < value) below++;
	return Math.round((PERCENT * below) / population.length);
}

/** Index of the first sorted element ≥ `value` — the count of elements strictly below it. */
function lowerBound(sorted: readonly number[], value: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((sorted[mid] ?? Number.POSITIVE_INFINITY) < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Percentile rank of every value against the whole input, in input order.
 * O(n log n); identical to mapping `percentileOf` over the input.
 */
export function percentileRanks(values: readonly number[]): number[] {
	for (const v of values) if (!Number.isFinite(v)) throw new Error("percentileRanks requires finite values");
	if (values.length === 0) return [];
	const sorted = [...values].sort((a, b) => a - b);
	return values.map((v) => Math.round((PERCENT * lowerBound(sorted, v)) / values.length));
}
