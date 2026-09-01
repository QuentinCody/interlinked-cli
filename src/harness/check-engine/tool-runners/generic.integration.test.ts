// Behavioral unit tests for the "generic" tool runners — ESLint, Oxlint,
// Knip, Semgrep, Gitleaks (sync + async) and the dependency-audit dispatcher
// (osv-scanner → npm audit fallback).
//
// Boundaries are mocked at the module edge so the tests are deterministic and
// never spawn a real linter / scanner / fs walk:
//   • node:child_process `spawnSync` — drives the sync runners + osv/npm audit.
//   • node:fs `existsSync` — drives `findEslintConfig` and the runDepAudit
//     `package.json` probe.
//   • ../spawn-async.js `runProcessAsync` — drives the async runners.
//   • ../../quality-checks/dependency-audit.js `hasOsvScanner` — drives the
//     osv-scanner-vs-fallback branch in runDepAudit.
// The real output parsers (parseEslintOutput / parseOxlintJson / parseKnipJson /
// parseSemgrepJson / parseGitleaksJson / parseOsvScannerJson / parseNpmAuditJson
// and filterResultsToFile) run UNMOCKED, so the assertions exercise the actual
// raw-output → CheckResult[] / AuditResult mapping rather than a stubbed parser.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "../spawn-async.js";
import type { CheckScope, ToolRunnerInput } from "../types.js";

// --- Module-edge mocks (registered once; behavior swapped per test) ----------

const spawnSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const runProcessAsyncMock = vi.fn();
const hasOsvScannerMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("node:fs", () => ({
	existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));

vi.mock("../spawn-async.js", () => ({
	runProcessAsync: (...args: unknown[]) => runProcessAsyncMock(...args),
}));

vi.mock("../../quality-checks/dependency-audit.js", () => ({
	hasOsvScanner: (...args: unknown[]) => hasOsvScannerMock(...args),
}));

// Imported after the mocks are registered.
const {
	runEslint,
	runOxlint,
	runKnip,
	runSemgrep,
	runGitleaks,
	runDepAudit,
	runEslintAsync,
	runOxlintAsync,
	runKnipAsync,
	runSemgrepAsync,
	runGitleaksAsync,
} = await import("./generic.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = `${PROJECT_ROOT}/src/app.ts`;
const ESLINT_CONFIG = `${PROJECT_ROOT}/.eslintrc.json`;
const PACKAGE_JSON = `${PROJECT_ROOT}/package.json`;

// ---------------------------------------------------------------------------
// Tool output fixtures (real shapes the unmocked parsers consume).
// ---------------------------------------------------------------------------

/** ESLint `--format json` output (eslint 10 dropped the `unix` formatter). */
function eslintUnix(file = "src/app.ts"): string {
	return JSON.stringify([
		{
			filePath: file,
			messages: [
				{ ruleId: "no-unused-vars", severity: 1, message: "'x' is assigned a value but never used", line: 7, column: 4 },
				{ ruleId: "no-console", severity: 1, message: "Unexpected console statement", line: 19, column: 1 },
			],
		},
	]);
}

/** Oxlint JSON: { diagnostics: [{ message, code, severity, filename, labels }] }. */
function oxlintJson(file = "src/app.ts"): string {
	return JSON.stringify({
		diagnostics: [
			{
				message: "eqeqeq violation",
				code: "eslint(eqeqeq)",
				severity: "error",
				filename: file,
				labels: [{ span: { line: 5, column: 2 } }],
			},
			{
				message: "prefer const",
				code: "eslint(prefer-const)",
				severity: "warning",
				filename: file,
				labels: [{ span: { line: 9, column: 1 } }],
			},
		],
	});
}

/** Knip JSON: one unused file + one issue with an unused export. */
function knipJson(): string {
	return JSON.stringify({
		files: ["src/orphan.ts"],
		issues: [
			{
				file: "src/app.ts",
				exports: [{ name: "unusedHelper", line: 42 }],
			},
		],
	});
}

/** Semgrep JSON: { results: [{ path, start, check_id, extra }] }. */
function semgrepJson(file = `${PROJECT_ROOT}/src/app.ts`): string {
	return JSON.stringify({
		results: [
			{
				path: file,
				start: { line: 3, col: 11 },
				check_id: "rules.no-eval",
				extra: { message: "eval is dangerous" },
			},
		],
	});
}

/** Gitleaks JSON: [{ File, StartLine, RuleID, Description }]. */
function gitleaksJson(): string {
	return JSON.stringify([
		{
			File: "src/secrets.ts",
			StartLine: 8,
			RuleID: "aws-access-key",
			Description: "AWS Access Key detected",
		},
	]);
}

/** osv-scanner JSON: one package, one group with a numeric max_severity. */
function osvJson(): string {
	return JSON.stringify({
		results: [
			{
				packages: [
					{
						vulnerabilities: [{ id: "GHSA-xxxx", severity: [{ score: "9.8" }] }],
						groups: [{ ids: ["GHSA-xxxx"], max_severity: "9.8" }],
					},
				],
			},
		],
	});
}

/** npm audit JSON: metadata.vulnerabilities with a high + moderate count. */
function npmAuditJson(): string {
	return JSON.stringify({
		metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 1, low: 0 } },
	});
}

// ---------------------------------------------------------------------------
// Scope / input builders.
// ---------------------------------------------------------------------------

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: TARGET,
		...overrides,
	};
}

function projectScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return { projectRoot: PROJECT_ROOT, mode: "project", ...overrides };
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** Minimal SpawnSyncReturns; stdout/stderr widened so the runner's
 *  `result.stdout || ""` fallback branches are reachable. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
	return {
		pid: 123,
		output: [],
		stdout: "",
		stderr: "",
		status: null,
		signal: null,
		...over,
	} as SpawnSyncReturns<string>;
}

function procResult(over: Partial<RunProcessResult>): RunProcessResult {
	return {
		stdout: "",
		stderr: "",
		code: null,
		timedOut: false,
		killed: false,
		...over,
	};
}

/** ENOENT-shaped Error for the "tool not installed" short-circuit branches. */
const enoent = (): NodeJS.ErrnoException =>
	Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

/** existsSync impl: only the listed paths "exist". */
function existsForPaths(paths: Iterable<string>): (p: unknown) => boolean {
	const set = new Set(paths);
	return (p: unknown) => set.has(String(p));
}

beforeEach(() => {
	spawnSyncMock.mockReset();
	existsSyncMock.mockReset();
	runProcessAsyncMock.mockReset();
	hasOsvScannerMock.mockReset();
	// Safe defaults: nothing exists, osv-scanner absent.
	existsSyncMock.mockReturnValue(false);
	hasOsvScannerMock.mockReturnValue(false);
});

// ===========================================================================
// runEslint (sync) — config discovery + spawn + parse
// ===========================================================================

describe("runEslint (sync)", () => {
	it("returns [] without spawning when no eslint config is found (5-level walk)", () => {
		// Default existsSync → false at every probed dir/name.
		expect(runEslint(input(fileScope()))).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("discovers a config and invokes eslint (json format) with targetFile in file mode", () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runEslint(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("npx");
		expect(args).toEqual([
			"eslint",
			"--no-error-on-unmatched-pattern",
			"--format",
			"json",
			TARGET,
		]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("targets '.' in project mode", () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runEslint(input(projectScope()));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args[args.length - 1]).toBe(".");
	});

	it("targets '.' when file mode but targetFile is missing", () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		runEslint(input(scope));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args[args.length - 1]).toBe(".");
	});

	it("returns [] when status === 0 (clean) even with stdout content", () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: eslintUnix() }));
		expect(runEslint(input(fileScope()))).toEqual([]);
	});

	it("parses findings from stdout on non-zero status", () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: eslintUnix() }));
		const out = runEslint(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "eslint",
				severity: "warning",
				file: "src/app.ts",
				line: 7,
				column: 4,
				message: "'x' is assigned a value but never used [no-unused-vars]",
				ruleId: "no-unused-vars",
			},
			{
				tool: "eslint",
				severity: "warning",
				file: "src/app.ts",
				line: 19,
				column: 1,
				message: "Unexpected console statement [no-console]",
				ruleId: "no-console",
			},
		]);
	});

	it("reads diagnostics from stderr too (stdout+stderr concat path)", () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined, stderr: eslintUnix() }));
		const out = runEslint(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]?.ruleId).toBe("no-unused-vars");
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runEslint(input(fileScope()))).toEqual([]);
	});

	it("discovers a config in an ancestor directory (walk-up succeeds)", () => {
		// targetFile deep; config at the repo root one level up from projectRoot.
		const ROOT_CONFIG = "/work/eslint.config.js";
		existsSyncMock.mockImplementation(existsForPaths([ROOT_CONFIG]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runEslint(input(fileScope()));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("returns [] after exhausting the 5-level walk without reaching fs root", () => {
		// A projectRoot deep enough that 5 dirname() hops never equal the
		// previous dir → the loop runs all 5 iterations and falls through to the
		// trailing `return false` (rather than the `parent === dir` early-out).
		const deepRoot = "/a/b/c/d/e/f/g/h";
		expect(runEslint(input(fileScope({ projectRoot: deepRoot })))).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
		// existsSync was probed for all 9 config names across each level it walked.
		expect(existsSyncMock.mock.calls.length).toBeGreaterThanOrEqual(9 * 5);
	});
});

// ===========================================================================
// runOxlint (sync)
// ===========================================================================

describe("runOxlint (sync)", () => {
	it("invokes oxlint --format=json with targetFile in file mode, cwd/timeout/pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runOxlint(input(fileScope(), 7_777));
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("npx");
		expect(args).toEqual(["oxlint", "--format=json", TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 7_777,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("targets '.' in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runOxlint(input(projectScope()));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["oxlint", "--format=json", "."]);
	});

	it("targets '.' when file mode but targetFile is missing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		runOxlint(input(scope));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["oxlint", "--format=json", "."]);
	});

	it("returns [] when oxlint is not installed (ENOENT error)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runOxlint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (clean) even with stdout content", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: oxlintJson() }));
		expect(runOxlint(input(fileScope()))).toEqual([]);
	});

	it("returns [] on non-zero status with empty stdout (trim → '' guard)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "   " }));
		expect(runOxlint(input(fileScope()))).toEqual([]);
	});

	it("returns [] on non-zero status with undefined stdout (the '' fallback)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runOxlint(input(fileScope()))).toEqual([]);
	});

	it("parses diagnostics from stdout on non-zero status", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: oxlintJson() }));
		const out = runOxlint(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "oxlint",
				severity: "error",
				file: "src/app.ts",
				line: 5,
				column: 2,
				message: "eqeqeq violation",
				ruleId: "eslint(eqeqeq)",
			},
			{
				tool: "oxlint",
				severity: "warning",
				file: "src/app.ts",
				line: 9,
				column: 1,
				message: "prefer const",
				ruleId: "eslint(prefer-const)",
			},
		]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runOxlint(input(fileScope()))).toEqual([]);
	});

	it("treats a non-ENOENT spawn error as a real (non-zero) run and parses output", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: oxlintJson(), error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }),
		);
		expect(runOxlint(input(fileScope()))).toHaveLength(2);
	});
});

// ===========================================================================
// runKnip (sync)
// ===========================================================================

describe("runKnip (sync)", () => {
	it("invokes knip with no-progress + json reporter, cwd/timeout/pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runKnip(input(fileScope(), 6_543));
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("npx");
		expect(args).toEqual(["knip", "--no-progress", "--reporter", "json"]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 6_543,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when knip is not installed (ENOENT error)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runKnip(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (clean)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: knipJson() }));
		expect(runKnip(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 2 (config error)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stdout: knipJson() }));
		expect(runKnip(input(fileScope()))).toEqual([]);
	});

	it("returns [] on non-zero status with empty stdout (trim → '' guard)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runKnip(input(fileScope()))).toEqual([]);
	});

	it("parses unused files + exports on status === 1 (project mode, no filtering)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: knipJson() }));
		const out = runKnip(input(projectScope()));
		expect(out).toEqual([
			{
				tool: "knip",
				severity: "warning",
				file: "src/orphan.ts",
				line: 0,
				message: "unused file — not imported by any other module",
				ruleId: "unused-file",
			},
			{
				tool: "knip",
				severity: "warning",
				file: "src/app.ts",
				line: 42,
				message: "unused export: unusedHelper",
				ruleId: "unused-export",
			},
		]);
	});

	it("filters results to targetFile when file mode + targetFile + filterToFile", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: knipJson() }));
		// targetFile = src/app.ts → the unused-file row (src/orphan.ts) is dropped.
		const out = runKnip(input(fileScope({ targetFile: "src/app.ts", filterToFile: true })));
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe("src/app.ts");
		expect(out[0]?.ruleId).toBe("unused-export");
	});

	it("does NOT filter when filterToFile is unset (file mode, all rows returned)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: knipJson() }));
		const out = runKnip(input(fileScope({ targetFile: "src/app.ts" })));
		expect(out).toHaveLength(2);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runKnip(input(fileScope()))).toEqual([]);
	});
});

// ===========================================================================
// runSemgrep (sync)
// ===========================================================================

describe("runSemgrep (sync)", () => {
	it("invokes semgrep scan with the default ruleset + targetFile in file mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runSemgrep(input(fileScope(), 8_001));
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("semgrep");
		expect(args).toEqual([
			"scan",
			"--quiet",
			"--no-git-ignore",
			"--metrics",
			"off",
			"--config",
			"p/default",
			"--json",
			TARGET,
		]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 8_001,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("targets '.' in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runSemgrep(input(projectScope()));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args[args.length - 1]).toBe(".");
	});

	it("targets '.' when file mode but targetFile is missing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		runSemgrep(input(scope));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args[args.length - 1]).toBe(".");
	});

	it("returns [] when semgrep is not installed (ENOENT error)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runSemgrep(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 2 (config/auth error)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stdout: semgrepJson() }));
		expect(runSemgrep(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a clean run with empty stdout (trim → '' guard)", () => {
		// status 0 is NOT short-circuited by semgrep (only status 2 is), so the
		// empty-output guard is what returns [] here.
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: "  " }));
		expect(runSemgrep(input(fileScope()))).toEqual([]);
	});

	it("parses findings and relativizes path against projectRoot on status === 1", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: semgrepJson() }));
		const out = runSemgrep(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "semgrep",
				severity: "warning",
				file: "src/app.ts",
				line: 3,
				column: 11,
				message: "rules.no-eval: eval is dangerous",
				ruleId: "rules.no-eval",
			},
		]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runSemgrep(input(fileScope()))).toEqual([]);
	});
});

// ===========================================================================
// runGitleaks (sync)
// ===========================================================================

describe("runGitleaks (sync)", () => {
	it("returns [] without spawning when mode is not 'project' (hot-path skip)", () => {
		expect(runGitleaks(input(fileScope()))).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("invokes gitleaks detect with the report-to-stdout args in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runGitleaks(input(projectScope(), 12_000));
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("gitleaks");
		expect(args).toEqual([
			"detect",
			"--no-git",
			"--no-banner",
			"--report-format",
			"json",
			"--report-path",
			"/dev/stdout",
			"--source",
			".",
		]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 12_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when gitleaks is not installed (ENOENT error)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runGitleaks(input(projectScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (no leaks)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: gitleaksJson() }));
		expect(runGitleaks(input(projectScope()))).toEqual([]);
	});

	it("returns [] when status !== 1 (e.g. status 2)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stdout: gitleaksJson() }));
		expect(runGitleaks(input(projectScope()))).toEqual([]);
	});

	it("returns [] when status === 1 but output contains FTL (fatal, not findings)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stderr: "9:00AM FTL could not scan", stdout: gitleaksJson() }),
		);
		expect(runGitleaks(input(projectScope()))).toEqual([]);
	});

	it("returns [] when status === 1 but output contains 'no such file'", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stderr: "open x: no such file or directory", stdout: gitleaksJson() }),
		);
		expect(runGitleaks(input(projectScope()))).toEqual([]);
	});

	it("returns [] when status === 1 with empty stdout (trim → '' guard, non-fatal)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "", stderr: "" }));
		expect(runGitleaks(input(projectScope()))).toEqual([]);
	});

	it("parses leaks on status === 1 with a clean (non-fatal) stdout", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: gitleaksJson() }));
		const out = runGitleaks(input(projectScope()));
		expect(out).toEqual([
			{
				tool: "gitleaks",
				severity: "error",
				file: "src/secrets.ts",
				line: 8,
				message: "aws-access-key: AWS Access Key detected",
				ruleId: "aws-access-key",
			},
		]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runGitleaks(input(projectScope()))).toEqual([]);
	});
});

// ===========================================================================
// runDepAudit (sync) — osv-scanner → npm audit dispatch
// ===========================================================================

describe("runDepAudit (sync)", () => {
	it("uses osv-scanner when available and returns its parsed AuditResult", () => {
		hasOsvScannerMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: osvJson() }));
		const out = runDepAudit(input(projectScope(), 20_000));
		expect(out).toEqual({
			tool: "osv-scanner",
			total: 1,
			critical: 1,
			high: 0,
			moderate: 0,
			low: 0,
			detail: "1 critical — GHSA-xxxx",
		});
		// osv-scanner spawned with the recursive scan args, in projectRoot.
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("osv-scanner");
		expect(args).toEqual(["scan", "source", "--format=json", "--recursive", "."]);
		expect(opts).toMatchObject({ cwd: PROJECT_ROOT, timeout: 20_000 });
		// npm audit never consulted.
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("falls through to npm audit when osv-scanner is available but returns null", () => {
		hasOsvScannerMock.mockReturnValue(true);
		existsSyncMock.mockImplementation(existsForPaths([PACKAGE_JSON]));
		spawnSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "osv-scanner") {
				// status 0 → osv returns null (clean / unsupported project).
				return spawnResult({ status: 0, stdout: "" });
			}
			// npm audit.
			return spawnResult({ status: 1, stdout: npmAuditJson() });
		});
		const out = runDepAudit(input(projectScope()));
		expect(out).toEqual({
			tool: "npm audit",
			total: 3,
			critical: 0,
			high: 2,
			moderate: 1,
			low: 0,
			detail: "2 high, 1 moderate",
		});
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
		expect(spawnSyncMock.mock.calls[1]?.[0]).toBe("npm");
	});

	it("returns null when osv-scanner returns null AND there is no package.json", () => {
		hasOsvScannerMock.mockReturnValue(true);
		// no package.json (default existsSync → false).
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: "" })); // osv clean → null
		expect(runDepAudit(input(projectScope()))).toBeNull();
		// only the osv-scanner spawn happened.
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("uses npm audit directly when osv-scanner is unavailable and package.json exists", () => {
		hasOsvScannerMock.mockReturnValue(false);
		existsSyncMock.mockImplementation(existsForPaths([PACKAGE_JSON]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: npmAuditJson() }));
		const out = runDepAudit(input(projectScope(), 15_000));
		expect(out?.tool).toBe("npm audit");
		expect(out?.total).toBe(3);
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("npm");
		expect(args).toEqual(["audit", "--json", "--audit-level=moderate"]);
		expect(opts).toMatchObject({ cwd: PROJECT_ROOT, timeout: 15_000 });
	});

	it("returns null when osv-scanner is unavailable and there is no package.json", () => {
		hasOsvScannerMock.mockReturnValue(false);
		expect(runDepAudit(input(projectScope()))).toBeNull();
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	// --- runOsvScanner branch coverage (exercised via runDepAudit) -----------

	it("osv-scanner ENOENT → null → falls through to package.json check", () => {
		hasOsvScannerMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		// no package.json → overall null after fall-through.
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("osv-scanner status === null → treated as unavailable (null)", () => {
		hasOsvScannerMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, stdout: osvJson() }));
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("osv-scanner status === 128 (scan error) → treated as unavailable (null)", () => {
		hasOsvScannerMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(spawnResult({ status: 128, stdout: osvJson() }));
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("osv-scanner status === 1 but empty stdout → null (trim guard)", () => {
		hasOsvScannerMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "   " }));
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("osv-scanner status === 1 with undefined stdout → null (the '' fallback)", () => {
		// Exercises the right-hand side of `(result.stdout || "")` in runOsvScanner.
		hasOsvScannerMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("osv-scanner spawn throws → catch returns null", () => {
		hasOsvScannerMock.mockReturnValue(true);
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	// --- runNpmAudit branch coverage (exercised via runDepAudit) -------------

	it("npm audit ENOENT → null", () => {
		hasOsvScannerMock.mockReturnValue(false);
		existsSyncMock.mockImplementation(existsForPaths([PACKAGE_JSON]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("npm audit empty stdout → null (trim guard)", () => {
		hasOsvScannerMock.mockReturnValue(false);
		existsSyncMock.mockImplementation(existsForPaths([PACKAGE_JSON]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "  " }));
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("npm audit undefined stdout → null (the '' fallback)", () => {
		// Exercises the right-hand side of `(result.stdout || "")` in runNpmAudit.
		hasOsvScannerMock.mockReturnValue(false);
		existsSyncMock.mockImplementation(existsForPaths([PACKAGE_JSON]));
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("npm audit returns null for a no-vulnerability report (parser → null)", () => {
		hasOsvScannerMock.mockReturnValue(false);
		existsSyncMock.mockImplementation(existsForPaths([PACKAGE_JSON]));
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 0,
				stdout: JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } } }),
			}),
		);
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});

	it("npm audit spawn throws → catch returns null", () => {
		hasOsvScannerMock.mockReturnValue(false);
		existsSyncMock.mockImplementation(existsForPaths([PACKAGE_JSON]));
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runDepAudit(input(projectScope()))).toBeNull();
	});
});

// ===========================================================================
// runEslintAsync
// ===========================================================================

describe("runEslintAsync", () => {
	it("returns [] without spawning when no eslint config is found", async () => {
		const out = await runEslintAsync(input(fileScope()));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("invokes runProcessAsync (json format) with targetFile + cwd/timeout in file mode", async () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runEslintAsync(input(fileScope(), 4_321));
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("npx");
		expect(args).toEqual(["eslint", "--no-error-on-unmatched-pattern", "--format", "json", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("targets '.' in project mode", async () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runEslintAsync(input(projectScope()));
		const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
		expect(args[args.length - 1]).toBe(".");
	});

	it("returns [] when code === 0 (clean) even with stdout content", async () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: eslintUnix() }));
		expect(await runEslintAsync(input(fileScope()))).toEqual([]);
	});

	it("parses findings from stdout+stderr on a non-zero code", async () => {
		existsSyncMock.mockImplementation(existsForPaths([ESLINT_CONFIG]));
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: eslintUnix() }));
		const out = await runEslintAsync(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ tool: "eslint", ruleId: "no-unused-vars", line: 7 });
	});
});

// ===========================================================================
// runOxlintAsync
// ===========================================================================

describe("runOxlintAsync", () => {
	it("invokes runProcessAsync with --format=json + targetFile, cwd/timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runOxlintAsync(input(fileScope(), 2_222));
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("npx");
		expect(args).toEqual(["oxlint", "--format=json", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 2_222 });
	});

	it("targets '.' when file mode but targetFile is missing", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		await runOxlintAsync(input(scope));
		const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["oxlint", "--format=json", "."]);
	});

	it("returns [] when code === null (ENOENT etc.)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: oxlintJson() }));
		expect(await runOxlintAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 0 (clean)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: oxlintJson() }));
		expect(await runOxlintAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a non-zero code with empty stdout (trim → '' guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "  " }));
		expect(await runOxlintAsync(input(fileScope()))).toEqual([]);
	});

	it("parses diagnostics on a non-zero code", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: oxlintJson() }));
		const out = await runOxlintAsync(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ tool: "oxlint", severity: "error", ruleId: "eslint(eqeqeq)" });
	});
});

// ===========================================================================
// runKnipAsync
// ===========================================================================

describe("runKnipAsync", () => {
	it("invokes runProcessAsync with no-progress + json reporter, cwd/timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runKnipAsync(input(fileScope(), 3_456));
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("npx");
		expect(args).toEqual(["knip", "--no-progress", "--reporter", "json"]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 3_456 });
	});

	it("returns [] when code === null (ENOENT etc.)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: knipJson() }));
		expect(await runKnipAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 0 (clean)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: knipJson() }));
		expect(await runKnipAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 2 (config error)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: knipJson() }));
		expect(await runKnipAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a non-zero code with empty stdout (trim → '' guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "" }));
		expect(await runKnipAsync(input(fileScope()))).toEqual([]);
	});

	it("parses unused files + exports on a non-zero code (project mode, no filtering)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: knipJson() }));
		const out = await runKnipAsync(input(projectScope()));
		expect(out).toHaveLength(2);
		expect(out[0]?.ruleId).toBe("unused-file");
		expect(out[1]?.ruleId).toBe("unused-export");
	});

	it("filters results to targetFile when file mode + targetFile + filterToFile", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: knipJson() }));
		const out = await runKnipAsync(input(fileScope({ targetFile: "src/app.ts", filterToFile: true })));
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe("src/app.ts");
	});

	it("does NOT filter when filterToFile is unset (all rows returned)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: knipJson() }));
		const out = await runKnipAsync(input(fileScope({ targetFile: "src/app.ts" })));
		expect(out).toHaveLength(2);
	});
});

// ===========================================================================
// runSemgrepAsync
// ===========================================================================

describe("runSemgrepAsync", () => {
	it("invokes runProcessAsync with the default ruleset + targetFile, cwd/timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runSemgrepAsync(input(fileScope(), 9_090));
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("semgrep");
		expect(args).toEqual([
			"scan",
			"--quiet",
			"--no-git-ignore",
			"--metrics",
			"off",
			"--config",
			"p/default",
			"--json",
			TARGET,
		]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 9_090 });
	});

	it("targets '.' in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runSemgrepAsync(input(projectScope()));
		const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
		expect(args[args.length - 1]).toBe(".");
	});

	it("returns [] when code === null (ENOENT etc.)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: semgrepJson() }));
		expect(await runSemgrepAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 2 (config/auth error)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: semgrepJson() }));
		expect(await runSemgrepAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a clean run with empty stdout (trim → '' guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: "  " }));
		expect(await runSemgrepAsync(input(fileScope()))).toEqual([]);
	});

	it("parses findings and relativizes path on a non-zero code", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: semgrepJson() }));
		const out = await runSemgrepAsync(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "semgrep",
				severity: "warning",
				file: "src/app.ts",
				line: 3,
				column: 11,
				message: "rules.no-eval: eval is dangerous",
				ruleId: "rules.no-eval",
			},
		]);
	});
});

// ===========================================================================
// runGitleaksAsync
// ===========================================================================

describe("runGitleaksAsync", () => {
	it("returns [] without spawning when mode is not 'project' (hot-path skip)", async () => {
		const out = await runGitleaksAsync(input(fileScope()));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("invokes runProcessAsync with detect args in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runGitleaksAsync(input(projectScope(), 11_111));
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("gitleaks");
		expect(args).toEqual([
			"detect",
			"--no-git",
			"--no-banner",
			"--report-format",
			"json",
			"--report-path",
			"/dev/stdout",
			"--source",
			".",
		]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 11_111 });
	});

	it("returns [] when code === null (process never started)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: gitleaksJson() }));
		expect(await runGitleaksAsync(input(projectScope()))).toEqual([]);
	});

	it("returns [] when code !== 1 (e.g. clean exit 0)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: gitleaksJson() }));
		expect(await runGitleaksAsync(input(projectScope()))).toEqual([]);
	});

	it("returns [] when code === 1 but output contains FTL", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stderr: "FTL boom", stdout: gitleaksJson() }),
		);
		expect(await runGitleaksAsync(input(projectScope()))).toEqual([]);
	});

	it("returns [] when code === 1 but output contains 'no such file'", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stderr: "no such file", stdout: gitleaksJson() }),
		);
		expect(await runGitleaksAsync(input(projectScope()))).toEqual([]);
	});

	it("returns [] when code === 1 with empty stdout (trim → '' guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "", stderr: "" }));
		expect(await runGitleaksAsync(input(projectScope()))).toEqual([]);
	});

	it("parses leaks on code === 1 with a clean (non-fatal) stdout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: gitleaksJson() }));
		const out = await runGitleaksAsync(input(projectScope()));
		expect(out).toEqual([
			{
				tool: "gitleaks",
				severity: "error",
				file: "src/secrets.ts",
				line: 8,
				message: "aws-access-key: AWS Access Key detected",
				ruleId: "aws-access-key",
			},
		]);
	});
});
