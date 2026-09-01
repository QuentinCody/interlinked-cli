// Diff-aware behavioral checks (Batch 3).
//
// Each check reads `git diff --cached HEAD` for files in
// `session.files_written` and surfaces a CheckResultEntry when the staged
// diff exhibits a known test-suite-gaming or claim-vs-reality drift
// pattern. All run at PreToolUse time on `git commit` invocations
// alongside the existing commit gates in `server.ts`.

import { extname, basename as pathBasename } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { extractAddedLines, getStagedDiff } from "./behavioral-checks.js";
import { checkReintroducesRemovedCode } from "./behavioral-diff-checks-reintro.js";
import { checkTestTimeoutInflation } from "./behavioral-diff-checks-timeouts.js";
import type { CheckResultEntry, SessionTrajectory } from "./types.js";

// Re-export so callers importing from this module path keep working.
export { checkReintroducesRemovedCode, checkTestTimeoutInflation };

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

function basename(p: string): string {
	return p.split("/").pop() || p;
}

// ==========================================================================
// 1. Disabled-test delta
// ==========================================================================
// Staged diff added `.skip`, `xit`, `xdescribe`, `it.skip(`, etc. to a test
// file. The transition is the tell — pre-existing skips don't fire.

const DISABLE_DIRECTIVES_RE =
	/(?:^|\b)(?:it|test|describe|context)\s*\.\s*(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest|xcontext)\s*\(/;

/** Public API — flags newly-added `.skip` / `xit` directives in test files. */
export function checkDisabledTestDelta(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		let added = 0;
		let removed = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+") && DISABLE_DIRECTIVES_RE.test(line)) added++;
			else if (line.startsWith("-") && DISABLE_DIRECTIVES_RE.test(line)) removed++;
		}
		const delta = added - removed;
		if (delta <= 0) continue;
		results.push({
			source: "structural",
			name: "disabled_test_delta",
			severity: "error",
			message: `${basename(file)} adds ${delta} new disabled-test directive(s) (.skip / xit / .todo). Fix the failing test instead of skipping it. If skipping is genuinely necessary, document why with a TICKET-XXX reference.`,
			file,
			determinism: "fully_deterministic",
		});
	}
	return results;
}

// ==========================================================================
// 2. Test-block count regression — MOVED to behavioral-diff-checks-oracle.ts
// ==========================================================================
// Rewritten 2026-07 (docs/design/test-oracle-integrity.md §4.1): commit-scoped
// and SUT-conditioned, with `severity: "error"` only on the unexplained-loss
// branch. Re-exported here so existing importers (pre-tool-pipeline-stages,
// tests) keep resolving from this module. The oracle sibling also hosts the
// two new checks; this file sits at the line cap.
export {
	checkAssertionCountRegression,
	checkAssertionValueSwap,
	checkTestBlockCountRegression,
} from "./behavioral-diff-checks-oracle.js";

// ==========================================================================
// 3. Assertion-strength weakening
// ==========================================================================
// Diff replaces a strong matcher (`toBe(<literal>)`, `toEqual(<literal>)`,
// `toMatch(/.../)`) with a weaker one (`toBeTruthy()`, `toBeDefined()`,
// `not.toThrow()`). Strong agent tell.

const STRONG_MATCHER_RE = /\.\s*(?:toBe|toEqual|toStrictEqual|toMatch)\s*\(/;
const WEAK_MATCHER_RE =
	/\.\s*(?:toBeTruthy|toBeDefined|toBeFalsy|toBeUndefined|not\s*\.\s*toThrow)\s*\(/;

/** Public API — flags assertion weakening in staged diffs. */
export function checkAssertionStrengthWeakening(
	session: SessionTrajectory,
): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		let strongRemoved = 0;
		let weakAdded = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("-") && STRONG_MATCHER_RE.test(line)) strongRemoved++;
			else if (line.startsWith("+") && WEAK_MATCHER_RE.test(line)) weakAdded++;
		}
		// Heuristic: a strong matcher removed AND a weak matcher added in
		// the same diff is an assertion-weakening tell. Don't fire on
		// pure additions or pure deletions.
		if (strongRemoved === 0 || weakAdded === 0) continue;
		results.push({
			source: "structural",
			name: "assertion_strength_weakening",
			severity: "warning",
			message: `${basename(file)} replaces strong assertions (toBe/toEqual/toMatch x${strongRemoved}) with weak ones (toBeTruthy/toBeDefined/not.toThrow x${weakAdded}). Either restore the strong assertion (and fix what made it fail), or document why the looser matcher is correct.`,
			file,
			determinism: "heuristic",
		});
	}
	return results;
}

// ==========================================================================
// 4. Conventional-commit ↔ diff coherence
// ==========================================================================
// Parse the `-m "msg"` argument from the `git commit` invocation, classify
// its conventional-commit prefix, and surface a finding when the diff
// contradicts the claim:
//   - `fix:` claim, diff is comment-only / whitespace / import-only / test-only
//   - `feat:` claim, no new exports introduced
//   - `refactor:` claim, but assertion arguments / business logic mutated
//   - `test:` claim, but production source touched
//   - `docs:` claim, but `.ts` / `.tsx` files outside docs touched

interface ParsedCommitMessage {
	type: string;
	subject: string;
}

const COMMIT_TYPE_RE = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s*(.+)$/;
const COMMIT_M_FLAG_RE = /-m\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/;

export function parseCommitMessageFromBash(command: string): ParsedCommitMessage | null {
	const match = COMMIT_M_FLAG_RE.exec(command);
	if (!match) return null;
	const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
	if (!raw) return null;
	const typeMatch = COMMIT_TYPE_RE.exec(raw);
	if (!typeMatch) return null;
	return { type: nonNull(typeMatch[1]).toLowerCase(), subject: nonNull(typeMatch[2]) };
}

const PROD_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function isDocsPath(file: string): boolean {
	return /(?:^|\/)(?:docs|documentation|website|site)\//.test(file) ||
		extname(file) === ".md" ||
		extname(file) === ".mdx";
}

function isTestPath(file: string): boolean {
	return TEST_FILE_RE.test(file);
}

function isProdSource(file: string): boolean {
	return PROD_EXTS.has(extname(file)) && !isTestPath(file);
}

function extractRemovedLines(diff: string): string {
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith("-") || line.startsWith("---")) continue;
		out.push(line.slice(1));
	}
	return out.join("\n");
}

function isCommentOrWhitespaceOnly(text: string): boolean {
	if (!text.trim()) return true;
	const substantive = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.filter((l) => !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
	return substantive.length === 0;
}

/**
 * A diff is a true no-op (worth flagging on a `fix:` claim) only when BOTH
 * added and removed sides are comment/whitespace-only. A deletion-only
 * change that removes substantive code IS a real fix even though the
 * added side is empty — return false so the gate doesn't false-positive
 * on legitimate cleanup commits.
 */
function diffIsCommentOrWhitespaceOnly(diff: string): boolean {
	const addedNoOp = isCommentOrWhitespaceOnly(extractAddedLines(diff));
	const removedNoOp = isCommentOrWhitespaceOnly(extractRemovedLines(diff));
	return addedNoOp && removedNoOp;
}

const EXPORT_NAME_RE =
	/^\s*export\s+(?:async\s+)?(?:default\s+)?(?:function\s+\*?|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)([A-Za-z_$][\w$]*)/gm;
// Barrel-style named re-exports: `export { Foo, Bar } from "./mod"` and
// (rarer) plain `export { Foo, Bar }` for surface-redeclarations.
const EXPORT_NAMED_LIST_RE = /^\s*export\s*\{\s*([^}]+)\s*\}/gm;
// Catch-all re-export: `export * from "./mod"` and `export * as ns from "./mod"`.
const EXPORT_STAR_RE = /^\s*export\s+\*(?:\s+as\s+\w+)?\s+from\s+["']/m;
// Anonymous default export: `export default function () { … }`,
// `export default () => …`, `export default {`, `export default 1`.
// Distinct from the named-default form which the main regex already covers.
const EXPORT_DEFAULT_ANY_RE =
	/^\s*export\s+default\s+(?:async\s+)?(?:function\s*\*?\s*\(|class\s*(?:\{|extends)|\(|\{|\[|[A-Za-z_$])/m;

function exportedNamesIn(text: string): Set<string> {
	const names = new Set<string>();
	EXPORT_NAME_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXPORT_NAME_RE.exec(text);
	while (m !== null) {
		names.add(nonNull(m[1]));
		m = EXPORT_NAME_RE.exec(text);
	}
	EXPORT_NAMED_LIST_RE.lastIndex = 0;
	let n: RegExpExecArray | null = EXPORT_NAMED_LIST_RE.exec(text);
	while (n !== null) {
		// Each entry is `Foo` or `Foo as Bar` — credit the public-facing
		// alias (the right side of `as`) since that's the surface name.
		for (const raw of nonNull(n[1]).split(",")) {
			const local = (raw.split(/\s+as\s+/i)[1] ?? raw).trim().replace(/^type\s+/, "");
			if (local) names.add(local);
		}
		n = EXPORT_NAMED_LIST_RE.exec(text);
	}
	return names;
}

function diffIntroducesNewExport(diff: string): boolean {
	const added = extractAddedLines(diff);
	// Star re-exports propagate an unknown surface; treat their *addition*
	// as a new export so feat: claims about them don't false-positive.
	if (EXPORT_STAR_RE.test(added)) return true;
	// Anonymous-default export added — counts as new public surface.
	if (EXPORT_DEFAULT_ANY_RE.test(added)) return true;
	const addedNames = exportedNamesIn(added);
	if (addedNames.size === 0) return false;
	// Subtract names that also appear on `-` lines — those are edits to
	// pre-existing exports, not new public surface.
	const removedLines: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("-") && !line.startsWith("---")) removedLines.push(line.slice(1));
	}
	const removedNames = exportedNamesIn(removedLines.join("\n"));
	for (const name of addedNames) {
		if (!removedNames.has(name)) return true;
	}
	return false;
}

/** Public API — flags conventional-commit prefix vs staged-diff mismatches. */
export function checkConventionalCommitCoherence(
	session: SessionTrajectory,
	message: ParsedCommitMessage | null,
): CheckResultEntry[] {
	if (!message) return [];
	const results: CheckResultEntry[] = [];
	const files = [...session.files_written];
	if (files.length === 0) return [];

	const allDiffs = files.map((f) => ({ file: f, diff: getStagedDiff(f) }));
	// Only files with a non-empty staged diff belong to THIS commit. session
	// .files_written also includes files written earlier in the session and
	// committed separately; using it directly false-fires (e.g. test:/docs: on
	// prod files that are not part of this commit).
	const stagedFiles = allDiffs.filter((d) => d.diff).map((d) => d.file);
	if (stagedFiles.length === 0) return [];

	switch (message.type) {
		case "fix": {
			// Every touched file's added lines should be more than just
			// comments / imports / test-only.
			const allCommentOrWs = allDiffs.every((d) => !d.diff || diffIsCommentOrWhitespaceOnly(d.diff));
			const onlyTests = stagedFiles.every((f) => !isProdSource(f) || isTestPath(f));
			if (allCommentOrWs) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "fix:" but every staged change is comment-only / whitespace-only. Either rewrite the message (e.g. \`docs:\`, \`chore:\`) or include the actual fix.`,
					file: "<session>",
					determinism: "heuristic",
				});
			} else if (onlyTests) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "fix:" but no production source was modified — only tests. If the bug was in a test, use \`test:\`. If the production fix is missing, add it before committing.`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		case "feat": {
			const introducesExport = allDiffs.some(
				(d) => isProdSource(d.file) && d.diff && diffIntroducesNewExport(d.diff),
			);
			if (!introducesExport) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "feat:" but the staged diff introduces no new exported symbol. New features typically expose a callable surface — verify the message matches the change (try \`fix:\` or \`refactor:\` if you didn't add a public API).`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		case "test": {
			const touchesProd = stagedFiles.some((f) => isProdSource(f));
			if (touchesProd) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "test:" but production source files are also modified. Split the production change into its own commit (with \`fix:\` / \`feat:\` / \`refactor:\`) so the history accurately reflects what changed.`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		case "docs": {
			const touchesNonDocs = stagedFiles.some((f) => !isDocsPath(f) && PROD_EXTS.has(extname(f)));
			if (touchesNonDocs) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "docs:" but non-docs files (.ts / .tsx outside docs paths) are modified. Either narrow the diff to docs only or re-classify the commit type.`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		case "refactor": {
			// `refactor:` means "behavior preserved." Heuristic for behavior
			// change: assertion-argument mutations OR new-test additions
			// (suggests behavior was different than the prior tests captured).
			const testsWithMutation = allDiffs.filter((d) => isTestPath(d.file) && d.diff)
				.filter((d) => /\b(?:expect|assert)\s*\([^)]*\)\s*\.\s*to[A-Z]/.test(extractAddedLines(d.diff)));
			if (testsWithMutation.length > 0) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "info",
					message: `Commit message says "refactor:" but test assertions changed in ${testsWithMutation.length} file(s). Refactors preserve behavior — assertion changes suggest a behavior delta. Consider \`fix:\` or \`feat:\` if the SUT contract moved.`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		default:
			break;
	}

	return results;
}

// ==========================================================================
// 5. vi.setSystemTime added to a test that didn't have it before
// ==========================================================================
// Diff signal that the agent silenced a time-sensitive test failure by
// reaching for the clock mock instead of fixing the underlying issue.
// Sometimes legitimate (test newly tests time-dependent behavior); always
// worth surfacing.

const VI_SET_SYSTEM_TIME_RE = /\b(?:vi|jest)\s*\.\s*(?:setSystemTime|useFakeTimers)\s*\(/;

/** Public API — flags newly-added vi.setSystemTime / vi.useFakeTimers in tests. */
export function checkClockMockAdded(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		let added = 0;
		let removed = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+") && VI_SET_SYSTEM_TIME_RE.test(line)) added++;
			else if (line.startsWith("-") && VI_SET_SYSTEM_TIME_RE.test(line)) removed++;
		}
		const net = added - removed;
		if (net <= 0) continue;
		results.push({
			source: "structural",
			name: "clock_mock_added",
			severity: "info",
			message: `${basename(file)} adds ${net} clock-mock call(s) (vi.setSystemTime / vi.useFakeTimers). If this is to silence a real timing bug, fix the SUT instead. If the test genuinely depends on time, consider injecting a Clock interface so production code is the same shape.`,
			file,
			determinism: "fully_deterministic",
		});
	}
	return results;
}

void pathBasename; // suppress unused-import after refactor — keep available for future expansion

// ==========================================================================
// 7. "Done" without verify
// ==========================================================================
// Commit-gate signal: agent is committing source-file changes without ever
// running a test in the session. Distinct from the existing
// checkProdTestLocRatio (which compares LOC) — this fires when test_runs
// is empty entirely.

const TEST_FILE_RE_LOCAL = /\.(test|spec)\.|__tests__\/|\/tests\//;

/** Public API — flags committing without running tests in the session.
 *  Scoped to actual source files (`isProdSource` extension + non-test
 *  filter) so docs-only / config-only / lockfile-only commits don't get
 *  warned to "run the test suite" — those paths have no tests to run. */
export function checkDoneWithoutVerify(session: SessionTrajectory): CheckResultEntry[] {
	if (session.test_runs.size > 0) return [];
	const sourceEdits = [...session.files_written].filter(isProdSource);
	if (sourceEdits.length === 0) return [];
	void TEST_FILE_RE_LOCAL; // legacy ref: superseded by isProdSource — keep import alive in case future logic re-uses it.

	return [
		{
			source: "structural",
			name: "done_without_verify",
			severity: "warning",
			message: `Committing ${sourceEdits.length} source file edit(s) without running any tests in this session. Run the test suite (or the relevant subset) before committing — typecheck and lint don't substitute for running the code.`,
			file: "<session>",
			determinism: "fully_deterministic",
		},
	];
}
