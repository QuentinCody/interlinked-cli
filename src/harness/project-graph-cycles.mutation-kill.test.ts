import { describe, expect, it } from "vitest";
import { findCyclesThroughGraph } from "./project-graph-cycles.js";
import type { ImportEdge } from "./types.js";

function graphOf(pairs: Array<[string, string]>): Map<string, ImportEdge[]> {
	const graph = new Map<string, ImportEdge[]>();
	for (const [fromFile, toFile] of pairs) {
		const list = graph.get(fromFile) ?? [];
		list.push({ fromFile, toFile, specifier: toFile, symbols: [], isTypeOnly: false });
		graph.set(fromFile, list);
	}
	return graph;
}

describe("findCyclesThroughGraph — mutation-directed (shared descendants)", () => {
	// test-contract: invariant — two distinct import paths that converge on one shared module are two distinct cycles; reaching the shared node via the first path must not hide the second
	it("reports both cycles of a diamond that reconverges before closing", () => {
		const graph = graphOf([
			["/r/a.ts", "/r/b.ts"],
			["/r/a.ts", "/r/c.ts"],
			["/r/b.ts", "/r/d.ts"],
			["/r/c.ts", "/r/d.ts"],
			["/r/d.ts", "/r/a.ts"],
		]);
		expect(findCyclesThroughGraph("/r/a.ts", graph)).toEqual([
			["/r/a.ts", "/r/b.ts", "/r/d.ts", "/r/a.ts"],
			["/r/a.ts", "/r/c.ts", "/r/d.ts", "/r/a.ts"],
		]);
	});
});
