import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMetricsCoverage } from "./metrics-coverage.js";
import { cyclomaticForMetrics } from "./metrics.js";

function mkTmp(): string {
	return mkdtempSync(join(tmpdir(), "metrics-mkw55-"));
}

/** Minimal istanbul coverage-final.json entry: one uncovered statement (0%). */
function istanbulFinalJson(rel: string): string {
	return JSON.stringify({
		[rel]: {
			path: rel,
			statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
			s: { "0": 0 },
			fnMap: {},
			f: {},
		},
	});
}

function istanbulSummaryJson(rel: string): string {
	return JSON.stringify({
		total: { lines: { pct: 0 }, branches: { pct: 0 } },
		[rel]: { lines: { pct: 0 }, branches: { pct: 0 } },
	});
}

function lcovInfo(rel: string): string {
	return `SF:${rel}\nDA:1,5\nLF:1\nLH:1\nend_of_record\n`;
}

describe("loadMetricsCoverage — istanbul path construction (kills e5d15644 / 5f130d33 / 574095a2 / c4b5f64a)", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — loadMetricsCoverage() must read the istanbul
	// report at the fixed `coverage/coverage-final.json` +
	// `coverage/coverage-summary.json` paths documented on istanbulSource.
	it("P1: reads coverage from coverage/coverage-final.json and coverage/coverage-summary.json", () => {
		dir = mkTmp();
		mkdirSync(join(dir, "coverage"), { recursive: true });
		writeFileSync(join(dir, "coverage", "coverage-final.json"), istanbulFinalJson("src/dup.ts"));
		writeFileSync(join(dir, "coverage", "coverage-summary.json"), istanbulSummaryJson("src/dup.ts"));

		const cov = loadMetricsCoverage(dir);
		expect(cov.available).toBe(true);
		expect(cov.source).toBe("istanbul");
		// Real, non-null value read from coverage-summary.json — a mutated
		// "coverage" / "coverage-summary.json" string breaks this to null.
		expect(cov.linePct("src/dup.ts")).toBe(0);
	});
});

describe("loadMetricsCoverage — freshness-ordered merge (kills reportMtimeMs + sort mutants)", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function setupTwoSources(): void {
		dir = mkTmp();
		mkdirSync(join(dir, "coverage"), { recursive: true });
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "coverage", "coverage-final.json"), istanbulFinalJson("src/dup.ts"));
		writeFileSync(join(dir, "coverage", "coverage-summary.json"), istanbulSummaryJson("src/dup.ts"));
		writeFileSync(join(dir, "coverage", "lcov.info"), lcovInfo("src/dup.ts"));

		// istanbul reports are OLDER, lcov is NEWER — the fresher report (lcov,
		// 100% covered) must win over the stale istanbul report (0%). Fixed
		// epoch timestamps, not the real clock, so the ordering is deterministic.
		const old = new Date(1_700_000_000_000);
		const fresh = new Date(1_700_000_600_000);
		utimesSync(join(dir, "coverage", "coverage-final.json"), old, old);
		utimesSync(join(dir, "coverage", "coverage-summary.json"), old, old);
		utimesSync(join(dir, "coverage", "lcov.info"), fresh, fresh);
	}

	// test-contract: public-api — loadMetricsCoverage() merges istanbul + LCOV
	// reports and each axis (linePct/perFile) must prefer the FRESHER report's
	// file-mtime, per the exported MetricsCoverage contract's doc comment.
	it("P2: linePct prefers the FRESHER report (byLinePct sort + comparator + reportMtimeMs)", () => {
		setupTwoSources();
		const cov = loadMetricsCoverage(dir);
		// Correct behavior: lcov.info is newer, so its 100% wins over istanbul's
		// stale 0%. If reportMtimeMs always returns undefined/0, or the sort /
		// comparator is disabled, the stale istanbul report (0) wins instead.
		expect(cov.linePct("src/dup.ts")).toBe(100);
	});

	// test-contract: public-api — same fresher-report-wins contract as P2, but
	// exercised through the perFile axis (byPerFile ordering) instead of linePct.
	it("P3: perFile prefers the FRESHER report (byPerFile sort + comparator + reportMtimeMs)", () => {
		setupTwoSources();
		const cov = loadMetricsCoverage(dir);
		const sentinelMtime = 918273;
		const perFile = cov.perFile(
			"src/dup.ts",
			[{ name: "f", line: 1, endLine: 1 }],
			sentinelMtime,
		);
		expect(perFile).toBeDefined();
		// Only the LCOV path stamps the PASSED-IN mtime onto the result
		// (perFileCoverageFromCanonical); istanbul stamps its own report mtime.
		// If the fresher-first ordering is broken, istanbul (stale, first in
		// insertion order) answers instead and the sentinel mtime is lost.
		expect(perFile?.mtime).toBe(sentinelMtime);
	});
});

describe("loadMetricsCoverage — perFile source fallback (kills 0dcd3e4f2ee3c285)", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — MetricsCoverage.perFile doc comment: "Per-file
	// lookups try the FRESHER report first ... and fall back to the other for
	// files it lacks", i.e. an undefined result from one source must not stop
	// the search.
	it("P4: falls through to the NEXT source when the fresher one has no data for this file", () => {
		dir = mkTmp();
		mkdirSync(join(dir, "coverage"), { recursive: true });
		// istanbul reports ONLY src/dup.ts; lcov reports ONLY src/onlylcov.ts.
		writeFileSync(join(dir, "coverage", "coverage-final.json"), istanbulFinalJson("src/dup.ts"));
		writeFileSync(join(dir, "coverage", "coverage-summary.json"), istanbulSummaryJson("src/dup.ts"));
		writeFileSync(join(dir, "coverage", "lcov.info"), lcovInfo("src/onlylcov.ts"));

		// Make istanbul the fresher (first-tried) source. Fixed epoch timestamps
		// keep the ordering deterministic across runs.
		const old = new Date(1_700_000_000_000);
		const fresh = new Date(1_700_000_600_000);
		utimesSync(join(dir, "coverage", "lcov.info"), old, old);
		utimesSync(join(dir, "coverage", "coverage-final.json"), fresh, fresh);
		utimesSync(join(dir, "coverage", "coverage-summary.json"), fresh, fresh);

		const cov = loadMetricsCoverage(dir);
		// istanbul (tried first) has no entry for src/onlylcov.ts -> undefined ->
		// the loop must continue to the lcov source instead of returning early.
		const perFile = cov.perFile("src/onlylcov.ts", [{ name: "f", line: 1, endLine: 1 }], 5);
		expect(perFile).toBeDefined();
	});
});

describe("cyclomaticForMetrics — extension dispatch (kills 378a971ae7d00134)", () => {
	// test-contract: public-api — cyclomaticForMetrics doc comment: dispatch by
	// extension, not "output nonempty" — a .py file must go through
	// computeCyclomaticComplexity's Python walker, never the JS/TS AST pass.
	it("P5: a Python file is analyzed by the Python walker, not treated as JS/TS", () => {
		const pySource = ["def foo():", "    if True:", "        return 1", "    return 2", ""].join(
			"\n",
		);
		const result = cyclomaticForMetrics(pySource, "module.py");
		// The TS/JS-only AST pass returns an EMPTY array (not null) for a .py
		// file when it wrongly dispatches there, so `?? computeCyclomaticComplexity`
		// never runs and the branchy `foo` function goes unreported.
		expect(result.length).toBeGreaterThan(0);
		expect(result.some((f) => f.name === "foo")).toBe(true);
	});
});
