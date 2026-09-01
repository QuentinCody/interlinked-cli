// ===========================================
// Per-edit coverage — pure decision helpers (extracted from coverage-write-guard.ts)
// ===========================================
// The uncovered-added-line / coverage-drop / red-bar decision pieces of the
// per-edit gate, split out to keep the guard module under the per-file line cap.
// Pure functions over the runner's PerFileCoverage — no overlay, no runner, no
// config. Import from coverage-write-guard.ts unless you specifically need the
// decision pieces in isolation (the delete-only path does).

import { RED_BAR_MARKER, UNCOVERED_MARKER } from "../coverage-debt.js";
import { type FunctionCoverage, type PerFileCoverage } from "../coverage-final-reader.js";
import { readFileCoverageBaselineEntry } from "../coverage-obligation-ledger.js";
import { minCoverageFor } from "../metric-caps.js";
import type { HarnessDecision } from "../types.js";
import { hasPerLineData } from "./coverage-crap-decision.js";
import { pctPrecise } from "./coverage-scope.js";

/**
 * The covered-line *fraction* (0..1) for a file, derived from the per-function
 * statement coverage the runner reports. Empty / no-statement files report 1
 * (nothing to cover ⇒ no regression). This is the honest aggregate the drop
 * check compares against the prior baseline.
 */
function coveredFraction(cov: PerFileCoverage): number {
	if (cov.functions.length === 0) return 1;
	let sum = 0;
	for (const fn of cov.functions) sum += fn.statement_pct;
	return sum / cov.functions.length / 100;
}

/**
 * The covered-line fraction from PER-LINE data (coverage.py): covered /
 * (covered + uncovered). A file with no executable lines reports 1 (nothing to
 * cover ⇒ no regression), matching the function-path convention.
 */
function coveredFractionByLine(covered: ReadonlySet<number>, uncovered: ReadonlySet<number>): number {
	const total = covered.size + uncovered.size;
	if (total === 0) return 1;
	return covered.size / total;
}

/**
 * The first executable line the edit ADDED that is uncovered, or null when none.
 * When the edited-line set is known, only an added line counts (the line-precise
 * strict-TDD invariant); when derivation failed (undefined), ANY uncovered line
 * counts — an edit must not leave the file with an uncovered line. Lowest line
 * number first, for a stable, actionable message.
 */
function uncoveredAddedLine(
	uncovered: ReadonlySet<number>,
	editedLines: Set<number> | undefined,
): number | null {
	let lowest: number | null = null;
	for (const ln of uncovered) {
		if (editedLines && !editedLines.has(ln)) continue;
		if (lowest === null || ln < lowest) lowest = ln;
	}
	return lowest;
}

/** True when a function's body range intersects any edited line. */
function fnTouchesEditedLines(fn: FunctionCoverage, editedLines: Set<number>): boolean {
	for (let ln = fn.line; ln <= fn.endLine; ln++) {
		if (editedLines.has(ln)) return true;
	}
	return false;
}

/**
 * The first uncovered function that the edit ADDED/changed, or null when every
 * edited function is covered. A function is "uncovered" when it never executed
 * (hits 0) or none of its statements ran (statement_pct 0). When the edited-line
 * set is unavailable (fail-open on derivation), every uncovered function counts
 * — the strict-TDD invariant: an edit must not leave an uncovered function.
 */
function uncoveredAddedFunction(
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
): FunctionCoverage | null {
	for (const fn of cov.functions) {
		const uncovered = fn.hits === 0 || fn.statement_pct === 0;
		if (!uncovered) continue;
		if (!editedLines || fnTouchesEditedLines(fn, editedLines)) return fn;
	}
	return null;
}

/** The actionable strict-TDD block for an uncovered added line. Interpolates
 *  {@link UNCOVERED_MARKER} — the phrase debt-mode's `isUncoveredBlock`
 *  recognizes this verdict by. */
function blockForUncovered(relPath: string, fn: FunctionCoverage): HarnessDecision {
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: ${relPath} line ${fn.line} (function ` +
			`\`${fn.name}\`) is executable but ${UNCOVERED_MARKER} after this edit. ` +
			"Add a test that exercises this code, then retry.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/**
 * The strict-TDD block for an uncovered added line known only by NUMBER (the
 * per-line path; coverage.py gives no function name). Same actionable shape as
 * {@link blockForUncovered} minus the function attribution.
 */
function blockForUncoveredLine(relPath: string, line: number): HarnessDecision {
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: ${relPath} line ${line} is executable but ` +
			`${UNCOVERED_MARKER} after this edit. Add a test that exercises this ` +
			"line, then retry.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** Render the failing-test list for the red-bar reason, or a generic phrase. */
export function failingTestPhrase(failingTests: string[] | undefined): string {
	if (!failingTests || failingTests.length === 0) return "one or more tests are failing";
	const shown = failingTests.slice(0, 3);
	const suffix = failingTests.length > shown.length ? ", …" : "";
	return `failing test(s): ${shown.join(", ")}${suffix}`;
}

/**
 * The red-bar (strict per-edit TDD) block: the overlay ran the suite and it came
 * back RED (`testsPassed === false`). A failing suite is a harder failure than a
 * coverage gap, so this fires BEFORE the uncovered-line / drop decision and names
 * the failing test(s) so the fix is actionable. Interpolates
 * {@link RED_BAR_MARKER} — the phrase debt-mode's `isRedBarBlock` folds this
 * verdict into a `red_suite` debt by. `failingTestFiles` (when the runner parsed
 * them) ride the decision as `failing_test_files`, the structured evidence debt
 * mode records so red-episode relatedness follows the actual failure, not just
 * filename convention.
 */
export function blockForRedBar(
	relPath: string,
	failingTests: string[] | undefined,
	failingTestFiles?: string[] | undefined,
): HarnessDecision {
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: your edit to ${relPath} ${RED_BAR_MARKER} ` +
			`— ${failingTestPhrase(failingTests)}. Fix the failing test(s) before proceeding. ` +
			"Strict TDD: an edit may not save a transiently-red state.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
		...(failingTestFiles && failingTestFiles.length > 0
			? { failing_test_files: failingTestFiles }
			: {}),
	};
}

/**
 * Tolerance for the per-file %-drop BACKSTOP (below). The precise non-decrease
 * guard is the per-LINE added-line check, which runs first (line `decideFromCoverage`
 * → the `"block" in verdict` return) and exactly refuses a newly-uncovered line.
 * This %-drop check is a coarser backstop comparing `now` against the stored
 * baseline — but ONLY within the same test scope: baselines record the scope
 * that measured them (coverage-scope.ts), and a cross-scope comparison
 * re-anchors instead of blocking (2026-07-24: a file pinned at 100% from a
 * broad run false-blocked EVERY edit once selection narrowed to a scope that
 * could only reach 98.7%). Within one scope the epsilon absorbs sub-line float
 * wobble (1.0 → 0.9997) while catching a real multi-line regression; the
 * commit-time full-suite gate re-checks against the complete measurement.
 */
const COVERAGE_DROP_EPSILON = 0.005;

/** How many uncovered lines the drop message names (orientation, not a dump). */
const UNCOVERED_SAMPLE_MAX = 3;

/** First few uncovered lines, sorted — the pointer that turns a ten-minute
 *  "what dropped?" diagnosis into a one-line read. Empty when the engine's
 *  report carries no per-line data. */
function sampleUncoveredLines(cov: PerFileCoverage): number[] {
	const lines = cov.uncoveredLines;
	if (!lines || lines.size === 0) return [];
	return [...lines].sort((a, b) => a - b).slice(0, UNCOVERED_SAMPLE_MAX);
}

/** The actionable block for a per-file coverage regression vs the baseline.
 *  Unrounded percentages (98.7%, not "99%") and named uncovered lines — the
 *  rounded form hid the one-line gap behind an apparent 1% mystery. */
function blockForDrop(
	relPath: string,
	prior: number,
	now: number,
	uncoveredSample: number[] = [],
): HarnessDecision {
	const where =
		uncoveredSample.length > 0
			? ` (uncovered now: line ${uncoveredSample.join(", line ")})`
			: "";
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: this edit drops ${relPath} coverage from ` +
			`${pctPrecise(prior)} to ${pctPrecise(now)} under the same affected-test scope. ` +
			`The changed code itself passed the added-coverage check — the drop comes from ` +
			`previously-covered code going uncovered${where}. Restore or extend the covering ` +
			`test(s), then retry.`,
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** Block when a file's coverage is below the configured floor (`min_coverage`,
 *  default 0 = off) — an absolute per-file minimum, distinct from the
 *  non-decrease drop ratchet. */
function blockForFloor(relPath: string, now: number, floorPct: number): HarnessDecision {
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: ${relPath} coverage ${Math.round(now * 100)}% is below the ` +
			`configured floor of ${floorPct}%. Add tests to reach it, or change the floor: ` +
			"`interlinked caps set coverage <pct>`.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** Out-params handed back to the caller on allow: the measured fraction to
 *  persist, and — when the stored baseline was earned under a DIFFERENT test
 *  scope — the re-anchor signal (caller surfaces a loud allow-warning; the
 *  reseed itself happens via the normal on-allow baseline write). */
export interface CoverageDecisionOut {
	now?: number;
	scopeChanged?: { priorFraction: number };
}

/** Same-scope drop check with cross-scope re-anchor semantics: a baseline
 *  earned under a different (or legacy scope-less) test set is not comparable —
 *  every legacy 1.0 entry would otherwise false-block all edits once selection
 *  narrowed — so it signals the re-anchor instead of blocking. */
function dropVerdict(
	entry: { fraction: number; scope: string | null },
	relPath: string,
	now: number,
	scopeId: string | undefined,
	uncoveredSample: number[],
	out: CoverageDecisionOut | undefined,
	dropEpsilon?: number,
): HarnessDecision | null {
	if (scopeId !== undefined && entry.scope !== scopeId) {
		if (out) out.scopeChanged = { priorFraction: entry.fraction };
		return null;
	}
	if (now < entry.fraction - (dropEpsilon ?? COVERAGE_DROP_EPSILON)) {
		return blockForDrop(relPath, entry.fraction, now, uncoveredSample);
	}
	return null;
}

/** Per-file coverage regression check: the non-decrease drop vs the baseline
 *  (same-scope only — see dropVerdict), then the absolute `min_coverage`
 *  floor. Returns a block or null. Folding both into one helper keeps
 *  `decideFromCoverage` at low complexity. */
function perFileRegressionBlock(
	projectRoot: string,
	relPath: string,
	now: number,
	scopeId?: string,
	uncoveredSample: number[] = [],
	out?: CoverageDecisionOut,
	dropEpsilon?: number,
): HarnessDecision | null {
	const entry = readFileCoverageBaselineEntry(projectRoot, relPath);
	if (entry !== null) {
		const drop = dropVerdict(entry, relPath, now, scopeId, uncoveredSample, out, dropEpsilon);
		if (drop) return drop;
	}
	const floor = minCoverageFor(projectRoot);
	if (floor > 0 && now < floor / 100) return blockForFloor(relPath, now, floor);
	return null;
}

/**
 * The uncovered-added-line block and the now-fraction from PER-LINE data. Used
 * for engines whose report is natively per-line (coverage.py). Returns the block
 * for an uncovered added line, or the file's covered fraction when none.
 */
function decidePerLine(
	relPath: string,
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
): { block: HarnessDecision } | { now: number } {
	const covered = cov.coveredLines ?? new Set<number>();
	const uncovered = cov.uncoveredLines ?? new Set<number>();
	const line = uncoveredAddedLine(uncovered, editedLines);
	if (line !== null) return { block: blockForUncoveredLine(relPath, line) };
	return { now: coveredFractionByLine(covered, uncovered) };
}

/**
 * The uncovered-added-line block and the now-fraction from PER-FUNCTION data
 * (istanbul / JS). Behavior is unchanged from the original single-path gate.
 */
function decidePerFunction(
	relPath: string,
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
): { block: HarnessDecision } | { now: number } {
	const uncovered = uncoveredAddedFunction(cov, editedLines);
	if (uncovered) return { block: blockForUncovered(relPath, uncovered) };
	return { now: coveredFraction(cov) };
}

/**
 * Decide block-or-allow from the overlay's coverage of the edited file. Order:
 * uncovered-added-line first (the most actionable, line-specific message), then
 * the per-file drop vs baseline. On allow, the new fraction is handed back via
 * `out` so the CALLER persists it only after every later gate (CRAP) also
 * passes — writing it here would poison the baseline with rejected content if
 * CRAP then blocks (finding 8). Returns the block decision or null.
 *
 * One decision path, two coverage shapes: native per-line data (coverage.py) is
 * preferred when present because the decision is inherently per-line; otherwise
 * the per-function (istanbul / JS) path runs — identical to before this fork.
 */
export function decideFromCoverage(
	projectRoot: string,
	relPath: string,
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
	out: CoverageDecisionOut,
	scopeId?: string,
	/** `per_edit_coverage.drop_epsilon` override; absent ⇒ {@link COVERAGE_DROP_EPSILON}. */
	dropEpsilon?: number,
): HarnessDecision | null {
	const verdict = hasPerLineData(cov)
		? decidePerLine(relPath, cov, editedLines)
		: decidePerFunction(relPath, cov, editedLines);
	if ("block" in verdict) return verdict.block;

	const now = verdict.now;
	const regression = perFileRegressionBlock(
		projectRoot,
		relPath,
		now,
		scopeId,
		sampleUncoveredLines(cov),
		out,
		dropEpsilon,
	);
	if (regression) return regression;

	out.now = now;
	return null;
}
