// ===========================================
// Coverage discharge — the observed-green-run relief path
// ===========================================
// The Stop nudge (`verification-stop-checks.ts::formatDeferredCoverageWarning`)
// tells the user: "Run the suite + coverage to check these now, or commit". The
// commit half was real (the commit gate discharges on a clean pass), but the
// run half was a promise nothing recorded — `recordCoverageDischarge` had no
// caller outside the commit gate, so a user who followed the instruction kept
// receiving the same warning every Stop (finding 2026-06).
//
// This module closes the loop. The PostToolUse pipeline calls
// {@link dischargeObligationsAfterGreenRun} when it observes a coverage-suite
// Bash command complete GREEN; every open obligation whose file the fresh
// report actually MEASURED is discharged. Two honesty guards keep the standard
// measured, not claimed:
//   - per-file: a scoped run that never loaded the obligated file leaves its
//     obligation open (the report's file set is the evidence);
//   - freshness: a report OLDER than the obligation is not evidence — the
//     deferred edit post-dates it.
// The Stop nudge stays the reflective surface and the commit gate stays the
// enforcement surface; this only makes the documented relief path true.
//
// Deterministic throughout (regex + report parse + mtime compare — no
// inference), total / never throws: discharge bookkeeping must never crash the
// PostToolUse pipeline.

import { join } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { lcovReportPaths } from "./coverage-adapters.js";
import { loadCoverageFinal } from "./coverage-final-reader.js";
import { loadLcovFile } from "./coverage-lcov.js";
import {
	readOpenCoverageObligations,
	recordCoverageDischarge,
} from "./coverage-obligation-ledger.js";
import { mtimeOrZero } from "./mtime-or-zero.js";
import { shellSplit, splitSegments, stripLeadingPrefix } from "./shell-structure.js";

// ===========================================
// Coverage-suite command classification — argv-positional, never lexical
// ===========================================
// Classification works on the blessed shell-structure tokenization (segments →
// argv), NEVER by regex over the raw string: `touch coverage/lcov.info && echo
// 'pytest --cov'` lexically contains a runner + flag, but its only commands
// are `touch` and `echo` — the old regexes classified it as a green coverage
// run and the touched stale report discharged obligations without one test
// executing (finding 2026-06, round 6). Per segment, the HEAD token decides
// what is being run; quoted arguments are data.

/** Subcommands of nyc/c8 that re-emit or manage EXISTING data (no test runs). */
const REPORT_ONLY_SUBCOMMANDS = new Set(["report", "merge", "instrument", "check-coverage"]);

/** Argv tokens that make `cargo llvm-cov` a non-suite invocation: report
 *  emission/maintenance, and `run` (executes the BINARY, not the suite). Bare
 *  `cargo llvm-cov` and its `test`/`nextest` forms run the suite by default.
 *  Token-exact, so `--no-report` no longer disqualifies a real suite run the
 *  way the round-5 word-scan did. */
const CARGO_NON_SUITE_TOKENS = new Set(["report", "show-env", "clean", "run"]);

/** Python test-runner tokens, as a bare head (`pytest --cov`) or the `-m`
 *  module of a python/coverage invocation (`coverage run -m pytest`). */
const PY_RUNNER_TOKENS = new Set(["pytest", "py.test", "unittest", "nose2"]);

/** JS test runners recognized as the head command of a segment. */
const JS_RUNNER_HEADS = new Set(["vitest", "jest", "mocha", "ava"]);

/** Launcher heads whose real command follows (`npx vitest …`). */
const LAUNCHER_HEADS = new Set(["npx", "bunx"]);

/** Coverage wrappers that instrument whatever command follows. */
const COVERAGE_WRAPPER_HEADS = new Set(["nyc", "c8"]);

/** A node script whose BASENAME is test-named (`test.js`, `app.test.mjs`,
 *  `parser.spec.js`) — the no-framework way to run a test file under c8/nyc. */
const TEST_SCRIPT_RE = /(?:^|\/)[^\s/]*(?:test|spec)[^\s/]*\.[cm]?js$/i;

/** Last path segment, so `./node_modules/.bin/vitest` reads as `vitest`. */
function headName(token: string): string {
	return token.split("/").pop() ?? token;
}

/** Tokenized argv of one segment: env/sudo prefixes and launcher heads
 *  (npx/bunx, plus their own leading flags) are stripped to the real command. */
function segmentArgv(segment: string): string[] {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	while (tokens.length > 0 && LAUNCHER_HEADS.has(headName(nonNull(tokens[0])))) {
		tokens.shift();
		while (tokens.length > 0 && nonNull(tokens[0]).startsWith("-")) tokens.shift();
	}
	return tokens;
}

/** True when this argv IS a test-runner invocation (head-positional). */
function isRunnerInvocation(argv: string[]): boolean {
	const head = headName(argv[0] ?? "");
	if (JS_RUNNER_HEADS.has(head) || PY_RUNNER_TOKENS.has(head)) return true;
	if (head === "node") {
		return argv.includes("--test") || argv.slice(1).some((t) => TEST_SCRIPT_RE.test(t));
	}
	if (head === "npm" || head === "pnpm" || head === "yarn") {
		const sub = argv[1] === "run" ? argv[2] : argv[1];
		return typeof sub === "string" && sub.startsWith("test");
	}
	if (head === "bun") return argv[1] === "test";
	if (head.startsWith("python")) {
		const mIdx = argv.indexOf("-m");
		return mIdx !== -1 && PY_RUNNER_TOKENS.has(argv[mIdx + 1] ?? "");
	}
	return false;
}

function pythonCoverageModuleArgv(argv: string[]): string[] | null {
	const head = headName(argv[0] ?? "");
	if (!head.startsWith("python")) return null;
	const mIdx = argv.indexOf("-m");
	return mIdx !== -1 && argv[mIdx + 1] === "coverage" ? argv.slice(mIdx + 1) : null;
}

/** Coverage flags as argv TOKENS (`--coverage`, vitest's dotted
 *  `--coverage.*`, pytest-cov's `--cov`/`--cov=…`/`--cov-report…`). */
function hasCoverageFlagToken(argv: string[]): boolean {
	return argv.some(
		(t) =>
			t === "--coverage" ||
			t.startsWith("--coverage.") ||
			t === "--cov" ||
			t.startsWith("--cov=") ||
			t.startsWith("--cov-report"),
	);
}

/** Verdict for a coverage-wrapper head (`nyc`/`c8`) wrapping the rest of the
 *  segment's argv. Skips the wrapper's own leading flags (`c8
 *  --reporter=lcov mocha`) — a separate-value flag leaves its value in
 *  argv[0] and the runner check then fails, which is the safe
 *  under-matching direction (obligation stays open) — then rejects an empty
 *  or report-only wrapped command before checking for a real runner. */
function isCoverageWrapperSuiteInvocation(argv: string[]): boolean {
	const wrapped = argv.slice(1);
	while (wrapped.length > 0 && nonNull(wrapped[0]).startsWith("-")) wrapped.shift();
	if (wrapped.length === 0 || REPORT_ONLY_SUBCOMMANDS.has(nonNull(wrapped[0]))) return false;
	return isRunnerInvocation(wrapped);
}

/** One segment's verdict; see {@link isCoverageSuiteCommand}. */
function isCoverageSuiteSegment(argv: string[]): boolean {
	if (argv.length === 0) return false;
	const head = headName(nonNull(argv[0]));
	if (head.startsWith("#")) return false; // comment, not a command
	if (head === "cargo" && argv[1] === "llvm-cov") {
		return !argv.slice(2).some((t) => CARGO_NON_SUITE_TOKENS.has(t));
	}
	if (head === "coverage" && argv[1] === "run") {
		return argv.slice(2).some((t) => PY_RUNNER_TOKENS.has(t));
	}
	const pythonCoverageArgv = pythonCoverageModuleArgv(argv);
	if (pythonCoverageArgv) return isCoverageSuiteSegment(pythonCoverageArgv);
	if (COVERAGE_WRAPPER_HEADS.has(head)) return isCoverageWrapperSuiteInvocation(argv);
	return isRunnerInvocation(argv) && hasCoverageFlagToken(argv);
}

/**
 * True when a Bash command runs a TEST SUITE under coverage — the deterministic
 * trigger for the discharge pass. A test run without coverage, a coverage
 * EXPORT without a run (`coverage lcov -o …`), a coverage wrapper around a
 * NON-test program (`coverage run app.py`, `c8 node server.js`), or runner
 * text inside quotes/echo arguments is not one.
 */
export function isCoverageSuiteCommand(command: string): boolean {
	if (!command) return false;
	return splitSegments(command).some((seg) => isCoverageSuiteSegment(segmentArgv(seg)));
}

// ===========================================
// Run-window binding (finding 2026-06, round 6)
// ===========================================
// A report's freshness was judged only against the OBLIGATION's age, so a
// report written by a FAILED run (after the obligation) still discharged when
// a later green scoped run — which never rewrote that report — triggered the
// pass. Evidence must be bound to the observed green run itself: the
// PreToolUse pipeline notes when a coverage-suite Bash command STARTS, and the
// discharge pass accepts only reports modified at/after that start. No
// observed start ⇒ no discharge (fail toward keeping the obligation; the next
// observed run discharges normally). Single in-flight run per session —
// concurrent coverage runs overwrite the start, narrowing the window, which
// can only under-discharge.

const SUITE_RUN_STARTS = new Map<string, number>();

/** Filesystem mtime granularity + clock skew allowance for the window check. */
const RUN_WINDOW_SKEW_MS = 2000;

/** PreToolUse note: a coverage-suite Bash command is starting for `sessionId`. */
export function noteCoverageSuiteRunStart(sessionId: string, timestamp?: string): void {
	const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
	SUITE_RUN_STARTS.set(sessionId, Number.isFinite(parsed) ? parsed : Date.now());
}

/** One parsed coverage report: the repo-relative files it measured + its mtime. */
export interface MeasuredReport {
	files: ReadonlySet<string>;
	mtimeMs: number;
}

/**
 * Every existing coverage report's measured-file set: the istanbul
 * `coverage-final.json` plus each LCOV report (canonical + per-language —
 * the same candidate list the metrics/ratchet readers merge). Reports are kept
 * separate (not unioned) so each file's evidence carries ITS report's mtime.
 */
export function measuredCoverageFiles(projectRoot: string): MeasuredReport[] {
	const reports: MeasuredReport[] = [];
	const finalPath = join(projectRoot, "coverage", "coverage-final.json");
	const finalCov = loadCoverageFinal(finalPath, projectRoot);
	if (finalCov) reports.push({ files: new Set(finalCov.keys()), mtimeMs: mtimeOrZero(finalPath) });
	for (const rel of lcovReportPaths()) {
		const path = join(projectRoot, rel);
		const lcov = loadLcovFile(path, { cwd: projectRoot });
		if (lcov) reports.push({ files: new Set(lcov.files.keys()), mtimeMs: mtimeOrZero(path) });
	}
	return reports;
}

/**
 * Discharge every open obligation of `sessionId` whose file a fresh-enough
 * report measured. Freshness is TWO conjuncts: the report postdates the
 * obligation (an unparseable obligation timestamp degrades to "any report
 * counts" rather than blocking the relief), AND it was written at/after the
 * OBSERVED run's start (see {@link noteCoverageSuiteRunStart}) — a report a
 * failed earlier run left behind is not this run's evidence (round 6).
 * Returns the discharged files. Call AFTER observing a GREEN coverage-suite
 * run — green-ness is the caller's evidence; measurement and freshness are
 * checked here. Never throws.
 */
export function dischargeObligationsAfterGreenRun(
	projectRoot: string,
	sessionId: string,
	timestamp: string,
): string[] {
	try {
		const runStart = SUITE_RUN_STARTS.get(sessionId);
		SUITE_RUN_STARTS.delete(sessionId);
		if (runStart === undefined) return []; // start unobserved → cannot bind evidence
		const open = readOpenCoverageObligations(projectRoot, sessionId);
		if (open.length === 0) return [];
		const reports = measuredCoverageFiles(projectRoot);
		if (reports.length === 0) return [];
		const discharged: string[] = [];
		for (const obligation of open) {
			const openedAt = Date.parse(obligation.timestamp);
			const measured = reports.some(
				(r) =>
					r.files.has(obligation.file) &&
					(!Number.isFinite(openedAt) || r.mtimeMs >= openedAt) &&
					r.mtimeMs >= runStart - RUN_WINDOW_SKEW_MS,
			);
			if (!measured) continue;
			recordCoverageDischarge(projectRoot, obligation.file, sessionId, timestamp);
			discharged.push(obligation.file);
		}
		return discharged;
	} catch {
		return []; // bookkeeping must never crash the PostToolUse pipeline
	}
}
