import { describe, expect, it } from "vitest";
import { COVERAGE_METRICS } from "./coverage-metric-names.js";
import { compareFileEntry, gatedCoverageMetrics, normalizeReportPct } from "./coverage-ratchet-compare.js";
import type { CoverageBaselineFileEntry, FileCoverageEntry } from "./coverage-ratchet.js";

const ALL = gatedCoverageMetrics({});
const STRICT = { allowDecreasePct: 0, gatedMetrics: ALL };

function report(pcts: Partial<Record<(typeof COVERAGE_METRICS)[number], number>>): FileCoverageEntry {
	const entry: FileCoverageEntry = {};
	for (const metric of COVERAGE_METRICS) {
		const pct = pcts[metric];
		if (pct !== undefined) entry[metric] = { pct };
	}
	return entry;
}

describe("compareFileEntry — positive (must fire)", () => {
	it("P1: reports a functions drop and a statements drop as separate findings", () => {
		const prior: CoverageBaselineFileEntry = { lines_pct: 90, branches_pct: 80, statements_pct: 90, functions_pct: 100 };
		const out = compareFileEntry("src/a.ts", report({ lines: 90, branches: 80, statements: 85, functions: 50 }), prior, STRICT);
		expect(out.findings.map((f) => f.metric).sort()).toEqual(["functions", "statements"]);
		expect(out.decreased).toBe(true);
		// The dropped metrics hold their high-water; the flat ones persist.
		expect(out.nextEntry).toEqual({ lines_pct: 90, branches_pct: 80, statements_pct: 90, functions_pct: 100 });
	});

	it("P2: an absent required metric (lines) reads as 0 and is a reportable drop", () => {
		const prior: CoverageBaselineFileEntry = { lines_pct: 50, branches_pct: 50 };
		const out = compareFileEntry("src/a.ts", report({ branches: 50 }), prior, STRICT);
		expect(out.findings.map((f) => f.metric)).toEqual(["lines"]);
		expect(out.nextEntry.lines_pct).toBe(50);
	});

	it("P3: a rise on any metric counts as improved and advances only that water-line", () => {
		const prior: CoverageBaselineFileEntry = { lines_pct: 50, branches_pct: 50, functions_pct: 40 };
		const out = compareFileEntry("src/a.ts", report({ lines: 50, branches: 50, functions: 70 }), prior, STRICT);
		expect(out.improved).toBe(true);
		expect(out.findings).toEqual([]);
		expect(out.nextEntry.functions_pct).toBe(70);
	});
});

describe("compareFileEntry — negative (must not fire)", () => {
	it("N1: a legacy two-metric baseline records statements/functions on first sight without judging them", () => {
		const prior: CoverageBaselineFileEntry = { lines_pct: 90, branches_pct: 80 };
		const out = compareFileEntry("src/a.ts", report({ lines: 90, branches: 80, statements: 10, functions: 10 }), prior, STRICT);
		expect(out.findings).toEqual([]);
		expect(out.isNew).toBe(false);
		expect(out.nextEntry).toEqual({ lines_pct: 90, branches_pct: 80, statements_pct: 10, functions_pct: 10 });
	});

	it("N2: a metric absent from the report (LCOV has no statements) holds the prior value and is not a fake 0", () => {
		const prior: CoverageBaselineFileEntry = { lines_pct: 90, branches_pct: 80, statements_pct: 95 };
		const out = compareFileEntry("src/a.ts", report({ lines: 90, branches: 80, functions: 100 }), prior, STRICT);
		expect(out.findings).toEqual([]);
		expect(out.nextEntry.statements_pct).toBe(95);
		expect(out.nextEntry.functions_pct).toBe(100);
	});

	it("N3: an ungated metric never yields a finding, but its water-line still holds on a drop", () => {
		const prior: CoverageBaselineFileEntry = { lines_pct: 90, branches_pct: 80, functions_pct: 100 };
		const out = compareFileEntry("src/a.ts", report({ lines: 90, branches: 80, functions: 20 }), prior, {
			allowDecreasePct: 0,
			gatedMetrics: gatedCoverageMetrics({ metrics: ["lines", "branches"] }),
		});
		expect(out.findings).toEqual([]);
		expect(out.decreased).toBe(false);
		expect(out.nextEntry.functions_pct).toBe(100);
	});

	it("N4: a first-run file (no prior) is new, has no findings, and omits unmeasured optional metrics", () => {
		const out = compareFileEntry("src/a.ts", report({ lines: 10, branches: 20 }), undefined, STRICT);
		expect(out.isNew).toBe(true);
		expect(out.findings).toEqual([]);
		expect(out.nextEntry).toEqual({ lines_pct: 10, branches_pct: 20 });
		expect("statements_pct" in out.nextEntry).toBe(false);
	});
});

describe("gatedCoverageMetrics", () => {
	it("P4: defaults to every metric when the config is silent", () => {
		expect([...gatedCoverageMetrics({})].sort()).toEqual([...COVERAGE_METRICS].sort());
	});

	it("P5: narrows to the configured list", () => {
		expect([...gatedCoverageMetrics({ metrics: ["branches"] })]).toEqual(["branches"]);
	});
});

describe("normalizeReportPct", () => {
	it("P6: floors to the report's 2dp resolution", () => {
		expect(normalizeReportPct(99.999)).toBe(99.99);
		expect(normalizeReportPct(99.0)).toBe(99);
	});
});
