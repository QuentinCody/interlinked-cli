// ===========================================
// metrics split-plan — deterministic agglomerative clustering
// ===========================================
// Groups a file's units (`metrics-split-plan-graph.ts`) into 2–4 cohesive
// modules. Every unit starts alone; the pair of clusters with the strongest
// affinity merges next, until the cluster count is inside [min, max] and no
// remaining pair is worth merging. Affinity, in order:
//   1. the merge stays under the line-share cap (a split that recreates the
//      original file in one module is not a split),
//   2. reference edges between the two clusters (most first),
//   3. Jaccard similarity of their external import sets (tie-breaker),
//   4. smaller combined size, then source order.
// No randomness anywhere: the same graph always yields the same plan.

import type { SplitEdge, SplitUnit } from "./metrics-split-plan-graph.js";

export interface SplitCluster {
	/** Position in source order (by earliest member). */
	id: number;
	unitIds: number[];
	lines: number;
	cyclomatic: number;
	/** Union of member import specifiers (sorted). */
	imports: string[];
}

export interface ClusterOptions {
	minClusters: number;
	maxClusters: number;
	/** A merge may not produce a cluster above this share of the file's lines. */
	maxShareOfLines: number;
	/** Two leftovers whose combined size is under this share pool into one support module. */
	tinyShareOfLines: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
	minClusters: 2,
	maxClusters: 4,
	maxShareOfLines: 0.6,
	tinyShareOfLines: 0.05,
};

interface ClusterInput {
	units: SplitUnit[];
	edges: SplitEdge[];
	totalLines: number;
}

interface Working {
	unitIds: number[];
	lines: number;
	imports: Set<string>;
}

interface Candidate {
	a: number;
	b: number;
	underCap: boolean;
	/** Both sides together are crumbs (under the tiny share). */
	tiny: boolean;
	edges: number;
	similarity: number;
	combined: number;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let shared = 0;
	for (const x of a) if (b.has(x)) shared++;
	return shared / (a.size + b.size - shared);
}

/** Undirected edge counts between clusters, keyed `${lo}|${hi}`. */
function edgeCounts(clusters: Working[], edges: SplitEdge[]): Map<string, number> {
	const clusterOf = new Map<number, number>();
	clusters.forEach((c, i) => {
		for (const u of c.unitIds) clusterOf.set(u, i);
	});
	const counts = new Map<string, number>();
	for (const e of edges) {
		const a = clusterOf.get(e.from);
		const b = clusterOf.get(e.to);
		if (a === undefined || b === undefined || a === b) continue;
		const key = `${Math.min(a, b)}|${Math.max(a, b)}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** Lower is better: the first differing criterion decides. */
function compareCandidates(x: Candidate, y: Candidate): number {
	if (x.underCap !== y.underCap) return x.underCap ? -1 : 1;
	if (x.edges !== y.edges) return y.edges - x.edges;
	if (x.similarity !== y.similarity) return y.similarity - x.similarity;
	if (x.combined !== y.combined) return x.combined - y.combined;
	return x.a - y.a || x.b - y.b;
}

interface Budget {
	lineCap: number;
	tinyLines: number;
}

function bestPair(clusters: Working[], edges: SplitEdge[], budget: Budget): Candidate | null {
	const counts = edgeCounts(clusters, edges);
	let best: Candidate | null = null;
	for (let a = 0; a < clusters.length; a++) {
		for (let b = a + 1; b < clusters.length; b++) {
			const ca = clusters[a];
			const cb = clusters[b];
			if (!ca || !cb) continue;
			const combined = ca.lines + cb.lines;
			const candidate: Candidate = {
				a,
				b,
				underCap: combined <= budget.lineCap,
				tiny: combined <= budget.tinyLines,
				edges: counts.get(`${a}|${b}`) ?? 0,
				similarity: jaccard(ca.imports, cb.imports),
				combined,
			};
			if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
		}
	}
	return best;
}

function merge(clusters: Working[], pair: Candidate): Working[] {
	const ca = clusters[pair.a];
	const cb = clusters[pair.b];
	if (!ca || !cb) return clusters;
	const merged: Working = {
		unitIds: [...ca.unitIds, ...cb.unitIds].sort((x, y) => x - y),
		lines: ca.lines + cb.lines,
		imports: new Set([...ca.imports, ...cb.imports]),
	};
	const rest = clusters.filter((_, i) => i !== pair.a && i !== pair.b);
	rest.push(merged);
	return rest.sort((x, y) => (x.unitIds[0] ?? 0) - (y.unitIds[0] ?? 0));
}

/**
 * Above the cap a merge is forced; otherwise it needs room plus some affinity —
 * or both sides are crumbs (a lone constant, a two-line type) better carried
 * together than as one-declaration modules.
 */
function shouldMerge(count: number, pair: Candidate, opts: ClusterOptions): boolean {
	if (count > opts.maxClusters) return true;
	if (!pair.underCap) return false;
	return pair.edges > 0 || pair.similarity > 0 || pair.tiny;
}

function finalize(clusters: Working[], units: SplitUnit[]): SplitCluster[] {
	const byId = new Map(units.map((u) => [u.id, u]));
	return clusters.map((c, id) => ({
		id,
		unitIds: c.unitIds,
		lines: c.lines,
		cyclomatic: c.unitIds.reduce((sum, u) => sum + (byId.get(u)?.cyclomatic ?? 0), 0),
		imports: [...c.imports].sort(),
	}));
}

/** Deterministic grouping of units into [min, max] clusters (see header). */
export function clusterUnits(input: ClusterInput, overrides: Partial<ClusterOptions> = {}): SplitCluster[] {
	const opts = { ...DEFAULT_CLUSTER_OPTIONS, ...overrides };
	let clusters: Working[] = input.units.map((u) => ({
		unitIds: [u.id],
		lines: u.lines,
		imports: new Set(u.imports),
	}));
	const budget: Budget = {
		lineCap: input.totalLines * opts.maxShareOfLines,
		tinyLines: input.totalLines * opts.tinyShareOfLines,
	};
	while (clusters.length > opts.minClusters) {
		const pair = bestPair(clusters, input.edges, budget);
		if (!pair || !shouldMerge(clusters.length, pair, opts)) break;
		clusters = merge(clusters, pair);
	}
	return finalize(clusters, input.units);
}

/** The edges a split along `clusters` turns into cross-module imports. */
export function crossClusterEdges(clusters: SplitCluster[], edges: SplitEdge[]): SplitEdge[] {
	const clusterOf = new Map<number, number>();
	for (const c of clusters) for (const u of c.unitIds) clusterOf.set(u, c.id);
	return edges.filter((e) => clusterOf.get(e.from) !== clusterOf.get(e.to));
}
