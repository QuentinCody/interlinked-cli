// ===========================================
// Coverage index — union / replacement math
// ===========================================
// The pure core of the replaceable-contribution model
// (docs/design/incremental-per-edit-coverage-crap-ratchet.md sections 5.2, 8.1):
//
//   aggregate coverage = union(contribution for each valid test shard)
//
// Rerunning a shard replaces exactly its contribution; every other shard's
// evidence is retained, so overlapping coverage cannot be lost (the section 5.2
// A/B example) and a targeted rerun is never compared against a different test
// universe. Presence (hits > 0) drives enforcement; hit counts merely sum for
// diagnostics. All functions are pure — no I/O, no clock; the persistent store
// and staging layers build on top of these.

import type {
	CanonicalCoverageElementSet,
	DimensionCounts,
	FileCoverageMetrics,
	ShardCoverageContribution,
} from "./types.js";

/** A fresh element set with no executable elements in any dimension. */
export function emptyElementSet(): CanonicalCoverageElementSet {
	return { lines: new Map(), branches: new Map(), functions: new Map() };
}

/** Union one dimension across sets: key union, hit counts summed (diagnostics only). */
function unionDimension<K>(maps: readonly ReadonlyMap<K, number>[]): Map<K, number> {
	const out = new Map<K, number>();
	for (const m of maps) {
		for (const [key, hits] of m) out.set(key, (out.get(key) ?? 0) + hits);
	}
	return out;
}

/**
 * Union element sets for ONE file across shards. Keys union; a key is covered
 * when any contributor's hits are > 0. Contributions are only ever mixed for
 * the same source/config version (editing a source invalidates every shard
 * covering it — design doc section 11), so the key sets are mutually
 * consistent; key union still degrades gracefully if they drift. `statements`
 * appears in the union only when at least one contributor provides it.
 */
export function unionElementSets(
	sets: Iterable<CanonicalCoverageElementSet>,
): CanonicalCoverageElementSet {
	const all = [...sets];
	const out: CanonicalCoverageElementSet = {
		lines: unionDimension(all.map((s) => s.lines)),
		branches: unionDimension(all.map((s) => s.branches)),
		functions: unionDimension(all.map((s) => s.functions)),
	};
	const statements = all.flatMap((s) => (s.statements ? [s.statements] : []));
	if (statements.length > 0) out.statements = unionDimension(statements);
	return out;
}

/**
 * Build the per-file aggregate from scratch: every file any shard touched,
 * mapped to the union of all contributions for it. The full-rebuild path —
 * incremental updates go through {@link replaceShards} + {@link updateAggregate}.
 */
export function aggregateFiles(
	contributions: Iterable<ShardCoverageContribution>,
): Map<string, CanonicalCoverageElementSet> {
	const perFile = new Map<string, CanonicalCoverageElementSet[]>();
	for (const contribution of contributions) {
		for (const [file, elements] of contribution.files) {
			const list = perFile.get(file);
			if (list) list.push(elements);
			else perFile.set(file, [elements]);
		}
	}
	const out = new Map<string, CanonicalCoverageElementSet>();
	for (const [file, sets] of perFile) out.set(file, unionElementSets(sets));
	return out;
}

/**
 * Replace (and/or remove) shard contributions, copy-on-write: `prev` is never
 * mutated — accepted state stays immutable (design doc section 12). Returns the
 * next contribution map plus the exact set of files whose aggregates need
 * recomputing: every file in a replaced/removed shard's OLD contribution
 * (its evidence may vanish) and every file in a replacement's NEW contribution
 * (its evidence changes).
 */
export function replaceShards(
	prev: ReadonlyMap<string, ShardCoverageContribution>,
	replacements: readonly ShardCoverageContribution[],
	removedShardIds: readonly string[] = [],
): { next: Map<string, ShardCoverageContribution>; affectedFiles: Set<string> } {
	const next = new Map(prev);
	const affectedFiles = new Set<string>();
	const touch = (contribution: ShardCoverageContribution | undefined): void => {
		if (!contribution) return;
		for (const file of contribution.files.keys()) affectedFiles.add(file);
	};
	for (const shardId of removedShardIds) {
		touch(next.get(shardId));
		next.delete(shardId);
	}
	for (const replacement of replacements) {
		touch(next.get(replacement.shardId));
		touch(replacement);
		next.set(replacement.shardId, replacement);
	}
	return { next, affectedFiles };
}

/**
 * Recompute ONLY the affected files against the next contribution map,
 * structurally sharing every untouched file's aggregate (the <100 ms
 * recompute path — design doc section 10). A file no remaining shard reports
 * leaves the aggregate entirely: nothing measures it anymore. In-memory this
 * scans all shards per affected file; the on-disk reverse index
 * (files/<source-path-hash>.json) narrows that to the covering shards.
 */
export function updateAggregate(
	prevAggregate: ReadonlyMap<string, CanonicalCoverageElementSet>,
	contributions: ReadonlyMap<string, ShardCoverageContribution>,
	affectedFiles: ReadonlySet<string>,
): Map<string, CanonicalCoverageElementSet> {
	const out = new Map(prevAggregate);
	for (const file of affectedFiles) {
		const sets: CanonicalCoverageElementSet[] = [];
		for (const contribution of contributions.values()) {
			const elements = contribution.files.get(file);
			if (elements) sets.push(elements);
		}
		if (sets.length === 0) out.delete(file);
		else out.set(file, unionElementSets(sets));
	}
	return out;
}

/**
 * Covered/total/pct for one dimension. An empty dimension reports 100%:
 * nothing to cover means no regression is possible, matching the existing
 * gate's covered-fraction convention for no-statement files.
 */
function dimensionCounts(elements: ReadonlyMap<unknown, number>): DimensionCounts {
	let covered = 0;
	for (const hits of elements.values()) {
		if (hits > 0) covered++;
	}
	const total = elements.size;
	return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
}

/** Per-file metrics for an aggregated element set (the ratchet's comparison input). */
export function elementSetMetrics(elements: CanonicalCoverageElementSet): FileCoverageMetrics {
	return {
		lines: dimensionCounts(elements.lines),
		branches: dimensionCounts(elements.branches),
		functions: dimensionCounts(elements.functions),
		statements: elements.statements ? dimensionCounts(elements.statements) : null,
	};
}
