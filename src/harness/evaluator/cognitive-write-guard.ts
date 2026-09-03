// ===========================================
// Cognitive write warning (legacy, kept for its own tests) + the promoted
// BLOCKING gate below
// ===========================================
// `cognitiveWriteWarning` below is the original warn-only signal (delta
// semantics: warn when an edit GROWS a function past the cognitive cap, or
// lands a new function already over it — never on hold/shrink). It is no
// longer wired into the PreToolUse pipeline (see pre-tool-phases.ts, which now
// calls `checkCognitiveComplexityWrite` instead) but stays exported and
// covered by cognitive-write-guard.test.ts as a standalone unit.
//
// `checkCognitiveComplexityWrite` (bottom half of this file) is the promoted
// gate. It used to be a hand-mirrored copy of `checkFunctionComplexityWrite`
// (complexity-write-guard.ts); both are now instantiations of ONE shared engine
// (`per-function-metric-gate.ts`), so the two per-function metric gates cannot
// disagree about what "this edit" changed or how a violation is judged. What
// stays cognitive-specific is exactly the spec below: the analyzer (JS/TS only —
// there is no Python cognitive counter), the cap resolver, the looser per-edit
// slew tolerance, and the flatten-not-extract advice.
//
// PERF-DEBT: this parses both sides itself (2 parses) on top of the cyclomatic
// gate's and the pulse profiles' parses. Consolidating all per-edit AST work
// into one shared parse pass is tracked in scratch/CAMPAIGN.md.

import { readFileSync } from "node:fs";
import type { JsonObject } from "../../lib/json-types.js";
import { type CognitiveComplexityEntry, computeCognitiveAst } from "../checks/cognitive-ast.js";
import { cognitivePlanToMessage, planCognitiveFlattening } from "../cognitive-plan.js";
import { makeGrandfatherResolver } from "../function-complexity-baseline.js";
import { maxCognitiveFor, metricDef } from "../metric-caps.js";
import { checkPerFunctionMetricWrite, type MetricGateSpec } from "./per-function-metric-gate.js";

const ANON_FN = "(callback)";
const JS_TS_RE = /\.[cm]?[jt]sx?$/i;

/** name → max cognitive among same-named functions (anonymous skipped). */
function maxByName(entries: readonly CognitiveComplexityEntry[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const e of entries) {
		if (e.name === ANON_FN) continue;
		m.set(e.name, Math.max(m.get(e.name) ?? 0, e.cognitive));
	}
	return m;
}

/**
 * The warning for one projected write, or null. `absPath` is read for the
 * before-state (at PreToolUse the disk IS the before); a missing file means
 * every function is new.
 */
export function cognitiveWriteWarning(
	absPath: string,
	afterContent: string,
	cwd: string,
): string | null {
	if (!JS_TS_RE.test(absPath)) return null;
	const afterEntries = computeCognitiveAst(afterContent, absPath);
	if (!afterEntries) return null; // typescript unavailable — metric off

	const cap = maxCognitiveFor(cwd);
	let beforeMap = new Map<string, number>();
	try {
		const beforeEntries = computeCognitiveAst(readFileSync(absPath, "utf-8"), absPath);
		if (beforeEntries) beforeMap = maxByName(beforeEntries);
	} catch {
		beforeMap = new Map(); // unreadable/absent file ⇒ every function is new
	}

	const offenders: string[] = [];
	for (const [name, cog] of maxByName(afterEntries)) {
		if (cog <= cap) continue;
		const prior = beforeMap.get(name);
		if (prior === undefined) offenders.push(`${name}=${cog} (new)`);
		else if (cog > prior) offenders.push(`${name} ${prior}→${cog}`);
	}
	if (offenders.length === 0) return null;

	return (
		`[interlinked:cognitive] grew past cap ${cap} this edit: ${offenders.join(", ")}. ` +
		metricDef("cognitive").fixHint
	);
}

// ===========================================
// PreToolUse gate — per-function cognitive complexity cap (BLOCKING)
// ===========================================
// Promoted 2026-08-01: cognitive p99 across 9468 functions measured 26 against
// the shipped cap of 30 — the cap sits just above the 99th percentile, exactly
// where a backstop belongs — and the 51 over-cap functions are overwhelmingly
// the SAME functions the (already-blocking) cyclomatic gate flags. That answers
// the FP-calibration hedge this warn-only comment used to cite.

interface CognitiveWriteBlock {
	block: string;
}

/**
 * Per-edit sub-cap SLEW tolerance for cognitive complexity — the cognitive
 * analog of `SUB_CAP_RATCHET_TOLERANCE` (cyclomatic, = 2). Deliberately set
 * HIGHER than the cyclomatic tolerance rather than copied verbatim: cognitive
 * increments are nesting-weighted, so the same single-edit structural change
 * (e.g. one more branch added a level deeper) costs more cognitive than
 * cyclomatic — the spec's own oracle example puts a 3-deep nested `if` at
 * cyclomatic 4 but cognitive 6 (docs/design/history-relational-metrics.md
 * §"3-deep nested if"), roughly 1.5x at shallow nesting and worse as nesting
 * grows. A tolerance of 2 (cyclomatic's value) would false-block routine
 * single-branch edits inside already-nested code; doubling it to 4 keeps
 * "roughly one added branch's worth of nesting-weighted cost" as the
 * per-edit allowance while still catching a genuinely large one-edit jump
 * (e.g. wrapping a block in two new nesting levels at once). The hard cap
 * (`maxCognitiveFor`) is unchanged and remains the END-STATE backstop — a
 * within-tolerance rise that crosses the cap is still caught by the over-cap
 * path, not this one.
 */
export const SUB_CAP_COGNITIVE_RATCHET_TOLERANCE = 4;

/**
 * The cognitive instantiation of the shared per-function metric gate.
 *
 * JS/TS ONLY: `selectAnalyzer` returns null for every other extension, which is
 * how the engine skips them — there is no Python cognitive counter to dispatch
 * to (the cyclomatic spec routes `.py` to radon). No observer and no
 * loud-degrade callback either: the cognitive metric has no pulse telemetry, and
 * the only analyzer it can lose is `typescript`, whose absence is already
 * announced at daemon startup.
 *
 * The over-cap decision is the engine's hybrid of identity-based and
 * identity-free comparison, which was PORTED FROM this gate to the cyclomatic
 * one (2026-08-04) before the two were merged: uniquely-named entries compare
 * against their own prior value, ambiguous (anonymous / collision-named) ones
 * pool by rank. That split is what catches a decomposition that relocates
 * excess nesting into a newly-named, still-over-cap helper — complexity
 * relocated is not complexity removed.
 *
 * The advice is deliberately DIFFERENT from the cyclomatic block: cognitive
 * complexity responds to FLATTENING (guard clauses / early returns, extracting
 * the deepest-nested block), not "extract a branch" — a branch pulled out
 * unflattened just moves the same nesting cost into a helper (see the
 * relocation test in cognitive-write-guard.block.test.ts).
 *
 * `grandfatherFor` plugs in the per-function grandfather ledger's cognitive
 * section (`interlinked caps ratchet cognitive --to <n>`) — same contract as
 * the cyclomatic spec: listed functions may hold/shrink at their recorded
 * value, unlisted over-cap functions block, no ledger ⇒ legacy delta.
 */
const COGNITIVE_SPEC: MetricGateSpec<CognitiveComplexityEntry> = {
	label: "cognitive",
	anonName: ANON_FN,
	slewTolerance: SUB_CAP_COGNITIVE_RATCHET_TOLERANCE,
	metricOf: (entry) => entry.cognitive,
	selectAnalyzer: (filePath) =>
		JS_TS_RE.test(filePath) ? { compute: computeCognitiveAst, language: "js_ts" } : null,
	capFor: maxCognitiveFor,
	grandfatherFor: makeGrandfatherResolver("cognitive", ANON_FN),
	limitPhrase: "cognitive-complexity limit",
	unitPlural: "point(s)",
	unitAdj: "point",
	advice:
		"Flatten: replace nested if/else with guard clauses (early return), or extract the " +
		"deepest-nested block into its own named function — extracting it as-is without " +
		"flattening only relocates the nesting cost, it doesn't remove it.",
	planFor: cognitiveFlatteningHint,
};

/** The fewest flattening moves that bring `fnName` under `cap`, rendered as one
 *  sentence for the `↳ plan:` sub-line (null = nothing to say). The cyclomatic
 *  gate's twin is `decompositionPlanHint` in complexity-write-guard.ts. */
function cognitiveFlatteningHint(
	after: string,
	filePath: string,
	fnName: string,
	cap: number,
): string | null {
	const plan = planCognitiveFlattening(after, filePath, fnName, cap);
	return plan ? cognitivePlanToMessage(plan) : null;
}

/**
 * Block a Write/Edit/MultiEdit/apply_patch that introduces or worsens an
 * over-cap function's cognitive complexity. Returns null (allow) for
 * non-JS/TS, exempt files, missing AST support, or when the edit only
 * holds/reduces cognitive complexity. Same delta-semantics contract as
 * `checkFunctionComplexityWrite` (complexity-write-guard.ts): the on-disk
 * before-state is the ratchet baseline, so a pre-existing over-cap function
 * that is merely held or shrunk never blocks — only NEW over-cap functions or
 * a RAISE past the cap does.
 */
export function checkCognitiveComplexityWrite(
	toolInput: JsonObject,
	cwd: string,
): CognitiveWriteBlock | null {
	return checkPerFunctionMetricWrite(COGNITIVE_SPEC, toolInput, cwd);
}
