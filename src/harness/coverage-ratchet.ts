// ===========================================
// Per-File Coverage Ratchet
// ===========================================
// Maintains a per-file coverage baseline in `.interlinked/coverage-baseline.json`
// and compares the current run's coverage against it. Drops beyond the
// configured tolerance surface as findings; flat or rising coverage silently
// updates the baseline.
//
// Input: the JSON summary produced by vitest / c8 / istanbul
//   (`coverage/coverage-summary.json` by convention).
// Output: CoverageRatchetFinding[], shaped for the verify output formatter.
//
// Why per-file, not global: global coverage hides regressions — a hot module
// can subsidize a cold one. Ratcheting per-file forces the conversation
// when any specific file's coverage slips.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import type { CoverageRatchetConfig } from "./check-policy.js";
import type { CoverageMetricName } from "./coverage-metric-names.js";
import { compareFileEntry, type FileComparison, gatedCoverageMetrics } from "./coverage-ratchet-compare.js";
import { isFileCoverageEntry } from "./coverage-report-values.js";

// The per-metric comparison moved to `coverage-ratchet-compare.ts` (2026-09-16,
// line cap); re-exported so existing importers keep one entry point.
export { gatedCoverageMetrics, normalizeReportPct } from "./coverage-ratchet-compare.js";
import { detectPartialReport, type PartialReportVerdict } from "./coverage-partial-report.js";

export type { PartialReportVerdict } from "./coverage-partial-report.js";
// Partial-report detection (`detectPartialReport` + its verdict shape and
// tuning constants) lives in the sibling `coverage-partial-report.ts` — split
// out to stay under this file's 500-line cap. Re-exported here so every
// existing and new caller keeps importing from "./coverage-ratchet.js".
export {
	detectPartialReport,
	PARTIAL_REPORT_MIN_COMPARABLE_FILES,
	PARTIAL_REPORT_WELL_COVERED_BASELINE_PCT,
	PARTIAL_REPORT_ZEROED_RATIO,
} from "./coverage-partial-report.js";

// ===========================================
// Types
// ===========================================

/** The shape we care about from vitest/c8/istanbul JSON summary. */
export interface CoverageSummary {
	/** Per-file entries keyed by absolute or repo-relative path. */
	[filePath: string]: FileCoverageEntry | undefined;
}

export interface FileCoverageEntry {
	// Partial reports can omit individual metrics; present metrics are validated on load.
	lines?: CoverageMetric;
	statements?: CoverageMetric;
	functions?: CoverageMetric;
	branches?: CoverageMetric;
}

export interface CoverageMetric {
	/** Percentage (0–100). */
	pct: number;
	/** Absolute covered / total counts, if the reporter emits them. */
	covered?: number;
	total?: number;
}

/**
 * One file's high-water marks. `lines_pct` / `branches_pct` are the legacy
 * required pair (every baseline on disk carries them); `statements_pct` /
 * `functions_pct` were added 2026-09-16 and are OPTIONAL so a pre-existing
 * baseline still parses and a report that lacks a metric (LCOV has no
 * statements) records nothing for it rather than a fake 0.
 */
export interface CoverageBaselineFileEntry {
	lines_total?: number;
	lines_covered?: number;
	lines_pct: number;
	branches_pct: number;
	statements_pct?: number;
	functions_pct?: number;
}

/** Baseline stored on disk between runs. */
export interface CoverageBaseline {
	version: 1;
	/** ISO timestamp of last successful ratchet. */
	updated_at: string;
	/** Per-repo-relative-path snapshot of each metric's `pct` (see {@link CoverageBaselineFileEntry}). */
	files: Record<string, CoverageBaselineFileEntry>;
}

export interface CoverageRatchetFinding {
	name: "coverage_decrease";
	severity: "warning" | "error";
	file: string;
	metric: CoverageMetricName;
	baseline_pct: number;
	current_pct: number;
	delta_pct: number;
	message: string;
}

export interface CoverageRatchetResult {
	findings: CoverageRatchetFinding[];
	/** Summary stats surfaced in verify output / harness status. */
	stats: {
		files_checked: number;
		files_new: number;
		files_decreased: number;
		files_improved: number;
	};
	/** Updated baseline — caller decides whether to persist. */
	nextBaseline: CoverageBaseline;
	/**
	 * Set on every run. When `partial: true`, `findings` is forced empty and
	 * `nextBaseline` is the INPUT baseline, unchanged — see `detectPartialReport`.
	 */
	partialReport?: PartialReportVerdict;
}

// ===========================================
// Defaults and paths
// ===========================================

export function baselinePath(interlinkedDir: string): string {
	return join(interlinkedDir, "coverage-baseline.json");
}

export function emptyBaseline(): CoverageBaseline {
	return {
		version: 1,
		updated_at: new Date(0).toISOString(),
		files: {},
	};
}

// ===========================================
// I/O
// ===========================================

/**
 * Narrow a parsed `coverage-baseline.json` into the domain shape. Rejects
 * the whole file for an invalid top-level shape (same as the pre-fix
 * behavior), but a malformed INDIVIDUAL file entry is dropped rather than
 * discarding every other file's high-water mark — a single hand-edited or
 * partially-written entry must not reset the whole ratchet. This is the
 * READ side only; `saveBaseline`'s write shape is unchanged.
 */
function copyOptionalCoverageFields(entry: CoverageBaselineFileEntry, stats: JsonObject): void {
	for (const key of ["statements_pct", "functions_pct", "lines_total", "lines_covered"] as const) {
		const value = stats[key];
		if (typeof value === "number") entry[key] = value;
	}
}

function parseCoverageBaseline(value: unknown): CoverageBaseline | null {
	if (!isJsonObject(value)) return null;
	if (value.version !== 1) return null;
	if (!isJsonObject(value.files)) return null;
	const files: Record<string, CoverageBaselineFileEntry> = {};
	for (const [file, stats] of Object.entries(value.files)) {
		if (!isJsonObject(stats)) continue;
		const { lines_pct, branches_pct } = stats;
		if (typeof lines_pct !== "number" || typeof branches_pct !== "number") continue;
		const entry: CoverageBaselineFileEntry = { lines_pct, branches_pct };
		// The two newer metrics are optional on disk (pre-2026-09-16 baselines
		// lack them); a non-numeric value is dropped, not coerced.
		copyOptionalCoverageFields(entry, stats);
		files[file] = entry;
	}
	const updatedAt = typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString();
	return { version: 1, updated_at: updatedAt, files };
}

export function loadBaseline(interlinkedDir: string): CoverageBaseline {
	const path = baselinePath(interlinkedDir);
	if (!existsSync(path)) return emptyBaseline();
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parseCoverageBaseline(raw) ?? emptyBaseline();
	} catch {
		return emptyBaseline();
	}
}

export function saveBaseline(interlinkedDir: string, baseline: CoverageBaseline): void {
	const path = baselinePath(interlinkedDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
}

export function loadCoverageSummary(summaryPath: string): CoverageSummary | null {
	if (!existsSync(summaryPath)) return null;
	try {
		const raw: unknown = JSON.parse(readFileSync(summaryPath, "utf-8"));
		if (!isJsonObject(raw)) return null;
		const summary: CoverageSummary = {};
		for (const [file, value] of Object.entries(raw)) {
			if (isFileCoverageEntry(value)) summary[file] = value;
		}
		return summary;
	} catch {
		return null;
	}
}

// ===========================================
// Core compare
// ===========================================

export interface CompareOptions {
	config: CoverageRatchetConfig;
	/** Repo root — used to normalize absolute paths in the summary. */
	repoRoot: string;
	/**
	 * Files the current session has touched. When provided, ratchet only
	 * fires for these paths. Omit to evaluate every file in the summary.
	 */
	changedFiles?: string[];
}

/**
 * Short-circuit result for a partial report: no findings (nothing in a scoped
 * run is measurable), and the INPUT baseline returned unchanged — so even a
 * caller that unconditionally persists `nextBaseline` (e.g. `--update-baseline`)
 * cannot corrupt the high-water mark from a partial run. See the module doc
 * above for why; verified in coverage-ratchet.test.ts.
 */
function partialReportResult(
	baseline: CoverageBaseline,
	partialReport: PartialReportVerdict,
): CoverageRatchetResult {
	return {
		findings: [],
		stats: { files_checked: 0, files_new: 0, files_decreased: 0, files_improved: 0 },
		nextBaseline: baseline,
		partialReport,
	};
}

/** Per-entry context threaded through {@link processCoverageEntry} — grouped
 * so the helper takes one context object rather than five loose params. */
interface CoverageEntryContext {
	repoRoot: string;
	changedSet: Set<string> | null;
	baseline: CoverageBaseline;
	allowDecreasePct: number;
	gatedMetrics: ReadonlySet<CoverageMetricName>;
}

/**
 * Resolve one `summary` entry to a comparable file, or `null` if it should
 * be skipped (the synthetic `total` bucket, an unresolvable path, or a path
 * outside `changedSet` when diff-scoping is active). Isolates every
 * skip-guard for one loop iteration so the caller's loop body is a flat
 * accumulate step.
 */
function processCoverageEntry(
	rawPath: string,
	entry: FileCoverageEntry | undefined,
	ctx: CoverageEntryContext,
): { relPath: string; outcome: FileComparison } | null {
	if (!entry || rawPath === "total") return null;
	const relPath = normalizePath(rawPath, ctx.repoRoot);
	if (!relPath) return null;
	if (ctx.changedSet && !ctx.changedSet.has(relPath)) return null;

	const outcome = compareFileEntry(relPath, entry, ctx.baseline.files[relPath], ctx);
	return { relPath, outcome };
}

export function compareCoverage(
	summary: CoverageSummary,
	baseline: CoverageBaseline,
	options: CompareOptions,
): CoverageRatchetResult {
	const { config, repoRoot, changedFiles } = options;

	// A scoped run's report cannot be trusted to measure ANYTHING — fail to
	// unmeasured, never to regressed. See the module doc above.
	const partialReport = detectPartialReport(summary, baseline, repoRoot);
	if (partialReport.partial) return partialReportResult(baseline, partialReport);

	const findings: CoverageRatchetFinding[] = [];
	const nextFiles: Record<string, CoverageBaselineFileEntry> = {
		...baseline.files,
	};
	const ctx: CoverageEntryContext = {
		repoRoot,
		changedSet: changedFiles ? new Set(changedFiles) : null,
		baseline,
		allowDecreasePct: config.allow_decrease_pct,
		gatedMetrics: gatedCoverageMetrics(config),
	};

	let filesChecked = 0;
	let filesNew = 0;
	let filesDecreased = 0;
	let filesImproved = 0;

	for (const [rawPath, entry] of Object.entries(summary)) {
		const result = processCoverageEntry(rawPath, entry, ctx);
		if (!result) continue;

		filesChecked++;
		findings.push(...result.outcome.findings);
		nextFiles[result.relPath] = result.outcome.nextEntry;
		if (result.outcome.isNew) filesNew++;
		if (result.outcome.decreased) filesDecreased++;
		if (result.outcome.improved) filesImproved++;
	}

	return {
		findings,
		stats: {
			files_checked: filesChecked,
			files_new: filesNew,
			files_decreased: filesDecreased,
			files_improved: filesImproved,
		},
		nextBaseline: {
			version: 1,
			updated_at: new Date().toISOString(),
			files: nextFiles,
		},
		partialReport,
	};
}

/**
 * Normalize a coverage-summary key to a repo-relative POSIX path.
 * Skips synthetic buckets (the `total` aggregate, empty strings). Exported
 * so `coverage-partial-report.ts` shares this exact normalization rather
 * than re-deriving it.
 */
export function normalizePath(rawPath: string, repoRoot: string): string | null {
	if (!rawPath || rawPath === "total") return null;
	const absolute = resolve(repoRoot, rawPath);
	const rel = relative(repoRoot, absolute).replace(/\\/g, "/");
	if (rel.startsWith("..") || rel === "") return null;
	return rel;
}
