import { hasErrorCode } from "./check-engine/tool-errors.js";
// ===========================================
// CoverageRunner — run a project's suite WITH coverage, parse to per-file
// ===========================================
// The standalone foundation for per-edit coverage enforcement
// (docs/design/per-edit-coverage-enforcement.md, component 2). A runner does
// exactly three things and nothing else:
//   1. spawn the project's test suite under its native coverage engine in
//      `projectRoot`, writing the engine's report into `coverageDir`;
//   2. wall-clock time that run (`suiteMs`);
//   3. parse the emitted report into `Map<repoRelPath, PerFileCoverage>` using
//      the EXISTING coverage readers — never a new parser here.
//
// The block decision, apply-before-disk overlay, and budget-gate are built ON
// TOP of this module in a later step; this file deliberately wires into nothing
// (no evaluator, no verify). It just answers "what does the suite cover right
// now, and how long did it take?".
//
// Reuse map (no parsing is reimplemented here):
//   JS/TS  → vitest's `json` reporter emits `coverage-final.json`, which
//            `loadCoverageFinal` (coverage-final-reader.ts) already parses into
//            the per-function `PerFileCoverage` shape. We point vitest at
//            `coverageDir` and hand the file straight to that reader.
//   Python → coverage.py's native `coverage.json` is PER-LINE
//            (`files["<path>"].executed_lines` / `missing_lines`), with no
//            per-function ranges. The per-edit coverage BLOCK is itself
//            per-line ("is line N this edit added uncovered?"), so the line
//            data is exactly what it needs. The runner parses `executed_lines`/
//            `missing_lines` straight into `PerFileCoverage.coveredLines` /
//            `uncoveredLines` (the per-line fields the gate prefers when
//            present) — no AST function ranges, no LCOV detour. See
//            PythonCoverageRunner.
//
// Beyond coverage, each runner also reports a `testsPassed` signal derived from
// the suite's EXIT CODE (vitest/pytest both exit 1 on test failure, >1 on a
// runner-level error). `ok` ("a coverage report parsed") and `testsPassed`
// ("the tests passed") are orthogonal — a suite with failing tests can still
// emit a coverage report. The per-edit red-bar gate
// (`evaluator/coverage-write-guard.ts`) blocks on `testsPassed === false`.
//
// Errors never throw: a missing/failed runner, missing report, or unparseable
// output all become `{ ok:false, error }` so a caller can degrade gracefully.
//
// The spawn is ASYNC (node:child_process.spawn, not spawnSync): the daemon
// serves every session over one Unix socket, and a synchronous suite run
// blocked its event loop — head-of-line blocking every other session's hooks
// (docs/design/incremental-per-edit-coverage-crap-ratchet.md section 10.1).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCoverageFinal, type PerFileCoverage } from "./coverage-final-reader.js";
import {
	COVERAGE_FINAL_FILENAME,
	COVERAGE_PY_JSON_FILENAME,
	defaultJsTestCommand,
	defaultPythonTestCommand,
} from "./coverage-runner-commands.js";
import { parseCoveragePyJson } from "./coverage-runner-coverage-py.js";
import {
	parsePytestFailingTestFiles,
	parsePytestFailingTests,
	parseVitestFailingTestFiles,
	parseVitestFailingTests,
	withFailingTests,
} from "./coverage-runner-failing-tests.js";

// Re-export the report filenames + default suite commands moved to
// coverage-runner-commands.ts so the public surface is unchanged.
export {
	COVERAGE_FINAL_FILENAME,
	COVERAGE_PY_JSON_FILENAME,
	defaultJsTestCommand,
	defaultPythonTestCommand,
};

// ===========================================
// Public types
// ===========================================

/** Languages a runner can be requested for. */
export type CoverageLanguage = "js" | "ts" | "python";

/**
 * The coverage language for a file path (by extension), or null when no runner
 * covers it. SINGLE SOURCE for the extension→language mapping — the commit gate,
 * the per-edit target resolver, and the deletion paths all consume this one
 * (finding 2026-06: two hand-mirrored `languageForExt` copies were already
 * drifting toward a third).
 */
export function coverageLanguageForPath(filePath: string): CoverageLanguage | null {
	const dot = filePath.lastIndexOf(".");
	const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
	switch (ext) {
		case ".ts":
		case ".tsx":
		case ".mts":
		case ".cts":
			return "ts";
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return "js";
		case ".py":
			// `.pyi` STUBS are deliberately absent: coverage.py never executes or
			// reports them (they are Python's `.d.ts` analogue), so classifying them
			// as coverage targets sent ordinary type-stub edits into the default-on
			// gates where a `class Api: ...` stub blocked as "missing coverage"
			// (finding 2026-06). Lint/quality surfaces keep their own .pyi gating.
			return "python";
		default:
			return null;
	}
}

/** What the caller asks a runner to do. */
export interface CoverageRunOpts {
	/** Absolute project root; the suite runs here and report paths resolve here. */
	projectRoot: string;
	/** Absolute directory the coverage engine should write its report into. */
	coverageDir: string;
	/**
	 * Override the suite command (argv form, no shell). When omitted each runner
	 * uses its language default (e.g. JS → `vitest run --coverage …`).
	 */
	testCommand?: string[];
	/**
	 * Affected-test subset (repo-relative paths, resolved against {@link projectRoot}).
	 * When NON-EMPTY, the runner scopes the suite to exactly these test files
	 * (`vitest run <paths> …` / `pytest <paths> …`) — the fast per-edit path that
	 * lets the overlay run fit the budget. When undefined or empty, the FULL suite
	 * runs (unchanged). Ignored when an explicit {@link testCommand} is supplied —
	 * the caller has taken full control of the argv. See coverage-test-selector.ts.
	 */
	selectedTests?: string[];
	/** Per-run timeout in ms. Defaults to {@link DEFAULT_RUN_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** The result of one coverage run. */
export interface CoverageRunResult {
	/** Wall-clock duration of the suite spawn, in milliseconds. */
	suiteMs: number;
	/** Per-file coverage keyed by repo-relative POSIX path. Empty when `!ok`. */
	perFile: Map<string, PerFileCoverage>;
	/** True only when the suite ran and a report parsed. */
	ok: boolean;
	/** Human-readable reason when `ok` is false. Absent on success. */
	error?: string;
	/**
	 * Whether the suite's tests all passed — ORTHOGONAL to {@link ok} (which is
	 * "did the runner produce a coverage report?"). The red-bar block reads this:
	 *   - `true`  — the suite ran and every test passed (exit 0).
	 *   - `false` — the suite ran but one or more tests FAILED (vitest/pytest
	 *               exit 1). This is the RED state the red-bar gate blocks on.
	 *   - `null`  — could not be determined: the runner did not launch (ENOENT),
	 *               threw, or exited with a runner-level error code (vitest >1 /
	 *               pytest >=2 — interrupted / internal error / usage / no tests
	 *               collected). The red-bar gate fail-opens on `null`.
	 * A coverage report can be emitted even when some tests fail, so `ok` may be
	 * true while `testsPassed` is false.
	 */
	testsPassed: boolean | null;
	/**
	 * A few failing test names/ids for the block message, best-effort parsed from
	 * the runner's stdout/stderr. Absent when none were found or `testsPassed` is
	 * not `false`. Never load-bearing — the exit code is the source of truth for
	 * pass/fail; these names are message sugar only.
	 */
	failingTests?: string[];
	/**
	 * The failing test FILES (as the runner printed them — relative to its cwd,
	 * which for overlay runs mirrors the repo root), best-effort parsed from the
	 * same output. Absent unless `testsPassed === false` and at least one row
	 * parsed. Load-bearing only to WIDEN: debt mode records these on the
	 * `red_suite` obligation so an edit that can influence a failing test is
	 * recognized as part of the red→green loop; a missed/garbled path merely
	 * falls back to the filename-pair rule. The exit code still owns pass/fail.
	 */
	failingTestFiles?: string[];
}

/**
 * Runs a project's test suite with coverage and reports per-file coverage. One
 * implementation per language family; see {@link coverageRunnerFor}.
 */
export interface CoverageRunner {
	/**
	 * Stable execution key. Runners that drive the SAME suite process share an id —
	 * the Vitest runner serves both `js` and `ts` — so the commit gate dedups runs
	 * by id and never executes the same suite twice for a mixed-language commit
	 * (finding 2026-06). Optional for back-compat with test stubs; callers fall back
	 * to the language when it is absent.
	 */
	id?: string;
	run(opts: CoverageRunOpts): Promise<CoverageRunResult>;
}

/** The completed outcome of one spawned suite process (async analogue of `SpawnSyncReturns`). */
export interface SpawnOutcome {
	stdout: string;
	stderr: string;
	/** Exit code; null when the process was signal-killed or never exited cleanly. */
	status: number | null;
	/** Launch/timeout error (ENOENT, ETIMEDOUT, …); the promise resolves, never rejects. */
	error?: Error;
}

/**
 * Injectable spawn — async analogue of `spawnSync` with `encoding: "utf-8"`:
 * resolves with the completed outcome, never rejects. Tests pass a stub and
 * never run a real suite. ASYNC ON PURPOSE: the daemon serves every session
 * over one Unix socket, and the previous synchronous spawn blocked its event
 * loop for the whole suite run — head-of-line blocking every other session's
 * hooks (docs/design/incremental-per-edit-coverage-crap-ratchet.md
 * section 10.1, the Phase 2 prerequisite).
 */
export type SpawnFn = (
	command: string,
	args: string[],
	options: {
		cwd: string;
		timeout: number;
		encoding: "utf-8";
		/** Extra environment merged OVER process.env (added for runtime-oracle
		 *  jobs, e.g. `node --expose-gc` probes needing NODE_OPTIONS; absent =
		 *  inherit unchanged — the historical behavior). */
		env?: Record<string, string>;
	},
) => Promise<SpawnOutcome>;

/** Default per-run timeout (ms). A fast greenfield suite fits comfortably. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;

// ===========================================
// Shared spawn plumbing
// ===========================================

/** Grace before SIGKILL when a timed-out child ignores SIGTERM. */
const KILL_GRACE_MS = 5_000;

/**
 * The production spawn: `node:child_process.spawn` wrapped into one resolved
 * {@link SpawnOutcome}. Mirrors `spawnSync`'s contract — on timeout the child
 * is killed (SIGTERM, then SIGKILL after a grace period) and `error.code` is
 * `"ETIMEDOUT"`; a launch failure (ENOENT) resolves with `error` instead of
 * rejecting. The daemon's event loop stays free for other sessions while the
 * suite runs.
 */
const defaultSpawn: SpawnFn = (command, args, options) =>
	new Promise((resolveOutcome) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				cwd: options.cwd,
				...(options.env ? { env: { ...process.env, ...options.env } } : {}),
			});
		} catch (err) {
			resolveOutcome({
				stdout: "",
				stderr: "",
				status: null,
				error: err instanceof Error ? err : new Error(String(err)),
			});
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		child.stdout?.setEncoding(options.encoding);
		child.stderr?.setEncoding(options.encoding);
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const killTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
		}, options.timeout);
		killTimer.unref();
		const settle = (outcome: SpawnOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			resolveOutcome(outcome);
		};
		child.on("error", (err) => settle({ stdout, stderr, status: null, error: err }));
		child.on("close", (code) =>
			settle(
				timedOut
					? {
							stdout,
							stderr,
							status: null,
							error: Object.assign(
								new Error(`suite timed out after ${options.timeout} ms`),
								{ code: "ETIMEDOUT" },
							),
						}
					: { stdout, stderr, status: code },
			),
		);
	});

/** Outcome of attempting to run a suite command (before report parsing). */
interface SuiteRunOutcome {
	suiteMs: number;
	/** A reason string when the spawn failed/errored; null when it completed. */
	error: string | null;
	/**
	 * The completed spawn result (exit status + captured stdout/stderr), or null
	 * when the spawn never produced one (launch failure / thrown). Each runner
	 * maps `status` → `testsPassed` per its own exit-code contract.
	 */
	result: SpawnOutcome | null;
}

/**
 * Spawn one suite command and time it. Never throws: a launch failure (ENOENT),
 * a thrown/rejected spawn, or an empty command all resolve to an `error`
 * string. A non-zero exit is NOT fatal on its own — coverage can still be
 * emitted by a suite with failing tests — so we only flag a hard launch error
 * here and let the caller decide based on whether a report materialized and
 * what the exit status was (the `result` is returned for that pass/fail
 * interpretation).
 */
/** fast-check case cap for a per-edit (scoped) run — enough to keep property
 *  coverage meaningful while fitting the tight per-edit budget. Full runs
 *  (unscoped) keep the default. See src/test-setup/property-budget.ts (P0.1). */
const PER_EDIT_PROPERTY_NUMRUNS = 25;

/** The env delta capping fast-check for a scoped (per-edit) run, or undefined
 *  for a full run. defaultSpawn merges it over process.env. */
export function perEditBudgetEnv(opts: CoverageRunOpts): Record<string, string> | undefined {
	return opts.selectedTests && opts.selectedTests.length > 0
		? { INTERLINKED_PROPERTY_NUMRUNS: String(PER_EDIT_PROPERTY_NUMRUNS) }
		: undefined;
}

async function runSuite(
	spawnFn: SpawnFn,
	command: string[],
	opts: CoverageRunOpts,
): Promise<SuiteRunOutcome> {
	const [rawBin, ...args] = command;
	if (!rawBin) return { suiteMs: 0, error: "empty test command", result: null };
	// Resolve a bare bin (e.g. "vitest") to the project's local node_modules/.bin —
	// it is not on PATH. The apply-before-disk overlay symlinks node_modules, so it
	// resolves there too; bins not under node_modules/.bin (e.g. pytest) fall back
	// to PATH unchanged. This is what makes the coverage run actually launch.
	const localBin = `${opts.projectRoot}/node_modules/.bin/${rawBin}`;
	const bin = !rawBin.includes("/") && existsSync(localBin) ? localBin : rawBin;
	const timeout = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const start = Date.now();
	let result: SpawnOutcome;
	try {
		const budgetEnv = perEditBudgetEnv(opts);
		result = await spawnFn(bin, args, {
			cwd: opts.projectRoot,
			timeout,
			encoding: "utf-8",
			...(budgetEnv ? { env: budgetEnv } : {}),
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { suiteMs: Date.now() - start, error: `spawn threw: ${reason}`, result: null };
	}
	const suiteMs = Date.now() - start;
	if (result.error) {
		const hint = hasErrorCode(result.error, "ENOENT") ? `'${bin}' not found` : result.error.message;
		return { suiteMs, error: `suite did not run: ${hint}`, result: null };
	}
	return { suiteMs, error: null, result };
}

/**
 * Build the `{ ok:false }` result. `testsPassed` is null — a runner that failed
 * to produce a report could not establish a trustworthy pass/fail signal, so the
 * red-bar gate fail-opens (never blocks on an unmeasured suite).
 */
import { failure, spawnText, testsPassedFromStatus } from "./coverage-run-helpers.js";

// ===========================================
// JavaScript / TypeScript runner
// ===========================================

/**
 * Runs the suite with `vitest run --coverage` (json reporter) and parses the
 * resulting `coverage-final.json` via the existing istanbul reader. The reader
 * already returns `Map<repoRelPath, PerFileCoverage>`, so no parsing lives here.
 * Pass/fail comes from the exit code: 0 → passed, 1 → tests failed, >1 → a
 * runner error (null ⇒ fail-open downstream).
 */
export class JsCoverageRunner implements CoverageRunner {
	/** Shared by `js` and `ts` — one Vitest process covers both. */
	readonly id = "vitest";
	constructor(private readonly spawn: SpawnFn = defaultSpawn) {}

	async run(opts: CoverageRunOpts): Promise<CoverageRunResult> {
		const command =
			opts.testCommand ?? defaultJsTestCommand(opts.coverageDir, opts.selectedTests);
		const outcome = await runSuite(this.spawn, command, opts);
		if (outcome.error || !outcome.result) {
			return failure(outcome.suiteMs, outcome.error ?? "suite did not run");
		}

		const reportPath = join(opts.coverageDir, COVERAGE_FINAL_FILENAME);
		const perFile = loadCoverageFinal(reportPath, opts.projectRoot);
		if (!perFile) {
			return failure(
				outcome.suiteMs,
				`no parseable coverage at ${reportPath} — did the suite emit the json reporter?`,
			);
		}
		const testsPassed = testsPassedFromStatus(outcome.result.status, 1);
		const result: CoverageRunResult = { suiteMs: outcome.suiteMs, perFile, ok: true, testsPassed };
		const text = spawnText(outcome.result);
		return withFailingTests(result, parseVitestFailingTests(text), parseVitestFailingTestFiles(text));
	}
}

// ===========================================
// Python runner (coverage.py)
// ===========================================

/**
 * Python via `pytest --cov --cov-report=json:<dir>/coverage.json` (coverage.py).
 * Runs the suite (timing it), then parses the per-line `coverage.json` into the
 * `Map<repoRelPath, PerFileCoverage>` the interface returns — `executed_lines` →
 * `coveredLines`, `missing_lines` → `uncoveredLines`. The per-edit gate prefers
 * those per-line fields, so an uncovered added `.py` line blocks exactly as it
 * does for JS. Pass/fail comes from the exit code: 0 → passed, 1 → tests failed,
 * >=2 (interrupted / internal error / usage / no tests) → null (fail-open).
 * Never throws: a launch failure, a missing report, or unparseable JSON all
 * become `{ ok:false, error }`.
 */
export class PythonCoverageRunner implements CoverageRunner {
	/** coverage.py / pytest — distinct from the JS/TS Vitest process. */
	readonly id = "coverage-py";
	constructor(private readonly spawn: SpawnFn = defaultSpawn) {}

	async run(opts: CoverageRunOpts): Promise<CoverageRunResult> {
		const command =
			opts.testCommand ?? defaultPythonTestCommand(opts.coverageDir, opts.selectedTests);
		const outcome = await runSuite(this.spawn, command, opts);
		if (outcome.error || !outcome.result) {
			return failure(outcome.suiteMs, outcome.error ?? "suite did not run");
		}

		const reportPath = join(opts.coverageDir, COVERAGE_PY_JSON_FILENAME);
		const perFile = parseCoveragePyJson(reportPath, opts.projectRoot);
		if (!perFile) {
			return failure(
				outcome.suiteMs,
				`no parseable coverage at ${reportPath} — did pytest run with ` +
					"pytest-cov (--cov --cov-report=json)?",
			);
		}
		const testsPassed = testsPassedFromStatus(outcome.result.status, 1);
		const result: CoverageRunResult = { suiteMs: outcome.suiteMs, perFile, ok: true, testsPassed };
		const text = spawnText(outcome.result);
		return withFailingTests(result, parsePytestFailingTests(text), parsePytestFailingTestFiles(text));
	}
}

// ===========================================
// Factory
// ===========================================

/**
 * The runner for a language, or `null` when unsupported. JS and TS share
 * {@link JsCoverageRunner} (vitest covers both). Python returns the real
 * {@link PythonCoverageRunner} (coverage.py JSON → per-line `PerFileCoverage`).
 * `spawn` is forwarded so callers/tests can inject a stub.
 */
export function coverageRunnerFor(
	language: string,
	spawn?: SpawnFn,
): CoverageRunner | null {
	const inject = spawn ?? defaultSpawn;
	switch (language) {
		case "js":
		case "ts":
			return new JsCoverageRunner(inject);
		case "python":
			return new PythonCoverageRunner(inject);
		default:
			return null;
	}
}
