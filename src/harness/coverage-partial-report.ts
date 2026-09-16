// ===========================================
// Coverage Ratchet — Partial-Report Detection
// ===========================================
// Split out of coverage-ratchet.ts to stay under this repo's 500-line
// hand-written-file cap (`large-file-policy.ts`) — a re-exporting entry +
// sibling helper, the established pattern for over-cap modules here.
// `coverage-ratchet.ts` re-exports everything below; external callers keep
// importing from "./coverage-ratchet.js" unchanged.
//
// Vitest's `coverage.all: true` (and equivalent istanbul/c8 settings) lists
// EVERY file in the project in coverage-summary.json even when only a handful
// were actually exercised — unexercised files read as an honest-looking
// `{ pct: 0 }` rather than being absent. Someone running a SCOPED command
// (`vitest run --coverage <a few files>`) therefore overwrites the shared
// coverage/ report with a summary that LOOKS complete (all 1000+ files
// present) but is only measured for the handful actually run. Fed straight
// into `compareCoverage`, every other well-covered file reads as having
// dropped to 0% — a false "mass regression" (measured: 3748 spurious
// findings from a 3-file scoped run in this repo on 2026-07-31).
//
// The fix: a real edit cannot legitimately drive hundreds of previously
// well-covered files to EXACTLY 0% in one run. Detect that shape and treat
// the whole report as UNMEASURED rather than REGRESSED — same stance
// `per_edit_mutation` takes via `unavailable_behavior: "allow_unmeasured"`.

import { baselineKeyFor, COVERAGE_METRICS } from "./coverage-metric-names.js";
import {
	type CoverageBaseline,
	type CoverageBaselineFileEntry,
	type CoverageSummary,
	type FileCoverageEntry,
	normalizePath,
	normalizeReportPct,
} from "./coverage-ratchet.js";

export interface PartialReportVerdict {
	/** True when the report looks like a scoped/partial run, not a full one. */
	partial: boolean;
	/** Baseline-well-covered files that read as exactly 0% in the CURRENT report. */
	zeroed: number;
	/**
	 * Baseline-well-covered files present in the current report — the
	 * denominator of the zeroed ratio, and what the minimum-files guard
	 * counts against.
	 */
	comparable: number;
	/** Human-readable justification, surfaced in `interlinked coverage check` output. */
	reason: string;
}

/**
 * Minimum number of baseline-well-covered files that must be comparable
 * against the current report before the detector will render a verdict at
 * all. Below this, the baseline is either fresh or the repo is tiny, and a
 * handful of zeroed files is just as likely to be a real regression as a
 * scoped run — there isn't enough signal to tell the difference, so the
 * detector stays silent (never partial) rather than guess.
 */
export const PARTIAL_REPORT_MIN_COMPARABLE_FILES = 20;

/**
 * Fraction (not an absolute count, so the signal scales with repo size) of
 * comparable files that must read as exactly 0% before the report is judged
 * partial. Chosen well above the noise floor of a real, if unusually broad,
 * regression: a single genuinely-zeroed file among 20+ comparable files is
 * ~5%, well under this; the measured real-world scoped-run incident zeroed
 * essentially all comparable files (~100%).
 */
export const PARTIAL_REPORT_ZEROED_RATIO = 0.25;

/**
 * Baseline pct (lines OR branches) at/above which a file counts as
 * "well covered" for this signal. Set at the halfway point so a file that
 * was already weak (and might legitimately regress to 0 from a handful of
 * broken tests) doesn't count toward the partial-report signal — only files
 * that were doing well are informative here.
 */
export const PARTIAL_REPORT_WELL_COVERED_BASELINE_PCT = 50;

/** Repo-relative-path → entry map, skipping the synthetic `total` bucket and
 *  any path that normalizes outside `repoRoot` — same rules `compareCoverage`
 *  applies, factored out so both can share one notion of "the current report." */
function normalizeSummaryPaths(
	summary: CoverageSummary,
	repoRoot: string,
): Map<string, FileCoverageEntry> {
	const normalized = new Map<string, FileCoverageEntry>();
	for (const [rawPath, entry] of Object.entries(summary)) {
		if (!entry || rawPath === "total") continue;
		const relPath = normalizePath(rawPath, repoRoot);
		if (relPath) normalized.set(relPath, entry);
	}
	return normalized;
}

/** A baseline entry counts as "well covered" if ANY recorded metric clears
 *  the threshold — matching the real incident, where every metric read as 0
 *  together. Unrecorded optional metrics do not vote. */
function isWellCoveredInBaseline(prior: CoverageBaselineFileEntry): boolean {
	return COVERAGE_METRICS.some((metric) => {
		const pct = prior[baselineKeyFor(metric)];
		return pct !== undefined && pct >= PARTIAL_REPORT_WELL_COVERED_BASELINE_PCT;
	});
}

/** A report entry counts as "zeroed" only when BOTH metrics read exactly 0 —
 *  a file with real lines coverage but no branches (or vice versa) is not
 *  the unexercised-file shape this detector looks for. */
function isZeroedInReport(entry: FileCoverageEntry): boolean {
	const linesPct = normalizeReportPct(entry.lines?.pct ?? 0);
	const branchesPct = normalizeReportPct(entry.branches?.pct ?? 0);
	return linesPct === 0 && branchesPct === 0;
}

/** Walks the baseline once, counting how many of its well-covered files are
 *  (a) present in the current report at all — `comparable`, the signal's
 *  denominator — and (b) of those, how many now read as exactly 0 — `zeroed`. */
function countZeroedWellCoveredFiles(
	baseline: CoverageBaseline,
	normalizedSummary: Map<string, FileCoverageEntry>,
): { comparable: number; zeroed: number } {
	let comparable = 0;
	let zeroed = 0;
	for (const [relPath, prior] of Object.entries(baseline.files)) {
		if (!isWellCoveredInBaseline(prior)) continue;
		const entry = normalizedSummary.get(relPath);
		if (!entry) continue; // not in current report at all — a different signal (missing file)
		comparable++;
		if (isZeroedInReport(entry)) zeroed++;
	}
	return { comparable, zeroed };
}

/**
 * Pure detector: does `summary` look like a scoped/partial coverage run
 * rather than a full one, relative to `baseline`? Independently testable —
 * takes only in-memory data, no I/O.
 */
export function detectPartialReport(
	summary: CoverageSummary,
	baseline: CoverageBaseline,
	repoRoot: string,
): PartialReportVerdict {
	const normalizedSummary = normalizeSummaryPaths(summary, repoRoot);
	const { comparable, zeroed } = countZeroedWellCoveredFiles(baseline, normalizedSummary);

	if (comparable < PARTIAL_REPORT_MIN_COMPARABLE_FILES) {
		return {
			partial: false,
			zeroed,
			comparable,
			reason: `only ${comparable} baseline-well-covered file(s) comparable (need >= ${PARTIAL_REPORT_MIN_COMPARABLE_FILES}) — too few to judge either way`,
		};
	}

	// `comparable` is provably >= PARTIAL_REPORT_MIN_COMPARABLE_FILES (> 0) at
	// this point — the guard above returns before this line otherwise — so
	// this division never sees a zero denominator.
	const ratio = zeroed / comparable;
	if (ratio >= PARTIAL_REPORT_ZEROED_RATIO) {
		return {
			partial: true,
			zeroed,
			comparable,
			reason:
				`${zeroed}/${comparable} previously well-covered files ` +
				`(>= ${PARTIAL_REPORT_WELL_COVERED_BASELINE_PCT}%) now read as exactly 0% — ` +
				"this looks like a scoped `vitest run --coverage <files>` overwrote the shared " +
				"report, not a real regression. Re-run the full suite before trusting this report.",
		};
	}

	return {
		partial: false,
		zeroed,
		comparable,
		reason: `${zeroed}/${comparable} comparable files read as 0% — below the ${Math.round(PARTIAL_REPORT_ZEROED_RATIO * 100)}% partial-report threshold`,
	};
}
