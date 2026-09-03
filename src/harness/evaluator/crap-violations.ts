// ===========================================
// CRAP violation builders — shared by the per-edit and commit-time gates
// ===========================================
// One CRAP finding shape and one pair of builders, over the two coverage-report
// shapes a runner can produce: PER-FUNCTION (JS/istanbul) and PER-LINE
// (Python/coverage.py). Both surfaces that block on CRAP consume these:
//   - `coverage-crap-decision.ts` — the per-edit gate, scoped to touched functions.
//   - `commit-gate-scan.ts`       — the commit gate, over every changed source.
// They carried byte-identical copies of these builders (plus the `countInRange`
// helper) until they were unified here — the same metric on the same report
// shapes, so a change to the scoring must reach both surfaces at once.
//
// The score itself is NEVER reimplemented: `computeCrap` (exact formula + the
// ±3-line name/line matching) and `crapScore` come from `checks/crap.ts`.

import { computeCrap, crapScore } from "../checks/crap.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";

/** One CRAP violation for a function — drives the block message at both gates. */
export interface CrapViolation {
	function: string;
	line: number;
	cyclomatic: number;
	coverage_pct: number;
	crap_score: number;
}

/** Count how many of [start,end] (inclusive) appear in `lines`. */
function countInRange(lines: ReadonlySet<number>, start: number, end: number): number {
	let n = 0;
	for (const ln of lines) {
		if (ln >= start && ln <= end) n++;
	}
	return n;
}

/**
 * CRAP violations for the PER-FUNCTION (JS/istanbul) shape. Cyclomatic from the
 * analyzer, coverage from `cov.functions` — matched + scored by the REUSED
 * `computeCrap`. Callers scope the input themselves (the per-edit gate passes
 * only TOUCHED functions; the commit gate passes the whole file).
 */
export function crapViolationsPerFunction(
	relPath: string,
	complexities: FunctionComplexityEntry[],
	cov: PerFileCoverage,
	threshold: number,
): CrapViolation[] {
	const findings = computeCrap({
		complexities,
		coverage: cov.functions,
		filePath: relPath,
		fileMtime: 0,
		coverageMtime: null, // never stale: this is THIS run's fresh coverage
		threshold,
		staleTolerance: "include",
	});
	return findings.map((f) => ({
		function: f.function,
		line: f.line,
		cyclomatic: f.complexity,
		coverage_pct: f.coverage_pct,
		crap_score: f.crap_score,
	}));
}

/**
 * CRAP violations for the PER-LINE (Python/coverage.py) shape. coverage.py has no
 * function ranges, so the per-function fraction is the covered lines INSIDE each
 * analyzer-reported function body range over its executable lines
 * (covered + uncovered in range). A function with no executable lines in range is
 * skipped (no measurable coverage ⇒ not a CRAP signal). Scores via the REUSED
 * `crapScore`. Sorted worst-first for a stable message.
 */
export function crapViolationsPerLine(
	complexities: FunctionComplexityEntry[],
	cov: PerFileCoverage,
	threshold: number,
): CrapViolation[] {
	const covered = cov.coveredLines ?? new Set<number>();
	const uncovered = cov.uncoveredLines ?? new Set<number>();
	const violations: CrapViolation[] = [];
	for (const fn of complexities) {
		const inCovered = countInRange(covered, fn.line, fn.endLine);
		const inUncovered = countInRange(uncovered, fn.line, fn.endLine);
		const executable = inCovered + inUncovered;
		if (executable === 0) continue; // no measurable lines → no CRAP signal
		const covPct = (inCovered / executable) * 100;
		const score = crapScore(fn.cyclomatic, covPct);
		if (score < threshold) continue;
		violations.push({
			function: fn.name,
			line: fn.line,
			cyclomatic: fn.cyclomatic,
			coverage_pct: covPct,
			crap_score: score,
		});
	}
	violations.sort((a, b) => b.crap_score - a.crap_score);
	return violations;
}
