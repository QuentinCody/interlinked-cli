// ===========================================
// Streaming aggregation for `interlinked query --by [--sum]`
// ===========================================
// Fold each matched record into per-key groups as the tail scan delivers it —
// no matched-record buffering, so aggregating over a 50k-record window stays
// flat in memory. Array-valued by-paths fan out (each element counts once);
// records without the by-path land in an explicit "(none)" bucket rather than
// being silently dropped.

import { getPath, stringifyValue } from "./filters.js";

export interface AggregateRow {
	key: string;
	count: number;
	sum?: number;
}

interface AggregateState {
	groups: Map<string, { count: number; sum: number }>;
	sawSum: boolean;
}

export function createAggregateState(): AggregateState {
	return { groups: new Map(), sawSum: false };
}

export function foldRecord(
	state: AggregateState,
	record: Record<string, unknown>,
	byPath: string,
	sumPath?: string,
): void {
	const values = getPath(record, byPath).map(stringifyValue);
	const keys = values.length > 0 ? values : ["(none)"];
	const increment = sumPath === undefined ? undefined : firstFiniteNumber(getPath(record, sumPath));
	for (const key of keys) {
		const group = state.groups.get(key) ?? { count: 0, sum: 0 };
		group.count++;
		if (increment !== undefined) {
			group.sum += increment;
			state.sawSum = true;
		}
		state.groups.set(key, group);
	}
}

export function finalizeAggregate(state: AggregateState, limit: number): AggregateRow[] {
	const rows: AggregateRow[] = [...state.groups.entries()].map(([key, group]) => ({
		key,
		count: group.count,
		...(state.sawSum ? { sum: group.sum } : {}),
	}));
	rows.sort(
		(a, b) =>
			(b.sum ?? b.count) - (a.sum ?? a.count) || b.count - a.count || a.key.localeCompare(b.key),
	);
	return rows.slice(0, limit);
}

function firstFiniteNumber(values: unknown[]): number | undefined {
	for (const value of values) {
		const n = typeof value === "number" ? value : Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}
