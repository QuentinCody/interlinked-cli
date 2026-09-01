// Direct tests for findCyclesThroughGraph (project-graph-cycles.ts) — the
// pure DFS both circular_imports (cycles.ts) and new_import_cycle
// (new-import-cycle.ts) consume via ProjectGraph.findCyclesThrough.
// The type-only cases pin the Effect-derived refinement: an `import type`
// edge is erased at compile time, so a loop crossing one is not a runtime
// cycle (effect-ts-harness-additions.md §2.4).

import { describe, expect, it } from "vitest";
import { findCyclesThroughGraph } from "./project-graph-cycles.js";
import type { ImportEdge } from "./types.js";

function edge(fromFile: string, toFile: string, isTypeOnly = false): ImportEdge {
	return { fromFile, toFile, specifier: toFile, symbols: [], isTypeOnly };
}

function graphOf(edges: ImportEdge[]): Map<string, ImportEdge[]> {
	const graph = new Map<string, ImportEdge[]>();
	for (const e of edges) {
		const list = graph.get(e.fromFile) ?? [];
		list.push(e);
		graph.set(e.fromFile, list);
	}
	return graph;
}

describe("findCyclesThroughGraph — positive (must fire)", () => {
	it("P1: reports a two-file runtime cycle", () => {
		const graph = graphOf([edge("/r/a.ts", "/r/b.ts"), edge("/r/b.ts", "/r/a.ts")]);
		const cycles = findCyclesThroughGraph("/r/a.ts", graph);
		expect(cycles).toEqual([["/r/a.ts", "/r/b.ts", "/r/a.ts"]]);
	});

	it("P2: reports a three-file runtime cycle through the start file", () => {
		const graph = graphOf([
			edge("/r/a.ts", "/r/b.ts"),
			edge("/r/b.ts", "/r/c.ts"),
			edge("/r/c.ts", "/r/a.ts"),
		]);
		const cycles = findCyclesThroughGraph("/r/a.ts", graph);
		expect(cycles).toEqual([["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/a.ts"]]);
	});

	it("P3: a runtime cycle still fires when a parallel type-only edge also exists", () => {
		// a → b runtime AND a → b type-only: the runtime edge alone closes the loop.
		const graph = graphOf([
			edge("/r/a.ts", "/r/b.ts", true),
			edge("/r/a.ts", "/r/b.ts"),
			edge("/r/b.ts", "/r/a.ts"),
		]);
		const cycles = findCyclesThroughGraph("/r/a.ts", graph);
		expect(cycles).toEqual([["/r/a.ts", "/r/b.ts", "/r/a.ts"]]);
	});
});

describe("findCyclesThroughGraph — negative (must not fire)", () => {
	it("N1: a mutual import type pair is not a cycle", () => {
		const graph = graphOf([edge("/r/a.ts", "/r/b.ts", true), edge("/r/b.ts", "/r/a.ts", true)]);
		expect(findCyclesThroughGraph("/r/a.ts", graph)).toEqual([]);
	});

	it("N2: one type-only edge anywhere in the loop breaks the cycle", () => {
		// a → b runtime, b → c runtime, c → a TYPE-ONLY: erased at runtime.
		const graph = graphOf([
			edge("/r/a.ts", "/r/b.ts"),
			edge("/r/b.ts", "/r/c.ts"),
			edge("/r/c.ts", "/r/a.ts", true),
		]);
		expect(findCyclesThroughGraph("/r/a.ts", graph)).toEqual([]);
	});

	it("N3: an acyclic runtime chain reports nothing", () => {
		const graph = graphOf([edge("/r/a.ts", "/r/b.ts"), edge("/r/b.ts", "/r/c.ts")]);
		expect(findCyclesThroughGraph("/r/a.ts", graph)).toEqual([]);
	});

	it("N4: an unresolved edge (empty toFile) never extends a path", () => {
		const graph = graphOf([edge("/r/a.ts", ""), edge("/r/a.ts", "/r/b.ts")]);
		expect(findCyclesThroughGraph("/r/a.ts", graph)).toEqual([]);
	});
});
