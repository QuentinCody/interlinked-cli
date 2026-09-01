// ===========================================
// PreToolUse gate — per-edit coverage block (apply-before-disk overlay)
// ===========================================
// Component 3 of docs/design/per-edit-coverage-enforcement.md. On a code-file
// Write/Edit/MultiEdit, this applies the PROPOSED content to an apply-before-disk
// overlay (rooted UNDER projectRoot — see coverage-overlay.ts for why never
// os.tmpdir), runs the project's FULL suite under coverage there via a
// CoverageRunner, and BLOCKS the edit (strict TDD) if it adds an uncovered
// executable line or drops the file's coverage below its prior baseline.
//
// Red bar (per-edit TDD), opt-in via `per_edit_coverage.block_on_test_failure`:
// the same overlay run also yields `testsPassed` (from the suite's exit code). A
// FAILING suite is a harder failure than a coverage gap, so when that flag is on
// AND the run came back RED (`testsPassed === false`) the edit is blocked BEFORE
// the coverage decision, naming the failing test(s). `testsPassed === null`
// (runner unavailable / errored) fail-opens, exactly like a failed coverage
// measurement — a red bar can only ever fire from a clean, definitive red run.
//
// Three safety properties make this safe to ship:
//   1. CONFIG-GATED (DEFAULT ON — see `rules/default-config.ts`). Runs only when
//      `rules.per_edit_coverage.enabled` AND `mode === "block"`. A repo that opts
//      OUT returns at the first gate before any suite run — zero cost. On a big
//      suite (THIS repo, ~16k tests) the budget gate (property 2) routes
//      enforcement to commit time, so the per-edit overlay rarely runs HERE — but
//      it is live by default on fast-suite repos.
//   2. BUDGET-GATED. If the rolling suite-runtime estimate is at/above
//      `budget_ms`, the suite is NOT run per-edit; a deferred obligation is
//      recorded (commit-time enforcement is a later step) and the edit allowed.
//   3. FAIL-OPEN. Any runner/overlay error loud-degrades (stderr warn, allow) —
//      coverage enforcement must never crash the harness or false-block on its
//      own failure. A no-override block has no relief valve, so it fires only
//      from a clean, successful coverage measurement.
//
// Every dependency (CoverageRunner factory, overlay factory, clock) is injected
// via `CoverageWriteDeps` so the unit tests stub them and NO real suite runs.

import {
	readRuntimeEstimateMs,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "../coverage-obligation-ledger.js";
import {
	type CreateCoverageOverlayFn,
	createCoverageOverlay,
	type OverlayFile,
} from "../coverage-overlay.js";
import {
	type CoverageLanguage,
	type CoverageRunner,
	coverageRunnerFor,
} from "../coverage-runner.js";
import { routeBySelection, type SelectionRoute } from "../coverage-test-selector.js";
import type { DependencyView } from "../dependency-view.js";
import { crapThresholdFor } from "../metric-caps.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import {
	type CrapInput,
	type CyclomaticAnalyzer,
	DEFAULT_CRAP_THRESHOLD,
	decideCrap,
	defaultCyclomaticFor,
} from "./coverage-crap-decision.js";
import { type CoverageTarget, coverageEditPlan } from "./coverage-edit-targets.js";
import { isFileWrite } from "./tool-classifiers.js";

// Re-exported so this module's public surface is unchanged for existing importers.
export type { CyclomaticAnalyzer } from "./coverage-crap-decision.js";

/** Injectable seams so unit tests run with NO real suite / overlay / analyzer. */
export interface CoverageWriteDeps {
	/** Resolve a CoverageRunner for a language (default: the real factory). */
	runnerFor: (language: CoverageLanguage) => CoverageRunner | null;
	/** Build an apply-before-disk overlay (default: the real file-tree mirror). */
	createOverlay: CreateCoverageOverlayFn;
	/** Wall clock — injected for deterministic estimate timestamps in tests. */
	clock: () => number;
	/**
	 * The per-function cyclomatic analyzer for a language, or null to skip CRAP for
	 * it. Default: `defaultCyclomaticFor` (coverage-crap-decision.ts) — the same
	 * analyzers the strict cyclomatic PreToolUse gate uses. Injected so the CRAP
	 * tests supply a deterministic stub instead of spawning radon / loading TS.
	 */
	cyclomaticFor: (language: CoverageLanguage) => CyclomaticAnalyzer | null;
}

/** Production defaults — the real runner factory, overlay mirror, clock, analyzer. */
const DEFAULT_DEPS: CoverageWriteDeps = {
	runnerFor: (language) => coverageRunnerFor(language),
	createOverlay: createCoverageOverlay,
	clock: Date.now,
	cyclomaticFor: defaultCyclomaticFor,
};

// The uncovered-added-line / coverage-drop / red-bar DECISION helpers live in
// ./coverage-write-decision.ts — extracted verbatim (finding 2026-06).
import { coverageScopeId, formatScopeReanchorWarning } from "./coverage-scope.js";
import {
	blockForRedBar,
	type CoverageDecisionOut,
	decideFromCoverage,
} from "./coverage-write-decision.js";

// EVIDENCE-AUTHORITY CONTRACT (finding 2): there is deliberately NO
// `blockForUntestedSource`. An empty affected-test selection (`[]`) means only
// that no test STATICALLY imports the file — not that it is uncovered. The static
// reverse-import graph may SELECT which tests to run, but its silence may never
// PROVE absence of coverage: an integration test routinely exercises a CLI entry
// point, an HTTP route, a plugin, or a dynamically-imported module without
// importing its source. So `[]` routes to a MEASURED full-suite run
// (`routeBySelection`), and a block can only come from the real coverage decision
// over the lines the suite actually executed — never from the graph alone.

// CRAP (Change Risk Anti-Patterns) — the 4th per-edit block — lives in
// `coverage-crap-decision.ts` (`decideCrap`), extracted to keep this module under
// the per-file line cap. It runs AFTER the uncovered-added-line / drop decision: a
// flat coverage gap is the more basic failure; CRAP is the "complex AND
// under-covered" escalation. Computed from the SAME overlay coverage run (no
// second suite spawn). The uncovered-line / drop / red-bar decision itself lives
// in `coverage-write-decision.ts` (same extraction, finding 2026-06).

import {
	deferForBudget,
	loudDegrade,
	loudRunnerUnavailable,
	profileRunnerFastPath,
} from "./coverage-write-guard-degrade.js";
import {
	decideForDeletionOnly,
	decideForResidualLanguages,
} from "./coverage-write-guard-redbar.js";

interface GateContext {
	projectRoot: string;
	relPath: string;
	proposed: string;
	language: CoverageLanguage;
	editedLines: Set<number> | undefined;
	/** Sibling apply_patch sections (the patch's test + other touched files) written
	 *  into the SAME overlay alongside `proposed`, so a code+test patch's suite runs
	 *  against the whole atomic patch (finding 2026-06). Empty for a single-file edit. */
	overlayFiles?: OverlayFile[];
	budgetMs: number;
	/**
	 * Affected-test subset (repo-relative paths) the overlay run is scoped to.
	 * Non-empty ⇒ the fast per-edit path (only these tests run, no budget defer).
	 * Empty/undefined ⇒ the full suite runs (the budget gate already decided it
	 * fits). Forwarded to the runner as {@link CoverageRunOpts.selectedTests}.
	 */
	selectedTests?: string[];
	/**
	 * When true (`per_edit_coverage.block_on_test_failure`), an overlay run that
	 * leaves the suite RED (`testsPassed === false`) blocks the edit before the
	 * coverage decision. Default-absent ⇒ falsy ⇒ coverage-only behavior.
	 */
	blockOnTestFailure?: boolean;
	/**
	 * When true (`per_edit_coverage.block_on_crap`), a function the edit ADDED or
	 * TOUCHED whose CRAP score reaches {@link crapThreshold} blocks the edit AFTER
	 * the coverage decision. Default-absent ⇒ falsy ⇒ coverage-only behavior.
	 */
	blockOnCrap?: boolean;
	/** CRAP score at/above which a touched function blocks. Absent ⇒ {@link DEFAULT_CRAP_THRESHOLD}. */
	crapThreshold?: number;
	/** `per_edit_coverage.drop_epsilon` — tolerance for the %-drop backstop.
	 *  Absent ⇒ the shipped COVERAGE_DROP_EPSILON (0.005). Class-2 knob,
	 *  plan 25: an engine budget users may tune, not a quality bar. */
	dropEpsilon?: number;
	/**
	 * STAGE a passing target's new coverage baseline instead of persisting it
	 * in-loop. The entry flushes staged baselines only after the ENTIRE event
	 * resolves to allow — a mid-loop persist let an early target's baseline land
	 * while a later target blocked the whole atomic patch, leaving the baseline
	 * describing content that never existed (finding 2026-06). Absent ⇒ the
	 * baseline for this run is simply not recorded.
	 */
	recordBaseline?: (relPath: string, fraction: number, scope?: string) => void;
}

/**
 * Build the overlay, run the suite under coverage, update the estimate, and
 * decide. Split out of `checkCoverageWrite` so the entry stays low-complexity.
 * Throwing is contained by the entry's try/catch (loud-degrade).
 */
async function runOverlayAndDecide(
	ctx: GateContext,
	event: HarnessEvent,
	deps: CoverageWriteDeps,
): Promise<HarnessDecision | null> {
	const runner = deps.runnerFor(ctx.language);
	// Gate is ON for this language but no runner could be built → fail LOUD
	// (missing provider?), never silent — once per daemon for this repo+language
	// (runner absence is a stable repo property). Allow (can't-measure ≠ deny).
	if (!runner) {
		return loudRunnerUnavailable(ctx, `no coverage runner for ${ctx.language}`);
	}

	const overlay = deps.createOverlay(ctx.projectRoot, ctx.relPath, ctx.proposed, ctx.overlayFiles);
	try {
		const runOpts: { projectRoot: string; coverageDir: string; selectedTests?: string[]; timeoutMs: number } = {
			projectRoot: overlay.overlayRoot,
			coverageDir: `${overlay.overlayRoot}/.interlinked/coverage`,
			timeoutMs: ctx.budgetMs, // per-edit BUDGET, not the 120s suite default → an over-budget run defers (below), never hangs the daemon 2min
		};
		if (ctx.selectedTests && ctx.selectedTests.length > 0) {
			runOpts.selectedTests = ctx.selectedTests;
		}
		const result = await runner.run(runOpts);
		// Budget estimate from FULL runs ONLY: a scoped subset's runtime isn't the full-suite cost the gate keys on; blending it erodes the estimate below budget → the next full route re-runs the whole suite + times out (the big-monorepo starvation).
		if (runOpts.selectedTests === undefined) {
			updateRuntimeEstimateMs(ctx.projectRoot, result.suiteMs, deps.clock);
		}
		// `ok:false` means the runner produced no parseable coverage — the most
		// common real cause is a missing provider. Fail LOUD, not silent.
		if (!result.ok) {
			// Over-budget (suiteMs >= budgetMs): the run was killed at the per-edit
			// timeout (timeoutMs === budgetMs) before finishing - the wide-fan-in
			// SCOPED case (a correct but too-slow affected-test set). Failing open here
			// would let an edit that breaks a slow affected test through (caught only at
			// pre-push); record a commit-time obligation instead, exactly like the full
			// route's up-front budget defer, so the commit gate runs the affected tests
			// before the change can be pushed. A FAST failure (suiteMs < budgetMs) is a
			// real launch/parse failure (missing provider, ENOENT) - nothing to defer.
			if (result.suiteMs >= ctx.budgetMs) {
				return deferForBudget(ctx.projectRoot, ctx.relPath, event, result.suiteMs, ctx.budgetMs);
			}
			return loudRunnerUnavailable(ctx, result.error ?? "coverage run failed");
		}

		// Red bar before coverage: a FAILING suite is a harder failure than a
		// coverage gap. Only when opted in (block_on_test_failure) AND the suite
		// definitively came back red (testsPassed === false). `null` (couldn't
		// determine) falls through to the coverage decision — fail-open on the
		// pass/fail axis, exactly like the coverage block's runner-unavailable path.
		if (ctx.blockOnTestFailure && result.testsPassed === false) {
			return blockForRedBar(ctx.relPath, result.failingTests, result.failingTestFiles);
		}

		const cov = result.perFile.get(ctx.relPath);
		if (!cov) {
			return loudDegrade(ctx.relPath, "edited file absent from coverage report");
		}
		// Coverage decision first (uncovered-added-line / drop). A block here is the
		// more basic failure; CRAP is the "complex AND under-covered" escalation.
		// The scope id (which affected-test set measured `cov`) makes the drop
		// ratchet compare like-with-like: a baseline earned under a different scope
		// re-anchors instead of false-blocking (coverage-scope.ts).
		const scopeId = coverageScopeId(ctx.selectedTests);
		const covOut: CoverageDecisionOut = {};
		const coverageDecision = decideFromCoverage(
			ctx.projectRoot,
			ctx.relPath,
			cov,
			ctx.editedLines,
			covOut,
			scopeId,
			ctx.dropEpsilon,
		);
		if (coverageDecision) return coverageDecision;

		// Coverage allowed → the 4th per-edit gate. Only when opted in (block_on_crap);
		// uses the SAME overlay coverage just computed. It runs BEFORE the baseline is
		// persisted, so a CRAP block never poisons it with rejected content (finding 8).
		if (ctx.blockOnCrap) {
			const crapInput: CrapInput = {
				relPath: ctx.relPath,
				proposed: ctx.proposed,
				cov,
				editedLines: ctx.editedLines,
				threshold: ctx.crapThreshold ?? DEFAULT_CRAP_THRESHOLD,
				analyzer: deps.cyclomaticFor(ctx.language),
			};
			const crapDecision = decideCrap(crapInput, loudDegrade);
			if (crapDecision) return crapDecision;
		}

		// EVERY per-target gate passed → STAGE the new baseline (never persist
		// in-loop: a later target or residual-language run can still block the whole
		// atomic patch — finding 2026-06; see GateContext.recordBaseline).
		if (covOut.now !== undefined) {
			ctx.recordBaseline?.(ctx.relPath, covOut.now, scopeId);
		}
		// A cross-scope re-anchor is a loud ALLOW: the recorded high-water was
		// measured under a different affected-test set, so the gate reseeded at
		// today's measurement rather than blocking. Surface it — the commit-time
		// full-suite gate still holds the real line.
		if (covOut.scopeChanged) {
			return {
				decision: "allow",
				warnings: [
					formatScopeReanchorWarning(
						ctx.relPath,
						covOut.scopeChanged.priorFraction,
						covOut.now ?? 0,
						scopeId,
					),
				],
			};
		}
		return null;
	} finally {
		overlay.cleanup();
	}
}

/**
 * Outcome of affected-test selection, routing the rest of the gate:
 *   - `scoped` — a non-empty affected-test subset: run ONLY those (fast → fits
 *                the per-edit budget → skip the budget defer).
 *   - `full`   — selection unavailable (no depView / `null` / `[]`): run the full
 *                suite + budget gate. An empty selection is MEASURED, never
 *                blocked (evidence-authority contract — see routeBySelection).
 */
/**
 * PreToolUse coverage gate. Returns a `block` HarnessDecision when the proposed
 * edit (a) leaves the suite RED — only when `block_on_test_failure` is on, the
 * red-bar check, which precedes coverage — (b) adds an uncovered line / drops the
 * file's coverage, or (c) leaves a TOUCHED function with a CRAP score ≥ the
 * threshold — only when `block_on_crap` is on, the CRAP check, which FOLLOWS the
 * coverage decision; otherwise null (allow). All three are computed from ONE
 * overlay suite run. A pure no-op — runner never invoked — when disabled, in warn
 * mode, or for a non-code / unsupported-language / test / non-cappable file. Never
 * throws (fail-open).
 *
 * AFFECTED-TEST SELECTION (the keystone that makes this AFFORDABLE on a slow,
 * multi-language suite): when `depView` is supplied, the gate first walks the
 * reverse import graph to find only the tests transitively affected by the edit:
 *   - a NON-EMPTY subset → the overlay runs ONLY those tests (fast → fits the
 *     per-edit budget → enforced in-band, no defer);
 *   - `[]` (file in the graph, but no test statically imports it), `null` (file
 *     not in the graph), or no `depView` → the FULL suite + budget gate. A static
 *     graph may select tests but may never prove absence of coverage (integration
 *     tests exercise code they don't import), so an empty selection is MEASURED,
 *     never blocked.
 */
export async function checkCoverageWrite(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	deps: CoverageWriteDeps = DEFAULT_DEPS,
	depView?: DependencyView,
): Promise<HarnessDecision | null> {
	const cfg = rules.per_edit_coverage;
	if (!cfg?.enabled || cfg.mode !== "block") return null;
	if (!isFileWrite(event.tool_name)) return null;

	const projectRoot = event.cwd || process.cwd();
	// EARLY repo-profile fast-path (foreign-shaped repos): when the edited file's
	// language is gated but the detected repo profile has NO supported runner for
	// it, every overlay run could only end in the runner-unavailable warning — so
	// skip the overlay entirely, warning ONCE per daemon (then silent allows).
	// `undefined` = no fast-path (runner detected, ungated language, or a profile
	// detection error, which yields the conservative runners-true profile) — the
	// gate proceeds byte-identically to before.
	const fastPath = profileRunnerFastPath(event, cfg, projectRoot);
	if (fastPath !== undefined) return fastPath;
	// Plan = the production files to GATE (targets) + ALL files to MATERIALIZE in the
	// overlay (the patch's tests/siblings). For an apply_patch the whole ATOMIC patch
	// is overlaid, so a code+test patch is not falsely reported uncovered (finding
	// 2026-06); the full suite is forced only when `fullSuiteReason` says the
	// sections demand it. Non-code / test / non-cappable files are not targets.
	const plan = coverageEditPlan(event, projectRoot, cfg);
	// NO coverage targets ≠ nothing to enforce: a DELETE-ONLY source patch still
	// carries deletion overlays that can break the suite — handled by its own
	// red-bar path instead of a silent skip (finding 2026-06).
	if (plan.targets.length === 0) {
		return await decideForDeletionOnly(event, cfg, deps, plan, projectRoot);
	}

	// One decision per event: the FIRST blocking file wins (short-circuit). A
	// multi-file apply_patch otherwise accumulates any allow-time warnings (e.g. a
	// per-file loud-degrade) into a single allow decision so none is lost.
	// Full-suite forcing is REASONED, not blanket-per-patch (finding 2026-06): only
	// a patch whose sections make scoping unsound (new/changed tests, deletes,
	// moves) forces the full suite; a routine source-only patch keeps the scoped
	// route instead of deferring to the commit gate whenever the full-suite
	// estimate exceeds the budget.
	const warnings: string[] = [];
	// Baselines are STAGED during the loop and persisted only after the ENTIRE
	// event resolves to allow — a mid-loop persist let an early target's baseline
	// land while a later target blocked the whole atomic patch, leaving the
	// baseline describing content that never existed and corrupting future drop
	// decisions (finding 2026-06).
	const stagedBaselines: Array<{ relPath: string; fraction: number; scope?: string }> = [];
	const recordBaseline = (relPath: string, fraction: number, scope?: string): void => {
		stagedBaselines.push(scope === undefined ? { relPath, fraction } : { relPath, fraction, scope });
	};
	for (const target of plan.targets) {
		const decision = await decideForTarget(
			{ event, cfg, deps, depView, recordBaseline },
			projectRoot,
			target,
			plan.overlayFiles,
			plan.fullSuiteReason !== null,
		);
		if (decision?.decision === "block") return decision;
		if (decision?.warnings) warnings.push(...decision.warnings);
	}
	// Gated sections in a language NO target's runner serves (a deletion, move, or
	// test file in another ecosystem) get their own red-bar run — vitest passing
	// must not ship an unrun pytest breakage (finding 2026-06).
	const residual = await decideForResidualLanguages(event, cfg, deps, plan, projectRoot);
	if (residual?.decision === "block") return residual;
	if (residual?.warnings) warnings.push(...residual.warnings);
	// EVERYTHING allowed → only now do the staged baselines become durable state.
	for (const b of stagedBaselines) {
		writeFileCoverageBaseline(projectRoot, b.relPath, b.fraction, b.scope);
	}
	return warnings.length > 0 ? { decision: "allow", warnings } : null;
}

/** Evaluate ONE coverage target, containing its own failure as a loud-degrade so
 *  a single unmeasurable file in a multi-file patch never aborts the others. */
async function decideForTarget(
	call: GateCall,
	projectRoot: string,
	target: CoverageTarget,
	overlayFiles: OverlayFile[],
	forceFullSuite: boolean,
): Promise<HarnessDecision | null> {
	try {
		return await selectRunAndDecide(call, { projectRoot, ...target, overlayFiles, forceFullSuite });
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return loudDegrade(target.relPath, why);
	}
}

/** Fixed-per-call inputs threaded into {@link selectRunAndDecide} (the parts of
 *  the event/config the routing + run need). Bundled so the helper takes two
 *  params, not seven. */
interface GateCall {
	event: HarnessEvent;
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>;
	deps: CoverageWriteDeps;
	depView: DependencyView | undefined;
	/** The entry's baseline STAGING sink (see GateContext.recordBaseline). */
	recordBaseline: (relPath: string, fraction: number, scope?: string) => void;
}

/** One resolved coverage target plus the project root — the per-call facts the
 *  routing + run need. `CoverageTarget` (path/language/content/editedLines) is
 *  produced by `coverageTargetsFor`. */
type GateTarget = CoverageTarget & {
	projectRoot: string;
	/** All files to materialize in the overlay (this write's full section set). */
	overlayFiles?: OverlayFile[];
	/** Run the FULL suite — set when the plan's `fullSuiteReason` is non-null (the
	 *  patch touches tests / deletes / moves, so a scoped subset would be unsound). */
	forceFullSuite?: boolean;
};

/**
 * Run affected-test selection, apply the budget gate (full-suite route only),
 * build the {@link GateContext}, and run the overlay decision. Extracted from
 * `checkCoverageWrite` so that entry stays under the cyclomatic cap; throwing is
 * contained by the caller's try/catch (loud-degrade).
 */
async function selectRunAndDecide(call: GateCall, target: GateTarget): Promise<HarnessDecision | null> {
	const { cfg, deps, depView, event } = call;
	const { projectRoot, relPath, language, proposed, editedLines } = target;

	// Affected-test selection FIRST: a non-empty subset runs scoped (fast); an
	// empty/unknown selection falls back to the full suite (and the budget gate).
	// There is no "block from selection" — a block must come from a measured run,
	// never the graph's silence (see routeBySelection's evidence-authority note).
	// An apply_patch forces the FULL suite only when its SECTIONS require it (test
	// sections live only in the overlay, never the on-disk graph a scoped subset is
	// drawn from; deletes/moves have dependents no per-target selection covers) —
	// see `patchFullSuiteReason`. A source-only patch routes scoped like any edit
	// (finding 2026-06: blanket forcing deferred every patch on big-suite repos).
	const route: SelectionRoute = target.forceFullSuite
		? { kind: "full" }
		: routeBySelection(relPath, projectRoot, depView, target.overlayFiles);

	if (route.kind === "full") {
		const estimate = readRuntimeEstimateMs(projectRoot);
		if (estimate !== null && estimate >= cfg.budget_ms) {
			return deferForBudget(projectRoot, relPath, event, estimate, cfg.budget_ms);
		}
	}

	const ctx: GateContext = {
		projectRoot,
		relPath,
		proposed,
		language,
		editedLines,
		budgetMs: cfg.budget_ms,
		blockOnTestFailure: cfg.block_on_test_failure === true,
		blockOnCrap: cfg.block_on_crap === true,
		crapThreshold: crapThresholdFor(projectRoot, cfg.crap_threshold),
		...(typeof cfg.drop_epsilon === "number" && cfg.drop_epsilon >= 0
			? { dropEpsilon: cfg.drop_epsilon }
			: {}),
		recordBaseline: call.recordBaseline,
		...(target.overlayFiles ? { overlayFiles: target.overlayFiles } : {}),
		...(route.kind === "scoped" ? { selectedTests: route.tests } : {}),
	};
	return runOverlayAndDecide(ctx, event, deps);
}
