import { nonNull } from "../../lib/non-null.js";
// Tests for the coverage-index union/replacement math — pins every case in
// docs/design/incremental-per-edit-coverage-crap-ratchet.md section 16.1 plus
// the section 5.2 worked example and the copy-on-write recompute contract.
import { describe, expect, it } from "vitest";
import {
	aggregateFiles,
	elementSetMetrics,
	emptyElementSet,
	replaceShards,
	unionElementSets,
	updateAggregate,
} from "./aggregate.js";
import type { CanonicalCoverageElementSet, ShardCoverageContribution } from "./types.js";

/** Element set from terse literals: lines as [line, hits], branches/functions as [key, hits]. */
function set(init: {
	lines?: [number, number][];
	branches?: [string, number][];
	functions?: [string, number][];
	statements?: [string, number][];
}): CanonicalCoverageElementSet {
	const out: CanonicalCoverageElementSet = {
		lines: new Map(init.lines ?? []),
		branches: new Map(init.branches ?? []),
		functions: new Map(init.functions ?? []),
	};
	if (init.statements) out.statements = new Map(init.statements);
	return out;
}

function shard(shardId: string, files: Record<string, CanonicalCoverageElementSet>): ShardCoverageContribution {
	return { shardId, files: new Map(Object.entries(files)) };
}

function byId(contributions: ShardCoverageContribution[]): Map<string, ShardCoverageContribution> {
	return new Map(contributions.map((c) => [c.shardId, c]));
}

describe("unionElementSets", () => {
	it("a line covered by two shards stays covered when one stops covering it (16.1)", () => {
		// A covers {10, 11}; B covers {10, 12} — the section 5.2 example.
		const a = set({ lines: [[10, 1], [11, 1], [12, 0]] });
		const b = set({ lines: [[10, 1], [11, 0], [12, 1]] });
		const union = unionElementSets([a, b]);
		expect([...union.lines.entries()].filter(([, hits]) => hits > 0).map(([ln]) => ln)).toEqual([
			10, 11, 12,
		]);
		// A rerun now covers only {11}: line 10 must remain covered via B.
		const aPrime = set({ lines: [[10, 0], [11, 1], [12, 0]] });
		const replaced = unionElementSets([aPrime, b]);
		expect(replaced.lines.get(10)).toBeGreaterThan(0);
		expect(replaced.lines.get(11)).toBeGreaterThan(0);
		expect(replaced.lines.get(12)).toBeGreaterThan(0);
	});

	it("replacing the last covering shard uncovers the line but keeps it in the denominator (16.1)", () => {
		const only = set({ lines: [[10, 3], [11, 1]] });
		const rerun = set({ lines: [[10, 0], [11, 1]] });
		const union = unionElementSets([rerun]);
		expect(union.lines.get(10)).toBe(0); // uncovered, still executable
		expect(union.lines.has(10)).toBe(true);
		expect(unionElementSets([only]).lines.get(10)).toBe(3);
	});

	it("branch identities union and replace correctly (16.1)", () => {
		const a = set({ branches: [["12:0:0", 1], ["12:0:1", 0]] });
		const b = set({ branches: [["12:0:0", 0], ["12:0:1", 2]] });
		const union = unionElementSets([a, b]);
		expect(union.branches.get("12:0:0")).toBe(1);
		expect(union.branches.get("12:0:1")).toBe(2);
	});

	it("duplicate hit counts sum for diagnostics but never flip covered/not-covered (16.1)", () => {
		const a = set({ lines: [[5, 7]] });
		const b = set({ lines: [[5, 3]] });
		const union = unionElementSets([a, b]);
		expect(union.lines.get(5)).toBe(10); // summed for diagnostics
		const single = unionElementSets([set({ lines: [[5, 1]] })]);
		// Presence decision identical regardless of magnitude.
		expect((union.lines.get(5) ?? 0) > 0).toBe((single.lines.get(5) ?? 0) > 0);
	});

	it("keeps statement data only when a contributing set provides it", () => {
		const withStatements = set({ lines: [[1, 1]], statements: [["0:0", 1]] });
		const without = set({ lines: [[2, 1]] });
		expect(unionElementSets([withStatements, without]).statements?.get("0:0")).toBe(1);
		expect(unionElementSets([without]).statements).toBeUndefined();
		expect(unionElementSets([]).lines.size).toBe(0);
	});
});

describe("aggregateFiles", () => {
	it("unions per file across shards; a shard that never touched a file contributes nothing", () => {
		const a = shard("a.test.ts", { "src/m.ts": set({ lines: [[1, 1], [2, 0]] }) });
		const b = shard("b.test.ts", {
			"src/m.ts": set({ lines: [[1, 0], [2, 1]] }),
			"src/other.ts": set({ lines: [[7, 1]] }),
		});
		const agg = aggregateFiles([a, b]);
		expect(agg.get("src/m.ts")?.lines.get(1)).toBe(1);
		expect(agg.get("src/m.ts")?.lines.get(2)).toBe(1);
		expect(agg.get("src/other.ts")?.lines.get(7)).toBe(1);
		expect(agg.size).toBe(2);
	});
});

describe("replaceShards + updateAggregate", () => {
	it("deleted source elements disappear from the denominator after all covering shards rerun (16.1)", () => {
		// Editing src/m.ts invalidates every shard covering it (design doc
		// section 11), so the post-edit union mixes only fresh same-version
		// contributions — line 2 deleted ⇒ key absent from every rerun.
		const prev = byId([
			shard("a.test.ts", { "src/m.ts": set({ lines: [[1, 1], [2, 1]] }) }),
			shard("b.test.ts", { "src/m.ts": set({ lines: [[1, 1], [2, 0]] }) }),
		]);
		const { next, affectedFiles } = replaceShards(prev, [
			shard("a.test.ts", { "src/m.ts": set({ lines: [[1, 1]] }) }),
			shard("b.test.ts", { "src/m.ts": set({ lines: [[1, 1]] }) }),
		]);
		const agg = updateAggregate(aggregateFiles(prev.values()), next, affectedFiles);
		expect(agg.get("src/m.ts")?.lines.has(2)).toBe(false);
		expect(agg.get("src/m.ts")?.lines.size).toBe(1);
	});

	it("new executable elements enter the denominator (16.1)", () => {
		const prev = byId([shard("a.test.ts", { "src/m.ts": set({ lines: [[1, 1]] }) })]);
		const { next, affectedFiles } = replaceShards(prev, [
			shard("a.test.ts", { "src/m.ts": set({ lines: [[1, 1], [2, 0]] }) }),
		]);
		const agg = updateAggregate(aggregateFiles(prev.values()), next, affectedFiles);
		expect(agg.get("src/m.ts")?.lines.get(2)).toBe(0);
		expect(elementSetMetrics(nonNull(agg.get("src/m.ts"))).lines).toEqual({
			covered: 1,
			total: 2,
			pct: 50,
		});
	});

	it("affected files = files in old AND new contributions of the replaced shards", () => {
		const prev = byId([
			shard("a.test.ts", { "src/old.ts": set({ lines: [[1, 1]] }) }),
			shard("b.test.ts", { "src/stable.ts": set({ lines: [[1, 1]] }) }),
		]);
		const { affectedFiles } = replaceShards(prev, [
			shard("a.test.ts", { "src/new.ts": set({ lines: [[1, 1]] }) }),
		]);
		expect(affectedFiles).toEqual(new Set(["src/old.ts", "src/new.ts"]));
	});

	it("removing a shard drops its sole contributions; copy-on-write reuses untouched aggregates", () => {
		const prev = byId([
			shard("a.test.ts", { "src/only-a.ts": set({ lines: [[1, 1]] }) }),
			shard("b.test.ts", { "src/stable.ts": set({ lines: [[1, 1]] }) }),
		]);
		const prevAgg = aggregateFiles(prev.values());
		const { next, affectedFiles } = replaceShards(prev, [], ["a.test.ts"]);
		const agg = updateAggregate(prevAgg, next, affectedFiles);
		expect(next.has("a.test.ts")).toBe(false);
		expect(agg.has("src/only-a.ts")).toBe(false); // no shard measures it anymore
		// Untouched file aggregates are the SAME objects — recompute is scoped.
		expect(agg.get("src/stable.ts")).toBe(prevAgg.get("src/stable.ts"));
	});

	it("replaceShards never mutates the previous contribution map (accepted state is immutable)", () => {
		const prev = byId([shard("a.test.ts", { "src/m.ts": set({ lines: [[1, 0]] }) })]);
		replaceShards(prev, [shard("a.test.ts", { "src/m.ts": set({ lines: [[1, 1]] }) })]);
		expect(prev.get("a.test.ts")?.files.get("src/m.ts")?.lines.get(1)).toBe(0);
	});
});

describe("elementSetMetrics", () => {
	it("computes covered/total/pct per dimension", () => {
		const metrics = elementSetMetrics(
			set({
				lines: [[1, 1], [2, 0], [3, 2], [4, 0]],
				branches: [["1:0:0", 1], ["1:0:1", 0]],
				functions: [["f@1", 1]],
			}),
		);
		expect(metrics.lines).toEqual({ covered: 2, total: 4, pct: 50 });
		expect(metrics.branches).toEqual({ covered: 1, total: 2, pct: 50 });
		expect(metrics.functions).toEqual({ covered: 1, total: 1, pct: 100 });
		expect(metrics.statements).toBeNull();
	});

	it("an empty dimension reports 100% — nothing to cover means no regression is possible", () => {
		const metrics = elementSetMetrics(emptyElementSet());
		expect(metrics.lines).toEqual({ covered: 0, total: 0, pct: 100 });
		expect(metrics.branches.pct).toBe(100);
	});
});
