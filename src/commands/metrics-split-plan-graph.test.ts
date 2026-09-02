// ===========================================
// metrics-split-plan-graph — intra-file reference graph (TS AST)
// ===========================================
// Labeled per the Check Evidence Contract: P* cases must produce the unit /
// edge / import; N* cases must NOT.

import { describe, expect, it } from "vitest";
import { buildSplitGraph, type SplitGraph, type SplitUnit } from "./metrics-split-plan-graph.js";

const FIXTURE = [
	'import { readFileSync } from "node:fs";', // 1
	'import { join } from "node:path";', // 2
	'import type { Foo } from "./foo.js";', // 3
	"", // 4
	"/** alpha doc */", // 5
	"export function alpha(x: number): number {", // 6
	"\treturn beta(x) + 1;", // 7
	"}", // 8
	"", // 9
	"function beta(x: number): number {", // 10
	"\tif (x > 0) return x;", // 11
	"\treturn -x;", // 12
	"}", // 13
	"", // 14
	'export const gamma = (p: string): string => join(p, "x");', // 15
	"", // 16
	"export function delta(): string {", // 17
	'\treturn readFileSync("a", "utf8");', // 18
	"}", // 19
	"", // 20
	"interface Shape {", // 21
	"\ta: number;", // 22
	"}", // 23
	"", // 24
	"export class Box {", // 25
	"\tsize(): number {", // 26
	"\t\treturn 1;", // 27
	"\t}", // 28
	"}", // 29
	"", // 30
	"const LIMIT = 3;", // 31
	"", // 32
	"function usesLimit(s: Shape): boolean {", // 33
	"\treturn s.a > LIMIT;", // 34
	"}", // 35
	"", // 36
	"function eps(o: { beta(): number }): number {", // 37
	"\treturn o.beta();", // 38
	"}", // 39
	"", // 40
	"function typed(f: Foo): Foo {", // 41
	"\treturn f;", // 42
	"}", // 43
	"", // 44
	'console.log("side effect");', // 45
	"", // 46
].join("\n");

function graph(): SplitGraph {
	const g = buildSplitGraph(FIXTURE, "/repo/src/fixture.ts");
	if (!g) throw new Error("typescript unavailable — AST path required for this suite");
	return g;
}

function unit(g: SplitGraph, name: string): SplitUnit {
	const u = g.units.find((x) => x.name === name);
	if (!u) throw new Error(`unit ${name} missing`);
	return u;
}

function edgeNames(g: SplitGraph): string[] {
	return g.edges.map((e) => `${g.units[e.from]?.name}->${g.units[e.to]?.name}`);
}

describe("buildSplitGraph — positive (must fire)", () => {
	it("P1: lists every named top-level declaration in source order with its kind", () => {
		const g = graph();
		expect(g.units.map((u) => u.name)).toEqual([
			"alpha",
			"beta",
			"gamma",
			"delta",
			"Shape",
			"Box",
			"LIMIT",
			"usesLimit",
			"eps",
			"typed",
		]);
		expect(unit(g, "alpha").kind).toBe("function");
		expect(unit(g, "gamma").kind).toBe("function");
		expect(unit(g, "Shape").kind).toBe("type");
		expect(unit(g, "Box").kind).toBe("class");
		expect(unit(g, "LIMIT").kind).toBe("value");
		expect(g.units.map((u) => u.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("P2: a call to a sibling declaration is a reference edge", () => {
		const names = edgeNames(graph());
		expect(names).toContain("alpha->beta");
	});

	it("P3: a reference to a type or a constant is an edge too", () => {
		const names = edgeNames(graph());
		expect(names).toContain("usesLimit->Shape");
		expect(names).toContain("usesLimit->LIMIT");
	});

	it("P4: attributes external imports to the units that use their bindings", () => {
		const g = graph();
		expect(unit(g, "gamma").imports).toEqual(["node:path"]);
		expect(unit(g, "delta").imports).toEqual(["node:fs"]);
		expect(unit(g, "typed").imports).toEqual(["./foo.js"]);
	});

	it("P5: a unit's range starts at its attached doc comment and ends at its closing brace", () => {
		const alpha = unit(graph(), "alpha");
		expect(alpha.startLine).toBe(5);
		expect(alpha.endLine).toBe(8);
		expect(alpha.lines).toBe(4);
	});

	it("P6: sums AST cyclomatic complexity per unit", () => {
		const g = graph();
		expect(unit(g, "beta").cyclomatic).toBe(2);
		expect(unit(g, "alpha").cyclomatic).toBe(1);
		expect(unit(g, "Box").cyclomatic).toBe(1);
		expect(unit(g, "Shape").cyclomatic).toBe(0);
	});

	it("P7: records the export flag and the file's total line count", () => {
		const g = graph();
		expect(unit(g, "alpha").exported).toBe(true);
		expect(unit(g, "beta").exported).toBe(false);
		expect(g.totalLines).toBe(46);
		expect(g.filePath).toBe("/repo/src/fixture.ts");
	});
});

describe("buildSplitGraph — negative (must not fire)", () => {
	it("N1: a property access whose name matches a sibling is NOT an edge", () => {
		expect(edgeNames(graph())).not.toContain("eps->beta");
	});

	it("N2: a unit never references itself", () => {
		const g = graph();
		expect(g.edges.some((e) => e.from === e.to)).toBe(false);
	});

	it("N3: a unit with no import usage has an empty import set", () => {
		expect(unit(graph(), "alpha").imports).toEqual([]);
	});

	it("N4: an expression statement is not a unit and counts toward the preamble", () => {
		const g = graph();
		expect(g.units.some((u) => u.name === "console")).toBe(false);
		const unitLines = g.units.reduce((sum, u) => sum + u.lines, 0);
		expect(g.preambleLines).toBe(g.totalLines - unitLines);
		expect(g.preambleLines).toBeGreaterThan(0);
	});

	it("N5: a doc comment separated by a blank line is not attached to the unit", () => {
		const src = ["/** stray */", "", "export function one(): number {", "\treturn 1;", "}", ""].join("\n");
		const g = buildSplitGraph(src, "/repo/src/one.ts");
		expect(g?.units[0]?.startLine).toBe(3);
	});

	it("N6: an empty file yields no units, no edges, and a zero-line preamble beyond the newline", () => {
		const g = buildSplitGraph("", "/repo/src/empty.ts");
		expect(g?.units).toEqual([]);
		expect(g?.edges).toEqual([]);
	});
});
