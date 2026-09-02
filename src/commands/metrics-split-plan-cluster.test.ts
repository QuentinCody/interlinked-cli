// ===========================================
// metrics-split-plan-cluster — deterministic agglomerative grouping
// ===========================================
// P* cases: the clusterer must group / separate as described. N* cases: it
// must not collapse, randomize, or exceed its bounds.

import { describe, expect, it } from "vitest";
import {
	clusterUnits,
	crossClusterEdges,
	DEFAULT_CLUSTER_OPTIONS,
	type SplitCluster,
} from "./metrics-split-plan-cluster.js";
import type { SplitEdge, SplitUnit } from "./metrics-split-plan-graph.js";

function unit(id: number, name: string, lines: number, imports: string[] = [], cyclomatic = 1): SplitUnit {
	return {
		id,
		name,
		kind: "function",
		exported: false,
		startLine: id * 100 + 1,
		endLine: id * 100 + lines,
		lines,
		cyclomatic,
		imports,
	};
}

function edge(from: number, to: number): SplitEdge {
	return { from, to };
}

function members(clusters: SplitCluster[]): number[][] {
	return clusters.map((c) => [...c.unitIds]);
}

describe("clusterUnits — positive (must fire)", () => {
	it("P1: two call-connected pairs with no edge between them form two clusters", () => {
		const units = [unit(0, "a", 10), unit(1, "b", 10), unit(2, "c", 10), unit(3, "d", 10)];
		const edges = [edge(0, 1), edge(2, 3)];
		const out = clusterUnits({ units, edges, totalLines: 40 });
		expect(members(out)).toEqual([
			[0, 1],
			[2, 3],
		]);
	});

	it("P2: isolated units above the cluster cap pack by import-set similarity", () => {
		const units = [
			unit(0, "fsA", 10, ["node:fs"]),
			unit(1, "pathA", 10, ["node:path"]),
			unit(2, "fsB", 10, ["node:fs"]),
			unit(3, "pathB", 10, ["node:path"]),
			unit(4, "fsC", 10, ["node:fs"]),
		];
		const out = clusterUnits({ units, edges: [], totalLines: 50 }, { maxClusters: 2 });
		expect(members(out)).toEqual([
			[0, 2, 4],
			[1, 3],
		]);
	});

	it("P3: cluster rows carry Σ lines, Σ cyclomatic, and the union of imports", () => {
		const units = [unit(0, "a", 12, ["x"], 3), unit(1, "b", 8, ["y"], 4)];
		const out = clusterUnits(
			{ units, edges: [edge(0, 1)], totalLines: 20 },
			{ minClusters: 1, maxShareOfLines: 1 },
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ lines: 20, cyclomatic: 7, imports: ["x", "y"] });
	});

	it("P4: crossClusterEdges lists exactly the edges that cross a cluster boundary", () => {
		const clusters: SplitCluster[] = [
			{ id: 0, unitIds: [0, 1], lines: 0, cyclomatic: 0, imports: [] },
			{ id: 1, unitIds: [2], lines: 0, cyclomatic: 0, imports: [] },
		];
		const edges = [edge(0, 1), edge(1, 2), edge(2, 0)];
		expect(crossClusterEdges(clusters, edges)).toEqual([edge(1, 2), edge(2, 0)]);
	});

	it("P6: two tiny edge-less leftovers pool into one support cluster", () => {
		// a and b are too big to merge (90% of the file); c and d are crumbs
		// (2 lines each, under the 5% tiny share) — they pool, a and b stay apart.
		const units = [unit(0, "a", 45), unit(1, "b", 45), unit(2, "c", 2), unit(3, "d", 2)];
		const out = clusterUnits({ units, edges: [edge(0, 1)], totalLines: 100 });
		expect(members(out)).toEqual([[0], [1], [2, 3]]);
	});

	it("P5: the same input always yields the same clustering", () => {
		const units = Array.from({ length: 12 }, (_, i) => unit(i, `f${i}`, 5 + (i % 3), [`m${i % 4}`]));
		const edges = [edge(0, 1), edge(1, 2), edge(3, 4), edge(5, 6), edge(6, 7), edge(9, 10)];
		const first = clusterUnits({ units, edges, totalLines: 80 });
		const second = clusterUnits({ units, edges, totalLines: 80 });
		expect(second).toEqual(first);
		expect(first.length).toBeLessThanOrEqual(DEFAULT_CLUSTER_OPTIONS.maxClusters);
		expect(first.length).toBeGreaterThanOrEqual(DEFAULT_CLUSTER_OPTIONS.minClusters);
	});
});

describe("clusterUnits — negative (must not fire)", () => {
	it("N1: no units → no clusters", () => {
		expect(clusterUnits({ units: [], edges: [], totalLines: 0 })).toEqual([]);
	});

	it("N2: a single unit is never split and never dropped", () => {
		const out = clusterUnits({ units: [unit(0, "only", 30)], edges: [], totalLines: 30 });
		expect(members(out)).toEqual([[0]]);
	});

	it("N3: a fully connected chain does not collapse below minClusters", () => {
		const units = [unit(0, "a", 10), unit(1, "b", 10), unit(2, "c", 10), unit(3, "d", 10)];
		const edges = [edge(0, 1), edge(1, 2), edge(2, 3)];
		const out = clusterUnits({ units, edges, totalLines: 40 });
		expect(out.length).toBeGreaterThanOrEqual(2);
		expect(out.flatMap((c) => c.unitIds).sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
	});

	it("N4: a merge that would exceed the line-share cap is skipped when another pair exists", () => {
		// a↔b heavily connected but huge; c↔d small and connected. With maxClusters 3
		// and a 0.6 share cap, {a,b} (80%) must NOT merge while {c,d} does.
		const units = [unit(0, "a", 40), unit(1, "b", 40), unit(2, "c", 10), unit(3, "d", 10)];
		const edges = [edge(0, 1), edge(1, 0), edge(2, 3)];
		const out = clusterUnits({ units, edges, totalLines: 100 }, { maxClusters: 3 });
		expect(members(out)).toEqual([[0], [1], [2, 3]]);
	});

	it("N5: never emits more clusters than maxClusters", () => {
		const units = Array.from({ length: 9 }, (_, i) => unit(i, `f${i}`, 3));
		const out = clusterUnits({ units, edges: [], totalLines: 27 }, { maxClusters: 4 });
		expect(out.length).toBe(4);
	});
});
