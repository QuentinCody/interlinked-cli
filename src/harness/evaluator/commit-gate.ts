// ===========================================
// PreToolUse Bash gate — COMMIT-TIME quality bar
// ===========================================
// The hard gate for repos whose suite is too big for per-edit enforcement
// (`evaluator/coverage-write-guard.ts` defers to a commit-time obligation when
// the rolling suite estimate exceeds `per_edit_coverage.budget_ms`). This gate
// intercepts a real `git commit` Bash tool call at PreToolUse and BLOCKS it when
// the working tree violates the quality bar:
//
//   (a) RED bar      — the full suite came back failing (`testsPassed === false`),
//                      when `block_on_test_failure` is on (the same opt-out the
//                      per-edit gate honors).
//   (b) UNCOVERED    — any changed source file has an executable-but-uncovered
//                      line after the suite ran (strict TDD at commit boundary).
//   (c) CRAP         — any changed function's CRAP score >= `crap_threshold`
//                      (REUSED `crapScore` / `computeCrap` from `checks/crap.ts`),
//                      when `block_on_crap` is on.
//   (d) CYCLOMATIC   — any changed function's cyclomatic complexity > 25 (the
//                      hard cap; the strict per-edit gate caps lower but commit
//                      time is a coarser net — a function this branchy is a
//                      maintenance hazard regardless of coverage).
//
// Unlike `coverage-write-guard.ts` (apply-before-disk OVERLAY of the proposed
// edit), the commit gate runs against the REAL working tree — every changed file
// is already on disk, so no overlay is needed. It runs the project's FULL suite
// under coverage via the same language {@link CoverageRunner}.
//
// Safety properties (mirror the per-edit gate):
//   1. CONFIG-GATED (DEFAULT ON — see `rules/default-config.ts`). Runs only when
//      `rules.per_edit_coverage.enabled` is true AND `mode === "block"` — the
//      documented `mode: "warn"` / `block_on_test_failure: false` /
//      `block_on_crap: false` opt-outs are honored HERE exactly as at the
//      per-edit gate (finding 2026-06: only `enabled` was checked, so a repo's
//      opt-outs went ineffective precisely when per-edit checks deferred to
//      commit time). A repo that opts OUT returns at the first gate before any
//      git shell-out or suite run — zero cost. On a big suite (THIS repo) the
//      per-edit overlay defers to THIS commit gate, so it is the LIVE
//      enforcement surface here, not a dormant one.
//   2. GENEROUS TIMEOUT. Commit time is allowed to run the full suite — there is
//      NO ~25s per-edit budget here. The runner gets {@link COMMIT_RUN_TIMEOUT_MS}.
//   3. FAIL-OPEN. A runner that is unavailable / can't measure, a git-diff that
//      can't run, or any thrown error all loud-degrade (stderr warn, allow). A
//      commit must never be blocked by the gate's OWN failure — only by a clean,
//      definitive measurement.
//   4. `--no-verify` is NOTED. The agent can pass `--no-verify` to skip git's own
//      hooks; the gate still evaluates (it is not a git hook) but surfaces a
//      warning that the bypass was requested, so it is visible in the trail.
//
// Every dependency (CoverageRunner factory, git-diff fn, cyclomatic analyzer,
// clock, file reader) is INJECTED via {@link CommitGateDeps} so the unit tests
// stub them and NO real suite / git / analyzer runs. The `git commit` detection
// itself lives in the sibling `commit-parse.ts`; the changed-file selection
// (git queries, pathspec rebase, narrow filter, scan/deletion split) in
// `commit-gate-changes.ts`; the per-source violation scan + decision builders in
// `commit-gate-decision.ts`; the injectable-deps interface + suite run/scan
// engine in `commit-gate-suite.ts` (all re-exported below).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import { recordCoverageDischarge } from "../coverage-obligation-ledger.js";
import { type CoverageLanguage, coverageRunnerFor } from "../coverage-runner.js";
import { crapThresholdFor } from "../metric-caps.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import {
	changedSetForCommit,
	defaultGitChangedFiles,
	defaultResolveRepoRoot,
	type EvalMode,
	rebaseConstructedPaths,
	selectChangedSources,
} from "./commit-gate-changes.js";
import {
	type CyclomaticAnalyzer,
	degradeWithWarnings,
	noVerifyWarnings,
} from "./commit-gate-decision.js";
import { type CommitGateDeps, runSuiteAndScan } from "./commit-gate-suite.js";
import { parseGitCommit } from "./commit-parse.js";
import type { CommitParse } from "./commit-parse.js";
import { materializeIndexSnapshot } from "./staged-snapshot.js";

export { defaultGitChangedFiles, defaultResolveRepoRoot } from "./commit-gate-changes.js";
// Re-export the injectable-deps interface + commit-run timeout so existing call
// sites / tests import them from the gate module too.
export { COMMIT_RUN_TIMEOUT_MS, type CommitGateDeps } from "./commit-gate-suite.js";
// Re-export the parser + selection surfaces so existing call sites / tests import
// them from the gate module too.
export { parseGitCommit } from "./commit-parse.js";

/** The real cyclomatic analyzer for a coverage language, or null to skip. */
function defaultCyclomaticFor(language: CoverageLanguage): CyclomaticAnalyzer | null {
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

/** Production defaults — real runner factory, git diff, analyzer, clock, reader. */
const DEFAULT_DEPS: CommitGateDeps = {
	runnerFor: (language) => coverageRunnerFor(language),
	gitChangedFiles: defaultGitChangedFiles,
	cyclomaticFor: defaultCyclomaticFor,
	clock: Date.now,
	readFile: (absPath) => {
		try {
			return existsSync(absPath) ? readFileSync(absPath, "utf-8") : null;
		} catch {
			return null;
		}
	},
	recordDischarge: recordCoverageDischarge,
	resolveRepoRoot: defaultResolveRepoRoot,
	materializeIndexSnapshot,
};

// ===========================================
// Entry point
// ===========================================

/** Where the gate evaluates the commit, plus an optional snapshot cleanup. */
interface EvalTarget {
	root: string;
	cleanup: (() => void) | null;
}

/**
 * Resolve where the commit gate evaluates the commit (findings 3 & 4):
 *   - `index`    — a plain commit captures the INDEX exactly (no unstaged, no untracked).
 *   - `tracked`  — `-a`/`--all`: index PLUS tracked worktree mods, still no untracked.
 *   - `worktree` — the commit CONSTRUCTS content at run time:
 *       - NARROW (specific constructed paths): the base tree plus ONLY those
 *         paths' worktree state — the actual would-be snapshot. Evaluating the
 *         raw worktree let unrelated UNTRACKED tests and unstaged edits join
 *         the suite, so an untracked test could cover the staged source and
 *         approve a commit whose real tree stays uncovered (finding 2026-06).
 *         The base is the INDEX when the commit captures it (`git add p && git
 *         commit`, `--include`), and HEAD for a pathspec `--only` commit —
 *         git builds that commit from HEAD plus the named paths, so an
 *         unrelated staged file must neither false-block nor supply coverage
 *         (round 5).
 *       - BROAD (`git add -A && git commit`): the raw working tree — a broad add
 *         stages untracked files too, so the worktree IS the would-be snapshot.
 * Fail-safe: if materialization is unavailable or fails, fall back to the working
 * tree — never worse than before the fix.
 */
function resolveEvalTarget(
	projectRoot: string,
	mode: EvalMode,
	deps: CommitGateDeps,
	constructedPaths?: string[] | null,
	trackedOnlyPaths?: string[] | null,
	baseTree: "index" | "head" = "index",
): EvalTarget {
	if (mode === "worktree") {
		if (constructedPaths && constructedPaths.length > 0) {
			const snap =
				deps.materializeIndexSnapshot?.(
					projectRoot,
					false,
					constructedPaths,
					trackedOnlyPaths ?? undefined,
					baseTree,
				) ?? null;
			if (snap) return { root: snap.root, cleanup: snap.cleanup };
		}
		return { root: projectRoot, cleanup: null };
	}
	const snap = deps.materializeIndexSnapshot?.(projectRoot, mode === "tracked") ?? null;
	return snap ? { root: snap.root, cleanup: snap.cleanup } : { root: projectRoot, cleanup: null };
}

// ===========================================
// checkCommitGate helpers — each answers ONE question the orchestrator asks
// ===========================================
// Extracted 2026-07-31 to bring checkCommitGate's own cyclomatic complexity
// under the 22-branch cap (measured 26 before). Every finding-note comment
// from the original inline code moved with its logic — no behavior changed;
// `commit-gate.integration.test.ts` covers this whole call graph end-to-end
// through the same public `checkCommitGate` entry, unchanged.

/** `rules.per_edit_coverage`, narrowed to defined+usable (see PerEditCoverageConfig). */
type ResolvedCoverageConfig = NonNullable<GuardRulesConfig["per_edit_coverage"]>;

/** The resolved config + parsed commit for an event the gate should evaluate. */
interface CommitGateApplicability {
	cfg: ResolvedCoverageConfig;
	parse: CommitParse;
}

/**
 * Gate 1: is there anything for `checkCommitGate` to do at all? Three pure
 * no-op cases, all zero-cost (no git shell-out, no suite): the feature is OFF,
 * `mode` is `"warn"` (the documented loaded-but-non-blocking opt-out — the
 * commit gate checking only `enabled` made this ineffective at commit time,
 * finding 2026-06; same contract as the per-edit guard), or the command isn't
 * a real `git commit`. Returns null for all three; otherwise the resolved
 * config + parse the rest of the gate needs.
 */
function commitGateApplicability(
	event: HarnessEvent,
	rules: GuardRulesConfig,
): CommitGateApplicability | null {
	const cfg = rules.per_edit_coverage;
	if (!cfg?.enabled || cfg.mode !== "block") return null;
	const command = (event.tool_input?.command as string) || "";
	const parse = parseGitCommit(command);
	if (!parse?.isCommit) return null;
	return { cfg, parse };
}

/** Where + how {@link checkCommitGate} evaluates this commit. */
interface CommitContext {
	commandCwd: string;
	projectRoot: string;
	mode: EvalMode;
}

/**
 * Resolve the command's effective cwd, the repo toplevel it's anchored at, and
 * which tree model (`EvalMode`) applies:
 *   - `commandCwd` honors a `cd <dir>` / `git -C <dir>` redirect (finding 4):
 *     evaluate the repository the commit actually runs in, not the shell's
 *     parent cwd — a monorepo `cd packages/x && git commit` must gate
 *     packages/x, not the root.
 *   - `projectRoot` anchors at the git TOPLEVEL: git emits toplevel-relative
 *     changed paths, so a commit run from an ordinary subdirectory (`cd src &&
 *     git commit -a`) would otherwise resolve `src/a.ts` against `/repo/src` →
 *     `/repo/src/src/a.ts` and silently skip every changed source (finding
 *     2026-06). Fail-open to the command's own cwd when the toplevel can't be
 *     resolved.
 *   - `mode`: a commit that constructs content at run time (preceding `git
 *     add`, or a pathspec) → the WORKTREE (the index is stale
 *     pre-execution); `-a` → tracked snapshot; a plain commit → the INDEX.
 */
function resolveCommitContext(event: HarnessEvent, parse: CommitParse, deps: CommitGateDeps): CommitContext {
	const baseCwd = event.cwd || process.cwd();
	const commandCwd = parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd;
	const projectRoot = deps.resolveRepoRoot?.(commandCwd) ?? commandCwd;
	const mode: EvalMode = parse.constructsContent ? "worktree" : parse.all === true ? "tracked" : "index";
	return { commandCwd, projectRoot, mode };
}

/** The narrow-commit pathspec plumbing + the final changed-file set. */
interface PathspecContext {
	/** Constructed-content pathspecs rebased onto the repo toplevel; `null`
	 *  when the rebase couldn't resolve (degrade to broad), `undefined` when
	 *  the commit had no pathspec at all. */
	constructed: string[] | null | undefined;
	/** The tracked-only subset of `constructed`, when the parser found one. */
	trackedOnly: string[] | null | undefined;
	/** Which tree a NARROW worktree snapshot should start from. */
	baseTree: "index" | "head";
	/** The changed-file set the gate actually evaluates for this commit. */
	changed: string[];
}

/**
 * Resolve which paths a NARROW constructed-content commit (`git commit
 * src/a.ts`, `git add src/a.ts && git commit`) actually stages, so an
 * UNRELATED dirty worktree file does not block the commit (finding 2026-06:
 * evaluating the whole worktree over-blocked, breaking the zero-FP contract)
 * — UNIONED with the staged set when the commit also captures the
 * pre-existing index (`includesIndex` — finding 2026-06: staged files
 * bypassed otherwise). The parser's pathspecs are relative to the COMMAND's
 * directory while git's changed paths are TOPLEVEL-relative, so both
 * `constructed` and its tracked-only subset are rebased first; an unrebasable
 * spec degrades to broad (finding 2026-06: `cd packages/app && git add
 * src/a.ts && git commit` filtered toplevel paths against the raw spec and
 * the staged file bypassed). `baseTree` is the index only when the commit
 * CAPTURES the index; a pathspec `--only` commit builds from HEAD, so
 * unrelated staged content stays out of its snapshot (round 5).
 */
function resolvePathspecContext(
	parse: CommitParse,
	commandCwd: string,
	projectRoot: string,
	mode: EvalMode,
	allChanged: string[],
	deps: CommitGateDeps,
): PathspecContext {
	const constructed = parse.constructedPaths
		? rebaseConstructedPaths(parse.constructedPaths, commandCwd, projectRoot)
		: undefined;
	// trackedOnlyPaths ⊆ constructedPaths, so when `constructed` survived the
	// rebase (non-null) the tracked subset rebases too; when it degraded to
	// broad, the subset is irrelevant.
	const trackedOnly =
		constructed && parse.trackedOnlyPaths
			? rebaseConstructedPaths(parse.trackedOnlyPaths, commandCwd, projectRoot)
			: undefined;
	const changed = changedSetForCommit(
		allChanged,
		{
			...(constructed ? { constructedPaths: constructed } : {}),
			...(parse.includesIndex ? { includesIndex: true } : {}),
		},
		mode,
		() => deps.gitChangedFiles(projectRoot, true),
	);
	const baseTree = parse.includesIndex ? "index" : "head";
	return { constructed, trackedOnly, baseTree, changed };
}

/**
 * Is there nothing here for the suite to decide? Returns the decision
 * `checkCommitGate` should return immediately — an `allow` carrying any
 * `--no-verify` warning, or `null` — for either no-decidable-axis case below,
 * or `undefined` to mean "keep going, run the suite":
 *   - Nothing gated changed at all (docs / config / declaration-only).
 *   - A red-bar-ONLY run (tests / generated / deletions, nothing scannable)
 *     with `block_on_test_failure` off: no block is possible, so no suite is
 *     spent (mirrors the per-edit delete-only path's "no decidable axis"
 *     skip). Test-only and generated-only changes DO still reach the suite
 *     when `block_on_test_failure` is on: their language is in
 *     `suiteLanguages` even though there is nothing to scan, because a
 *     failing test edit must not be committed (finding 2026-06) — the same
 *     red-bar-only treatment delete-only commits already get.
 */
function noGatedSourcesDecision(
	sourceCount: number,
	suiteLanguages: CoverageLanguage[],
	cfg: ResolvedCoverageConfig,
	warnings: string[],
): HarnessDecision | null | undefined {
	if (sourceCount === 0 && suiteLanguages.length === 0) {
		return warnings.length > 0 ? { decision: "allow", warnings } : null;
	}
	if (sourceCount === 0 && cfg.block_on_test_failure !== true) {
		return warnings.length > 0 ? { decision: "allow", warnings } : null;
	}
	return undefined;
}

/**
 * PreToolUse commit gate. Returns a `block` HarnessDecision when the command is a
 * real `git commit` AND `per_edit_coverage.enabled` AND the working tree fails the
 * quality bar (red suite / uncovered changed line / CRAP-over / cyclomatic-over);
 * otherwise `null` (allow / not applicable). A pure no-op — no git, no suite — when
 * the feature is OFF, the command isn't a commit, or no changed file is a gated
 * source. Never throws (fail-open). `--no-verify` is surfaced as a warning on the
 * decision (block or allow) so the bypass attempt is visible.
 */
export async function checkCommitGate(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	deps: CommitGateDeps = DEFAULT_DEPS,
): Promise<HarnessDecision | null> {
	const applicability = commitGateApplicability(event, rules);
	if (!applicability) return null;
	const { cfg, parse } = applicability;

	// `--no-verify` is a bypass of git's hooks (not this gate). Note it so the
	// attempt is visible whether we end up blocking or allowing.
	const warnings = noVerifyWarnings(parse.noVerify);

	try {
		const { commandCwd, projectRoot, mode } = resolveCommitContext(event, parse, deps);
		// Changed files: staged-only ONLY for the plain index commit; the broader
		// worktree query for `-a` / constructed commits — and untracked files ONLY for
		// CONSTRUCTED commits, whose `git add` stages new files at run time (finding
		// 2026-06: `git diff` never lists untracked, so a brand-new source bypassed).
		const allChanged = deps.gitChangedFiles(projectRoot, mode === "index", mode === "worktree");
		if (allChanged === null) {
			return degradeWithWarnings("git diff unavailable — cannot determine changed files", warnings);
		}
		const pathspec = resolvePathspecContext(parse, commandCwd, projectRoot, mode, allChanged, deps);
		// A NARROW constructed commit evaluates its base tree + its own staged
		// paths, not the raw worktree (finding 2026-06: an untracked test could
		// cover the staged source and approve a commit whose actual snapshot is
		// uncovered).
		const target = resolveEvalTarget(
			projectRoot,
			mode,
			deps,
			pathspec.constructed,
			pathspec.trackedOnly,
			pathspec.baseTree,
		);
		try {
			const { sources, deletedPaths, suiteLanguages } = selectChangedSources(
				pathspec.changed,
				target.root,
				cfg.languages,
				deps.readFile,
			);
			const earlyExit = noGatedSourcesDecision(sources.length, suiteLanguages, cfg, warnings);
			if (earlyExit !== undefined) return earlyExit;

			return await runSuiteAndScan(
				{
					projectRoot: target.root,
					sources,
					suiteLanguages,
					crapThreshold: crapThresholdFor(projectRoot, cfg.crap_threshold),
					blockOnTestFailure: cfg.block_on_test_failure === true,
					blockOnCrap: cfg.block_on_crap === true,
					deletedPaths,
					warnings,
					// Discharge obligations against the REAL repo root (where the ledger
					// lives), not the snapshot, on a clean pass (finding 12).
					ledgerRoot: projectRoot,
					sessionId: event.session_id,
					...(event.timestamp ? { eventTs: event.timestamp } : {}),
				},
				deps,
			);
		} finally {
			target.cleanup?.();
		}
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return degradeWithWarnings(why, warnings);
	}
}
