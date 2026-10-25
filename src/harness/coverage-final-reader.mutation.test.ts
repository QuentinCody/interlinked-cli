import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	__resetCoverageFinalCache,
	coverageForFile,
	loadCoverageFinal,
	loadCoverageFinalSummary,
} from "./coverage-final-reader.js";

let tmp: string;
let coveragePath: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "crap-cov-mut-"));
	mkdirSync(join(tmp, "coverage"), { recursive: true });
	coveragePath = join(tmp, "coverage", "coverage-final.json");
	__resetCoverageFinalCache();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeReport(report: unknown): void {
	writeFileSync(coveragePath, JSON.stringify(report), "utf-8");
}

function stmt(line: number, endLine = line): { start: { line: number }; end: { line: number } } {
	return { start: { line }, end: { line: endLine } };
}

describe("loadCoverageFinalSummary — percentage and branch-slot semantics", () => {
	// Basis: coverage-final-reader.ts:168 "Percentage rounded to 2 decimals".
	it("rounds line and branch percentages to two decimals", () => {
		const file = join(tmp, "src/round.ts");
		writeReport({
			[file]: {
				path: file,
				statementMap: { "0": stmt(1), "1": stmt(2), "2": stmt(3) },
				s: { "0": 1, "1": 0, "2": 0 },
				b: { "0": [1, 1, 0] },
			},
		});
		const entry = nonNull(loadCoverageFinalSummary(coveragePath, tmp))["src/round.ts"];
		expect(entry?.lines).toEqual({ pct: 33.33, covered: 1, total: 3 });
		expect(entry?.branches).toEqual({ pct: 66.67, covered: 2, total: 3 });
	});

	// Basis: coverage-report-values.ts:29 "Branch slots are validated individually".
	it("ignores a null or numeric b value instead of failing the whole summary", () => {
		const file = join(tmp, "src/badb.ts");
		writeReport({
			[file]: {
				path: file,
				statementMap: { "0": stmt(1) },
				s: { "0": 1 },
				b: { "0": 5, "1": null, "2": [1, 0] },
			},
		});
		const entry = nonNull(loadCoverageFinalSummary(coveragePath, tmp))["src/badb.ts"];
		expect(entry?.branches).toEqual({ pct: 50, covered: 1, total: 2 });
	});

	it("does not count a non-finite branch hit value as a branch slot", () => {
		const file = join(tmp, "src/inf.ts");
		// 1e999 is valid JSON text that JSON.parse turns into Infinity.
		const body = `{${JSON.stringify(file)}:{"path":${JSON.stringify(file)},"statementMap":{"0":{"start":{"line":1},"end":{"line":1}}},"s":{"0":1},"b":{"0":[1e999,1,0]}}}`;
		writeFileSync(coveragePath, body, "utf-8");
		const entry = nonNull(loadCoverageFinalSummary(coveragePath, tmp))["src/inf.ts"];
		expect(entry?.branches).toEqual({ pct: 50, covered: 1, total: 2 });
	});

	// Basis: the doc comment at coverage-final-reader.ts:184-193 returns null when
	// there are no "usable file entries".
	it("returns null when the only entry is the repository root itself (empty relative key)", () => {
		writeReport({
			[tmp]: { path: tmp, statementMap: { "0": stmt(1) }, s: { "0": 1 } },
		});
		expect(loadCoverageFinalSummary(coveragePath, tmp)).toBeNull();
	});

	it("skips an entry that has a statementMap but no hit map without throwing", () => {
		const file = join(tmp, "src/nohits.ts");
		writeReport({ [file]: { path: file, statementMap: { "0": stmt(1) } } });
		expect(loadCoverageFinalSummary(coveragePath, tmp)).toBeNull();
	});
});

describe("loadCoverageFinal — entry keying and function ranges", () => {
	it("keys a file by its entry.path, not by the surrounding map key", () => {
		const file = join(tmp, "src/real.ts");
		writeReport({
			"bogus/map-key.ts": { path: file, statementMap: { "0": stmt(1) }, s: { "0": 1 } },
		});
		const coverage = nonNull(loadCoverageFinal(coveragePath, tmp));
		expect([...coverage.keys()]).toEqual(["src/real.ts"]);
	});

	it("drops an entry whose path lies outside the repository root", () => {
		const outside = join(tmp, "..", "crap-cov-mut-elsewhere", "src/bar.ts");
		writeReport({
			[outside]: { path: outside, statementMap: { "0": stmt(1) }, s: { "0": 1 } },
		});
		const coverage = nonNull(loadCoverageFinal(coveragePath, tmp));
		expect([...coverage.keys()]).toEqual([]);
	});

	// Basis: FunctionCoverage.line is the "1-based declaration start line"
	// (coverage-final-reader.ts:30).
	it("uses the declaration range, not the body range, for the function start line", () => {
		const file = join(tmp, "src/decl.ts");
		writeReport({
			[file]: {
				path: file,
				fnMap: {
					"0": {
						name: "f",
						decl: { start: { line: 5 }, end: { line: 5 } },
						loc: { start: { line: 2 }, end: { line: 8 } },
					},
				},
				f: { "0": 1 },
				statementMap: { "0": stmt(2), "1": stmt(5), "2": stmt(6) },
				s: { "0": 0, "1": 1, "2": 1 },
			},
		});
		const fns = coverageForFile(nonNull(loadCoverageFinal(coveragePath, tmp)), "src/decl.ts")?.functions;
		expect(fns).toEqual([{ name: "f", line: 5, endLine: 8, hits: 1, statement_pct: 100 }]);
	});

	// Basis: FunctionCoverage.line is documented as 1-based (coverage-final-reader.ts:30).
	it("omits a function whose declaration starts at line 0", () => {
		const file = join(tmp, "src/zero.ts");
		writeReport({
			[file]: {
				path: file,
				fnMap: { "0": { name: "z", decl: { start: { line: 0 }, end: { line: 3 } } } },
				f: { "0": 1 },
				statementMap: { "0": stmt(1), "1": stmt(2) },
				s: { "0": 1, "1": 1 },
			},
		});
		const entry = coverageForFile(nonNull(loadCoverageFinal(coveragePath, tmp)), "src/zero.ts");
		expect(entry?.functions).toEqual([]);
	});
});

describe("loadCoverageFinal — per-line coverage", () => {
	// Basis: coverage-final-reader.ts:346 "A line is covered if ANY statement starting on it executed."
	it("never lists a line as uncovered when a covered statement starts on it", () => {
		const file = join(tmp, "src/lines.ts");
		writeReport({
			[file]: {
				path: file,
				statementMap: { "0": stmt(4), "1": stmt(3, 4) },
				s: { "0": 1, "1": 0 },
			},
		});
		const entry = coverageForFile(nonNull(loadCoverageFinal(coveragePath, tmp)), "src/lines.ts");
		expect([...(entry?.coveredLines ?? [])]).toEqual([4]);
		expect([...(entry?.uncoveredLines ?? [])]).toEqual([3]);
	});
});
