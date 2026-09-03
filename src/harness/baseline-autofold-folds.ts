// ===========================================
// Baseline auto-fold — the three individual folds
// ===========================================
// One fold per water-line. Each is pure-ish (read → plan → maybe write), each
// is independently skippable, and each moves its baseline in ONE direction
// only — the direction `docs/design/baseline-integrity-gate.md` §2 marks safe:
//
//   coverage-baseline.json        per-file pct may only RISE   (never lowered)
//   untested-files-baseline.json  the exemption list may only SHRINK (never grown)
//   large-files-baseline.json     grandfather counts may only SHRINK / drop
//
// These are harness-INTERNAL ratchet writes through plain `fs`, exactly like
// `coverage-ratchet.ts::saveBaseline` and `interlinked adopt`. They therefore
// never pass through the PreToolUse baseline-integrity gate, which only sees
// Write/Edit/MultiEdit tool calls — that carve-out is by design (the gate exists
// to stop the AGENT lowering a water-line, not to stop the harness raising one).
// The loosening direction is refused HERE, in the planners below, so the
// bypass can never be used to loosen anything.
//
// Orchestration, budget, audit log and config live in `baseline-autofold.ts`.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadCheckPolicy } from "./check-policy.js";
import {
	baselinePath,
	compareCoverage,
	type CoverageBaseline,
	loadBaseline,
	loadCoverageSummary,
	saveBaseline,
} from "./coverage-ratchet.js";
import {
	countLines,
	type LargeFileBaseline,
	loadLargeFileBaseline,
	saveLargeFileBaseline,
} from "./large-file-policy.js";
import {
	hasCompanionTest,
	loadUntestedFilesBaseline,
	saveUntestedFilesBaseline,
	type UntestedFilesBaseline,
} from "./tested-file-policy.js";

/** Which water-line a fold moved. Stable — this is the audit-row contract. */
export type FoldKind = "coverage" | "coverage_edit" | "untested_files" | "large_files";

/** Why a fold did nothing. `null` means it ran and moved something. */
type FoldSkipReason =
	| "no-baseline"
	| "no-input"
	| "stale-report"
	| "partial-report"
	| "no-change"
	| "budget";

/** What one fold did. `changed` counts entries actually moved in the safe
 *  direction; `refused` counts would-be LOOSENINGS the planner withheld. */
export interface FoldOutcome {
	kind: FoldKind;
	changed: number;
	refused: number;
	skipped: FoldSkipReason | null;
	/** Capped sample of the entries moved — the audit row's `details`. */
	details: string[];
	/** True when the fold computed a change but did not persist it (dry run). */
	dryRun: boolean;
}

/** Audit `details` never grows past this — a session that touched 400 files
 *  must not write a 400-entry JSONL row. */
export const FOLD_DETAIL_CAP = 20;

/** Coverage reports this fold will read, newest-first preference. Deliberately
 *  a short literal list rather than an import from `src/commands/coverage.ts`:
 *  nothing under `src/harness/` imports from the command layer. */
const COVERAGE_SUMMARY_CANDIDATES = [
	"coverage/coverage-summary.json",
	".interlinked/coverage/coverage-summary.json",
];

function mtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function skippedOutcome(kind: FoldKind, skipped: FoldSkipReason, refused = 0): FoldOutcome {
	return { kind, changed: 0, refused, skipped, details: [], dryRun: false };
}

// ===========================================
// Fold A — coverage high-waters
// ===========================================

/** The freshest existing coverage summary, or null when none is on disk. */
export function findCoverageSummary(cwd: string): string | null {
	const present = COVERAGE_SUMMARY_CANDIDATES.map((rel) => join(cwd, rel)).filter((p) =>
		existsSync(p),
	);
	if (present.length === 0) return null;
	return present.sort((a, b) => mtimeMs(b) - mtimeMs(a))[0] ?? null;
}

/**
 * Whether a coverage report is EVIDENCE FROM THIS SESSION rather than a
 * months-old artifact. Fresh iff the report was written after the session
 * started, or after the baseline it would update — either way it carries
 * information the baseline does not already hold. A report older than both is
 * exactly the 49-66-day staleness this module exists to end, and folding it
 * would only re-assert numbers already recorded.
 */
export function isCoverageReportFresh(args: {
	reportMtimeMs: number;
	baselineMtimeMs: number;
	sessionStartMs: number;
}): boolean {
	return args.reportMtimeMs >= args.sessionStartMs || args.reportMtimeMs > args.baselineMtimeMs;
}

/** Count per-file metrics that ROSE between two baselines (the fold's payload). */
function countRaised(
	prior: CoverageBaseline,
	next: CoverageBaseline,
): { raised: number; details: string[] } {
	const details: string[] = [];
	let raised = 0;
	for (const [file, entry] of Object.entries(next.files)) {
		const before = prior.files[file];
		if (!before) continue; // a NEW file entry is not a "raise" — nothing to beat
		if (entry.lines_pct > before.lines_pct || entry.branches_pct > before.branches_pct) {
			raised++;
			if (details.length < FOLD_DETAIL_CAP) {
				details.push(`${file}: lines ${before.lines_pct}→${entry.lines_pct}`);
			}
		}
	}
	return { raised, details };
}

/**
 * Fold a fresh coverage report into `coverage-baseline.json`.
 *
 * Direction is guaranteed by `compareCoverage`, not re-implemented here: its
 * `nextBaseline` advances a metric only when the metric is flat or rising, and
 * keeps the prior high-water otherwise. `stats.files_decreased` is therefore
 * the REFUSAL count — files whose coverage fell and were held at their old
 * value. A partial report short-circuits inside `compareCoverage` (input
 * baseline returned unchanged), and is reported as a skip here.
 */
export function foldCoverage(opts: {
	cwd: string;
	interlinkedDir: string;
	sessionStartMs: number;
	dryRun: boolean;
}): FoldOutcome {
	const reportPath = findCoverageSummary(opts.cwd);
	if (!reportPath) return skippedOutcome("coverage", "no-input");
	const fresh = isCoverageReportFresh({
		reportMtimeMs: mtimeMs(reportPath),
		baselineMtimeMs: mtimeMs(baselinePath(opts.interlinkedDir)),
		sessionStartMs: opts.sessionStartMs,
	});
	if (!fresh) return skippedOutcome("coverage", "stale-report");
	const summary = loadCoverageSummary(reportPath);
	if (!summary) return skippedOutcome("coverage", "no-input");

	const prior = loadBaseline(opts.interlinkedDir);
	const result = compareCoverage(summary, prior, {
		config: loadCheckPolicy(opts.cwd).coverage_ratchet,
		repoRoot: opts.cwd,
	});
	if (result.partialReport?.partial) return skippedOutcome("coverage", "partial-report");
	const { raised, details } = countRaised(prior, result.nextBaseline);
	const refused = result.stats.files_decreased;
	if (raised === 0) return skippedOutcome("coverage", "no-change", refused);
	if (!opts.dryRun) saveBaseline(opts.interlinkedDir, result.nextBaseline);
	return { kind: "coverage", changed: raised, refused, skipped: null, details, dryRun: opts.dryRun };
}

// ===========================================
// Fold A2 — per-edit coverage baseline (coverage-edit-baseline.json)
// ===========================================

// Raw on-disk shape of coverage-edit-baseline.json: fraction, or {f, scope}.
// The parsed value is `unknown` (untrusted JSON off disk) and validated
// field-by-field below, not trusted via a cast.

function editBaselineFraction(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { f?: unknown }).f === "number"
	)
		return (value as { f: number }).f;
	return null;
}

/**
 * Boundary parse for coverage-edit-baseline.json: a corrupt or missing file
 * folds as empty and gets rebuilt tighter. Kept as `unknown` values (not
 * cast to EditBaselineValue) — untrusted JSON off disk, re-validated per
 * entry by editBaselineFraction.
 */
function parseEditBaselineFile(editPath: string): Record<string, unknown> {
	try {
		if (!existsSync(editPath)) return {};
		const parsed: unknown = JSON.parse(readFileSync(editPath, "utf-8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch (err) {
		void err; // unreadable/corrupt baseline — rebuild from the full water-line
		return {};
	}
}

/**
 * Fold the full-run water-line's per-file line coverage into the per-edit
 * gate's baseline (`coverage-edit-baseline.json`).
 *
 * WHY: that file's only other writer is the per-edit coverage gate itself, so
 * with the gate disabled the file fossilized (58 days stale, 2026-08-25) while
 * `coverage-baseline.json` stayed fresh via Fold A. This fold gives it a
 * second, always-on producer. Runs AFTER Fold A so it reads the just-raised
 * water-line. Tighten-only: an entry may only rise, and a missing entry may be
 * added (both make the drop-check stricter); a lower full-run number is
 * REFUSED — the prior high-water holds, which also preserves scoped entries
 * measured under narrower test scopes. Idempotent, so no freshness gate: a
 * no-op fold reports "no-change" and writes nothing.
 */
export function foldCoverageEditBaseline(opts: {
	interlinkedDir: string;
	dryRun: boolean;
}): FoldOutcome {
	const full = loadBaseline(opts.interlinkedDir);
	const entries = Object.entries(full.files);
	if (entries.length === 0) return skippedOutcome("coverage_edit", "no-input");
	const editPath = join(opts.interlinkedDir, "coverage-edit-baseline.json");
	const prior = parseEditBaselineFile(editPath);
	const next: Record<string, unknown> = { ...prior };
	const details: string[] = [];
	let raised = 0;
	let refused = 0;
	for (const [file, entry] of entries) {
		if (!Number.isFinite(entry.lines_pct)) continue;
		const fraction = entry.lines_pct / 100;
		const existing = editBaselineFraction(prior[file]);
		if (existing !== null && fraction <= existing) {
			if (fraction < existing) refused++;
			continue;
		}
		next[file] = fraction;
		raised++;
		if (details.length < FOLD_DETAIL_CAP) {
			details.push(`${file}: ${existing === null ? "new" : existing.toFixed(2)}→${fraction.toFixed(2)}`);
		}
	}
	if (raised === 0) return skippedOutcome("coverage_edit", "no-change", refused);
	if (!opts.dryRun) writeFileSync(editPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	return { kind: "coverage_edit", changed: raised, refused, skipped: null, details, dryRun: opts.dryRun };
}

// ===========================================
// Fold B — untested-files exemptions
// ===========================================

/**
 * Plan the exemption drops for the files this session wrote. SHRINK-ONLY by
 * construction: the returned set is built by REMOVING from the recorded set,
 * so a new untested file cannot enter it — the loosening direction is
 * unrepresentable rather than merely unchosen.
 *
 * `hasTest` is injected so the planner stays a pure function; production passes
 * `hasCompanionTest`, the same resolver the `untested_files` verify check uses.
 */
export function planExemptionDrops(args: {
	baseline: UntestedFilesBaseline;
	touched: string[];
	hasTest: (rel: string) => boolean;
}): { files: Set<string>; dropped: string[] } {
	const files = new Set(args.baseline.files);
	const dropped: string[] = [];
	for (const rel of args.touched) {
		if (!files.has(rel)) continue; // never an ADD — only recorded entries can leave
		if (!args.hasTest(rel)) continue;
		files.delete(rel);
		dropped.push(rel);
	}
	return { files, dropped };
}

/** Drop exemptions for session-written files that now own a companion test. */
export function foldUntestedFiles(opts: {
	cwd: string;
	touched: string[];
	dryRun: boolean;
}): FoldOutcome {
	if (opts.touched.length === 0) return skippedOutcome("untested_files", "no-input");
	const baseline = loadUntestedFilesBaseline(opts.cwd);
	if (!baseline) return skippedOutcome("untested_files", "no-baseline");
	const { files, dropped } = planExemptionDrops({
		baseline,
		touched: opts.touched,
		hasTest: (rel) => hasCompanionTest(rel, opts.cwd),
	});
	if (dropped.length === 0) return skippedOutcome("untested_files", "no-change");
	if (!opts.dryRun) saveUntestedFilesBaseline(opts.cwd, { ...baseline, files });
	return {
		kind: "untested_files",
		changed: dropped.length,
		refused: 0, // adds are unrepresentable above — see planExemptionDrops
		skipped: null,
		details: dropped.slice(0, FOLD_DETAIL_CAP),
		dryRun: opts.dryRun,
	};
}

// ===========================================
// Fold C — large-files grandfather counts
// ===========================================

/** Current line count of a repo-relative file, or null when unreadable. */
function lineCountOf(cwd: string, rel: string): number | null {
	try {
		const abs = resolve(cwd, rel);
		if (!existsSync(abs)) return null;
		return countLines(readFileSync(abs, "utf-8"));
	} catch {
		return null;
	}
}

/** The grandfather plan: the next `files` map plus what moved and what was held. */
interface GrandfatherShrinkPlan {
	files: Record<string, number>;
	dropped: string[];
	tightened: string[];
	refused: number;
}

/**
 * Plan grandfather drops + count tightenings for the touched files.
 *
 * Three outcomes per file, all in the safe direction:
 *   - now at/under `max_lines`      → the entry is DROPPED (offender resolved)
 *   - still over cap but SMALLER    → the recorded count is LOWERED
 *   - over cap and not recorded     → REFUSED (adding it pre-authorizes an
 *                                     over-cap file — the exact loosening the
 *                                     baseline-integrity gate blocks)
 * A recorded count is never raised and a new entry is never created.
 */
export function planGrandfatherShrink(args: {
	baseline: LargeFileBaseline;
	touched: string[];
	lineCountOf: (rel: string) => number | null;
}): GrandfatherShrinkPlan {
	const files = { ...args.baseline.files };
	const dropped: string[] = [];
	const tightened: string[] = [];
	let refused = 0;
	for (const rel of args.touched) {
		const lines = args.lineCountOf(rel);
		if (lines === null) continue;
		const recorded = files[rel];
		if (recorded === undefined) {
			if (lines > args.baseline.max_lines) refused++; // withheld: never grow the list
			continue;
		}
		if (lines <= args.baseline.max_lines) {
			delete files[rel];
			dropped.push(`${rel}: ${recorded}→under cap (${lines})`);
		} else if (lines < recorded) {
			files[rel] = lines;
			tightened.push(`${rel}: ${recorded}→${lines}`);
		}
	}
	return { files, dropped, tightened, refused };
}

/** Drop/tighten grandfather entries for files this session shrank. */
export function foldLargeFiles(opts: {
	cwd: string;
	touched: string[];
	dryRun: boolean;
}): FoldOutcome {
	if (opts.touched.length === 0) return skippedOutcome("large_files", "no-input");
	const baseline = loadLargeFileBaseline(opts.cwd);
	if (!baseline) return skippedOutcome("large_files", "no-baseline");
	const plan = planGrandfatherShrink({
		baseline,
		touched: opts.touched,
		lineCountOf: (rel) => lineCountOf(opts.cwd, rel),
	});
	const changed = plan.dropped.length + plan.tightened.length;
	if (changed === 0) return skippedOutcome("large_files", "no-change", plan.refused);
	if (!opts.dryRun) saveLargeFileBaseline(opts.cwd, { ...baseline, files: plan.files });
	return {
		kind: "large_files",
		changed,
		refused: plan.refused,
		skipped: null,
		details: [...plan.dropped, ...plan.tightened].slice(0, FOLD_DETAIL_CAP),
		dryRun: opts.dryRun,
	};
}

/** Normalize a session's written-file set to repo-relative POSIX paths inside
 *  `cwd`. Paths outside the repo (linked workspaces, temp probes) are dropped —
 *  they can't be keys in a repo-relative baseline. */
export function toRepoRelative(cwd: string, paths: Iterable<string>): string[] {
	const out = new Set<string>();
	for (const p of paths) {
		if (!p) continue;
		const rel = relative(cwd, resolve(cwd, p)).replace(/\\/g, "/");
		if (rel === "" || rel.startsWith("..")) continue;
		out.add(rel);
	}
	return [...out];
}
