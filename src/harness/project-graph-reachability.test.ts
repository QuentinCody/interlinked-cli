// Companion for the pure backward-BFS reachability computation. This file
// tests `computeReachabilityVerdict` directly — its own internal
// self-reachability shortcut (target === one of entryAbs) is NOT exercised
// through `ProjectGraph.isFileReachableFromEntryPoints`
// (`__tests__/reachability.test.ts`), because that caller has its OWN
// duplicate self-reachability check before ever delegating here.
import { describe, expect, it } from "vitest";
import { computeReachabilityVerdict } from "./project-graph-reachability.js";

describe("computeReachabilityVerdict — self-reachability shortcut", () => {
	it("returns a zero-distance verdict without touching the reverse graph when the target is itself an entry point", () => {
		const target = "/repo/src/a.ts";
		const entryAbs = [target, "/repo/src/b.ts"];
		const verdict = computeReachabilityVerdict(target, entryAbs, new Map(), (p) => p);
		expect(verdict).toEqual({
			reachable: true,
			distance: 0,
			path: [target],
			entry_points_considered: entryAbs,
		});
	});
});
