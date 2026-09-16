// ===========================================
// Per-file coverage comparison — one metric at a time
// ===========================================
// The comparison half of `coverage-ratchet.ts`, split out under the 500-line
// cap when the ratchet grew from {lines, branches} to every metric the
// report carries (2026-09-16). Every metric in `COVERAGE_METRICS` is
// recorded and high-watered; `gatedMetrics` only narrows which drops become
// findings. Types stay in `coverage-ratchet.ts` (type-only import here, so
// there is no runtime cycle).

import type { CoverageRatchetConfig } from "./check-policy.js";
import { baselineKeyFor, COVERAGE_METRICS, type CoverageMetricName } from "./coverage-metric-names.js";
import type {
	CoverageBaselineFileEntry,
	CoverageRatchetFinding,
	FileCoverageEntry,
} from "./coverage-ratchet.js";

/** Per-file comparison outcome — factored out of `compareCoverage`'s loop so
 *  the orchestrator stays a flat accumulation instead of nested branching. */
export interface FileComparison {
	findings: CoverageRatchetFinding[];
	nextEntry: CoverageBaselineFileEntry;
	isNew: boolean;
	/** True when at least one metric dropped beyond tolerance (never double-
	 *  counts a file with several metrics decreasing). */
	decreased: boolean;
	improved: boolean;
}

export interface FileCompareContext {
	allowDecreasePct: number;
	/** Metrics whose drops are REPORTED; see {@link gatedCoverageMetrics}. */
	gatedMetrics: ReadonlySet<CoverageMetricName>;
}

/**
 * The legacy pair every baseline entry MUST carry. An absent report value
 * for one of these reads as 0 (the pre-2026-09-16 behavior, kept so an
 * existing baseline compares identically); an absent value for any other
 * metric is "not measured" — recorded as nothing, compared as nothing.
 */
const REQUIRED_METRICS: ReadonlySet<CoverageMetricName> = new Set(["lines", "branches"]);

/** One metric's comparison: the value to persist and the drop finding, if any. */
interface MetricComparison {
	next: number | undefined;
	delta: number | undefined;
	finding: CoverageRatchetFinding | null;
}

interface MetricCompareInput {
	metric: CoverageMetricName;
	relPath: string;
	/** Report value, already resolved for the required-metric fallback. */
	current: number | undefined;
	/** Baseline value for this metric, if the baseline has ever seen it. */
	prior: number | undefined;
	allowDecreasePct: number;
	/** Whether a drop on this metric is REPORTED (the baseline high-waters regardless). */
	gated: boolean;
}

function compareMetric(input: MetricCompareInput): MetricComparison {
	const { metric, relPath, current, prior, allowDecreasePct, gated } = input;
	// Unmeasured this run: hold whatever the baseline has (possibly nothing).
	if (current === undefined) return { next: prior, delta: undefined, finding: null };
	// Normalize to the report's own resolution (see `normalizeReportPct`)
	// before comparing OR persisting: the report can only ever state a
	// value at 2dp, so anything finer is not a measurable regression.
	const currentPct = normalizeReportPct(current);
	// First observation of this metric for the file: record, never judge.
	if (prior === undefined) return { next: currentPct, delta: undefined, finding: null };
	const priorPct = normalizeReportPct(prior);
	const delta = currentPct - priorPct;
	const dropped = delta < -allowDecreasePct;
	return {
		// Only advance the baseline for a metric that is flat or rising. A
		// decreased metric stays at its prior (normalized) value so the next
		// run still compares against the high-water mark — even when the
		// metric is not gated (the water-line is a record, not a policy).
		next: delta >= 0 ? currentPct : priorPct,
		delta,
		finding:
			gated && dropped
				? buildFinding({ metric, file: relPath, baseline: priorPct, current: currentPct, delta })
				: null,
	};
}

export function compareFileEntry(
	relPath: string,
	entry: FileCoverageEntry,
	prior: CoverageBaselineFileEntry | undefined,
	ctx: FileCompareContext,
): FileComparison {
	const findings: CoverageRatchetFinding[] = [];
	const next: Partial<Record<CoverageMetricName, number>> = {};
	let improved = false;
	for (const metric of COVERAGE_METRICS) {
		const reported = entry[metric]?.pct;
		const result = compareMetric({
			metric,
			relPath,
			current: reported ?? (REQUIRED_METRICS.has(metric) ? 0 : undefined),
			prior: prior?.[baselineKeyFor(metric)],
			allowDecreasePct: ctx.allowDecreasePct,
			gated: ctx.gatedMetrics.has(metric),
		});
		if (result.next !== undefined) next[metric] = result.next;
		if (result.delta !== undefined && result.delta > 0) improved = true;
		if (result.finding) findings.push(result.finding);
	}
	return {
		findings,
		nextEntry: toBaselineFileEntry(next),
		isNew: prior === undefined,
		decreased: findings.length > 0,
		improved,
	};
}

/** Assemble the on-disk entry: the required pair always present (0 when the
 *  report carried nothing — see {@link REQUIRED_METRICS}), the rest only
 *  when measured, so an unmeasured metric never persists as a fake 0. */
function toBaselineFileEntry(next: Partial<Record<CoverageMetricName, number>>): CoverageBaselineFileEntry {
	const entry: CoverageBaselineFileEntry = { lines_pct: next.lines ?? 0, branches_pct: next.branches ?? 0 };
	if (next.statements !== undefined) entry.statements_pct = next.statements;
	if (next.functions !== undefined) entry.functions_pct = next.functions;
	return entry;
}

/** Metrics whose drops the ratchet REPORTS: the config's `metrics` list, or
 *  every metric when the config is silent. Exported so the CLI can say which
 *  metrics a run gated on. */
export function gatedCoverageMetrics(
	config: Pick<CoverageRatchetConfig, "metrics">,
): ReadonlySet<CoverageMetricName> {
	return new Set(config.metrics ?? COVERAGE_METRICS);
}

/** The report's 2dp resolution, expressed as a scale factor. */
const REPORT_PCT_SCALE = 100;
/** Guards float-representation error (98.99999999999999 for an exact 99.0)
 *  from flooring into the wrong bucket; far smaller than any 2dp distinction. */
const FLOOR_EPSILON = 1e-9;

/**
 * The report's own resolution: 2 decimal places, FLOORED (not rounded).
 *
 * Verified empirically against the real coverage-summary.json in this repo:
 * for every entry carrying `covered`/`total` counts where floor and round
 * disagree (876 sampled cases), the reported `pct` matched
 * `Math.floor(exact * 100) / 100` in 876/876 cases and
 * `Math.round(exact * 100) / 100` in 0/876 — istanbul's json-summary reporter
 * floors so coverage never rounds up to a number it hasn't actually reached
 * (e.g. 99.996% never reads as "100%").
 *
 * A baseline captured via the LCOV path (`coverage-lcov.ts::canonicalToCoverageSummary`)
 * stores the EXACT `(covered / total) * 100` ratio at full float precision, with
 * no rounding at all. Comparing that directly against a floored report value
 * manufactures a perpetual sub-0.01pp "regression" that isn't measurable at the
 * report's own resolution — every file whose true ratio has more than 2
 * significant decimal digits shows a phantom drop forever. Flooring BOTH sides
 * to this resolution before comparing (and before persisting into the next
 * baseline) means the artifact cannot survive: a value that only ever differs
 * in digits past the report's own precision now compares equal.
 */
export function normalizeReportPct(pct: number): number {
	return Math.floor(pct * REPORT_PCT_SCALE + FLOOR_EPSILON) / REPORT_PCT_SCALE;
}

interface FindingInput {
	metric: CoverageMetricName;
	file: string;
	baseline: number;
	current: number;
	delta: number;
}

const roundTenth = (value: number): number => Math.round(value * 10) / 10;

function buildFinding(input: FindingInput): CoverageRatchetFinding {
	const { metric, file } = input;
	const baseline = roundTenth(input.baseline);
	const current = roundTenth(input.current);
	const delta = roundTenth(input.delta);
	return {
		name: "coverage_decrease",
		severity: "warning",
		file,
		metric,
		baseline_pct: baseline,
		current_pct: current,
		delta_pct: delta,
		message: `${metric} coverage for ${file} dropped from ${baseline}% to ${current}% (${delta}%). Add tests before committing.`,
	};
}
