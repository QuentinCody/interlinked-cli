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
import { isJsonObject } from "../lib/json-types.js";
import type { CoverageRatchetConfig } from "./check-policy.js";
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
	// `lines`/`branches` come off a JSON coverage-summary report read from disk
	// (`loadCoverageSummary` casts the parsed JSON with `as CoverageSummary`),
	// so a partial/hand-authored report can omit either key at runtime.
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

/** Baseline stored on disk between runs. */
export interface CoverageBaseline {
	version: 1;
	/** ISO timestamp of last successful ratchet. */
	updated_at: string;
	/** Per-repo-relative-path snapshot of { lines.pct, branches.pct }. */
	files: Record<string, { lines_pct: number; branches_pct: number }>;
}

export interface CoverageRatchetFinding {
	name: "coverage_decrease";
	severity: "warning" | "error";
	file: string;
	metric: "lines" | "branches";
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
function parseCoverageBaseline(value: unknown): CoverageBaseline | null {
	if (!isJsonObject(value)) return null;
	if (value.version !== 1) return null;
	if (!isJsonObject(value.files)) return null;
	const files: Record<string, { lines_pct: number; branches_pct: number }> = {};
	for (const [file, stats] of Object.entries(value.files)) {
		if (!isJsonObject(stats)) continue;
		const { lines_pct, branches_pct } = stats;
		if (typeof lines_pct !== "number" || typeof branches_pct !== "number") continue;
		files[file] = { lines_pct, branches_pct };
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
		const raw = JSON.parse(readFileSync(summaryPath, "utf-8"));
		if (!raw || typeof raw !== "object") return null;
		return raw as CoverageSummary;
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

/** Per-file comparison outcome — factored out of `compareCoverage`'s loop so
 *  the orchestrator stays a flat accumulation instead of nested branching. */
interface FileComparison {
	findings: CoverageRatchetFinding[];
	nextEntry: { lines_pct: number; branches_pct: number };
	isNew: boolean;
	/** True when at least one metric dropped beyond tolerance (never double-
	 *  counts a file with both lines AND branches decreasing). */
	decreased: boolean;
	improved: boolean;
}

function compareFileEntry(
	relPath: string,
	entry: FileCoverageEntry,
	prior: { lines_pct: number; branches_pct: number } | undefined,
	allowDecreasePct: number,
): FileComparison {
	// Normalize to the report's own resolution (see `normalizeReportPct`)
	// before comparing OR persisting: the report can only ever state a
	// value at 2dp, so anything finer is not a measurable regression.
	const linesPct = normalizeReportPct(entry.lines?.pct ?? 0);
	const branchesPct = normalizeReportPct(entry.branches?.pct ?? 0);

	if (!prior) {
		return {
			findings: [],
			nextEntry: { lines_pct: linesPct, branches_pct: branchesPct },
			isNew: true,
			decreased: false,
			improved: false,
		};
	}

	const priorLinesPct = normalizeReportPct(prior.lines_pct);
	const priorBranchesPct = normalizeReportPct(prior.branches_pct);
	const linesDelta = linesPct - priorLinesPct;
	const branchesDelta = branchesPct - priorBranchesPct;

	const findings: CoverageRatchetFinding[] = [];
	if (linesDelta < -allowDecreasePct) {
		findings.push(buildFinding("lines", relPath, priorLinesPct, linesPct, linesDelta));
	}
	if (branchesDelta < -allowDecreasePct) {
		findings.push(buildFinding("branches", relPath, priorBranchesPct, branchesPct, branchesDelta));
	}

	return {
		findings,
		// Only advance the baseline for metrics that are flat or rising. A
		// decreased metric stays at its prior (normalized) value so the next
		// run still compares against the high-water mark.
		nextEntry: {
			lines_pct: linesDelta >= 0 ? linesPct : priorLinesPct,
			branches_pct: branchesDelta >= 0 ? branchesPct : priorBranchesPct,
		},
		isNew: false,
		decreased: findings.length > 0,
		improved: linesDelta > 0 || branchesDelta > 0,
	};
}

/** Per-entry context threaded through {@link processCoverageEntry} — grouped
 * so the helper takes one context object rather than four loose params. */
interface CoverageEntryContext {
	repoRoot: string;
	changedSet: Set<string> | null;
	baseline: CoverageBaseline;
	allowDecreasePct: number;
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

	const outcome = compareFileEntry(relPath, entry, ctx.baseline.files[relPath], ctx.allowDecreasePct);
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
	const nextFiles: Record<string, { lines_pct: number; branches_pct: number }> = {
		...baseline.files,
	};
	const ctx: CoverageEntryContext = {
		repoRoot,
		changedSet: changedFiles ? new Set(changedFiles) : null,
		baseline,
		allowDecreasePct: config.allow_decrease_pct,
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
 *
 * The tiny epsilon guards against float-representation error (e.g. an exact
 * 99.0 stored as 98.99999999999999) flooring into the wrong bucket; it is far
 * smaller than any real 2dp distinction.
 */
export function normalizeReportPct(pct: number): number {
	return Math.floor(pct * 100 + 1e-9) / 100;
}

function buildFinding(
	metric: "lines" | "branches",
	file: string,
	baseline: number,
	current: number,
	delta: number,
): CoverageRatchetFinding {
	const roundedBaseline = Math.round(baseline * 10) / 10;
	const roundedCurrent = Math.round(current * 10) / 10;
	const roundedDelta = Math.round(delta * 10) / 10;
	return {
		name: "coverage_decrease",
		severity: "warning",
		file,
		metric,
		baseline_pct: roundedBaseline,
		current_pct: roundedCurrent,
		delta_pct: roundedDelta,
		message: `${metric} coverage for ${file} dropped from ${roundedBaseline}% to ${roundedCurrent}% (${roundedDelta}%). Add tests before committing.`,
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
