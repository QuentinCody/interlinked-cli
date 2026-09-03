// ===========================================
// loadMetricsCoverage — istanbul + LCOV MERGE (finding 2026-06)
// ===========================================
// Unconditional istanbul-over-LCOV precedence made a polyglot repo's
// non-istanbul files vanish from metrics and the tested-file gate, and let a
// STALE istanbul report shadow a fresh LCOV one. The loader now loads BOTH,
// unions the file sets, and resolves per-file lookups through the FRESHER
// report first (report-file mtime), falling back to the other.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetCoverageFinalCache } from "../../harness/coverage-final-reader.js";
import { discoverMetricSourceFiles, loadMetricsCoverage } from "../metrics-coverage.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "metrics-cov-"));
	mkdirSync(join(tmp, "coverage"), { recursive: true });
	__resetCoverageFinalCache();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Minimal valid istanbul coverage-final.json for one fully-covered TS file. */
function istanbulFinal(rel: string): object {
	const abs = join(tmp, rel);
	return {
		[abs]: {
			path: abs,
			fnMap: { "0": { name: "ifn", decl: { start: { line: 1 }, end: { line: 2 } } } },
			f: { "0": 3 },
			statementMap: {
				"0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
				"1": { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
			},
			s: { "0": 3, "1": 3 },
		},
	};
}

function writeIstanbul(rel: string, linePct: number): void {
	writeFileSync(join(tmp, "coverage", "coverage-final.json"), JSON.stringify(istanbulFinal(rel)));
	writeFileSync(
		join(tmp, "coverage", "coverage-summary.json"),
		JSON.stringify({ [join(tmp, rel)]: { lines: { pct: linePct, covered: 1, total: 2 } } }),
	);
}

/** Minimal LCOV report: one file, every DA line hit (100% line coverage) by
 *  default. `reportRel` targets a per-language report path (finding 2026-06:
 *  the adapters each emit their own file; readers must merge them all). */
function writeLcov(
	rel: string,
	lines: string[] = ["DA:1,1", "DA:2,1"],
	reportRel = "coverage/lcov.info",
): void {
	const lcov = [`SF:${rel}`, "FN:1,lfn", "FNDA:2,lfn", ...lines, "end_of_record", ""].join("\n");
	const target = join(tmp, reportRel);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, lcov);
}

/** Pin a report file's mtime so freshness ordering is deterministic. */
function setMtime(file: string, when: Date): void {
	utimesSync(join(tmp, "coverage", file), when, when);
}

const OLDER = new Date("2026-06-01T00:00:00Z");
const NEWER = new Date("2026-06-08T00:00:00Z");

describe("loadMetricsCoverage — single-source and absent cases", () => {
	it("reports unavailable when neither report exists", () => {
		const cov = loadMetricsCoverage(tmp);
		expect(cov.available).toBe(false);
		expect(cov.source).toBeNull();
		expect(cov.fileSet.size).toBe(0);
		expect(cov.perFile("src/a.ts", [], 0)).toBeUndefined();
		expect(cov.linePct("src/a.ts")).toBeNull();
	});

	it("istanbul alone behaves as before (source 'istanbul')", () => {
		writeIstanbul("src/a.ts", 50);
		const cov = loadMetricsCoverage(tmp);
		expect(cov.source).toBe("istanbul");
		expect(cov.fileSet.has("src/a.ts")).toBe(true);
		expect(cov.perFile("src/a.ts", [], 0)?.functions[0]?.name).toBe("ifn");
		expect(cov.linePct("src/a.ts")).toBe(50);
	});

	it("LCOV alone behaves as before (source 'lcov')", () => {
		writeLcov("src/py_mod.py");
		const cov = loadMetricsCoverage(tmp);
		expect(cov.source).toBe("lcov");
		expect(cov.fileSet.has("src/py_mod.py")).toBe(true);
		expect(cov.linePct("src/py_mod.py")).toBe(100);
		const perFile = cov.perFile("src/py_mod.py", [{ name: "lfn", line: 1, endLine: 2 }], 0);
		expect(perFile?.functions[0]?.name).toBe("lfn");
	});
});

describe("loadMetricsCoverage — polyglot MERGE (both reports present)", () => {
	it("unions the file sets and reports source 'istanbul+lcov'", () => {
		writeIstanbul("src/a.ts", 50);
		writeLcov("src/py_mod.py");
		const cov = loadMetricsCoverage(tmp);
		expect(cov.source).toBe("istanbul+lcov");
		expect(cov.fileSet.has("src/a.ts")).toBe(true);
		expect(cov.fileSet.has("src/py_mod.py")).toBe(true);
	});

	it("a file present ONLY in LCOV resolves even when istanbul exists (the polyglot case)", () => {
		writeIstanbul("src/a.ts", 50);
		writeLcov("src/py_mod.py");
		const cov = loadMetricsCoverage(tmp);
		expect(cov.linePct("src/py_mod.py")).toBe(100); // previously null: LCOV was discarded
		const perFile = cov.perFile("src/py_mod.py", [{ name: "lfn", line: 1, endLine: 2 }], 0);
		expect(perFile?.functions[0]?.name).toBe("lfn");
	});

	it("a file present ONLY in istanbul still resolves through the merge", () => {
		writeIstanbul("src/a.ts", 50);
		writeLcov("src/py_mod.py");
		const cov = loadMetricsCoverage(tmp);
		expect(cov.linePct("src/a.ts")).toBe(50);
		expect(cov.perFile("src/a.ts", [], 0)?.functions[0]?.name).toBe("ifn");
	});
});

describe("loadMetricsCoverage — freshness arbitration for files in BOTH reports", () => {
	it("a FRESH LCOV report wins over a STALE istanbul one for the shared file", () => {
		writeIstanbul("src/dual.ts", 50); // istanbul says 50%
		writeLcov("src/dual.ts"); // lcov says 100%
		setMtime("coverage-final.json", OLDER);
		setMtime("coverage-summary.json", OLDER);
		setMtime("lcov.info", NEWER);
		const cov = loadMetricsCoverage(tmp);
		expect(cov.linePct("src/dual.ts")).toBe(100); // fresher report's number
		const perFile = cov.perFile("src/dual.ts", [{ name: "lfn", line: 1, endLine: 2 }], 0);
		expect(perFile?.functions[0]?.name).toBe("lfn"); // resolved via LCOV
	});

	it("a FRESH istanbul report wins over a STALE LCOV one for the shared file", () => {
		writeIstanbul("src/dual.ts", 50);
		writeLcov("src/dual.ts");
		setMtime("coverage-final.json", NEWER);
		setMtime("coverage-summary.json", NEWER);
		setMtime("lcov.info", OLDER);
		const cov = loadMetricsCoverage(tmp);
		expect(cov.linePct("src/dual.ts")).toBe(50);
		const perFile = cov.perFile("src/dual.ts", [{ name: "lfn", line: 1, endLine: 2 }], 0);
		expect(perFile?.functions[0]?.name).toBe("ifn"); // resolved via istanbul
	});

	it("each axis follows ITS OWN backing file: fresh final.json + STALE summary → istanbul perFile, LCOV linePct", () => {
		// The istanbul per-statement data (coverage-final.json) is the freshest,
		// but its summary (coverage-summary.json) predates the LCOV report — the
		// line percentage must come from LCOV, not the stale summary (finding
		// 2026-06: a single mtime axis let final.json's freshness carry the stale
		// summary along with it).
		const MIDDLE = new Date("2026-06-04T00:00:00Z");
		writeIstanbul("src/dual.ts", 50);
		writeLcov("src/dual.ts");
		setMtime("coverage-final.json", NEWER);
		setMtime("coverage-summary.json", OLDER);
		setMtime("lcov.info", MIDDLE);
		const cov = loadMetricsCoverage(tmp);
		const perFile = cov.perFile("src/dual.ts", [{ name: "lfn", line: 1, endLine: 2 }], 0);
		expect(perFile?.functions[0]?.name).toBe("ifn"); // per-file axis: final.json is freshest
		expect(cov.linePct("src/dual.ts")).toBe(100); // linePct axis: lcov beats the stale summary
	});
});

describe("loadMetricsCoverage — per-language LCOV reports (finding 2026-06)", () => {
	// The adapters each emit their OWN report (coverage/lcov-python.info,
	// coverage/javascript/lcov.info, …) so polyglot runs stop clobbering one
	// shared file. The loader must treat every existing report as a source.

	it("merges two per-language reports when the canonical lcov.info is absent", () => {
		writeLcov("pkg/mod.py", undefined, "coverage/lcov-python.info");
		writeLcov("src/app.ts", undefined, "coverage/javascript/lcov.info");
		const cov = loadMetricsCoverage(tmp);
		expect(cov.available).toBe(true);
		expect(cov.source).toBe("lcov"); // two LCOV files are still ONE format
		expect(cov.linePct("pkg/mod.py")).toBe(100);
		expect(cov.linePct("src/app.ts")).toBe(100);
	});

	it("merges a per-language report WITH the canonical one", () => {
		writeLcov("src/app.ts"); // canonical coverage/lcov.info
		writeLcov("pkg/mod.py", undefined, "coverage/lcov-python.info");
		const cov = loadMetricsCoverage(tmp);
		expect(cov.linePct("src/app.ts")).toBe(100);
		expect(cov.linePct("pkg/mod.py")).toBe(100); // pre-fix: only ONE file was read
	});

	it("a file in TWO LCOV reports resolves through the fresher one", () => {
		writeLcov("src/dual.ts"); // canonical: 100%
		writeLcov("src/dual.ts", ["DA:1,1", "DA:2,0"], "coverage/lcov-python.info"); // 50%
		setMtime("lcov.info", OLDER);
		utimesSync(join(tmp, "coverage", "lcov-python.info"), NEWER, NEWER);
		const cov = loadMetricsCoverage(tmp);
		expect(cov.linePct("src/dual.ts")).toBe(50); // the fresher report's number
	});
});

describe("loadMetricsCoverage — unambiguous summary keys (finding 2026-06)", () => {
	it("does NOT attribute a packages/ file's coverage to a root file sharing the path tail", () => {
		// Two istanbul summary entries whose keys share the `/src/foo.ts` tail. The
		// old suffix match returned whichever the iteration reached first.
		writeFileSync(
			join(tmp, "coverage", "coverage-final.json"),
			JSON.stringify(istanbulFinal("src/foo.ts")),
		);
		writeFileSync(
			join(tmp, "coverage", "coverage-summary.json"),
			JSON.stringify({
				[join(tmp, "packages/a/src/foo.ts")]: { lines: { pct: 11, covered: 1, total: 9 } },
				[join(tmp, "src/foo.ts")]: { lines: { pct: 88, covered: 8, total: 9 } },
			}),
		);
		const cov = loadMetricsCoverage(tmp);
		expect(cov.linePct("src/foo.ts")).toBe(88);
		expect(cov.linePct("packages/a/src/foo.ts")).toBe(11);
	});

	it("drops a summary key outside the repo even when its tail matches", () => {
		writeFileSync(
			join(tmp, "coverage", "coverage-final.json"),
			JSON.stringify(istanbulFinal("src/foo.ts")),
		);
		writeFileSync(
			join(tmp, "coverage", "coverage-summary.json"),
			JSON.stringify({ "/elsewhere/src/foo.ts": { lines: { pct: 11, covered: 1, total: 9 } } }),
		);
		const cov = loadMetricsCoverage(tmp);
		expect(cov.linePct("src/foo.ts")).toBeNull();
	});
});

describe("discoverMetricSourceFiles — scope resolution", () => {
	it("includes an src/ source file and excludes its companion test", () => {
		// test-contract: public-api — discoverMetricSourceFiles is the source
		// enumeration `interlinked metrics` scans; src/ inclusion + test
		// exclusion is the documented `isAnalyzableSource` contract.
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "widget.ts"), "export function f() {}\n");
		writeFileSync(join(tmp, "src", "widget.test.ts"), "test('x', () => {});\n");
		const cov = loadMetricsCoverage(tmp);
		const files = discoverMetricSourceFiles(tmp, cov);
		expect(files).toContain("src/widget.ts");
		expect(files).not.toContain("src/widget.test.ts");
	});

	it("includes a non-src/ file only when the coverage report knows it (polyglot case)", () => {
		// test-contract: public-api — a file outside src/ is in scope only via
		// coverage.fileSet, per isAnalyzableSource's non-`src/` branch.
		mkdirSync(join(tmp, "pkg"), { recursive: true });
		writeFileSync(join(tmp, "pkg", "outside.py"), "def f():\n    pass\n");
		const covAbsent = loadMetricsCoverage(tmp);
		expect(discoverMetricSourceFiles(tmp, covAbsent)).not.toContain("pkg/outside.py");

		writeFileSync(
			join(tmp, "coverage", "coverage-final.json"),
			JSON.stringify(istanbulFinal("pkg/outside.py")),
		);
		const covPresent = loadMetricsCoverage(tmp);
		expect(discoverMetricSourceFiles(tmp, covPresent)).toContain("pkg/outside.py");
	});
});
