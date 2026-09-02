// ===========================================
// metrics-complexity-census unit tests — the pure census core
// ===========================================
// Fixture values (cyclomatic / cognitive / lines) were pinned by running the
// harness's own AST analyzers over the same strings (scratch probe, 2026-09-01),
// so every oracle below is what the gates themselves would measure.

import { describe, expect, it } from "vitest";
import {
	CENSUS_METRICS,
	type CensusSource,
	collectCensusRows,
	countOver,
	HISTOGRAM_BANDS,
	histogram,
	percentile,
	perFileMass,
	proposeCaps,
	summarize,
	topN,
} from "./metrics-complexity-census.js";

const SIMPLE = "export function one(a: number): number {\n\treturn a;\n}\n";
const BRANCHY = [
	"export function branchy(a: number): number {",
	"\tif (a > 1) {",
	"\t\tif (a > 2) {",
	"\t\t\treturn 2;",
	"\t\t}",
	"\t\treturn 1;",
	"\t}",
	"\tfor (let i = 0; i < a; i++) {",
	"\t\tif (i % 2 === 0 && i > 3) continue;",
	"\t}",
	"\treturn 0;",
	"}",
	"",
	"export const arrow = (x: number): number => (x > 0 ? x : -x);",
	"",
].join("\n");

const SOURCES: CensusSource[] = [
	{ file: "src/simple.ts", content: SIMPLE },
	{ file: "src/branchy.ts", content: BRANCHY },
];

describe("percentile", () => {
	it("P1: uses the floor(p/100 · n) rank the reference census used", () => {
		const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		expect(percentile(sorted, 50)).toBe(6);
		expect(percentile(sorted, 90)).toBe(10);
		expect(percentile(sorted, 100)).toBe(10);
		expect(percentile(sorted, 0)).toBe(1);
	});

	it("N1: returns 0 for an empty sample instead of NaN", () => {
		expect(percentile([], 50)).toBe(0);
	});
});

describe("summarize", () => {
	it("P1: reports n, mean, and every percentile in the census order", () => {
		const d = summarize([3, 1, 2, 10]);
		expect(d).toEqual({ n: 4, mean: 4, p50: 3, p75: 10, p90: 10, p95: 10, p99: 10, max: 10 });
	});

	it("N1: an empty sample yields zeros, not NaN", () => {
		expect(summarize([])).toEqual({ n: 0, mean: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 });
	});
});

describe("histogram", () => {
	it("P1: places each value in the first band whose ceiling covers it, overflow last", () => {
		const bands = histogram([0, 1, 2, 3, 5, 9, 100], [1, 2, 3, 5, 8]);
		expect(bands).toEqual([
			{ lo: 0, hi: 1, count: 2 },
			{ lo: 2, hi: 2, count: 1 },
			{ lo: 3, hi: 3, count: 1 },
			{ lo: 4, hi: 5, count: 1 },
			{ lo: 6, hi: 8, count: 0 },
			{ lo: 9, hi: null, count: 2 },
		]);
	});

	it("P2: ships the exact bands the reference census printed", () => {
		expect(HISTOGRAM_BANDS.cyclomatic).toEqual([1, 2, 3, 5, 8, 12, 16, 22, 30]);
		expect(HISTOGRAM_BANDS.cognitive).toEqual([0, 3, 6, 10, 15, 20, 30, 40]);
		expect(HISTOGRAM_BANDS.lines).toEqual([100, 200, 300, 400, 500, 600]);
		expect(CENSUS_METRICS).toEqual(["cyclomatic", "cognitive", "lines"]);
	});

	it("N1: an empty sample produces every band with count 0", () => {
		const bands = histogram([], [1, 2]);
		expect(bands.map((b) => b.count)).toEqual([0, 0, 0]);
	});
});

describe("topN / countOver", () => {
	it("P1: topN sorts by value descending, breaks ties by file then line, and does not mutate", () => {
		const rows = [
			{ file: "b.ts", name: "x", line: 1, value: 3 },
			{ file: "a.ts", name: "y", line: 9, value: 3 },
			{ file: "a.ts", name: "z", line: 2, value: 3 },
			{ file: "c.ts", name: "w", line: 1, value: 7 },
		];
		const copy = [...rows];
		expect(topN(rows, 3).map((r) => r.name)).toEqual(["w", "z", "y"]);
		expect(rows).toEqual(copy);
	});

	it("P2: countOver counts strictly-greater values only", () => {
		expect(countOver([1, 22, 23, 30], 22)).toBe(2);
	});

	it("N1: topN with n=0 returns nothing", () => {
		expect(topN([{ value: 1 }], 0)).toEqual([]);
	});
});

describe("collectCensusRows", () => {
	it("P1: measures cappable files with the AST analyzers and keeps file:line per function", () => {
		const rows = collectCensusRows(SOURCES, "/repo");
		expect(rows).not.toBeNull();
		if (rows === null) return;
		expect(rows.files).toBe(2);
		expect(rows.lines).toEqual([
			{ file: "src/simple.ts", value: 4 },
			{ file: "src/branchy.ts", value: 15 },
		]);
		expect(rows.cyclomatic).toEqual([
			{ file: "src/simple.ts", name: "one", line: 1, value: 1 },
			{ file: "src/branchy.ts", name: "branchy", line: 1, value: 6 },
			{ file: "src/branchy.ts", name: "arrow", line: 14, value: 2 },
		]);
		expect(rows.cognitive.map((r) => [r.name, r.value])).toEqual([
			["one", 0],
			["branchy", 7],
			["arrow", 1],
		]);
	});

	it("N1: skips test files and scratch/ — the same population the gates judge", () => {
		const rows = collectCensusRows(
			[
				...SOURCES,
				{ file: "src/branchy.test.ts", content: BRANCHY },
				{ file: "scratch/x.ts", content: SIMPLE },
			],
			"/repo",
		);
		expect(rows?.files).toBe(2);
		expect(rows?.cyclomatic).toHaveLength(3);
	});

	it("N2: returns null when the AST analyzer is unavailable rather than an empty census", () => {
		const rows = collectCensusRows(SOURCES, "/repo", {
			cyclomatic: () => null,
			cognitive: () => [],
		});
		expect(rows).toBeNull();
	});
});

describe("perFileMass", () => {
	it("P1: sums cyclomatic + cognitive per file, counts functions, and reports density = ΣCC ÷ fns", () => {
		const rows = collectCensusRows(SOURCES, "/repo");
		if (rows === null) throw new Error("analyzer unavailable");
		expect(perFileMass(rows.cyclomatic, rows.cognitive)).toEqual([
			{ file: "src/branchy.ts", cc: 8, cog: 8, fns: 2, density: 4 },
			{ file: "src/simple.ts", cc: 1, cog: 0, fns: 1, density: 1 },
		]);
	});

	it("N1: a file with cognitive rows but no cyclomatic rows has density 0, not NaN", () => {
		expect(perFileMass([], [{ file: "x.ts", name: "f", line: 1, value: 4 }])).toEqual([
			{ file: "x.ts", cc: 0, cog: 4, fns: 0, density: 0 },
		]);
	});
});

describe("proposeCaps", () => {
	it("P1: proposes p90 and p95 per metric from the tree, with the sample size", () => {
		const rows = collectCensusRows(SOURCES, "/repo");
		if (rows === null) throw new Error("analyzer unavailable");
		const p = proposeCaps(rows);
		expect(p.cyclomatic).toEqual({ n: 3, p90: 6, p95: 6 });
		expect(p.cognitive).toEqual({ n: 3, p90: 7, p95: 7 });
		expect(p.lines).toEqual({ n: 2, p90: 15, p95: 15 });
	});

	it("N1: an empty tree proposes zeros rather than throwing", () => {
		const p = proposeCaps({ files: 0, cyclomatic: [], cognitive: [], lines: [] });
		expect(p.lines).toEqual({ n: 0, p90: 0, p95: 0 });
	});
});
