// interlinked-tdd: exempt
// ===========================================
// Interlinked Harness — Behavioral Checks (prod/test LOC ratio gate)
// ===========================================
// The git-diff-based prod/test LOC ratio commit gate and its numstat-driven
// delta computation, split out of `behavioral-checks-tdd.ts` to keep each
// module under the per-file line cap; the public API is re-exported from
// `behavioral-checks-tdd.ts` (and onward from `behavioral-checks.ts`) so all
// importers are unchanged.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nonNull } from "../lib/non-null.js";
import type { CheckResultEntry, SessionTrajectory } from "./types.js";
import { isCodeFile } from "./verification-stop-checks.js";

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

const PROD_TEST_LOC_RATIO_LIMIT = 5;

/** Lines added + deleted, split by prod vs test path. */
export interface LocDelta {
	prodLoc: number;
	testLoc: number;
}

/**
 * Compute LOC delta covering BOTH tracked changes (`git diff --numstat HEAD`)
 * AND untracked-but-not-ignored files (counted at full line count, since
 * they're entirely new). Counts added + deleted for tracked files so a
 * 50-line refactor registers as 100 churn — that's what the ratio gate
 * cares about (proportional test coverage of touched code).
 *
 * Three-bucket classification: a path counts toward testLoc if it matches
 * the test convention, prodLoc if it's a known code-file extension, and
 * is dropped otherwise. The third bucket exists because the previous
 * bipartite split routed every non-test path into prodLoc — docs
 * (CLAUDE.md), JSON data, lockfiles, and shell-script bootstraps then
 * tripped the "wrote N lines of production code with no tests" warning
 * on doc-only sessions. `isCodeFile` is the shared positive predicate
 * used by the Stop-event verification nudges.
 *
 * The untracked path matters because `git diff` doesn't see new files
 * before they're staged, and the gate fires at PreToolUse time on
 * `git add ... && git commit ...` — before staging happens. Without
 * untracked accounting, a brand-new test file wouldn't count.
 *
 * Returns zeroes on any failure (not in a repo, no HEAD, git missing).
 */
/**
 * Accumulate the numstat delta for one tracked-diff line into `delta` in
 * place. Split out of `sumTrackedNumstat` so the loop body carries no
 * nesting of its own.
 */
function accumulateNumstatLine(line: string, delta: LocDelta): void {
	const parts = line.split("\t");
	if (parts.length < 3) return;
	const added = Number.parseInt(nonNull(parts[0]), 10);
	const deleted = Number.parseInt(nonNull(parts[1]), 10);
	if (!Number.isFinite(added) || !Number.isFinite(deleted)) return;
	const path = nonNull(parts[2]);
	const loc = added + deleted;
	if (TEST_FILE_RE.test(path)) delta.testLoc += loc;
	else if (isCodeFile(path)) delta.prodLoc += loc;
	// else: docs, JSON data, lockfiles, etc. — not "production code"
}

/** Lines added + deleted for tracked changes, from `git diff --numstat HEAD`. */
function sumTrackedNumstat(cwd: string): LocDelta {
	const numstat = execSync("git diff --numstat HEAD", {
		cwd,
		encoding: "utf-8",
		timeout: 3000,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const delta: LocDelta = { prodLoc: 0, testLoc: 0 };
	for (const line of numstat.split("\n")) accumulateNumstatLine(line, delta);
	return delta;
}

/**
 * Full line count for one untracked-but-not-ignored path, added into
 * `delta` in place. Best-effort: an unreadable file is silently skipped
 * (it may have been deleted between `git ls-files` and this read).
 */
function accumulateUntrackedFile(cwd: string, path: string, delta: LocDelta): void {
	if (!path) return;
	const isTest = TEST_FILE_RE.test(path);
	if (!isTest && !isCodeFile(path)) return;
	try {
		const content = readFileSync(join(cwd, path), "utf-8");
		const loc = content.split("\n").length;
		if (isTest) delta.testLoc += loc;
		else delta.prodLoc += loc;
	} catch {
		// intentional: best-effort read; skip an unreadable untracked file.
	}
}

/** Lines counted in full for untracked-but-not-ignored files. */
function sumUntrackedLoc(cwd: string): LocDelta {
	const untracked = execSync("git ls-files --others --exclude-standard", {
		cwd,
		encoding: "utf-8",
		timeout: 3000,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const delta: LocDelta = { prodLoc: 0, testLoc: 0 };
	for (const path of untracked.split("\n")) accumulateUntrackedFile(cwd, path, delta);
	return delta;
}

/**
 * Combined tracked + untracked LOC delta. Throws only if the TRACKED diff
 * itself fails (mirrors the original single-try-block behavior, where
 * prodLoc/testLoc were outer-scoped `let`s mutated by both loops: a
 * failure in the untracked-file listing after the tracked diff already
 * succeeded returned the partial tracked totals, not zero — only a
 * failure before any accumulation (i.e. the tracked diff itself) produced
 * an unrecoverable zero).
 */
function computeNumstatDelta(cwd: string): LocDelta {
	const tracked = sumTrackedNumstat(cwd);
	try {
		const untracked = sumUntrackedLoc(cwd);
		return {
			prodLoc: tracked.prodLoc + untracked.prodLoc,
			testLoc: tracked.testLoc + untracked.testLoc,
		};
	} catch {
		// intentional: untracked-file listing failed AFTER the tracked diff
		// already succeeded — return the partial tracked totals, matching
		// the original shared-`let` fallthrough behavior.
		return tracked;
	}
}

export function gitNumstatDelta(cwd: string = process.cwd()): LocDelta {
	try {
		return computeNumstatDelta(cwd);
	} catch {
		// intentional: git unavailable / not a repo / no HEAD — fall back to 0
		return { prodLoc: 0, testLoc: 0 };
	}
}

/**
 * Commit gate: flag when prod LOC delta exceeds test LOC delta by more than
 * PROD_TEST_LOC_RATIO_LIMIT × — measured against `git diff HEAD`, NOT against
 * file totals. Touching a 1000-line file with a 2-line edit contributes 2 to
 * the delta, not 1000. The previous file-total approach made the gate fire
 * on any session that brushed a large file, even when the actual change was
 * small and well-tested.
 */
export function checkProdTestLocRatio(
	session: SessionTrajectory,
	getDelta: () => LocDelta = gitNumstatDelta,
): CheckResultEntry[] {
	void session; // signature kept for symmetry with other commit gates
	const { prodLoc, testLoc } = getDelta();
	if (testLoc === 0 && prodLoc === 0) return [];
	if (testLoc === 0) {
		return [
			{
				source: "structural",
				name: "prod_test_loc_ratio",
				severity: "warning",
				message: `Wrote ${prodLoc} lines of production code this session with no tests written. Add tests before committing.`,
				file: "<session>",
				determinism: "heuristic",
			},
		];
	}
	const ratio = prodLoc / testLoc;
	if (ratio > PROD_TEST_LOC_RATIO_LIMIT) {
		return [
			{
				source: "structural",
				name: "prod_test_loc_ratio",
				severity: "warning",
				message: `Prod/test LOC ratio is ${ratio.toFixed(1)}:1 (limit ${PROD_TEST_LOC_RATIO_LIMIT}:1). Production code is growing faster than test coverage.`,
				file: "<session>",
				determinism: "heuristic",
			},
		];
	}
	return [];
}
