// ===========================================
// CRAP (Change Risk Anti-Patterns) — the 4th per-edit coverage block
// ===========================================
// CRAP(fn) = cyclomatic² · (1 − cov)³ + cyclomatic (the formula REUSED from
// checks/crap.ts — never reimplemented here). A function blocks when it is BOTH
// complex AND under-covered. This runs AFTER the uncovered-added-line / drop
// decision in coverage-write-guard.ts: a flat coverage gap is the more basic
// failure; CRAP is the "complex AND under-covered" escalation. Computed from the
// SAME overlay coverage run — no second suite spawn. Cyclomatic comes from the
// per-language analyzer; the coverage fraction from the overlay's per-function
// (JS/istanbul) or per-line (Python/coverage.py) data, intersected with each
// function's body range.
//
// Extracted from coverage-write-guard.ts to keep that module under the per-file
// line cap. The guard injects its `loudDegrade` (fail-open) so this module stays
// pure and import-acyclic.

import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CoverageLanguage } from "../coverage-runner.js";
import type { HarnessDecision } from "../types.js";
import { type CrapViolation, crapViolationsPerFunction, crapViolationsPerLine } from "./crap-violations.js";

// The CRAP violation shape + its two per-report-shape builders are SHARED with
// the commit gate (`commit-gate-scan.ts`) — one implementation in
// `crap-violations.ts`. Re-exported so this module's public surface is unchanged
// for existing importers (`coverage-write-guard-overlay.ts` types on it).
export type { CrapViolation } from "./crap-violations.js";

/**
 * A per-function cyclomatic counter for one language, used to compute CRAP from
 * the overlay coverage. Returns `null` when the backing analyzer is unavailable
 * (the loud "do not treat as simple" signal — typescript/radon absent), which the
 * CRAP gate fail-opens on, exactly like the coverage block fail-opens on an
 * unmeasured suite.
 */
export type CyclomaticAnalyzer = (
	content: string,
	filePath: string,
) => FunctionComplexityEntry[] | null;

/** Default CRAP cutoff — the McCabe/SonarQube convention (cyclomatic-10 @ 0% = 110). */
export const DEFAULT_CRAP_THRESHOLD = 30;

/**
 * The real cyclomatic analyzer for a coverage language, or null to skip CRAP for
 * it: the in-process TS AST for js/ts, radon for python — the same analyzers the
 * strict cyclomatic PreToolUse gate uses. Lives here (not in the guard) so the
 * guard stays under the line cap and the mapping has one home.
 */
export function defaultCyclomaticFor(language: CoverageLanguage): CyclomaticAnalyzer | null {
	switch (language) {
		case "js":
		case "ts":
			return computeCyclomaticAst;
		case "python":
			return computeCyclomaticPython;
		default:
			return null;
	}
}

/** Inputs to the CRAP decision, all explicit so it needs no GateContext fields. */
export interface CrapInput {
	relPath: string;
	proposed: string;
	cov: PerFileCoverage;
	editedLines: Set<number> | undefined;
	threshold: number;
	analyzer: CyclomaticAnalyzer | null;
}

/** True when the runner reported native per-line coverage (coverage.py path). */
export function hasPerLineData(cov: PerFileCoverage): boolean {
	return cov.uncoveredLines !== undefined || cov.coveredLines !== undefined;
}

/**
 * True when a complexity entry's body range intersects the edited lines, OR when
 * the edited-line set is unavailable (derivation failed — fail-safe: every
 * function counts, matching the coverage check's same-named invariant). The line-
 * precise filter is what scopes CRAP to functions the edit ADDED or TOUCHED.
 */
function crapTouches(fn: FunctionComplexityEntry, editedLines: Set<number> | undefined): boolean {
	if (!editedLines) return true;
	for (let ln = fn.line; ln <= fn.endLine; ln++) {
		if (editedLines.has(ln)) return true;
	}
	return false;
}

/** The actionable CRAP block for the worst touched function (highest CRAP). */
function blockForCrap(relPath: string, worst: CrapViolation): HarnessDecision {
	const crap = Math.round(worst.crap_score);
	const cov = Math.round(worst.coverage_pct);
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: this edit leaves \`${worst.function}\` ` +
			`(${relPath} line ${worst.line}) with a CRAP score of ${crap} ` +
			`(cyclomatic ${worst.cyclomatic}, coverage ${cov}%) — it is BOTH complex AND ` +
			"under-covered. CRAP = cyclomatic² · (1 − coverage)³ + cyclomatic, checked after " +
			"the coverage gate. Reduce complexity (decompose the function) OR add coverage " +
			"(exercise its branches), then retry.\n" +
			"This CRAP threshold is per-repo configurable: `interlinked caps set crap <n>` " +
			"(`interlinked caps explain crap` for what it measures).",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/**
 * The CRAP block for the edited file, or null when no touched function is over the
 * threshold. Runs only when a cyclomatic analyzer is available — an unavailable
 * analyzer fail-opens via the injected `onDegrade` (the guard's loud-degrade),
 * like the coverage block on an unmeasured suite. `onDegrade` returns the
 * fail-open decision (an ALLOW carrying an agent-visible warning), which this
 * propagates so the "CRAP gate ON but couldn't run" state is never silent.
 * Cyclomatic is parsed from the proposed content; only functions the edit ADDED or
 * TOUCHED are scored.
 */
export function decideCrap(
	input: CrapInput,
	onDegrade: (relPath: string, why: string) => HarnessDecision,
	/** Fired exactly once, only when a block is about to be returned, with the
	 *  single violation that drives it (`blockForCrap` only ever surfaces the
	 *  worst of the touched functions) — the telemetry hook's one shown-finding
	 *  observation point. Never called on degrade/null paths: those aren't a
	 *  CRAP finding being shown, just "couldn't measure" or "nothing over
	 *  threshold". */
	onShown?: (relPath: string, worst: CrapViolation) => void,
): HarnessDecision | null {
	if (!input.analyzer) {
		return onDegrade(input.relPath, "no cyclomatic analyzer for CRAP — fail-open");
	}
	const all = input.analyzer(input.proposed, input.relPath);
	if (all === null) {
		return onDegrade(input.relPath, "cyclomatic analyzer unavailable for CRAP — fail-open");
	}
	const touched = all.filter((fn) => crapTouches(fn, input.editedLines));
	if (touched.length === 0) return null;

	const violations = hasPerLineData(input.cov)
		? crapViolationsPerLine(touched, input.cov, input.threshold)
		: crapViolationsPerFunction(input.relPath, touched, input.cov, input.threshold);
	const worst = violations[0];
	if (!worst) return null;
	onShown?.(input.relPath, worst);
	return blockForCrap(input.relPath, worst);
}
