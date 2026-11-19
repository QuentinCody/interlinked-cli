// ===========================================
// Summary + project-level streaming reporters
// ===========================================
// Owns the tail "X / Y files flagged" computation (`summarizeFlaggedFiles`,
// the only unit-tested pure helper here) and the small per-section stderr
// reporters for project-wide findings that aren't part of the external-tool
// or code-quality passes: project setup, registry parity, lockfile
// multiplicity, decision-surface ratchet, Supermodel dead code, undocumented
// env vars, scored suggestions, plus the `verify-runs.jsonl` row emitter.
//
// The orchestrator (`verify.ts`) calls these in sequence and threads the
// shared `allFlaggedFiles` set through.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
	type CaseDivergenceFinding,
	runCaseDivergenceCheck,
} from "../../harness/case-divergence.js";
import type { LockfileMultiplicityResult } from "../../harness/quality-checks/decision-surface.js";
import type { DecisionSurfaceRatchetResult } from "../../harness/quality-checks/decision-surface-ratchet.js";
import {
	type RegistryDriftFinding,
	runRegistryParityCheck,
} from "../../harness/registry-parity.js";
import {
	formatDeadCodeFindings,
	isSupermodelCliAvailable,
	runSupermodelDeadCode,
} from "../../harness/supermodel-analyses.js";

import { checkProjectSetup, runSuggestions } from "./tool-results.js";

const MAX_LISTED_FILES = 20;
const MAX_ENV_FILES = 10;
const SUGGESTIONS_LIMIT = 3;
const SUGGESTIONS_THRESHOLD = 0.5;

// Some checks report project-wide findings that aren't tied to any real file.
// They go into `allFlaggedFiles` under a synthetic token so the per-check
// section still renders, but they must not inflate the "X / Y files flagged"
// ratio (numerator > denominator was the visible symptom). Extend this set if
// another check introduces a new sentinel.
const SYNTHETIC_FILE_TOKENS = new Set<string>(["<project>"]);

/** Normalize a flagged-file entry to a path relative to `cwd`. Leaves synthetic
 *  tokens unchanged so callers can filter them out by identity. */
function normalizeFlaggedPath(cwd: string, p: string): string {
	if (SYNTHETIC_FILE_TOKENS.has(p)) return p;
	return isAbsolute(p) ? relative(cwd, p) : p;
}

/** Pure helper for the tail summary line. Exported for unit tests.
 *
 *  Inputs:
 *    - `cwd`           — the project root the scan ran against.
 *    - `files`         — paths from `discoverFiles()` (absolute; `.ts`/`.py`/… only).
 *    - `flagged`       — raw entries that accumulated in `allFlaggedFiles`;
 *                        a mix of absolute/relative/sentinel strings produced
 *                        by various checks.
 *
 *  Output:
 *    - `flaggedFiles`    — count of real files with at least one finding.
 *    - `totalFiles`      — size of the universe the numerator is taken against.
 *                          Equals |discovered ∪ real-flagged| so config files
 *                          that only external tools care about (e.g.
 *                          `tsconfig.json`) count on both sides.
 *    - `projectFindings` — count of non-file, project-wide findings (e.g. the
 *                          prod/test LOC ratio). Reported separately.
 */
export function summarizeFlaggedFiles(
	cwd: string,
	files: readonly string[],
	flagged: Iterable<string>,
): { flaggedFiles: number; totalFiles: number; projectFindings: number } {
	const discovered = new Set(files.map((f) => normalizeFlaggedPath(cwd, f)));
	const flaggedReal = new Set<string>();
	let projectFindings = 0;
	for (const p of flagged) {
		if (SYNTHETIC_FILE_TOKENS.has(p)) {
			projectFindings++;
			continue;
		}
		flaggedReal.add(normalizeFlaggedPath(cwd, p));
	}
	const universe = new Set<string>([...discovered, ...flaggedReal]);
	return {
		flaggedFiles: flaggedReal.size,
		totalFiles: universe.size,
		projectFindings,
	};
}

// Emit a row into .interlinked/verify-runs.jsonl so successive verify
// invocations build a longitudinal record of error counts. Used to
// bisect when regressions entered the codebase without re-running tools.
export function emitVerifyRun(
	cwd: string,
	data: {
		mode: string;
		files_scanned: number;
		flagged_files: number;
		project_findings: number;
		summary: Array<{ label: string; count: number; color: string }>;
		duration_ms: number;
	},
): void {
	try {
		const path = join(cwd, ".interlinked", "verify-runs.jsonl");
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const branch = safeGitOutput(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
		const head = safeGitOutput(["rev-parse", "HEAD"], cwd);
		const dirty = safeGitOutput(["status", "--porcelain"], cwd) ? true : false;
		const record = {
			ts: new Date().toISOString(),
			cwd,
			branch: branch || null,
			head: head || null,
			dirty,
			mode: data.mode,
			files_scanned: data.files_scanned,
			flagged_files: data.flagged_files,
			project_findings: data.project_findings,
			counts: data.summary.map((s) => ({ label: s.label, count: s.count })),
			duration_ms: data.duration_ms,
			exit_code: process.exitCode || 0,
		};
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch (_err) {
		/* intentional: verify-runs is best-effort observability */
	}
}

// --no-optional-locks: a read-only probe must never take .git/index.lock. `git status` otherwise does, and the
// 3 s timeout kills it while it holds the lock — a stale lock that blocks every later git add/commit (2026-11-13).
function safeGitOutput(args: string[], cwd: string): string {
	try {
		const out = execFileSync("git", ["--no-optional-locks", ...args], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});
		return out.trim();
	} catch (_err) {
		return "";
	}
}

/** Public API — consumed by `verify.ts`. */
export function streamProjectSetup(cwd: string, allFlaggedFiles: Set<string>): void {
	const setupIssues = checkProjectSetup(cwd);
	process.stderr.write("\n  \x1b[1mproject setup\x1b[0m\n");
	if (setupIssues.length === 0) {
		process.stderr.write("    \x1b[32m✓\x1b[0m configuration valid\n");
		return;
	}
	for (const issue of setupIssues) {
		process.stderr.write(`    \x1b[31m✗\x1b[0m ${issue.message}\n`);
		process.stderr.write(`\x1b[2m         fix: ${issue.fix}\x1b[0m\n`);
		allFlaggedFiles.add(issue.file);
	}
}

/** Public API — consumed by `verify.ts`. */
export function streamRegistryParity(cwd: string, allFlaggedFiles: Set<string>): void {
	let findings: RegistryDriftFinding[];
	try {
		findings = runRegistryParityCheck(cwd);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write("\n  \x1b[1mregistry parity\x1b[0m\n");
		process.stderr.write(`    \x1b[31m✗\x1b[0m config error: ${msg}\n`);
		return;
	}
	if (findings.length === 0) return;
	process.stderr.write("\n  \x1b[1mregistry parity\x1b[0m\n");
	for (const f of findings) {
		process.stderr.write(`    \x1b[31m✗\x1b[0m ${f.message}\n`);
		allFlaggedFiles.add(f.source_file);
	}
}

/**
 * Public API — consumed by `verify.ts`. Advisory (only invoked under
 * `--all-checks`). Reports identifiers that appear in two case spellings
 * across the codebase. Best-effort: a thrown error is swallowed so a verify
 * run never fails on this advisory pass.
 */
export function streamCaseDivergence(
	cwd: string,
	files: readonly string[],
	allFlaggedFiles: Set<string>,
): void {
	let findings: CaseDivergenceFinding[];
	try {
		findings = runCaseDivergenceCheck(cwd, files);
	} catch {
		return;
	}
	if (findings.length === 0) return;
	process.stderr.write("\n  \x1b[1mcase divergence\x1b[0m (advisory)\n");
	for (const f of findings) {
		process.stderr.write(`    \x1b[33m!\x1b[0m ${f.message}\n`);
		for (const sp of f.spellings) {
			const loc = sp.locs[0];
			if (loc) {
				const more = sp.locs.length > 1 ? ` (+${sp.locs.length - 1} more)` : "";
				process.stderr.write(
					`\x1b[2m         ${sp.name} — ${loc.file}:${loc.line} (${sp.style})${more}\x1b[0m\n`,
				);
			}
		}
		for (const file of f.files) allFlaggedFiles.add(file);
	}
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Stream the lockfile-multiplicity warning. Silent when only one (or
 * zero) package managers are implied by the lockfiles present. Loud
 * when two or more managers coexist — that's a config error, not a
 * decision-surface count. See `docs/design/decision-surface-metric.md` §4.
 */
export function streamLockfileMultiplicity(result: LockfileMultiplicityResult): void {
	if (!result.multiplicity) return;
	process.stderr.write("\n  \x1b[1mlockfile multiplicity\x1b[0m\n");
	process.stderr.write(
		`    \x1b[31m✗\x1b[0m multiple lockfiles found: ${result.lockfiles.join(" + ")}\n`,
	);
	process.stderr.write(
		`\x1b[2m         pick one (${result.managers.join(" / ")}) and delete the others — installs are non-deterministic until you do\x1b[0m\n`,
	);
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Stream the decision-surface-growth ratchet. Silent when no growth or
 * when the ratchet skipped (not a git repo / no baseline ref). Loud when
 * one or more categories gained a new tool since the baseline ref.
 * See `docs/design/decision-surface-metric.md` §2.
 */
export function streamDecisionSurfaceRatchet(result: DecisionSurfaceRatchetResult): void {
	if (result.warnings.length === 0) return;
	process.stderr.write("\n  \x1b[1mdecision-surface growth\x1b[0m\n");
	process.stderr.write(
		`\x1b[2m         baseline ${result.baselineRef}; +${result.totalGrowth} entries\x1b[0m\n`,
	);
	for (const line of result.warnings) {
		process.stderr.write(`    \x1b[33m!\x1b[0m ${line}\n`);
	}
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Stream the Supermodel dead-code section. Opt-in via `--dead-code`:
 * `supermodel dead-code` is a cloud API call (uploads the repo, requires
 * an API key, can take minutes), so it is never part of the default fast
 * `verify` gate. Silent unless the flag is set. When the flag is set but
 * the `supermodel` CLI is absent, prints a one-line skip note rather than
 * failing — the integration is opt-in and degrades gracefully. See
 * `docs/plans/08-supermodel-graph-provider.md` §3d.
 */
export function streamSupermodelDeadCode(
	cwd: string,
	opts: { deadCode?: boolean },
	allFlaggedFiles: Set<string>,
): void {
	if (!opts.deadCode) return;
	process.stderr.write("\n  \x1b[1msupermodel dead-code\x1b[0m\n");
	if (!isSupermodelCliAvailable()) {
		process.stderr.write(
			"    \x1b[2m· skipped — `supermodel` CLI not found on PATH\x1b[0m\n",
		);
		return;
	}
	process.stderr.write("    \x1b[2m· running cloud analysis...\x1b[0m");
	const analysis = runSupermodelDeadCode(cwd);
	process.stderr.write("\r\x1b[K");
	if (!analysis) {
		process.stderr.write(
			"    \x1b[2m· no result — `supermodel` errored (API key, network, or timeout)\x1b[0m\n",
		);
		return;
	}
	if (analysis.candidates.length === 0) {
		process.stderr.write(
			`    \x1b[32m✓\x1b[0m no dead code (${analysis.totalDeclarations} declarations analyzed)\n`,
		);
		return;
	}
	process.stderr.write(
		`    \x1b[33m!\x1b[0m \x1b[33m${analysis.candidates.length}\x1b[0m dead-code candidate(s) of ${analysis.totalDeclarations} declarations\n`,
	);
	for (const c of analysis.candidates) allFlaggedFiles.add(c.file);
	for (const line of formatDeadCodeFindings(analysis, { max: MAX_LISTED_FILES })) {
		process.stderr.write(`\x1b[2m         ${line}\x1b[0m\n`);
	}
}

/** Public API — consumed by `verify.ts`. */
export function streamUndocumentedEnvVars(
	undocumentedEnvVars: Array<{ file: string; message: string }>,
	allFlaggedFiles: Set<string>,
): void {
	process.stderr.write("\n  \x1b[1menv/config integrity\x1b[0m\n");
	if (undocumentedEnvVars.length === 0) {
		process.stderr.write("    \x1b[32m✓\x1b[0m all env vars documented\n");
		return;
	}
	const envNames = new Set(
		undocumentedEnvVars.map((r) => {
			const m = r.message.match(/"([^"]+)"/);
			return m ? m[1] : "";
		}),
	);
	const envFiles = new Set(undocumentedEnvVars.map((r) => r.file));
	for (const f of envFiles) allFlaggedFiles.add(f);
	process.stderr.write(
		`    \x1b[33m!\x1b[0m \x1b[33m${envNames.size}\x1b[0m undocumented env vars in \x1b[33m${envFiles.size}\x1b[0m files\n`,
	);
	for (const file of [...envFiles].sort().slice(0, MAX_ENV_FILES)) {
		process.stderr.write(`\x1b[2m         ${file}\x1b[0m\n`);
	}
	if (envFiles.size > MAX_ENV_FILES) {
		process.stderr.write(
			`\x1b[2m         ... and ${envFiles.size - MAX_ENV_FILES} more files\x1b[0m\n`,
		);
	}
}

/** Public API — consumed by `verify.ts`. */
export function streamSuggestionsSummary(files: string[], cwd: string): void {
	process.stderr.write("  \x1b[2mscoring suggestions...\x1b[0m");
	const suggestions = runSuggestions({
		files,
		cwd,
		limit: SUGGESTIONS_LIMIT,
		threshold: SUGGESTIONS_THRESHOLD,
	});
	process.stderr.write("\r\x1b[K");
	if (suggestions.size === 0) {
		process.stderr.write("\n  \x1b[1msuggestions\x1b[0m\n");
		process.stderr.write("    \x1b[32m✓\x1b[0m no suggestions\n");
		return;
	}
	let total = 0;
	for (const f of suggestions.values()) total += f.length;
	process.stderr.write("\n  \x1b[1msuggestions\x1b[0m (scored heuristics)\n");
	process.stderr.write(
		`    \x1b[36m·\x1b[0m \x1b[36m${total}\x1b[0m suggestions in \x1b[36m${suggestions.size}\x1b[0m files\n`,
	);
	for (const [file] of [...suggestions.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		process.stderr.write(`\x1b[2m         ${file}\x1b[0m\n`);
	}
}
