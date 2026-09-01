// ===========================================
// Fixture-Leak — Stop-time orphan-fixture detector
// ===========================================
//
// Catches the test-cleanup-leak pattern: a test calls
// `writeFixture(NAME, ...)` (or `setupFixture` / `createFixture`) under
// `src/**/` and its `afterAll`/`afterEach` was meant to `rmFixture` the
// file, but the cleanup didn't run (test killed mid-run, the cleanup
// itself threw, runner panicked, etc.). The file is left untracked in
// the working tree.
//
// Detection is deterministic — no LLM, no heuristic about content. The
// path must (a) be untracked, (b) live under `src/`, (c) have an
// underscore-prefixed basename in the conventional fixture-leak shape,
// and (d) its basename must appear as a string literal in a test file
// that also contains a fixture-writer call. All four conditions must
// hold; the call-shape requirement is what stops the basename appearing
// in a code comment from false-positiving.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ServerRuntime } from "./server/runtime-context.js";
import type { HarnessEvent } from "./types.js";

/** Underscore-prefixed source-code basename. The convention is project-
 *  specific: `_multi_edit_case_a.ts` / `_case_b.tsx` / `_fixture_x.py`. */
const FIXTURE_BASENAME_RE =
	/^_[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt)$/;

/** Test file path shapes recognized across runners. */
const TEST_FILE_RE = /\.(?:test|spec)\.[jt]sx?$|__tests__\/[^/]+\.[jt]sx?$|\/tests\//;

/** Fixture-writer call shapes. The detector requires at least one such
 *  call somewhere in the test file alongside the basename string before
 *  flagging — a basename appearing only in a comment is not enough. */
const FIXTURE_WRITER_CALL_RE =
	/\b(?:writeFixture|setupFixture|createFixture|makeFixture)\s*\(/;

const GIT_TIMEOUT_MS = 3_000;

interface FixtureLeak {
	/** Repo-relative path of the orphaned fixture. */
	file: string;
	/** Repo-relative path of the test file that creates this fixture. */
	referencedBy: string;
}

/**
 * Scan the working tree for untracked `src/**\/_*.ts`-shaped files whose
 * basename also appears in a test file that uses `writeFixture(`-style
 * helper. Returns the empty list on any failure (not a repo, no git
 * binary, none found, …) so the caller can treat the result as advisory.
 */
export function detectFixtureLeaks(cwd: string = process.cwd()): FixtureLeak[] {
	const untracked = listUntracked(cwd);
	if (untracked.length === 0) return [];

	const candidates = untracked.filter(isFixtureCandidatePath);
	if (candidates.length === 0) return [];

	const testContents = loadTrackedTestContents(cwd);
	if (testContents.size === 0) return [];

	const leaks: FixtureLeak[] = [];
	for (const candidate of candidates) {
		const name = basename(candidate);
		for (const [testFile, content] of testContents) {
			if (!content.includes(name)) continue;
			if (!FIXTURE_WRITER_CALL_RE.test(content)) continue;
			leaks.push({ file: candidate, referencedBy: testFile });
			break;
		}
	}
	return leaks;
}

function isFixtureCandidatePath(path: string): boolean {
	if (!path.startsWith("src/")) return false;
	return FIXTURE_BASENAME_RE.test(basename(path));
}

function listUntracked(cwd: string): string[] {
	try {
		const stdout = execSync("git ls-files --others --exclude-standard", {
			cwd,
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return stdout.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function loadTrackedTestContents(cwd: string): Map<string, string> {
	const out = new Map<string, string>();
	let tracked: string[];
	try {
		const stdout = execSync("git ls-files", {
			cwd,
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["pipe", "pipe", "pipe"],
		});
		tracked = stdout.split("\n").filter(Boolean);
	} catch {
		return out;
	}
	for (const path of tracked) {
		if (!TEST_FILE_RE.test(path)) continue;
		try {
			out.set(path, readFileSync(join(cwd, path), "utf-8"));
		} catch {
			// intentional: unreadable test file — skip.
		}
	}
	return out;
}

interface FormatFixtureLeakOpts {
	leaks: ReadonlyArray<FixtureLeak>;
	maxShown?: number;
}

/**
 * Stop-event formatter — produce a warning string listing orphaned
 * fixture files. Returns null when there are none. Same stderr-only,
 * never-block contract as the other verification-stop-check formatters.
 */
export function formatFixtureLeakWarning(opts: FormatFixtureLeakOpts): string | null {
	if (opts.leaks.length === 0) return null;
	const max = opts.maxShown ?? 5;
	const shown = opts.leaks.slice(0, max);
	const lines = shown.map((l) => `  - ${l.file}  (created by ${l.referencedBy})`);
	const more =
		opts.leaks.length > max ? `\n  ...and ${opts.leaks.length - max} more` : "";
	return (
		`[interlinked:fixture-leak] Stopping with ${opts.leaks.length} orphaned test fixture(s) ` +
		`under src/ — files whose basename appears in a writeFixture()/setupFixture()/` +
		`createFixture() call but never got cleaned up:\n${lines.join("\n")}${more}\n` +
		"The test's afterAll/afterEach was supposed to rm these and didn't (the cleanup " +
		"threw, the runner was killed mid-test, or the file path drifted from the helper). " +
		"Either fix the cleanup helper or `rm` the listed files before stopping."
	);
}

/** Stop-wiring entry point — relocated from lifecycle-stop-warnings.ts (line-cap
 *  pressure) alongside its own detect/format pair, matching the co-located
 *  pattern dead-on-arrival.ts / untested-exports-stop-check.ts already use.
 *  Behavior unchanged: same name, same signature, so the call site in
 *  buildVerificationStopWarnings needed no edit, only its import source. */
export function checkFixtureLeaks(ctx: ServerRuntime, event: HarnessEvent): string | null {
	const leaks = detectFixtureLeaks(event.cwd || ctx.cwd);
	const warning = formatFixtureLeakWarning({ leaks });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: fixture-leaks (${leaks.length})`);
	return warning;
}
