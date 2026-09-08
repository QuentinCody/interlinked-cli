// Behavioral unit tests for checkDeadExports.
//
// The function under test is pure given a ProjectGraph: it only calls
// `graph.getExports(filePath)` and `graph.getImporters(filePath)` and returns
// StructuralCheckResult[]. No filesystem / network / time access — so we stub
// the two graph methods directly through the consumed graph interface.

import { describe, expect, it, vi } from "vitest";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol, ImportEdge } from "../types/graph.js";
import { checkDeadExports } from "./dead-exports.js";

// --- fixture helpers ---------------------------------------------------------

function exp(name: string, kind: ExportedSymbol["kind"] = "function"): ExportedSymbol {
	return { name, kind, isTypeOnly: false, line: 1 };
}

function edge(symbols: string[], fromFile = "/proj/importer.ts"): ImportEdge {
	return {
		fromFile,
		toFile: "/proj/target.ts",
		specifier: "./target",
		symbols,
		isTypeOnly: false,
	};
}

/** Stub graph exposing only the two methods checkDeadExports consumes. */
function makeGraph(opts: {
	exports?: ExportedSymbol[];
	importers?: ImportEdge[];
}): Pick<ProjectGraph, "getExports" | "getImporters"> {
	return {
		getExports: vi.fn().mockReturnValue(opts.exports ?? []),
		getImporters: vi.fn().mockReturnValue(opts.importers ?? []),
	};
}

const FILE = "/proj/target.ts";
const REL = "target.ts";

// --- tests -------------------------------------------------------------------

describe("checkDeadExports", () => {
	describe("early exits", () => {
		it("returns [] when the file has no exports (L22)", () => {
			const graph = makeGraph({ exports: [] });
			expect(checkDeadExports(FILE, REL, graph)).toEqual([]);
			// getImporters must not even be reached on the no-exports path.
			expect((vi.mocked(graph.getImporters))).not.toHaveBeenCalled();
		});

		it("returns [] when a namespace/wildcard importer exists (empty symbols, L31)", () => {
			// edge with zero symbols + at least one importer => whole-module import,
			// so every export is considered used.
			const graph = makeGraph({
				exports: [exp("foo"), exp("bar")],
				importers: [edge([])],
			});
			expect(checkDeadExports(FILE, REL, graph)).toEqual([]);
		});

		it("does NOT short-circuit on an empty-symbols edge when no real importers (guard L31 importers.length>0)", () => {
			// importers array is non-empty (one edge with []), so L31's
			// `importers.length > 0` is true and it returns []. Verify the OTHER
			// side: a single namespace edge among real edges still returns [].
			const graph = makeGraph({
				exports: [exp("foo")],
				importers: [edge(["foo"]), edge([])],
			});
			// foo is imported by the first edge AND the namespace edge triggers L31.
			expect(checkDeadExports(FILE, REL, graph)).toEqual([]);
		});
	});

	describe("no importers at all (L35 branch)", () => {
		// test-contract: behavior — dead_code_action "delete" (operator request
		// 2026-08-17) instructs verify-then-delete; exports stay caveated because
		// import analysis cannot see runtime/dynamic consumers
		it("P: appends the verify-then-delete instruction when dead_code_action is 'delete'", () => {
			const graph = makeGraph({
				exports: [exp("alpha")],
				importers: [],
			});
			const res = checkDeadExports(FILE, REL, graph, "delete");
			expect(res[0]?.message).toContain('dead_code_action is "delete"');
			expect(res[0]?.message).toContain("verify no runtime/dynamic consumer");
		});

		it("N: default action ('flag' / omitted) carries no delete instruction", () => {
			const graph = makeGraph({
				exports: [exp("alpha")],
				importers: [],
			});
			for (const res of [
				checkDeadExports(FILE, REL, graph),
				checkDeadExports(FILE, REL, graph, "flag"),
			]) {
				expect(res[0]?.message).not.toContain("dead_code_action");
			}
		});

		it("flags every named export when nothing imports the file", () => {
			const graph = makeGraph({
				exports: [exp("alpha"), exp("beta")],
				importers: [],
			});
			const res = checkDeadExports(FILE, REL, graph);
			expect(res).toHaveLength(1);
			expect(res[0]).toMatchObject({
				check: "dead_exports",
				severity: "info",
				file: FILE,
			});
			expect(res[0]?.message).toContain("target.ts exports 2 symbol(s)");
			expect(res[0]?.message).toContain("`alpha`, `beta`");
			expect(res[0]?.message).not.toContain("more");
		});

		it("filters out default and * exports before counting (L42)", () => {
			const graph = makeGraph({
				exports: [exp("default", "default"), exp("*", "namespace"), exp("real")],
				importers: [],
			});
			const res = checkDeadExports(FILE, REL, graph);
			expect(res).toHaveLength(1);
			expect(res[0]?.message).toContain("exports 1 symbol(s)");
			expect(res[0]?.message).toContain("`real`");
			expect(res[0]?.message).not.toContain("default");
		});

		it("returns [] when the only exports are default/* (L44 exportNames.length===0)", () => {
			const graph = makeGraph({
				exports: [exp("default", "default"), exp("*", "namespace")],
				importers: [],
			});
			expect(checkDeadExports(FILE, REL, graph)).toEqual([]);
		});

		it("truncates to 5 names and appends a +N more suffix (L50 ternary true)", () => {
			const names = ["a", "b", "c", "d", "e", "f", "g"]; // 7 named exports
			const graph = makeGraph({
				exports: names.map((n) => exp(n)),
				importers: [],
			});
			const res = checkDeadExports(FILE, REL, graph);
			expect(res[0]?.message).toContain("exports 7 symbol(s)");
			// first 5 shown, joined with backticks
			expect(res[0]?.message).toContain("`a`, `b`, `c`, `d`, `e`");
			expect(res[0]?.message).toContain("+2 more");
			// f and g should not be listed inline
			expect(res[0]?.message).not.toContain("`f`");
		});

		it("shows exactly 5 names with no suffix at the boundary (L50 ternary false)", () => {
			const names = ["a", "b", "c", "d", "e"]; // exactly 5
			const graph = makeGraph({
				exports: names.map((n) => exp(n)),
				importers: [],
			});
			const res = checkDeadExports(FILE, REL, graph);
			expect(res[0]?.message).toContain("`a`, `b`, `c`, `d`, `e`");
			expect(res[0]?.message).not.toContain("more");
		});

		describe.each(["index", "main", "server", "worker"])(
			"entry-point basename %s is skipped (L38 || chain)",
			(base) => {
				it("returns [] for .ts file", () => {
					const path = `/proj/sub/${base}.ts`;
					const graph = makeGraph({
						exports: [exp("anything")],
						importers: [],
					});
					expect(checkDeadExports(path, `sub/${base}.ts`, graph)).toEqual([]);
				});
			},
		);

		it("does NOT skip a non-entry-point basename (L38 all comparisons false)", () => {
			const path = "/proj/utils.ts";
			const graph = makeGraph({
				exports: [exp("helper")],
				importers: [],
			});
			const res = checkDeadExports(path, "utils.ts", graph);
			expect(res).toHaveLength(1);
			expect(res[0]?.message).toContain("`helper`");
		});

		it("strips the extension when matching entry-point basenames (extname use)", () => {
			// basename(filePath, extname(filePath)) must yield "index" for index.tsx too.
			const graph = makeGraph({
				exports: [exp("x")],
				importers: [],
			});
			expect(checkDeadExports("/proj/index.tsx", "index.tsx", graph)).toEqual([]);
			// And a file literally named "indexer.ts" must NOT be treated as an entry point.
			const res = checkDeadExports("/proj/indexer.ts", "indexer.ts", makeGraph({ exports: [exp("x")], importers: [] }));
			expect(res).toHaveLength(1);
		});
	});

	describe("importers exist — per-symbol dead detection (L57 branch)", () => {
		it("flags exports that no importer references", () => {
			const graph = makeGraph({
				exports: [exp("used"), exp("dead1"), exp("dead2")],
				importers: [edge(["used"])],
			});
			const res = checkDeadExports(FILE, REL, graph);
			expect(res).toHaveLength(1);
			expect(res[0]).toMatchObject({ check: "dead_exports", severity: "info", file: FILE });
			expect(res[0]?.message).toContain("Unused exports in target.ts");
			expect(res[0]?.message).toContain("`dead1`, `dead2`");
			expect(res[0]?.message).not.toContain("`used`");
			expect(res[0]?.message).not.toContain("more");
		});

		it("returns [] when every named export is imported (L61 deadExports.length===0)", () => {
			const graph = makeGraph({
				exports: [exp("a"), exp("b")],
				importers: [edge(["a", "b"])],
			});
			expect(checkDeadExports(FILE, REL, graph)).toEqual([]);
		});

		it("aggregates imported symbols across multiple importer edges (L26-29 loop)", () => {
			const graph = makeGraph({
				exports: [exp("a"), exp("b"), exp("c")],
				importers: [edge(["a"]), edge(["b"], "/proj/other.ts")],
			});
			const res = checkDeadExports(FILE, REL, graph);
			// only c is unreferenced
			expect(res).toHaveLength(1);
			expect(res[0]?.message).toContain("`c`");
			expect(res[0]?.message).not.toContain("`a`");
			expect(res[0]?.message).not.toContain("`b`");
		});

		it("ignores default and * exports in dead detection (L58)", () => {
			// default and * are never counted as dead even if unreferenced.
			const graph = makeGraph({
				exports: [exp("default", "default"), exp("*", "namespace"), exp("real")],
				importers: [edge(["real"])],
			});
			expect(checkDeadExports(FILE, REL, graph)).toEqual([]);
		});

		it("truncates dead list to 5 with +N more (L68 ternary true)", () => {
			const dead = ["d1", "d2", "d3", "d4", "d5", "d6"]; // 6 dead
			const graph = makeGraph({
				exports: [exp("kept"), ...dead.map((n) => exp(n))],
				importers: [edge(["kept"])],
			});
			const res = checkDeadExports(FILE, REL, graph);
			expect(res[0]?.message).toContain("`d1`, `d2`, `d3`, `d4`, `d5`");
			expect(res[0]?.message).toContain("+1 more");
			expect(res[0]?.message).not.toContain("`d6`");
		});

		it("shows exactly 5 dead names with no suffix (L68 ternary false)", () => {
			const dead = ["d1", "d2", "d3", "d4", "d5"]; // exactly 5
			const graph = makeGraph({
				exports: [exp("kept"), ...dead.map((n) => exp(n))],
				importers: [edge(["kept"])],
			});
			const res = checkDeadExports(FILE, REL, graph);
			expect(res[0]?.message).toContain("`d1`, `d2`, `d3`, `d4`, `d5`");
			expect(res[0]?.message).not.toContain("more");
		});
	});
});
