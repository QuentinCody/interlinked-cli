// ===========================================
// interlinked coverage metrics — per-metric distribution over the merged report
// ===========================================
// The ANALYSIS surface for four-metric coverage (lines / statements /
// functions / branches). One row per metric: how many files carry it, how
// many sit at 100%, how many sit under the `--under` threshold, p50 / p90,
// and the lowest files — so a campaign can be aimed at the metric with the
// most headroom instead of at "coverage" as one number. Reads the same
// merged report the ratchet reads (`resolveReportPaths` + `loadMergedReport`)
// and refuses to aggregate a PARTIAL report: an unmeasured report has no
// distribution, and printing one would be the vacuous-success class.

import { resolve } from "node:path";
import { COVERAGE_METRICS, type CoverageMetricName, isCoverageMetricName } from "../harness/coverage-metric-names.js";
import {
	type CoverageSummary,
	detectPartialReport,
	loadBaseline,
	type PartialReportVerdict,
} from "../harness/coverage-ratchet.js";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { loadMergedReport, resolveReportPaths } from "./coverage.js";
import { percentile } from "./metrics-complexity-census.js";

export interface CoverageMetricsOptions {
	cwd?: string;
	json?: boolean;
	/** One report path; default merges every discovered report (as `coverage check`). */
	report?: string;
	/** Restrict to one metric name. */
	metric?: string;
	/** Threshold for the "under N%" count (default 90). */
	under?: string;
	/** How many lowest files to list per metric (default 10). */
	top?: string;
}

export interface LowestFile {
	file: string;
	pct: number;
}

export interface MetricDistribution {
	metric: CoverageMetricName;
	/** Files whose entry carries this metric. */
	measured: number;
	/** Files whose entry lacks it (LCOV carries no statements, for example). */
	unmeasured: number;
	at_100: number;
	under_threshold: number;
	mean: number;
	p50: number;
	p90: number;
	/** Ascending by pct, capped at `top`. */
	lowest: LowestFile[];
}

export interface CoverageMetricsReport {
	report: string;
	/** Files in the merged report (the synthetic `total` bucket excluded). */
	files: number;
	threshold: number;
	/** Set when the report looked partial — `metrics` is then empty. */
	partial: PartialReportVerdict | null;
	metrics: MetricDistribution[];
}

interface SummarizeOptions {
	metrics: readonly CoverageMetricName[];
	under: number;
	top: number;
}

const DEFAULT_UNDER_PCT = 90;
const DEFAULT_TOP = 10;
const FULL_PCT = 100;
const P50 = 50;
const P90 = 90;
const TENTHS = 10;

/** Round to one decimal place for display. */
const roundTenth = (value: number): number => Math.round(value * TENTHS) / TENTHS;

function fileEntries(summary: CoverageSummary): [string, NonNullable<CoverageSummary[string]>][] {
	const out: [string, NonNullable<CoverageSummary[string]>][] = [];
	for (const [file, entry] of Object.entries(summary)) {
		if (file === "total" || !entry) continue;
		out.push([file, entry]);
	}
	return out;
}

function distributionFor(
	metric: CoverageMetricName,
	entries: readonly [string, NonNullable<CoverageSummary[string]>][],
	opts: SummarizeOptions,
): MetricDistribution {
	const measured: LowestFile[] = [];
	for (const [file, entry] of entries) {
		const pct = entry[metric]?.pct;
		if (pct !== undefined) measured.push({ file, pct });
	}
	measured.sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file));
	const sorted = measured.map((m) => m.pct);
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	return {
		metric,
		measured: measured.length,
		unmeasured: entries.length - measured.length,
		at_100: sorted.filter((v) => v >= FULL_PCT).length,
		under_threshold: sorted.filter((v) => v < opts.under).length,
		// `sorted.length` is non-zero on the division branch by the guard.
		mean: sorted.length === 0 ? 0 : roundTenth(sum / sorted.length),
		p50: percentile(sorted, P50),
		p90: percentile(sorted, P90),
		lowest: measured.slice(0, opts.top),
	};
}

/** Pure: one distribution row per requested metric over a merged summary. */
export function summarizeCoverageMetrics(summary: CoverageSummary, opts: SummarizeOptions): MetricDistribution[] {
	const entries = fileEntries(summary);
	return opts.metrics.map((metric) => distributionFor(metric, entries, opts));
}

export function renderCoverageMetrics(report: CoverageMetricsReport): string {
	const lines: string[] = [header("Coverage Metrics"), kvLine("Report", report.report), kvLine("Files", String(report.files))];
	if (report.partial) {
		lines.push("", c.yellow("  ⚠ Coverage report looks PARTIAL — no distribution, not measured."));
		lines.push(c.dim(`    ${report.partial.zeroed}/${report.partial.comparable} previously well-covered files now read as exactly 0%.`));
		lines.push(c.dim("    Re-run the full suite before trusting this report."));
		return lines.join("\n");
	}
	lines.push("", `  ${"metric".padEnd(11)}${"measured".padStart(9)}${"at 100%".padStart(9)}${`under ${report.threshold}%`.padStart(11)}${"mean".padStart(7)}${"p50".padStart(7)}${"p90".padStart(7)}`);
	for (const m of report.metrics) {
		lines.push(
			`  ${m.metric.padEnd(11)}${String(m.measured).padStart(9)}${String(m.at_100).padStart(9)}${String(m.under_threshold).padStart(11)}${m.mean.toFixed(1).padStart(7)}${m.p50.toFixed(1).padStart(7)}${m.p90.toFixed(1).padStart(7)}`,
		);
	}
	for (const m of report.metrics) {
		if (m.lowest.length === 0) continue;
		lines.push("", c.dim(`  lowest ${m.metric} (${m.lowest.length}):`));
		for (const low of m.lowest) lines.push(`    ${low.pct.toFixed(1).padStart(6)}%  ${low.file}`);
	}
	return lines.join("\n");
}

function parseMetrics(metric: string | undefined): readonly CoverageMetricName[] | null {
	if (metric === undefined) return COVERAGE_METRICS;
	return isCoverageMetricName(metric) ? [metric] : null;
}

function parseCount(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function coverageMetricsCommand(opts: CoverageMetricsOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const metrics = parseMetrics(opts.metric);
	if (metrics === null) {
		outputError(mode, `Unknown coverage metric "${opts.metric}". Expected one of: ${COVERAGE_METRICS.join(", ")}`);
		process.exitCode = 1;
		return;
	}
	const reportPaths = resolveReportPaths(cwd, opts.report);
	if (reportPaths.length === 0) {
		outputError(mode, "No coverage report found. Run the suite with coverage first (e.g. `npm run test:coverage`).");
		process.exitCode = 1;
		return;
	}
	const loaded = loadMergedReport(reportPaths, cwd);
	if (loaded.failedPath !== null) {
		outputError(mode, `Failed to parse coverage report at ${loaded.failedPath}`);
		process.exitCode = 1;
		return;
	}
	const partial = detectPartialReport(loaded.summary, loadBaseline(getConfigDir(cwd)), cwd);
	const under = parseCount(opts.under, DEFAULT_UNDER_PCT);
	const report: CoverageMetricsReport = {
		report: reportPaths.join(" + "),
		files: fileEntries(loaded.summary).length,
		threshold: under,
		partial: partial.partial ? partial : null,
		metrics: partial.partial ? [] : summarizeCoverageMetrics(loaded.summary, { metrics, under, top: parseCount(opts.top, DEFAULT_TOP) }),
	};
	output(mode, report, { json: () => report, normal: () => renderCoverageMetrics(report) });
	// A partial report yields no verdict — exit nonzero so a script cannot
	// mistake "nothing measured" for "nothing under threshold".
	if (partial.partial) process.exitCode = 1;
}
