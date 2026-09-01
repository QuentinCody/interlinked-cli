// ===========================================
// PreToolUse gate — per-function cyclomatic cap (strict, no override)
// ===========================================
// Blocks a Write/Edit/MultiEdit/apply_patch that would push a function's
// cyclomatic complexity past the cap. This module is now just the CYCLOMATIC
// SPEC — the decision engine (over-cap hybrid comparison, sub-cap slew ratchet,
// content projection, apply_patch reconstruction, block rendering) lives in
// `per-function-metric-gate.ts` and is shared with the cognitive gate, which
// used to be a hand-mirrored copy of it.
//
// DELTA semantics, mirroring the line-cap gate (`checkLargeFileLineCountWrite`):
// an edit that holds or reduces an already-complex function is always allowed —
// the refactor-down path — so the on-disk before-state is the implicit ratchet
// baseline. Only a NEW over-cap function, RAISING an existing function past the
// cap, or a sub-cap rise over `SUB_CAP_RATCHET_TOLERANCE` is blocked.
//
// Dispatch is per-language: `.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts` parse with
// the TS AST (`computeCyclomaticAst`); `.py` parses with radon
// (`computeCyclomaticPython`); every other extension is skipped. The block
// contract (cap, delta semantics, no override) is identical across languages —
// only the per-function counter differs. Python dispatch is unique to this
// metric; the cognitive analyzer is JS/TS only.
//
// There is deliberately NO escape hatch / suppression: an agent-writable
// override gets gamed (the agent would suppress every file it wants to grow),
// which defeats the gate. The only way past is to decompose.
//
// Because a no-override block has no relief valve for a false positive, it runs
// ONLY when the analyzer is available (the optional `typescript` dep for JS/TS,
// `radon` on PATH for Python — both present in a normal install). Without it the
// gate fails open — a heuristic count would risk FP-blocking legitimate code
// with no recourse. The unavailability is surfaced LOUDLY, never silently: the
// TS path warns at daemon startup (`astComplexityAvailable()` in server.ts); the
// Python path has no startup probe (radon is per-repo), so a `.py` edit that
// can't be analyzed emits a one-shot stderr degrade here.
// Codex/Copilot `apply_patch` payloads are reconstructed to post-edit content
// via the conservative V4A applier (fail-open on any uncertainty), so they no
// longer bypass the gate by carrying their edit in the patch body.

import type { JsonObject } from "../../lib/json-types.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import { maxCyclomaticFor } from "../metric-caps.js";
import {
	checkPerFunctionMetricWrite,
	type MetricGateSpec,
	type MetricObserver,
} from "./per-function-metric-gate.js";

export { projectContent, resolveFilePath } from "./per-function-metric-gate.js";

/**
 * Per-function cyclomatic cap — the agreed hard "bad" line. One number for now;
 * a future ratchet baseline (like `.interlinked/large-files-baseline.json`) can
 * lower it (25 → 15 → …) as the codebase's hotspots are decomposed.
 */
export const DEFAULT_MAX_CYCLOMATIC = 25;

/**
 * Per-edit sub-cap SLEW tolerance. A uniquely-named function that stays at or
 * below the cap may rise by AT MOST this many branches in a single edit; a
 * larger one-edit jump blocks (decompose, then retry). This relaxes the former
 * strict "may not increase at all" sub-cap ratchet into a per-edit rate limit:
 * a small incremental rise *toward* — but never *past* — the cap is acceptable,
 * while a big leap in one edit is the smell worth catching.
 *
 * The hard cap (`maxCyclomaticFor`) is unchanged and remains the END-STATE
 * backstop: no edit may leave a function over the cap regardless of how small
 * the rise (a within-tolerance bump that crosses the cap is caught by the
 * over-cap path, not here). Many small rises across several edits can still walk
 * a function toward the cap — that is the accepted trade (the cap is the ceiling
 * the slew limit only governs how fast you may approach it).
 *
 * CRAP inherits this automatically: CRAP is monotonic in cyclomatic, so a
 * bounded cyclomatic rise is a bounded CRAP rise, and CRAP's own cap (30) stays
 * its end-state backstop. There is deliberately no separate sub-cap CRAP ratchet
 * — every CRAP gate (`decideCrap` block, `computeCrapRisers` advisory) fires
 * only at/over 30 — so nothing on the CRAP side needs loosening.
 *
 * Set to 1 for a tighter "+1 per edit" policy. A future per-repo override can
 * live alongside `maxCyclomaticFor` in `.interlinked/metric-caps.json`. The
 * cognitive analog is `SUB_CAP_COGNITIVE_RATCHET_TOLERANCE` (= 4, deliberately
 * looser — see cognitive-write-guard.ts).
 */
export const SUB_CAP_RATCHET_TOLERANCE = 2;

const JS_TS_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const PY_RE = /\.py$/;
/** AST entries with this name are anonymous — not matchable across before/after. */
const ANON_FN = "(callback)";

interface ComplexityWriteBlock {
	block: string;
}

/**
 * Telemetry observer — receives the before/after entries the gate already
 * parsed for every analyzed file, plus the projected after-content (for
 * content-hash matching at PostToolUse). Observation only: it never affects
 * the block decision. Wired to the cyclomatic pulse (complexity-pulse.ts);
 * the cognitive gate deliberately has no equivalent.
 */
export type ComplexityObserver = MetricObserver<FunctionComplexityEntry>;

/** A per-function cyclomatic counter for one language. Returns `null` (the loud
 *  "analyzer unavailable" signal — see cyclomatic-ast/cyclomatic-python) when the
 *  backing parser is absent, which the caller fails open on. */
type CyclomaticAnalyzer = (content: string, filePath: string) => FunctionComplexityEntry[] | null;

/**
 * Pick the cyclomatic analyzer for a path, or null to skip (non-code extension).
 * `language` tags the loud-degrade message; the block contract is identical
 * regardless. JS/TS uses the in-process TS AST; Python shells to radon.
 * Exported for the pulse's stash-miss fallback parse (complexity-pulse.ts).
 */
export function selectAnalyzer(
	filePath: string,
): { compute: CyclomaticAnalyzer; language: "js_ts" | "python" } | null {
	if (JS_TS_RE.test(filePath)) return { compute: computeCyclomaticAst, language: "js_ts" };
	if (PY_RE.test(filePath)) return { compute: computeCyclomaticPython, language: "python" };
	return null;
}

/**
 * Surface a per-edit analyzer-unavailable degrade for languages without a
 * daemon-startup probe (Python: radon is per-repo, so server.ts can't warn up
 * front the way it does for `typescript`). Fired once per process to stay loud
 * but not naggy; the gate still fails open (no false block), matching the TS
 * fallback — the warning is the "not silent" half of the contract.
 */
let pythonDegradeWarned = false;

/** Test-only reset of the once-per-process degrade-warning latch, so a suite can
 *  assert the loud-degrade fires deterministically regardless of test order
 *  (mirrors `__resetTsCacheForTesting` in cyclomatic-ast.ts). */
export function __resetPythonDegradeWarningForTesting(): void {
	pythonDegradeWarned = false;
}

function warnAnalyzerUnavailable(language: string): void {
	// JS/TS degrade is already announced at daemon startup (astComplexityAvailable
	// in server.ts); only Python needs a per-edit surface.
	if (language !== "python" || pythonDegradeWarned) return;
	pythonDegradeWarned = true;
	process.stderr.write(
		"[interlinked] WARNING: `radon` is not resolvable — the strict cyclomatic " +
			"PreToolUse gate for Python (.py) is degraded and cannot enforce the " +
			`${DEFAULT_MAX_CYCLOMATIC}-branch cap. Install it (e.g. \`pip install radon\`) ` +
			"in this repo to restore enforcement. Edits are allowed meanwhile (fail-open).\n",
	);
}

/** The cyclomatic instantiation of the shared per-function metric gate. */
const CYCLOMATIC_SPEC: MetricGateSpec<FunctionComplexityEntry> = {
	label: "cyclomatic",
	anonName: ANON_FN,
	slewTolerance: SUB_CAP_RATCHET_TOLERANCE,
	metricOf: (entry) => entry.cyclomatic,
	selectAnalyzer,
	capFor: maxCyclomaticFor,
	onAnalyzerUnavailable: warnAnalyzerUnavailable,
	limitPhrase: "cyclomatic limit",
	unitPlural: "branch(es)",
	unitAdj: "branch",
	advice: "Decompose: extract cohesive branches into smaller named functions, then retry.",
};

/**
 * Block a Write/Edit/MultiEdit/apply_patch that introduces or worsens an
 * over-cap function. Returns null (allow) for non-JS/TS, exempt files, missing
 * AST support, or when the edit only holds/reduces complexity.
 */
export function checkFunctionComplexityWrite(
	toolInput: JsonObject,
	cwd: string,
	observe?: ComplexityObserver,
): ComplexityWriteBlock | null {
	return checkPerFunctionMetricWrite(CYCLOMATIC_SPEC, toolInput, cwd, observe);
}
