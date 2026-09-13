// ===========================================
// Per-Language Test Dispatchers for `affected_tests`
// ===========================================
// Dispatches the affected_tests quality check to a language-appropriate
// test runner (vitest, pytest, cargo test, go test). Each dispatcher owns
// its own invocation shape and pre-existing-failure classification.
//
// Keeps the runQualityChecks main body lean: the dispatch loop in
// quality-checks.ts just looks up the dispatcher by LanguageId and calls it.

import { existsSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { goBuildTagArgs, goToolTags } from "../check-engine/tool-runners/go-invocation.js";
import type { LanguageId, LanguageProfile } from "../types.js";
import { scheduleTests } from "../test-scheduler.js";
import { buildTestCandidates, classifyTestFailure } from "./test-classifier.js";
import { runBoundedTestProcess } from "./test-process-gate.js";
/** Maximum selected test files in one hook run. Larger or full plans remain queued. */
const DEFAULT_MAX_DEPENDENT_TESTS = 150;

interface TestDispatcherInput {
	/** Path as reported by the agent (may be relative) */
	filePath: string;
	/** Absolute filesystem path of the edited file */
	absPath: string;
	/** Project root resolved by findProjectRoot() */
	checkCwd: string;
	/** LanguageProfile for the edited file's language */
	profile: LanguageProfile;
	/** Per-check timeout from config */
	timeoutMs: number;
	/** Configured severity (forwarded into every result) */
	severity: "error" | "warning";
	/** Check name to stamp on results (usually "affected_tests") */
	checkName: string;
	/** `affected_tests` only: cap on all selected test files
	 *  (see {@link DEFAULT_MAX_DEPENDENT_TESTS}). Absent → the default. */
	maxDependentTests?: number;
}

interface TestDispatcherResult {
	name: string;
	severity: "error" | "warning";
	message: string;
	file: string;
	detail: string;
}

/**
 * Dispatch an affected_tests run for the given language. Returns zero or
 * more results to append to the check pipeline's findings. Must never throw;
 * unavailable/interrupted execution becomes an explicit deferred warning so
 * a missing toolchain or killed runner cannot be mistaken for a clean test.
 */
export type TestDispatcher = (
	input: TestDispatcherInput,
) => TestDispatcherResult[] | Promise<TestDispatcherResult[]>;

/** Public API — consumed by quality-checks.runQualityChecks. */
export const TEST_DISPATCHERS: Partial<Record<LanguageId, TestDispatcher>> = {
	typescript: runVitestDispatcher,
	python: runPytestDispatcher,
	rust: runCargoTestDispatcher,
	go: runGoTestDispatcher,
};

// ===========================================
// Shared helpers
// ===========================================

// interlinked-ignore: duplicated_policy_constant — coincidental value match
// only; this governs truncated-output line count, unrelated to
// DEFAULT_MAX_DEPENDENT_TESTS's companion-test-file cap.
function truncateTail(output: string, lines = 8): string {
	return output.split("\n").slice(-lines).join("\n");
}

function combinedOutput(result: { stdout?: string | null; stderr?: string | null }): string {
	const stdout = (result.stdout || "").trim();
	const stderr = (result.stderr || "").trim();
	if (stdout && stderr) return `${stderr}\n${stdout}`;
	return stdout || stderr;
}

// ===========================================
// TypeScript / JavaScript (vitest)
// ===========================================
// One shared planner owns static, companion, declared and recorded dependencies.

const DEFERRED_TEST_REASONS = {
	busy: "another test check is running",
	timeout: "test process timed out",
	interrupted: "test process was interrupted",
	unavailable: "test process could not be started",
} as const;

function deferredTestResult(
	input: TestDispatcherInput,
	reason: keyof typeof DEFERRED_TEST_REASONS,
): TestDispatcherResult {
	return {
		name: "affected_tests_deferred",
		severity: "warning",
		message: `Affected tests deferred for ${input.filePath} (${DEFERRED_TEST_REASONS[reason]})`,
		file: input.filePath,
		detail: "No test verdict was produced. The daemon kept serving instead of queueing more memory-heavy work; re-run the affected test after the active check finishes.",
	};
}

async function runVitestDispatcher(input: TestDispatcherInput): Promise<TestDispatcherResult[]> {
    if (!(input.profile.test_runner?.command ?? "npx vitest run").includes("vitest")) return [{
        name: "affected_tests_deferred", severity: "warning", file: input.filePath,
        message: "Affected tests unavailable", detail: "The configured runner is not Vitest; no run was scheduled.",
    }];
    try {
        const result = await scheduleTests({ root: input.checkCwd, paths: [input.absPath], timeoutMs: input.timeoutMs,
            maxTests: input.maxDependentTests ?? DEFAULT_MAX_DEPENDENT_TESTS, waitForCapacity: false });
        if (result.status === "passed") return [];
        if (result.status === "failed") return [{ name: input.checkName, severity: input.severity,
            file: input.filePath, message: `Tests failed for ${input.filePath}`, detail: result.output }];
        return [plannedTestDeferral(input, result.reason)];
    } catch (error) {
        return [plannedTestDeferral(input, error instanceof Error ? error.message : "Test planning unavailable")];
    }
}

function plannedTestDeferral(input: TestDispatcherInput, detail: string): TestDispatcherResult {
    return { name: "affected_tests_deferred", severity: "warning", file: input.filePath,
        message: "Affected test request retained", detail };
}

// ===========================================
// Python (pytest)
// ===========================================
// Uses filename convention via LANG_TEST_CANDIDATE_EMITTERS.python. Runs
// `python -m pytest <testfile> -x --tb=short -q` so the test runner doesn't
// collect the whole project — we only care about tests related to the
// edited source file.

async function runPytestDispatcher(input: TestDispatcherInput): Promise<TestDispatcherResult[]> {
	const testFile = findFirstExistingCandidate(input.absPath, input.profile);
	if (!testFile) return [];
	const rel = relativizeFromRoot(testFile, input.checkCwd);
	const run = await runBoundedTestProcess({
		command: "python",
		args: ["-m", "pytest", "-x", "--tb=short", "-q", rel],
		cwd: input.checkCwd,
		timeoutMs: input.timeoutMs,
	});
	if (run.kind === "deferred") return [deferredTestResult(input, run.reason)];
	if (run.code === 0) return [];

	const output = combinedOutput(run);
	const classification = classifyTestFailure(`pytest:${rel}`, output, "python");
	if (classification === "pre-existing") return [];

	return [
		{
			name: input.checkName,
			severity: input.severity,
			message: `Tests failed for ${input.filePath} (pytest ${rel})`,
			file: input.filePath,
			detail: truncateTail(output),
		},
	];
}

// ===========================================
// Rust (cargo test --no-run)
// ===========================================
// Cargo tests are project-wide; no per-file scoping. We compile-check with
// `--no-run` to catch test build breakage without the cost of actual
// execution. The whole-project nature means we must be strict about
// classifying pre-existing (unresolved imports, missing manifest) — a
// false-positive here silently hides a real regression.

async function runCargoTestDispatcher(input: TestDispatcherInput): Promise<TestDispatcherResult[]> {
	const run = await runBoundedTestProcess({
		command: "cargo",
		args: ["test", "--no-run", "--message-format=short"],
		cwd: input.checkCwd,
		timeoutMs: input.timeoutMs,
	});
	if (run.kind === "deferred") return [deferredTestResult(input, run.reason)];
	if (run.code === 0) return [];

	const output = combinedOutput(run);
	const classification = classifyTestFailure(`cargo:${input.checkCwd}`, output, "rust");
	if (classification === "pre-existing") return [];

	return [
		{
			name: input.checkName,
			severity: input.severity,
			message: `Tests failed to compile for ${input.filePath} (cargo test --no-run)`,
			file: input.filePath,
			detail: truncateTail(output),
		},
	];
}

// ===========================================
// Go (go test ./<pkgdir>)
// ===========================================
// Scopes to the edited file's package. Running `go test ./...` on every
// edit is too slow and pollutes output with failures in unrelated packages.
//
// Build tags come from the shared Go invocation policy so this compile lands
// in the SAME build-cache key set as `go build` / golangci-lint in
// check-engine/tool-runners/go.ts. Without that, three per-edit Go
// compilations each populate a different cache and re-do each other's work.

async function runGoTestDispatcher(input: TestDispatcherInput): Promise<TestDispatcherResult[]> {
	const pkgDir = dirname(input.absPath);
	const relPkg = relative(input.checkCwd, pkgDir) || ".";
	// Prepend ./ to avoid accidental module-path interpretation.
	const pkgArg = relPkg.startsWith(".") ? relPkg : `./${relPkg.split(sep).join("/")}`;
	const tagArgs = goBuildTagArgs(goToolTags(process.env));

	const run = await runBoundedTestProcess({
		command: "go",
		args: ["test", "-count=1", ...tagArgs, pkgArg],
		cwd: input.checkCwd,
		timeoutMs: input.timeoutMs,
	});
	if (run.kind === "deferred") return [deferredTestResult(input, run.reason)];
	if (run.code === 0) return [];

	const output = combinedOutput(run);
	const classification = classifyTestFailure(`gotest:${pkgArg}`, output, "go");
	if (classification === "pre-existing") return [];

	return [
		{
			name: input.checkName,
			severity: input.severity,
			message: `Tests failed for ${input.filePath} (go test ${pkgArg})`,
			file: input.filePath,
			detail: truncateTail(output),
		},
	];
}

// ===========================================
// Small local helpers
// ===========================================

function findFirstExistingCandidate(
	absPath: string,
	profile: LanguageProfile,
): string | null {
	const ext = extname(absPath);
	const base = absPath.slice(0, -ext.length);
	const dir = dirname(absPath);
	const baseName = absPath.slice(dir.length + 1, -ext.length);
	const candidates = buildTestCandidates(absPath, ext, base, dir, baseName, profile);
	return candidates.find((t) => existsSync(t)) ?? null;
}

function relativizeFromRoot(absPath: string, root: string): string {
	const prefix = join(root, sep);
	return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

// Exported helpers for tests. Dispatcher internals stay private otherwise.
export const __test_only__ = {
	runVitestDispatcher,
	runPytestDispatcher,
	runCargoTestDispatcher,
	runGoTestDispatcher,
	relativizeFromRoot,
};
