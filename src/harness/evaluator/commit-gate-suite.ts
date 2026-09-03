// interlinked-tdd: exempt
// ===========================================
// Commit gate — injectable deps + suite run/scan engine
// ===========================================
// The orchestration substrate of the commit gate, extracted from
// `commit-gate.ts`. Holds the injectable-seam interface (`CommitGateDeps`), the
// resolved-context shapes (`GateContext` / `SuiteOutcome`), and the engine that
// runs the FULL suite once per changed-source language and scans each changed
// file. The entry (`commit-gate.ts`) builds a `GateContext` and calls
// `runSuiteAndScan`. Imports the decision/scan helpers from
// `commit-gate-decision.ts`; never imports back from `commit-gate.ts`.

import { isAbsolute, resolve } from "node:path";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CoverageLanguage, CoverageRunner } from "../coverage-runner.js";
import { maxCyclomaticFor } from "../metric-caps.js";
import type { HarnessDecision } from "../types.js";
import type { GitChangedFilesFn } from "./commit-gate-changes.js";
import {
	blockForViolations,
	type CyclomaticAnalyzer,
	decideRedBar,
	failingTestPhrase,
	loudDegrade,
	scanFile,
} from "./commit-gate-decision.js";
import type { ChangedSource, Violation } from "./commit-gate-scan.js";
import type { StagedSnapshot } from "./staged-snapshot.js";

/** Injectable seams so unit tests run with NO real suite / git / analyzer. */
export interface CommitGateDeps {
	/** Resolve a CoverageRunner for a language (default: the real factory). */
	runnerFor: (language: CoverageLanguage) => CoverageRunner | null;
	/** List changed source files vs HEAD (default: the real `git diff`). */
	gitChangedFiles: GitChangedFilesFn;
	/** The per-function cyclomatic analyzer for a language (default: TS AST / radon). */
	cyclomaticFor: (language: CoverageLanguage) => CyclomaticAnalyzer | null;
	/** Wall clock — injected for deterministic timestamps in tests. */
	clock: () => number;
	/** Read a file's current content from disk (default: `fs.readFileSync`). */
	readFile: (absPath: string) => string | null;
	/** Discharge a file's deferred coverage obligation on a clean pass (finding 12;
	 *  default: the real ledger append). Optional: tests that don't assert discharge
	 *  omit it and the discharge is a no-op. */
	recordDischarge?: (projectRoot: string, file: string, sessionId: string, timestamp: string) => void;
	/** Resolve a directory to its git repository TOPLEVEL (finding 2026-06: git emits
	 *  toplevel-relative paths, so a `cd src && git commit -a` must anchor at the
	 *  toplevel, not the subdirectory). Optional: when absent (or it returns null)
	 *  the gate uses the command's cwd — exactly the pre-fix behavior. Default: the
	 *  real `git rev-parse --show-toplevel`. */
	resolveRepoRoot?: (dir: string) => string | null;
	/**
	 * Materialize the would-be-committed tree so the gate evaluates the commit, not
	 * the raw working tree (finding 3). `includeTrackedWorktree` is true for `-a`
	 * (index + tracked worktree mods, still NO untracked files), false for a plain
	 * commit (the index only). `constructedPaths` (a NARROW `git add p && git
	 * commit` / `git commit p`) overlays ONLY those paths' worktree state onto the
	 * index — the actual snapshot such a command produces (finding 2026-06: the raw
	 * worktree let an untracked test mask the staged source's missing coverage).
	 * `trackedOnlyPaths` (⊆ constructedPaths) overlay TRACKED files only — a
	 * pathspec commit (`git commit -- src`) never includes untracked files, so
	 * copying them let an absent-from-the-commit test supply coverage (round 4).
	 * Optional: when absent (or it returns null) the gate falls back to the working
	 * tree. Default: the real `git checkout-index` materializer.
	 */
	materializeIndexSnapshot?: (
		projectRoot: string,
		includeTrackedWorktree?: boolean,
		constructedPaths?: string[],
		trackedOnlyPaths?: string[],
		baseTree?: "index" | "head",
	) => StagedSnapshot | null;
}

/**
 * Generous per-run timeout (ms) for the commit-time suite. Commit time is allowed
 * to run the full suite (no per-edit budget), so this is far above the per-edit
 * `DEFAULT_RUN_TIMEOUT_MS` — a large suite must have room to finish.
 */
export const COMMIT_RUN_TIMEOUT_MS = 600_000;

// ===========================================
// Suite run + scan
// ===========================================

/** Resolved, validated inputs for the suite run + scan. */
export interface GateContext {
	projectRoot: string;
	sources: ChangedSource[];
	/** Languages the suite runs for — every scanned source's language PLUS every
	 *  gated-language DELETION's language, so a delete-only commit still runs the
	 *  red-bar suite (finding 2026-06: it skipped enforcement entirely). */
	suiteLanguages: CoverageLanguage[];
	crapThreshold: number;
	/** `per_edit_coverage.block_on_test_failure` — a RED suite blocks only when
	 *  true; off, the red bar is surfaced as a warning and the scan proceeds
	 *  (finding 2026-06: the commit gate blocked red unconditionally, making the
	 *  documented opt-out ineffective exactly when per-edit checks defer here). */
	blockOnTestFailure: boolean;
	/** `per_edit_coverage.block_on_crap` — CRAP violations count only when true. */
	blockOnCrap: boolean;
	/** Gated-language paths DELETED by this commit. A clean green pass discharges
	 *  THEIR deferred obligations too: a budget-deferred delete-only edit records
	 *  an obligation for the deleted path, and no future coverage report can ever
	 *  contain a deleted file — without this the Stop warning stayed open forever
	 *  even after the gate verified the deletion (finding 2026-06). */
	deletedPaths: string[];
	warnings: string[];
	/** The REAL repo root (where the obligation ledger lives), session id, and event
	 *  timestamp — used to DISCHARGE deferred coverage obligations on a clean pass so
	 *  the Stop check stops warning "never enforced" (finding 12). Absent ⇒ no discharge. */
	ledgerRoot?: string;
	sessionId?: string;
	eventTs?: string;
}

/** The merged outcome of running every changed language's suite. */
interface SuiteOutcome {
	perFile: Map<string, PerFileCoverage>;
	failingTests: string[];
	anyRed: boolean;
	/** Set to a loud-degrade reason when any language's run could not be measured. */
	degradeReason: string | null;
}

/**
 * Run the full suite once per distinct changed-source language and merge the
 * per-file coverage maps. A runner that is missing or could not measure sets
 * `degradeReason` (the caller fail-opens). Red is OR-ed across languages.
 */
async function runSuites(ctx: GateContext, deps: CommitGateDeps): Promise<SuiteOutcome> {
	// Suite languages come from the SELECTION (scanned sources ∪ deletions), not
	// from `sources` alone — a delete-only commit has no scan sources yet must
	// still run its language's suite (finding 2026-06).
	const languages = ctx.suiteLanguages;
	const perFile = new Map<string, PerFileCoverage>();
	const failingTests: string[] = [];
	let anyRed = false;
	// Dedup by the runner's stable EXECUTION KEY, not by language: the Vitest runner
	// serves both `js` and `ts`, so a commit changing both must run the suite ONCE,
	// not twice against the same report dir (finding 2026-06). Falls back to the
	// language when a runner exposes no id (test stubs).
	const ranKeys = new Set<string>();

	for (const language of languages) {
		const runner = deps.runnerFor(language);
		if (!runner) {
			return { perFile, failingTests, anyRed, degradeReason: `no coverage runner for ${language}` };
		}
		const key = runner.id ?? language;
		if (ranKeys.has(key)) continue;
		ranKeys.add(key);
		const result = await runner.run({
			projectRoot: ctx.projectRoot,
			coverageDir: `${ctx.projectRoot}/.interlinked/commit-gate-coverage`,
			timeoutMs: COMMIT_RUN_TIMEOUT_MS,
		});
		if (!result.ok) {
			const why = result.error ?? `coverage run failed for ${language}`;
			return { perFile, failingTests, anyRed, degradeReason: why };
		}
		if (result.testsPassed === false) {
			anyRed = true;
			failingTests.push(...(result.failingTests ?? []));
		}
		for (const [k, v] of result.perFile) perFile.set(k, v);
	}
	return { perFile, failingTests, anyRed, degradeReason: null };
}

/** Scan every changed source for violations against the merged coverage map. */
function collectViolations(
	ctx: GateContext,
	perFile: Map<string, PerFileCoverage>,
	deps: CommitGateDeps,
): Violation[] {
	const violations: Violation[] = [];
	// EFFECTIVE per-repo cyclomatic cap (metric-caps.json override → shipped
	// default). Resolve against the REAL repo root, NOT `ctx.projectRoot` (which
	// may be a materialized index snapshot whose tree omits `.interlinked/`):
	// `ctx.ledgerRoot` is the real root the gate sets for the obligation ledger,
	// and the cap policy lives beside it. Threading this is what makes a repo's
	// `interlinked caps set cyclomatic` cap honored at commit time, not just
	// per-edit (finding 2026-06, round 8). Cheap — metric-caps is mtime-cached.
	const cyclomaticCap = maxCyclomaticFor(ctx.ledgerRoot ?? ctx.projectRoot);
	for (const source of ctx.sources) {
		const abs = isAbsolute(source.relPath)
			? source.relPath
			: resolve(ctx.projectRoot, source.relPath);
		const content = deps.readFile(abs);
		if (content === null) continue; // raced deletion — skip
		violations.push(
			...scanFile({
				source,
				cov: perFile.get(source.relPath),
				content,
				analyzer: deps.cyclomaticFor(source.language),
				crapThreshold: ctx.crapThreshold,
				blockOnCrap: ctx.blockOnCrap,
				cyclomaticCap,
			}),
		);
	}
	return violations;
}

/**
 * Decide the RED bar for a finished suite run: a block decision when the suite is
 * red and `block_on_test_failure` is on (baseline-aware — pre-existing red recorded
 * at adopt time does not block wholesale; only NEW failures do), otherwise null so
 * the scan proceeds. With the flag off the red bar is SURFACED as a warning and the
 * scan runs on the red run's coverage — under-reporting can only ADD violations,
 * never hide one (finding 2026-06: the commit gate blocked red unconditionally).
 */
function decideRedBarOrWarn(ctx: GateContext, outcome: SuiteOutcome): HarnessDecision | null {
	if (!outcome.anyRed) return null;
	if (!ctx.blockOnTestFailure) {
		ctx.warnings.push(
			"[interlinked:commit-gate] NOTE: the full suite is RED " +
				`(${failingTestPhrase(outcome.failingTests)}) but block_on_test_failure is off — ` +
				"not blocking on the red bar.",
		);
		return null;
	}
	// The baseline lives under the REAL repo root's `.interlinked/` (`ledgerRoot`),
	// never a materialized snapshot that omits it.
	return decideRedBar(outcome.failingTests, ctx.warnings, ctx.ledgerRoot ?? ctx.projectRoot);
}

/**
 * Run the FULL suite under coverage for the languages spanned by the changed
 * sources, then scan each changed file for violations. Returns a block decision
 * or null (allow). Split out of `checkCommitGate` so the entry stays
 * low-complexity. Throwing is contained by the entry's try/catch (loud-degrade).
 */
export async function runSuiteAndScan(
	ctx: GateContext,
	deps: CommitGateDeps,
): Promise<HarnessDecision | null> {
	const outcome = await runSuites(ctx, deps);
	if (outcome.degradeReason !== null) return loudDegrade(outcome.degradeReason);

	// Red bar first — a failing suite is a harder failure than a coverage gap.
	// Only when opted in (`block_on_test_failure`, the same flag the per-edit gate
	// honors). With the flag off the scan proceeds on the red run's coverage while
	// the clean-pass discharge below is withheld.
	const redDecision = decideRedBarOrWarn(ctx, outcome);
	if (redDecision) return redDecision;

	const violations = collectViolations(ctx, outcome.perFile, deps);
	if (violations.length > 0) return blockForViolations(violations, ctx.warnings);

	// CLEAN: the suite RAN (not degraded), came back GREEN, and every gated source
	// PASSED → discharge each source's deferred coverage obligation so the Stop
	// check stops warning "never enforced" (finding 12). Only reached on a measured
	// pass — never a degrade, and never the red-suite-with-flag-off path above
	// (an obligation must not be discharged by a red bar). DELETED paths discharge
	// too: their obligations name files no future coverage report can ever contain,
	// and the green suite IS the verification of the deletion — without this the
	// Stop warning stayed open permanently (finding 2026-06).
	if (!outcome.anyRed && ctx.ledgerRoot && ctx.sessionId && deps.recordDischarge) {
		const ts = ctx.eventTs ?? new Date().toISOString();
		for (const file of [...ctx.sources.map((s) => s.relPath), ...ctx.deletedPaths]) {
			deps.recordDischarge(ctx.ledgerRoot, file, ctx.sessionId, ts);
		}
	}

	// Clean tree → allow. Carry any accumulated warnings (e.g. the `--no-verify`
	// note) so the bypass attempt stays visible; otherwise a clean no-op (null).
	return ctx.warnings.length > 0 ? { decision: "allow", warnings: ctx.warnings } : null;
}
