// Behavioral companion tests for checkImportCycles (cycles.ts).
// The function is a thin wrapper over ProjectGraph.findCyclesThrough: it
// short-circuits on the empty case, otherwise picks the shortest cycle,
// renders it with toRelative, and packages it as one warning result.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { ProjectGraph } from "../project-graph.js";
import { checkImportCycles } from "./cycles.js";

/**
 * Minimal ProjectGraph stand-in exposing only the two methods cycles.ts
 * touches: findCyclesThrough (the source of cycles) and toRelative (the
 * absolute→relative renderer). Everything else is irrelevant to this check.
 */
function fakeGraph(opts: {
	cycles: string[][];
	toRelative?: (f: string) => string;
}): Pick<ProjectGraph, "findCyclesThrough" | "toRelative"> {
	const toRelative = opts.toRelative ?? ((f: string) => f.replace(/^\/repo\//, ""));
	return {
		findCyclesThrough: (_file: string): string[][] => opts.cycles,
		toRelative,
	};
}

describe("checkImportCycles", () => {
	it("returns no results when the graph reports no cycles", () => {
		const graph = fakeGraph({ cycles: [] });
		const results = checkImportCycles("/repo/src/a.ts", "src/a.ts", graph);
		expect(results).toEqual([]);
	});

	it("emits one import_cycles warning describing the shortest cycle", () => {
		// Two cycles of differing length — the check must pick the shorter one.
		const longCycle = ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts", "/repo/src/a.ts"];
		const shortCycle = ["/repo/src/a.ts", "/repo/src/d.ts", "/repo/src/a.ts"];
		const graph = fakeGraph({ cycles: [longCycle, shortCycle] });

		const results = checkImportCycles("/repo/src/a.ts", "src/a.ts", graph);

		expect(results).toHaveLength(1);
		const r = nonNull(results[0]);
		expect(r.check).toBe("import_cycles");
		expect(r.severity).toBe("warning");
		expect(r.file).toBe("/repo/src/a.ts");
		// affectedFiles carries the shortest cycle (absolute), not the long one.
		expect(r.affectedFiles).toEqual(shortCycle);
		// The message renders the shortest cycle relative-path joined by arrows.
		expect(r.message).toContain("Circular dependency detected involving src/a.ts");
		expect(r.message).toContain("src/a.ts → src/d.ts → src/a.ts");
		expect(r.message).not.toContain("src/b.ts");
	});

	it("applies toRelative to every node when rendering the cycle path", () => {
		const cycle = ["/abs/x.ts", "/abs/y.ts", "/abs/x.ts"];
		const graph = fakeGraph({
			cycles: [cycle],
			toRelative: (f) => f.replace(/^\/abs\//, "rel/"),
		});

		const r = nonNull(checkImportCycles("/abs/x.ts", "rel/x.ts", graph)[0]);

		expect(r.message).toContain("rel/x.ts → rel/y.ts → rel/x.ts");
	});

	it("selects the shortest even when it is not first and ties keep a valid cycle", () => {
		// First-listed is the longest; a sort-by-length must surface the 2-hop one.
		const three = ["/repo/m.ts", "/repo/n.ts", "/repo/o.ts"];
		const two = ["/repo/m.ts", "/repo/p.ts"];
		const graph = fakeGraph({ cycles: [three, two] });

		const r = nonNull(checkImportCycles("/repo/m.ts", "m.ts", graph)[0]);

		expect(r.affectedFiles).toEqual(two);
		expect(r.message).toContain("m.ts → p.ts");
	});
});
