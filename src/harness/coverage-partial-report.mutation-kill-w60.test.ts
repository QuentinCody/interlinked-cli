import { describe, expect, it } from "vitest";
import {
	detectPartialReport,
	PARTIAL_REPORT_MIN_COMPARABLE_FILES,
	PARTIAL_REPORT_WELL_COVERED_BASELINE_PCT,
	PARTIAL_REPORT_ZEROED_RATIO,
} from "./coverage-partial-report.js";
import type { CoverageBaseline, CoverageSummary } from "./coverage-ratchet.js";

const REPO_ROOT = "/repo";

/** N baseline files, all comfortably well-covered (80/80), named wc0..wc{n-1}. */
function wellCoveredBaselineFiles(n: number): CoverageBaseline["files"] {
	const files: CoverageBaseline["files"] = {};
	for (let i = 0; i < n; i++) {
		files[`wc${i}.ts`] = { lines_pct: 80, branches_pct: 80 };
	}
	return files;
}

/** Matching summary entries for the files above: unzeroed, not counted as zeroed. */
function wellCoveredSummaryEntries(n: number): CoverageSummary {
	const summary: CoverageSummary = {};
	for (let i = 0; i < n; i++) {
		summary[`wc${i}.ts`] = { lines: { pct: 80 }, branches: { pct: 80 } };
	}
	return summary;
}

const MIN = PARTIAL_REPORT_MIN_COMPARABLE_FILES;

describe("detectPartialReport — normalizeSummaryPaths total/entry exclusion", () => {
	// Kills a36fc13a52bff3e6 (!entry||total -> false), 047a158aa7cb848e (|| -> &&),
	// 9989cf3b1cf4410f (rawPath==="total" -> false), 5095f48e50bebd1d ("total" -> "").
	it("excludes the synthetic 'total' key from the comparable count even when a baseline file is literally named 'total'", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: {
				...wellCoveredBaselineFiles(MIN - 1),
				total: { lines_pct: 80, branches_pct: 80 },
			},
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN - 1),
			total: { lines: { pct: 0 }, branches: { pct: 0 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		// "total" must never be treated as a real file entry: comparable stays at
		// MIN - 1 (below the floor), so the detector stays silent.
		expect(verdict.comparable).toBe(MIN - 1);
		expect(verdict.partial).toBe(false);
		expect(verdict.reason).toContain(`only ${MIN - 1}`);
	});
});

describe("detectPartialReport — isWellCoveredInBaseline threshold", () => {
	// Kills c0bae0da597137c2 (OR -> true): a baseline file below threshold on
	// both metrics must never count toward `comparable`.
	it("does not count a baseline file below the well-covered threshold on both metrics", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: {
				...wellCoveredBaselineFiles(MIN),
				lowcov: { lines_pct: 10, branches_pct: 10 },
			},
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			lowcov: { lines: { pct: 10 }, branches: { pct: 10 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.comparable).toBe(MIN);
	});

	// Kills 66db5512f3dce194 (OR -> AND) and c8a7f8d71be1f4b1 (lines term -> false):
	// a file well-covered via lines alone (lines >= threshold, branches below)
	// must still count as well-covered (OR semantics).
	it("counts a baseline file as well-covered via lines alone when branches is below threshold", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: {
				...wellCoveredBaselineFiles(MIN),
				linesonly: { lines_pct: 80, branches_pct: 10 },
			},
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			linesonly: { lines: { pct: 80 }, branches: { pct: 10 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.comparable).toBe(MIN + 1);
	});

	// Kills b1e7d1867b2eb0c1 (>= -> >) and ca62b8bc871613f5 (>= -> <): exact
	// boundary (lines_pct === threshold, branches_pct 0) must still count.
	it("counts a baseline file whose lines_pct sits exactly at the well-covered threshold", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: {
				...wellCoveredBaselineFiles(MIN),
				boundary: { lines_pct: PARTIAL_REPORT_WELL_COVERED_BASELINE_PCT, branches_pct: 0 },
			},
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			boundary: { lines: { pct: 50 }, branches: { pct: 0 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.comparable).toBe(MIN + 1);
	});
});

describe("detectPartialReport — isZeroedInReport", () => {
	// Kills ce87a1f4273bac96 (?? -> && on lines): a nonzero lines pct combined
	// with zero branches pct must NOT read as zeroed.
	it("does not treat a file with nonzero lines pct as zeroed, even with zero branches", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: { ...wellCoveredBaselineFiles(MIN), mixed: { lines_pct: 80, branches_pct: 80 } },
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			mixed: { lines: { pct: 5 }, branches: { pct: 0 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.zeroed).toBe(0);
	});

	// Kills fee77e8071c837c7 (?? -> && on branches) and 86d3e834ec47ccc1 (&& -> ||):
	// zero lines with nonzero branches must NOT read as zeroed either.
	it("does not treat a file with nonzero branches pct as zeroed, even with zero lines", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: { ...wellCoveredBaselineFiles(MIN), mixed2: { lines_pct: 80, branches_pct: 80 } },
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			mixed2: { lines: { pct: 0 }, branches: { pct: 5 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.zeroed).toBe(0);
	});

	// Kills b029f945747b55ab (linesPct===0 -> true): a nonzero lines pct with
	// zero branches must not be forced into "zeroed" via a stuck-true lines check.
	it("requires the real lines value, not a forced-true check, to call a file zeroed", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: { ...wellCoveredBaselineFiles(MIN), nz: { lines_pct: 80, branches_pct: 80 } },
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			nz: { lines: { pct: 99 }, branches: { pct: 0 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.zeroed).toBe(0);
	});

	// Kills 7391e154acb7d633 (branchesPct===0 -> true): symmetric case for branches.
	it("requires the real branches value, not a forced-true check, to call a file zeroed", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: { ...wellCoveredBaselineFiles(MIN), nz2: { lines_pct: 80, branches_pct: 80 } },
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			nz2: { lines: { pct: 0 }, branches: { pct: 99 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.zeroed).toBe(0);
	});

	// Kills 143a972adba7df5b (optional chaining removed on lines): a report entry
	// missing `lines` entirely must not throw.
	it("does not throw when a report entry is missing the lines metric", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: { ...wellCoveredBaselineFiles(MIN), nolines: { lines_pct: 80, branches_pct: 80 } },
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			// SAFETY: deliberately missing `lines` to exercise the optional-chaining
			// guard on a malformed report entry — real coverage tools can omit it.
			nolines: { branches: { pct: 0 } },
		};
		expect(() => detectPartialReport(summary, baseline, REPO_ROOT)).not.toThrow();
	});

	// Kills ad72a812a0aceb75 (optional chaining removed on branches): a report
	// entry missing `branches` entirely must not throw.
	it("does not throw when a report entry is missing the branches metric", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: { ...wellCoveredBaselineFiles(MIN), nobranches: { lines_pct: 80, branches_pct: 80 } },
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			// SAFETY: deliberately missing `branches` to exercise the optional-chaining
			// guard on a malformed report entry — real coverage tools can omit it.
			nobranches: { lines: { pct: 0 } },
		};
		expect(() => detectPartialReport(summary, baseline, REPO_ROOT)).not.toThrow();
	});
});

describe("detectPartialReport — well-covered guard inside countZeroedWellCoveredFiles", () => {
	// Kills 86b4d042790387ac (!isWellCoveredInBaseline -> false): a baseline
	// file that is NOT well-covered must never enter the comparable count,
	// even when present (and zeroed) in the current report.
	it("excludes a not-well-covered baseline file from comparable, even when present and zeroed in the report", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: { ...wellCoveredBaselineFiles(MIN), weak: { lines_pct: 5, branches_pct: 5 } },
		};
		const summary: CoverageSummary = {
			...wellCoveredSummaryEntries(MIN),
			weak: { lines: { pct: 0 }, branches: { pct: 0 } },
		};
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.comparable).toBe(MIN);
		expect(verdict.zeroed).toBe(0);
	});
});

describe("detectPartialReport — reason strings", () => {
	// Kills 26c3f34de86b4d78, 187850a84d2a9a0b, 6255fc9b7abab3a8 (each string
	// segment of the "partial" reason blanked out).
	it("builds the exact partial-report reason text when the zeroed ratio meets the threshold", () => {
		const n = MIN;
		const zeroedCount = Math.ceil(n * PARTIAL_REPORT_ZEROED_RATIO);
		const baseline: CoverageBaseline = { version: 1, updated_at: "x", files: wellCoveredBaselineFiles(n) };
		const summary = wellCoveredSummaryEntries(n);
		for (let i = 0; i < zeroedCount; i++) {
			summary[`wc${i}.ts`] = { lines: { pct: 0 }, branches: { pct: 0 } };
		}
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.partial).toBe(true);
		expect(verdict.reason).toBe(
			`${zeroedCount}/${n} previously well-covered files ` +
				`(>= ${PARTIAL_REPORT_WELL_COVERED_BASELINE_PCT}%) now read as exactly 0% — ` +
				"this looks like a scoped `vitest run --coverage <files>` overwrote the shared " +
				"report, not a real regression. Re-run the full suite before trusting this report.",
		);
	});

	// Kills d99bd7887ab3c82b (* -> / on the percentage math) and
	// 01f086d1ab717dd5 (below-threshold reason string blanked out).
	it("builds the exact below-threshold reason text, showing the ratio as a whole percentage", () => {
		const n = MIN;
		const baseline: CoverageBaseline = { version: 1, updated_at: "x", files: wellCoveredBaselineFiles(n) };
		const summary = wellCoveredSummaryEntries(n);
		summary["wc0.ts"] = { lines: { pct: 0 }, branches: { pct: 0 } };
		const verdict = detectPartialReport(summary, baseline, REPO_ROOT);
		expect(verdict.partial).toBe(false);
		expect(verdict.zeroed).toBe(1);
		expect(verdict.reason).toBe(
			`1/${n} comparable files read as 0% — below the ${Math.round(PARTIAL_REPORT_ZEROED_RATIO * 100)}% partial-report threshold`,
		);
		expect(verdict.reason).toContain("25%");
	});
});
