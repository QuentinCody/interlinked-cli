// ===========================================
// Coverage metric names — the ONE list of per-file coverage metrics
// ===========================================
// istanbul / v8 json-summary emits four per-file metrics; LCOV carries three
// (no statements). Every surface that records, compares, renders, or gates
// per-file coverage iterates THIS list rather than naming metrics inline, so
// a metric cannot be parsed on one surface and silently dropped on another
// (the pre-2026-09-16 state: functions/statements were parsed and then
// ignored at the comparison).
//
// Kept in its own module because `check-policy.ts` (config shape) and
// `coverage-ratchet.ts` (comparison) both need the type and the ratchet
// already imports the policy — a shared leaf avoids the cycle.

export const COVERAGE_METRICS = ["lines", "statements", "functions", "branches"] as const;

export type CoverageMetricName = (typeof COVERAGE_METRICS)[number];

/** Baseline key for one metric: `lines` → `lines_pct`. */
export type CoverageBaselineKey = `${CoverageMetricName}_pct`;

export function baselineKeyFor(metric: CoverageMetricName): CoverageBaselineKey {
	return `${metric}_pct`;
}

export function isCoverageMetricName(value: unknown): value is CoverageMetricName {
	return typeof value === "string" && COVERAGE_METRICS.some((metric) => metric === value);
}
