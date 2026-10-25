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
import { readFileCoverageBaselineEntry, readFileCoverageHighWater } from "../coverage-obligation-ledger.js";
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
	failingTestFiles?: string[],
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
 * baseline. Baselines record the scope that measured them (coverage-scope.ts);
 * a cross-scope comparison re-anchors only upward, and nothing goes below the
 * file's full-suite high-water without a full-suite measurement — see
 * `highWaterVerdict` (this re-opens the 2026-07-24 bio shape — a file pinned
 * at 100% by a broad run, a narrowed scope reaching 98.7% — as a fail-closed
 * block that names how to re-measure, deliberately: the red-team 2026-10-21
 * churn sequence turned that exemption into an unbounded downward re-key).
 * The SAME epsilon is the high-water tolerance. Within one scope it absorbs sub-line float
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

/** A scope change the drop check describes in the block reason: the stored
 *  scope (a legacy scope-less entry is named "full") and today's. */
interface ScopeChange {
	from: string;
	to: string;
}

/** The actionable block for a per-file coverage regression vs the baseline.
 *  Unrounded percentages (98.7%, not "99%") and named uncovered lines — the
 *  rounded form hid the one-line gap behind an apparent 1% mystery. With a
 *  `scopeChange` the reason names both scopes: the drop was measured under a
 *  DIFFERENT affected-test set, and the gate refused to re-anchor downward. */
function blockForDrop(
	relPath: string,
	prior: number,
	now: number,
	uncoveredSample: number[] = [],
	scopeChange?: ScopeChange | "full-high-water",
): HarnessDecision {
	const where =
		uncoveredSample.length > 0
			? ` (uncovered now: line ${uncoveredSample.join(", line ")})`
			: "";
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: this edit drops ${relPath} coverage from ` +
			`${pctPrecise(prior)} to ${pctPrecise(now)}${dropScopePhrase(scopeChange)}. ` +
			`The changed code itself passed the added-coverage check — the drop comes from ` +
			`previously-covered code going uncovered${where}. Restore or extend the covering ` +
			`test(s), then retry.`,
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** How {@link blockForDrop} names the comparison: same scope, a changed scope,
 *  or a full-suite measurement against the file's full-suite high-water. */
function dropScopePhrase(scopeChange: ScopeChange | "full-high-water" | undefined): string {
	if (scopeChange === "full-high-water") {
		return ", its full-suite high-water, measured under the full suite — a real coverage drop";
	}
	if (scopeChange) {
		return `. The affected-test scope changed (${scopeChange.from} → ${scopeChange.to}); a changed ` +
			`test set re-anchors a water-line upward only — a baseline is never lowered by ` +
			`adding or removing companion tests`;
	}
	return " under the same affected-test scope";
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

/** The command a high-water block names: it runs the full suite under
 *  coverage, the only measurement allowed to accept a value below `hw`. */
const FULL_REMEASURE_HINT =
	"Re-measure under the FULL suite — land the change as an apply_patch that also touches the " +
	"file's test (the per-edit gate then runs the full suite), or run your full coverage suite and " +
	"`interlinked coverage check` to see the full-suite number";

/** A scoped (narrower-than-full) measurement fell below the file's full-suite
 *  high-water. Not proof of a drop, not proof of none: only a full-route
 *  measurement may store a value below `hw`, and none ran in this evaluation,
 *  so the gate fails CLOSED (the water-line may only tighten). */
function blockForUnconfirmedBelowHighWater(
	relPath: string,
	hw: number,
	now: number,
	scopeId: string,
	uncoveredSample: number[],
): HarnessDecision {
	const where = uncoveredSample.length > 0 ? ` (uncovered now: line ${uncoveredSample.join(", line ")})` : "";
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: this edit drops ${relPath} coverage from its full-suite ` +
			`high-water ${pctPrecise(hw)} to ${pctPrecise(now)} under the narrower affected-test scope ` +
			`${scopeId}${where}. A changed or narrowed test set never lowers a full-suite water-line; ` +
			`only a full-suite measurement at or above ${pctPrecise(hw)} may re-anchor it. ` +
			`${FULL_REMEASURE_HINT}. Or extend the selected tests to cover the file, then retry.`,
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** True when `scopeId` measured the full suite. An absent scope id is a
 *  scope-less caller, whose write the ledger records as full-suite. */
function isFullRoute(scopeId: string | undefined): boolean {
	return scopeId === undefined || scopeId === "full";
}

/**
 * The cross-scope HIGH-WATER check (red-team 2026-10-21, "scope re-anchor by
 * companion-test churn", round 2). The ledger keeps `hw`, the highest fraction
 * ever accepted for the file under the full suite (a legacy bare number N is
 * `hw: N`). No decision may store a value below `hw - epsilon` unless THIS
 * evaluation measured the full suite: a full-route measurement below it is a
 * real drop and blocks; a scoped one cannot tell, and blocks fail-closed. So
 * neither churning companion tests (full → scoped), alternating routes, nor a
 * legacy entry re-keys the water-line downward — the old exemption let a
 * stored "full"/legacy entry re-anchor DOWN under any narrower scope.
 */
function highWaterVerdict(
	hw: number | null,
	relPath: string,
	now: number,
	scopeId: string | undefined,
	uncoveredSample: number[],
	tolerance: number,
): HarnessDecision | null {
	if (hw === null || now >= hw - tolerance) return null;
	if (isFullRoute(scopeId)) return blockForDrop(relPath, hw, now, uncoveredSample, "full-high-water");
	return blockForUnconfirmedBelowHighWater(relPath, hw, now, scopeId ?? "unknown", uncoveredSample);
}

/** Drop check with scope semantics, AFTER {@link highWaterVerdict} passed.
 *  Same scope: a drop beyond epsilon blocks. Different scope: a HIGHER-or-equal
 *  measurement re-anchors (signalled via `out.scopeChanged`); a lower one
 *  BLOCKS whatever the stored scope — a water-line is never re-keyed downward
 *  by a changed test set (a full/legacy entry's `f` never exceeds its `hw`, so
 *  the high-water check already decided those). */
function dropVerdict(
	entry: { fraction: number; scope: string | null },
	relPath: string,
	now: number,
	scopeId: string | undefined,
	uncoveredSample: number[],
	out: CoverageDecisionOut | undefined,
	tolerance: number,
): HarnessDecision | null {
	const dropped = now < entry.fraction - tolerance;
	const crossScope = scopeId !== undefined && entry.scope !== scopeId;
	if (dropped) {
		const change = crossScope ? { from: entry.scope ?? "full", to: scopeId } : undefined;
		return blockForDrop(relPath, entry.fraction, now, uncoveredSample, change);
	}
	if (crossScope && out) out.scopeChanged = { priorFraction: entry.fraction };
	return null;
}

/** Per-file coverage regression check: the cross-scope high-water, the
 *  non-decrease drop vs the baseline (see dropVerdict), then the absolute
 *  `min_coverage` floor. Returns a block or null. Folding them into one helper
 *  keeps `decideFromCoverage` at low complexity. */
function perFileRegressionBlock(
	projectRoot: string,
	relPath: string,
	now: number,
	scopeId?: string,
	uncoveredSample: number[] = [],
	out?: CoverageDecisionOut,
	dropEpsilon?: number,
): HarnessDecision | null {
	const tolerance = dropEpsilon ?? COVERAGE_DROP_EPSILON;
	const hwBlock = highWaterVerdict(readFileCoverageHighWater(projectRoot, relPath), relPath, now, scopeId, uncoveredSample, tolerance);
	if (hwBlock) return hwBlock;
	const entry = readFileCoverageBaselineEntry(projectRoot, relPath);
	if (entry !== null) {
		const drop = dropVerdict(entry, relPath, now, scopeId, uncoveredSample, out, tolerance);
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
