// interlinked-tdd: exempt
// ===========================================
// Project Graph — Reachability BFS
// ===========================================
// Pure backward-BFS reachability computation extracted from
// `project-graph.ts`. Operates only on its inputs (target file, entry-point
// set, and the reverse import graph) plus an optional path-display helper for
// the verbose depth-cap note. No module-private state.

import { nonNull } from "../lib/non-null.js";
import type { ReachabilityVerdict } from "./types.js";

/**
 * Maximum BFS depth for `isFileReachableFromEntryPoints`. Empirically a
 * 1000-file repo with typical depth-of-imports under 10 never needs more
 * than ~15 hops; the cap is set well above that so the structural rule
 * (no pathological deep chains) does the limiting, not this number.
 *
 * Public API — exported so the Phase A2 tests and the Phase B
 * endpoint-security pack can assert against the cap value without
 * hard-coding it.
 */
export const REACHABILITY_DEPTH_CAP = 25;

type QueueHeadOutcome = "depth-cap" | "no-parents" | "continue" | "found";

interface QueueHeadResult {
	outcome: QueueHeadOutcome;
	foundEntry: string | null;
}

/**
 * Processes one BFS queue head for `computeReachabilityVerdict`: expands
 * `current`'s parents (mutating `distances`/`parents`/`queue` in place) and
 * reports what happened so the caller can decide continue/break. Mirrors the
 * original inline loop body exactly, including the early-exit-on-first-match
 * semantics of the original inner `for` + `break`.
 */
function processQueueHead(
	current: string,
	distances: Map<string, number>,
	reverseGraph: Map<string, Set<string>>,
	entrySet: Set<string>,
	parents: Map<string, string>,
	queue: string[],
): QueueHeadResult {
	const currentDist = distances.get(current) ?? 0;
	if (currentDist >= REACHABILITY_DEPTH_CAP) {
		return { outcome: "depth-cap", foundEntry: null };
	}
	const parentsOfCurrent = reverseGraph.get(current);
	if (!parentsOfCurrent) return { outcome: "no-parents", foundEntry: null };
	for (const parent of parentsOfCurrent) {
		if (distances.has(parent)) continue;
		distances.set(parent, currentDist + 1);
		parents.set(parent, current);
		if (entrySet.has(parent)) {
			return { outcome: "found", foundEntry: parent };
		}
		queue.push(parent);
	}
	return { outcome: "continue", foundEntry: null };
}

/**
 * Compute whether `target` is reachable from any of `entryAbs` by walking the
 * import chain backwards via `reverseGraph` (parents of each file). All inputs
 * are already absolute paths. `toRelative` is used only for the verbose
 * depth-cap stderr note. Returns a verdict; the caller owns memoization.
 */
export function computeReachabilityVerdict(
	target: string,
	entryAbs: string[],
	reverseGraph: Map<string, Set<string>>,
	toRelative: (filePath: string) => string,
): ReachabilityVerdict {
	const considered = [...entryAbs];

	// Self-reachability shortcut: if the target is an entry point.
	const entrySet = new Set(entryAbs);
	if (entrySet.has(target)) {
		return {
			reachable: true,
			distance: 0,
			path: [target],
			entry_points_considered: considered,
		};
	}

	// Backward BFS from target along reverseGraph until we hit any
	// entry point or exhaust / hit depth cap. Tracks parent pointers
	// so we can reconstruct the shortest path on success.
	const parents = new Map<string, string>();
	const distances = new Map<string, number>([[target, 0]]);
	const queue: string[] = [target];
	let depthCapHit = false;
	let head = 0;
	let foundEntry: string | null = null;

	while (head < queue.length) {
		const current = nonNull(queue[head++]);
		const step = processQueueHead(
			current,
			distances,
			reverseGraph,
			entrySet,
			parents,
			queue,
		);
		if (step.outcome === "depth-cap") {
			depthCapHit = true;
			continue;
		}
		if (step.outcome === "found") {
			foundEntry = step.foundEntry;
			break;
		}
	}

	if (foundEntry) {
		// Reconstruct path: entry → ... → target.
		const reversedPath: string[] = [foundEntry];
		let cursor: string | undefined = foundEntry;
		while (cursor && cursor !== target) {
			const next: string | undefined = parents.get(cursor);
			if (!next) break;
			reversedPath.push(next);
			cursor = next;
		}
		return {
			reachable: true,
			distance: reversedPath.length - 1,
			path: reversedPath,
			entry_points_considered: considered,
		};
	}

	if (depthCapHit && process.env.INTERLINKED_VERBOSE === "1") {
		console.error(
			`[project-graph] reachability depth cap (${REACHABILITY_DEPTH_CAP}) hit for ${toRelative(target)}`,
		);
	}
	return {
		reachable: false,
		entry_points_considered: considered,
	};
}
