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
import { dirname, extname, relative, resolve, sep } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import type { LanguageId, LanguageProfile } from "../types.js";
import type { ResolvedToolCommand } from "../check-engine/types.js";
import { findDirectImporters } from "./direct-importers.js";
import { buildTestCandidates, classifyTestFailure } from "./test-classifier.js";
import { runBoundedTestProcess } from "./test-process-gate.js";

/**
 * `affected_tests` only, TypeScript/JavaScript: ceiling on how many DIRECT
 * importers' companion test files one edit may run (see
 * {@link runDirectImporterCompanions}). Config knob:
 * `quality_checks.affected_tests.max_dependent_tests` in
 * `.interlinked/guard-rules.local.json` (falls back to this constant when
 * absent). Kept intentionally small — this is a bounded, one-hop expansion
 * of the affected-tests check, not the transitive/whole-suite selection the
 * mutation gate's `MAX_MUTATION_TEST_SCOPE` (150) performs; past this many
 * companion files in one PostToolUse pass, the runtime cost outweighs the
 * value of running them inline, so the edit is reported and skipped instead
 * (never silently widened or silently truncated to an arbitrary subset).
 */
export const DEFAULT_MAX_DEPENDENT_TESTS = 8;

export interface TestDispatcherInput {
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
	/** `affected_tests` only: cap on direct-importer companion test files
	 *  (see {@link DEFAULT_MAX_DEPENDENT_TESTS}). Absent → the default. */
	maxDependentTests?: number;
	/** `affected_tests` only, Go: resolved `go_test` command override from
	 *  `.interlinked/tool-commands*.json`. A full `command` argv is used
	 *  verbatim; otherwise configured `base_args` carry the project's flags
	 *  (e.g. build tags) into the touched-package run. */
	commandOverride?: ResolvedToolCommand | undefined;
}

export interface TestDispatcherResult {
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
export const TEST_DISPATCHERS = {
	typescript: runVitestDispatcher,
	python: runPytestDispatcher,
	rust: runCargoTestDispatcher,
	go: runGoTestDispatcher,
} satisfies Partial<Record<LanguageId, TestDispatcher>>;

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
// Extracted verbatim from the pre-refactor quality-checks.ts block.
// First tries `vitest --related` for module-graph-aware discovery, then
// falls back to filename-convention test lookup.

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
	const { filePath, absPath, profile, checkCwd, timeoutMs, severity, checkName } = input;
	const results: TestDispatcherResult[] = [];
	const runnerCmd = profile.test_runner?.command || "npx vitest run";
	if (!runnerCmd.includes("vitest")) return [];

	// 1) vitest --related
	const relatedRun = await runBoundedTestProcess({
		command: "npx",
		args: ["vitest", "run", "--related", absPath, "--reporter=verbose"],
		cwd: checkCwd,
		timeoutMs,
	});
	if (relatedRun.kind === "deferred") return [deferredTestResult(input, relatedRun.reason)];
	const relatedResult = relatedRun;

	const relatedOutput = combinedOutput(relatedResult);
	const unknownOption = /unknown option/i.test(relatedOutput);
	let ranViaRelated = false;

	if (!unknownOption) {
		ranViaRelated = true;
		if (relatedResult.code !== 0) {
			const classification = classifyTestFailure(
				`related:${absPath}`,
				relatedOutput,
				"typescript",
			);
			if (classification !== "pre-existing") {
				results.push({
					name: checkName,
					severity,
					message: `Tests failed for ${filePath} (vitest --related)`,
					file: filePath,
					detail: truncateTail(relatedOutput),
				});
			}
		}
	}

	// 2) Convention fallback
	if (!ranViaRelated) {
		const ext = extname(absPath);
		const base = absPath.slice(0, -ext.length);
		const dir = dirname(absPath);
		const baseName = absPath.slice(dir.length + 1, -ext.length);
		const candidates = buildTestCandidates(absPath, ext, base, dir, baseName, profile);
		const testFile = candidates.find((t) => existsSync(t));
		if (testFile) {
			const relTest = testFile.startsWith(checkCwd)
				? testFile.slice(checkCwd.length + 1)
				: testFile;
			const runnerParts = runnerCmd.split(/\s+/).filter(Boolean);
			const run = await runBoundedTestProcess({
				command: nonNull(runnerParts[0]),
				args: [...runnerParts.slice(1), relTest, "--reporter=verbose"],
				cwd: checkCwd,
				timeoutMs,
			});
			if (run.kind === "deferred") return [...results, deferredTestResult(input, run.reason)];
			const result = run;
			if (result.code !== 0) {
				const output = combinedOutput(result);
				const classification = classifyTestFailure(`conv:${relTest}`, output, "typescript");
				if (classification !== "pre-existing") {
					results.push({
						name: checkName,
						severity,
						message: `Tests failed for ${filePath} (${relTest})`,
						file: filePath,
						detail: truncateTail(output),
					});
				}
			}
		}
	}

	// 3) Direct importers — bounded, additive to phases 1/2 above. A
	// companion test belonging to a file that DIRECTLY imports the edited
	// file is a distinct concern from the edited file's own test, so this
	// runs regardless of whether phases 1/2 found (or reported) anything.
	results.push(...(await runDirectImporterCompanions(input)));

	return results;
}

/** Result of {@link capDependentTests} — a discriminated union so callers
 *  must branch on `kind` before reading either payload field. */
export type DependentTestCapDecision =
	| { kind: "ok"; tests: string[] }
	| { kind: "over_cap"; count: number };

/**
 * Cap decision for the direct-importer companion-test set — pure and
 * independently testable (no fs, no subprocess). `≤ cap` runs everything;
 * over cap declines the WHOLE set rather than an arbitrary truncated
 * subset, so "N dependent test files not run" always names the true count,
 * never a silently-dropped remainder.
 */
export function capDependentTests(
	companionTests: readonly string[],
	cap: number,
): DependentTestCapDecision {
	if (companionTests.length > cap) return { kind: "over_cap", count: companionTests.length };
	return { kind: "ok", tests: [...companionTests] };
}

/**
 * Phase 3 of {@link runVitestDispatcher}: resolve the edited file's DIRECT
 * importers (one hop, via {@link findDirectImporters} — no project-wide
 * graph build) and run each importer's OWN companion test, bounded by
 * `input.maxDependentTests` (default {@link DEFAULT_MAX_DEPENDENT_TESTS}).
 *
 * Over cap: reports the skip and runs nothing for this phase — see
 * {@link capDependentTests}. Under cap: every companion test file runs in
 * ONE vitest invocation (not one spawn per file).
 */
async function runDirectImporterCompanions(
	input: TestDispatcherInput,
): Promise<TestDispatcherResult[]> {
	const { filePath, absPath, profile, checkCwd, timeoutMs, severity, checkName } = input;
	const cap = input.maxDependentTests ?? DEFAULT_MAX_DEPENDENT_TESTS;

	const importers = findDirectImporters({ absPath, projectRoot: checkCwd });
	if (importers.length === 0) return [];

	const companionTests: string[] = [];
	for (const importer of importers) {
		const ext = extname(importer);
		const base = importer.slice(0, -ext.length);
		const dir = dirname(importer);
		const baseName = importer.slice(dir.length + 1, -ext.length);
		const candidates = buildTestCandidates(importer, ext, base, dir, baseName, profile);
		const testFile = candidates.find((t) => existsSync(t));
		if (testFile && !companionTests.includes(testFile)) companionTests.push(testFile);
	}
	if (companionTests.length === 0) return [];

	const decision = capDependentTests(companionTests, cap);
	if (decision.kind === "over_cap") {
		return [
			{
				name: checkName,
				severity: "warning",
				message: `${decision.count} dependent test files not run (over cap)`,
				file: filePath,
				detail: `Direct importers of ${filePath} have ${decision.count} companion test file(s); cap is ${cap}. Raise quality_checks.affected_tests.max_dependent_tests in .interlinked/guard-rules.local.json to run more.`,
			},
		];
	}

	const relTests = decision.tests.map((t) =>
		t.startsWith(checkCwd) ? t.slice(checkCwd.length + 1) : t,
	);
	const runnerCmd = profile.test_runner?.command || "npx vitest run";
	const runnerParts = runnerCmd.split(/\s+/).filter(Boolean);
	const run = await runBoundedTestProcess({
		command: nonNull(runnerParts[0]),
		args: [...runnerParts.slice(1), ...relTests, "--reporter=verbose"],
		cwd: checkCwd,
		timeoutMs,
	});
	if (run.kind === "deferred") return [deferredTestResult(input, run.reason)];
	const result = run;
	if (result.code === 0) return [];

	const output = combinedOutput(result);
	const classification = classifyTestFailure(`direct-importers:${absPath}`, output, "typescript");
	if (classification === "pre-existing") return [];

	const message =
		relTests.length === 1
			? `Tests failed for a direct importer of ${filePath} (${nonNull(relTests[0])})`
			: `Tests failed for ${relTests.length} direct importer test files of ${filePath}`;
	return [
		{
			name: checkName,
			severity,
			message,
			file: filePath,
			detail: truncateTail(output),
		},
	];
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

async function runGoTestDispatcher(input: TestDispatcherInput): Promise<TestDispatcherResult[]> {
	const pkgDir = dirname(input.absPath);
	const relPkg = relative(input.checkCwd, pkgDir) || ".";
	// Prepend ./ to avoid accidental module-path interpretation.
	const pkgArg = relPkg.startsWith(".") ? relPkg : `./${relPkg.split(sep).join("/")}`;

	// Tool-commands override (see check-engine/tool-commands.ts): a full
	// `command` argv is used verbatim (caller owns the run); otherwise the
	// configured `base_args` (e.g. `-tags 'dev devaccounts'`) carry into the
	// touched-package run, with any full-suite "./..." scope token replaced by
	// the package scope so flags keep preceding the package pattern.
	const override = input.commandOverride;
	const args = override?.argv
		? override.argv.slice(1)
		: ["test", ...scopedGoTestArgs(override?.baseArgs ?? [], pkgArg)];
	const bin = override?.argv?.[0] ?? "go";

	const run = await runBoundedTestProcess({
		command: bin,
		args,
		cwd: input.checkCwd,
		timeoutMs: override?.timeoutMs ?? input.timeoutMs,
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

/** Merge configured `go_test` base_args into a touched-package `go test`
 *  invocation: remove any full-suite "./..." scope token (it will be replaced
 *  by the package argument) and append `-count=1 <pkg>`. */
function scopedGoTestArgs(baseArgs: string[], pkgArg: string): string[] {
	const cleaned = baseArgs.filter((a) => a !== "./...");
	return [...cleaned, "-count=1", pkgArg];
}

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
	if (absPath.startsWith(root)) {
		const rest = absPath.slice(root.length);
		return rest.startsWith(sep) ? rest.slice(1) : rest;
	}
	return absPath;
}

// Exported helpers for tests. Dispatcher internals stay private otherwise.
export const __test_only__ = {
	runVitestDispatcher,
	runPytestDispatcher,
	runCargoTestDispatcher,
	runGoTestDispatcher,
	relativizeFromRoot,
	runDirectImporterCompanions,
};

// Keep the TestDispatcher type reachable by tests/extensions without
// re-exporting it publicly — prevents accidental consumer-side coupling
// while giving us a symbol for docs and future extension points.
export type __TestDispatcher = TestDispatcher;
