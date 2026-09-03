// ===========================================
// interlinked coverage — per-file coverage ratchet CLI
// ===========================================
// Thin wrapper around harness/coverage-ratchet.ts. Locates the coverage
// reports, preferring the LCOV family (the language-agnostic interchange path:
// LCOV → canonical model → ratchet shape) — EVERY existing LCOV report is
// loaded and MERGED, because the per-language adapters each emit their own file
// (finding 2026-06: one shared output path made each language's run clobber the
// previous one's report, so the ratchet silently lost a language) — and falling
// back to the istanbul/v8 `coverage-summary.json`. Loads the baseline from
// .interlinked/coverage-baseline.json, runs compareCoverage, and renders
// results. `--update-baseline` explicitly persists the new state; without it,
// any per-file drop surfaces as a finding and exits non-zero.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCheckPolicy } from "../harness/check-policy.js";
import { coverageSetupGuidance, lcovReportPaths } from "../harness/coverage-adapters.js";
import { loadCoverageFinalSummary } from "../harness/coverage-final-reader.js";
import { canonicalToCoverageSummary, loadLcovFile } from "../harness/coverage-lcov.js";
import {
	type CoverageRatchetFinding,
	type CoverageRatchetResult,
	type CoverageSummary,
	compareCoverage,
	loadBaseline,
	loadCoverageSummary,
	normalizePath,
	type PartialReportVerdict,
	saveBaseline,
} from "../harness/coverage-ratchet.js";
import { parseChangedFiles } from "../lib/changed-files-option.js";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { reportMtimeMs } from "../lib/report-mtime.js";

/** The istanbul/v8 fallbacks for a JS run that hasn't emitted lcov. The LCOV
 *  candidates come from `lcovReportPaths()` (canonical + per-language). */
const ISTANBUL_REPORT_PATHS = ["coverage/coverage-summary.json", "coverage/coverage-final.json"];

/** Every default report location, for the "no report found" guidance. */
function defaultReportPaths(): string[] {
	return [...lcovReportPaths(), ...ISTANBUL_REPORT_PATHS];
}

interface CoverageCheckOptions {
	report?: string;
	updateBaseline?: boolean;
	changedFiles?: string;
	strict?: boolean;
	cwd?: string;
	json?: boolean;
}

export async function coverageCheckCommand(opts: CoverageCheckOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);

	try {
		runCoverageCheck(mode, cwd, configDir, opts);
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

/** The body of `coverageCheckCommand`'s try-block: resolve reports, compare
 *  against the baseline, render, and persist. Errors propagate to the
 *  caller's catch — this function does not handle them itself. */
function runCoverageCheck(
	mode: ReturnType<typeof getOutputMode>,
	cwd: string,
	configDir: string,
	opts: CoverageCheckOptions,
): void {
	const reportPaths = resolveReportPaths(cwd, opts.report);
	if (reportPaths.length === 0) {
		outputError(
			mode,
			`No coverage report found. Expected one of:\n  ${defaultReportPaths()
				.map((p) => `- ${p}`)
				.join("\n  ")}\n\n` +
				`Generate one — each command emits LCOV at a per-language path the ratchet merges:\n${coverageSetupGuidance(cwd)}`,
		);
		process.exitCode = 1;
		return;
	}

	const loaded = loadMergedReport(reportPaths, cwd);
	if (loaded.failedPath !== null) {
		outputError(mode, `Failed to parse coverage report at ${loaded.failedPath}`);
		process.exitCode = 1;
		return;
	}
	const summary = loaded.summary;
	const reportPath = reportPaths.join(" + ");

	const policy = loadCheckPolicy(cwd);
	const baseline = loadBaseline(configDir);
	const changedFiles = parseChangedFiles(opts.changedFiles);
	const result = compareCoverage(summary, baseline, {
		config: policy.coverage_ratchet,
		repoRoot: cwd,
		...(changedFiles !== undefined ? { changedFiles } : {}),
	});

	output(mode, buildJsonPayload(reportPath, result), {
		json: () => buildJsonPayload(reportPath, result),
		normal: () => renderNormal(reportPath, result),
	});

	// A partial/scoped report (see `detectPartialReport`) is UNMEASURED, not
	// clean — `result.nextBaseline` is already the input baseline unchanged
	// (compareCoverage guarantees this), so persisting it is a safe no-op,
	// but skip the write and the misleading "updated" banner entirely: this
	// run measured nothing, so there is nothing to accept.
	if (opts.updateBaseline && !result.partialReport?.partial) {
		saveBaseline(configDir, result.nextBaseline);
		if (mode !== "json") {
			process.stderr.write(
				`\n  ${c.green("✓")} Baseline updated at ${join(".interlinked", "coverage-baseline.json")}\n`,
			);
		}
	} else if (opts.updateBaseline && mode !== "json") {
		process.stderr.write(
			`\n  ${c.yellow("⚠")} Baseline NOT updated — the report looks partial/scoped (see above).\n`,
		);
	}

	// A partial report can never fail the run: there is nothing measurable
	// to regress against. Fail to UNMEASURED, never to REGRESSED.
	if (!result.partialReport?.partial) {
		const hasErrors = result.findings.some((f) => f.severity === "error");
		const hasWarnings = result.findings.length > 0;
		if (hasErrors || (opts.strict && hasWarnings)) {
			process.exitCode = 1;
		}
	}
}

/**
 * Show the current baseline so users can see what's being ratcheted
 * against, and spot files with lower-than-expected baselines.
 */
export function coverageBaselineCommand(opts: { cwd?: string; json?: boolean }): void {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);
	const baseline = loadBaseline(configDir);

	output(mode, baseline, {
		json: () => baseline,
		normal: () => {
			const lines: string[] = [];
			lines.push(header("Coverage Baseline"));
			lines.push(kvLine("Updated", baseline.updated_at));
			lines.push(kvLine("Files", String(Object.keys(baseline.files).length)));
			const rows = Object.entries(baseline.files)
				.sort(([a], [b]) => a.localeCompare(b))
				.slice(0, 25);
			if (rows.length === 0) {
				lines.push("");
				lines.push(
					c.dim(
						"  (no baseline yet — run `interlinked coverage check --update-baseline`)",
					),
				);
			} else {
				lines.push("");
				for (const [file, metrics] of rows) {
					lines.push(
						`  ${file} ${c.dim(`lines=${metrics.lines_pct.toFixed(1)}% branches=${metrics.branches_pct.toFixed(1)}%`)}`,
					);
				}
				if (Object.keys(baseline.files).length > rows.length) {
					lines.push(
						c.dim(`  … and ${Object.keys(baseline.files).length - rows.length} more`),
					);
				}
			}
			return lines.join("\n");
		},
	});
}

// ===========================================
// Helpers
// ===========================================

/**
 * Load a coverage report into the ratchet's `CoverageSummary` shape, dispatching
 * by format: `.info` → LCOV (the language-agnostic interchange path, via the
 * canonical model); `coverage-final.json` → the istanbul FULL format, which
 * carries statementMap/s rather than summary lines/branches — feeding it to the
 * json-summary parser made the ratchet evaluate ZERO files and pass vacuously
 * (finding 2026-06, round 6); otherwise the istanbul/v8 json-summary.
 */
function loadReport(reportPath: string, cwd: string): CoverageSummary | null {
	if (reportPath.endsWith(".info")) {
		const cov = loadLcovFile(reportPath, { cwd });
		return cov ? canonicalToCoverageSummary(cov) : null;
	}
	if (reportPath.endsWith("coverage-final.json")) {
		return loadCoverageFinalSummary(reportPath, cwd);
	}
	return loadCoverageSummary(reportPath);
}

/**
 * The report files the check reads: an explicit `--report` path alone (the user
 * override); otherwise EVERY existing LCOV report (canonical + per-language —
 * all merged, finding 2026-06) PLUS the first existing istanbul report. The
 * istanbul report is never skipped just because LCOV files exist: in a polyglot
 * repo a fresh JS run may emit ONLY istanbul JSON while stale Python/Rust LCOV
 * lingers — dropping it made the ratchet silently omit current JS coverage
 * (round 5). The merge is mtime-ordered, so when both formats cover the same
 * files the fresher run's numbers win. Empty ⇒ no report anywhere.
 */
export function resolveReportPaths(cwd: string, explicit?: string): string[] {
	if (explicit) {
		const resolved = resolve(cwd, explicit);
		return existsSync(resolved) ? [resolved] : [];
	}
	const paths = lcovReportPaths()
		.map((p) => join(cwd, p))
		.filter((p) => existsSync(p));
	// Both istanbul formats (coverage-final.json FULL statementMap, coverage-
	// summary.json json-summary) describe the SAME run, so take ONE — but the
	// NEWEST existing one, not the first listed. An older coverage-summary.json
	// lingering beside a fresh coverage-final.json was silently winning: the loop
	// `break`ed on summary (listed first), the merge never saw final, and the
	// ratchet ran on stale data, missing current JS regressions (finding 2026-06).
	// The mtime sort mirrors loadMergedReport's "freshest run wins".
	const istanbul = ISTANBUL_REPORT_PATHS.map((candidate) => join(cwd, candidate))
		.filter((p) => existsSync(p))
		.sort((a, b) => reportMtimeMs(b) - reportMtimeMs(a))[0];
	if (istanbul) paths.push(istanbul);
	return paths;
}

/**
 * Load and MERGE the resolved reports. Files merge oldest-first so a FRESHER
 * report's per-file entries win any overlap (per-language reports are normally
 * disjoint; on a shared file the newest run is the honest number). Any existing
 * report that fails to parse — or parses to ZERO file entries — aborts the
 * merge LOUDLY (`failedPath`): a silent-partial merge would misreport exactly
 * like the clobbering this fixes, and an empty parse is how the ratchet once
 * "passed" with files_checked: 0 and wrote an invalid baseline (finding
 * 2026-06, round 6 — the vacuous-success class).
 *
 * Keys are normalized through `normalizePath` (the SAME repo-relative-POSIX
 * normalizer `compareCoverage` and `detectPartialReport` use) BEFORE merging —
 * not after. The LCOV reader already emits repo-relative keys, but the
 * istanbul `coverage-summary.json` / `coverage-final.json` readers emit
 * ABSOLUTE keys; merging on raw keys let the same file land under two
 * different keys (one per source), so it was compared and reported TWICE
 * downstream even though every consumer normalizes independently — the
 * normalization happened too late to prevent the duplicate entry in the first
 * place (finding 2026-07-31: 234 findings / 117 unique, 2088 files_checked for
 * 1044 real files — every file processed exactly twice). Normalizing here
 * collapses both spellings onto one key so "freshest report wins" actually
 * overwrites instead of coexisting.
 */
export function loadMergedReport(
	reportPaths: string[],
	cwd: string,
): { summary: CoverageSummary; failedPath: string | null } {
	const ordered = [...reportPaths].sort((a, b) => reportMtimeMs(a) - reportMtimeMs(b));
	const merged: CoverageSummary = {};
	for (const path of ordered) {
		const summary = loadReport(path, cwd);
		if (!summary || Object.keys(summary).length === 0) {
			return { summary: merged, failedPath: path };
		}
		for (const [key, entry] of Object.entries(summary)) {
			if (!entry) continue;
			const normalized = normalizePath(key, cwd);
			if (!normalized) continue;
			merged[normalized] = entry;
		}
	}
	return { summary: merged, failedPath: null };
}

interface CoverageCheckJson {
	report: string;
	findings: CoverageRatchetFinding[];
	stats: CoverageRatchetResult["stats"];
	/** Set whenever the ratchet ran; `partial: true` means findings above are
	 *  forced empty because the report couldn't be trusted — see `reason`. */
	partialReport?: PartialReportVerdict;
}

function buildJsonPayload(reportPath: string, result: CoverageRatchetResult): CoverageCheckJson {
	return {
		report: reportPath,
		findings: result.findings,
		stats: result.stats,
		...(result.partialReport ? { partialReport: result.partialReport } : {}),
	};
}

/** The partial-report banner: names the likely cause (a scoped test run
 *  overwriting the shared coverage/ report) so the human's next action is
 *  obvious, and makes explicit that this is NOT a clean pass — just an
 *  unmeasurable one. */
function renderPartialReportNotice(partialReport: PartialReportVerdict): string {
	const lines: string[] = [];
	lines.push(c.yellow("  ⚠ Coverage report looks PARTIAL — findings suppressed, not measured."));
	lines.push(
		c.dim(
			`    ${partialReport.zeroed}/${partialReport.comparable} previously well-covered files now read as exactly 0%.`,
		),
	);
	lines.push(
		c.dim(
			"    Likely cause: a scoped `vitest run --coverage <files>` overwrote the shared report.",
		),
	);
	lines.push(c.dim("    Re-run the full suite before trusting this report."));
	return lines.join("\n");
}

function renderNormal(reportPath: string, result: CoverageRatchetResult): string {
	const lines: string[] = [];
	lines.push(header("Coverage Ratchet"));
	lines.push(kvLine("Report", reportPath));

	if (result.partialReport?.partial) {
		lines.push("");
		lines.push(renderPartialReportNotice(result.partialReport));
		return lines.join("\n");
	}

	lines.push(kvLine("Files checked", String(result.stats.files_checked)));
	lines.push(
		kvLine(
			"New / Improved / Decreased",
			`${result.stats.files_new} / ${result.stats.files_improved} / ${result.stats.files_decreased}`,
		),
	);
	if (result.findings.length === 0) {
		lines.push("");
		lines.push(c.green("  ✓ No per-file coverage regressions."));
		return lines.join("\n");
	}
	lines.push("");
	lines.push(c.red(`  ${result.findings.length} regression(s):`));
	for (const f of result.findings) {
		lines.push(
			`    ${c.red("✗")} ${f.file} ${c.dim(`[${f.metric}]`)} ${f.baseline_pct}% → ${f.current_pct}% ${c.dim(`(${f.delta_pct.toFixed(1)}%)`)}`,
		);
	}
	lines.push("");
	lines.push(c.dim("  Add tests to restore coverage, or run with --update-baseline to accept."));
	return lines.join("\n");
}
