// ===========================================
// Commit-gate per-source violation detection
// ===========================================
// Pure violation builders for the commit gate: given one changed source's coverage
// report + cyclomatic analysis, produce the uncovered / cyclomatic / CRAP violations
// that become the block reason. No I/O, no daemon state — extracted from
// `commit-gate.ts` to keep that file under the per-file line cap. `scanFile` (which
// also needs `loudDegrade` + the analyzer type) stays in `commit-gate.ts` and calls
// these. REUSES `crapScore` / `computeCrap` from `checks/crap.ts` — never reimplemented.

import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CoverageLanguage } from "../coverage-runner.js";
import { DEFAULT_MAX_CYCLOMATIC } from "../metric-caps.js";
import { crapViolationsPerFunction, crapViolationsPerLine } from "./crap-violations.js";

/**
 * DEFAULT per-function cyclomatic cap at commit time — used when no caller
 * passes an explicit cap. Kept identical to the per-edit default
 * (`DEFAULT_MAX_CYCLOMATIC`) so the two enforcement surfaces agree on the
 * shipped figure. The commit gate resolves the EFFECTIVE per-repo cap via
 * `maxCyclomaticFor(repoRoot)` and threads it down: a lowered `interlinked caps
 * set cyclomatic` was honored per-edit but the deferred commit gate still
 * compared against a hard-coded 25, so a big suite that defers to commit time
 * could bypass a tightened cap (and a raised cap produced false commit blocks)
 * — finding 2026-06, round 8.
 */
export const COMMIT_CYCLOMATIC_CAP = DEFAULT_MAX_CYCLOMATIC;

/** A changed source file the gate will evaluate, with its resolved language. */
export interface ChangedSource {
	relPath: string;
	language: CoverageLanguage;
}

/** A single named violation for the block reason. */
export interface Violation {
	kind: "uncovered" | "crap" | "cyclomatic";
	file: string;
	detail: string;
}

/** True when the runner reported native per-line coverage (coverage.py path). */
export function hasPerLineData(cov: PerFileCoverage): boolean {
	return cov.uncoveredLines !== undefined || cov.coveredLines !== undefined;
}

/** The lowest uncovered executable line for a per-line (coverage.py) report, or null. */
function firstUncoveredLine(cov: PerFileCoverage): number | null {
	const uncovered = cov.uncoveredLines ?? new Set<number>();
	let lowest: number | null = null;
	for (const ln of uncovered) {
		if (lowest === null || ln < lowest) lowest = ln;
	}
	return lowest;
}

/** The first uncovered function for a per-function (istanbul / JS) report, or null. */
function firstUncoveredFunction(cov: PerFileCoverage): { name: string; line: number } | null {
	for (const fn of cov.functions) {
		if (fn.hits === 0 || fn.statement_pct === 0) return { name: fn.name, line: fn.line };
	}
	return null;
}

/** The worst (first) over-cap cyclomatic function for a file, or null. `cap` is
 *  the effective per-repo cyclomatic cap (defaults to the shipped figure). */
function firstOverCapCyclomatic(
	complexities: FunctionComplexityEntry[],
	cap: number = COMMIT_CYCLOMATIC_CAP,
): FunctionComplexityEntry | null {
	let worst: FunctionComplexityEntry | null = null;
	for (const fn of complexities) {
		if (fn.cyclomatic <= cap) continue;
		if (!worst || fn.cyclomatic > worst.cyclomatic) worst = fn;
	}
	return worst;
}

/** The uncovered-line / uncovered-function coverage violation for a file, or null. */
export function coverageViolation(source: ChangedSource, cov: PerFileCoverage): Violation | null {
	if (hasPerLineData(cov)) {
		const line = firstUncoveredLine(cov);
		if (line !== null) {
			return { kind: "uncovered", file: source.relPath, detail: `line ${line} is executable but uncovered` };
		}
		return null;
	}
	const fn = firstUncoveredFunction(cov);
	if (fn) {
		return {
			kind: "uncovered",
			file: source.relPath,
			detail: `\`${fn.name}\` (line ${fn.line}) is executable but uncovered`,
		};
	}
	return null;
}

/** The whole-file violation for a changed source that ran a full suite yet is ABSENT
 *  from the coverage report — no test loaded it, so its executable code is uncovered. */
export function missingCoverageViolation(source: ChangedSource): Violation {
	return {
		kind: "uncovered",
		file: source.relPath,
		detail: "absent from the coverage report after a full run — no test exercised it (untested)",
	};
}

/** Line starters that carry NO runtime behavior: type-level declarations, named /
 *  type-only imports (erased or pure bindings), re-exports (no logic of their own).
 *  A side-effect import (`import "./x"`) is NOT here — it runs code at load. */
const TYPE_ONLY_STARTERS = [
	"import ", // named/default/namespace import — module binding, no logic of this file's own
	"import{",
	"from ", // Python import form, for the gate's python language
	"export type",
	"export interface",
	"export declare",
	"export default interface",
	"export {",
	"export *",
	"export{",
	"interface ",
	"type ",
	"declare ",
	"| ", // union member of a multi-line type alias
	"& ", // intersection member of a multi-line type alias
];

/** Net brace depth contributed by one line (for skipping interface/type bodies). */
function braceDelta(line: string): number {
	let depth = 0;
	for (const ch of line) {
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
	}
	return depth;
}

/** Advances a multi-line type-alias continuation (`type X =\n  ...;`) past one
 *  more source line: folds the line's brace delta into `depth` and reports
 *  whether the continuation has closed (a trailing `;` ends it; anything else
 *  keeps it open). Extracted ONLY to satisfy the 15-point cognitive cap that the
 *  file's other edits in this unit re-armed; behavior is the inline original. */
function advanceContinuationLine(line: string, depth: number): { depth: number; continuation: boolean } {
	return { depth: depth + braceDelta(line), continuation: !line.endsWith(";") };
}

/**
 * True when a changed source has NO runtime behavior of its own — only imports,
 * type/interface/declare declarations, re-exports, and comments. This is the ONLY
 * exemption from the missing-coverage block: a file absent from the coverage report
 * with anything executable (a function, a top-level `console.log(…)`, an initializing
 * call, an enum) must block (finding 2026-06: gating on "the analyzer found ≥1
 * function" let function-less top-level code pass). Deterministic and deliberately
 * biased: anything unrecognized counts as EXECUTABLE — the exemption narrows, never
 * widens. A side-effect import (`import "./x"`) counts as executable.
 */
export function isTypeOnlySource(content: string): boolean {
	// Strip block + line comments (string-naive: a string literal outside a type
	// context already implies executable code, so misparsing inside one is moot).
	const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	let depth = 0; // inside an interface/type/declare body
	let continuation = false; // a type alias whose RHS starts on the NEXT line (`type X =`)
	for (const raw of stripped.split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		if (depth > 0) {
			depth += braceDelta(line);
			continue; // type-level body line
		}
		if (continuation) {
			const advanced = advanceContinuationLine(line, depth);
			depth = advanced.depth;
			continuation = advanced.continuation;
			continue;
		}
		// Side-effect import — runs the module at load: executable.
		if (line.startsWith('import "') || line.startsWith("import '")) return false;
		const starter = TYPE_ONLY_STARTERS.find((s) => line.startsWith(s));
		if (!starter) return false; // an executable statement
		depth += braceDelta(line);
		// ONLY a trailing `=` means the alias RHS continues below — any other ending
		// (`;`, a closed `}`, a re-export's quote) completes the statement. The old
		// "didn't end with ;" rule swallowed the NEXT line after a one-line
		// `interface T { … }`, hiding an executable statement (probe-caught).
		if (depth === 0 && line.endsWith("=")) continuation = true;
	}
	return true;
}

/** The over-cap cyclomatic violation for a file, or null. `cap` is the effective
 *  per-repo cyclomatic cap (`maxCyclomaticFor`), defaulting to the shipped figure
 *  so existing callers/tests keep their behavior. */
export function cyclomaticViolation(
	source: ChangedSource,
	complexities: FunctionComplexityEntry[],
	cap: number = COMMIT_CYCLOMATIC_CAP,
): Violation | null {
	const overCap = firstOverCapCyclomatic(complexities, cap);
	if (!overCap) return null;
	return {
		kind: "cyclomatic",
		file: source.relPath,
		detail: `\`${overCap.name}\` (line ${overCap.line}) has cyclomatic complexity ${overCap.cyclomatic} (cap ${cap})`,
	};
}

/** The worst CRAP violation for a file, or null. */
export function crapViolation(
	source: ChangedSource,
	complexities: FunctionComplexityEntry[],
	cov: PerFileCoverage,
	threshold: number,
): Violation | null {
	const hits = hasPerLineData(cov)
		? crapViolationsPerLine(complexities, cov, threshold)
		: crapViolationsPerFunction(source.relPath, complexities, cov, threshold);
	const worst = hits[0];
	if (!worst) return null;
	return {
		kind: "crap",
		file: source.relPath,
		detail: `\`${worst.function}\` (line ${worst.line}) has a CRAP score of ${Math.round(worst.crap_score)} (cyclomatic ${worst.cyclomatic}, coverage ${Math.round(worst.coverage_pct)}%)`,
	};
}
