import { nonNull } from "../../../lib/non-null.js";
import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral unit tests for the Swift tool runners (swiftlint sync + async,
// swift build).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `swiftlint` / `swift` binary:
//   • node:child_process `spawnSync` — drives the sync runners.
//   • ../spawn-async.js `runProcessAsync` — drives the async runner.
// The real parsers (parseSwiftLintJson / parseSwiftBuildOutput) and the real
// `filterResultsToFile` run unmocked, so we exercise the actual
// JSON/regex → CheckResult[] mapping and the file-scoping branch.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "../spawn-async.js";
import type { CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn<SpawnSyncStub>();
const runProcessAsyncMock = vi.fn<typeof import("../spawn-async.js").runProcessAsync>();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: Parameters<SpawnSyncStub>) => spawnSyncMock(...args),
}));

vi.mock("../spawn-async.js", () => ({
	runProcessAsync: (...args: Parameters<typeof runProcessAsyncMock>) => runProcessAsyncMock(...args),
}));

// Imported after the mocks are registered.
const { runSwiftLint, runSwiftLintAsync, runSwiftBuild } = await import("./swift.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = `${PROJECT_ROOT}/Sources/App/Main.swift`;

// ---------------------------------------------------------------------------
// SwiftLint JSON payloads (the `--reporter json` array shape).
// ---------------------------------------------------------------------------

/** One warning + one error, both for the target file, with a `character`. */
function lintJson(): string {
	return JSON.stringify([
		{
			file: TARGET,
			line: 10,
			character: 5,
			severity: "Warning",
			type: "Force Cast",
			rule_id: "force_cast",
			reason: "Force casts should be avoided.",
		},
		{
			file: TARGET,
			line: 22,
			character: 1,
			severity: "Error",
			type: "Force Try",
			rule_id: "force_try",
			reason: "Force tries should be avoided.",
		},
	]);
}

/** A finding for a *different* file — used to prove the filterToFile branch. */
function lintJsonOtherFile(): string {
	return JSON.stringify([
		{
			file: `${PROJECT_ROOT}/Sources/App/Other.swift`,
			line: 3,
			character: 2,
			severity: "Warning",
			type: "Line Length",
			rule_id: "line_length",
			reason: "Line should be 120 characters or less.",
		},
	]);
}

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: TARGET,
		...overrides,
	};
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** A minimal SpawnSyncReturns. `stdout`/`stderr`/`status` are widened so we
 *  can exercise the runner's `|| ""` and status-branch fallbacks. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
	// SAFETY: this fixture deliberately allows absent stdout/stderr to exercise the runner's fallback for incomplete process results.
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

const enoent = () => Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

beforeEach(() => {
	spawnSyncMock.mockReset();
	runProcessAsyncMock.mockReset();
});

// ===========================================================================
// runSwiftLint (sync)
// ===========================================================================

describe("runSwiftLint (sync)", () => {
	it("invokes swiftlint with json reporter + --path in file mode, cwd/timeout/pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: "" }));
		runSwiftLint(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("swiftlint");
		expect(args).toEqual(["lint", "--quiet", "--reporter", "json", "--path", TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("omits --path in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: "" }));
		runSwiftLint(input(fileScope({ mode: "project" })));
		const args = nonNull(spawnSyncMock.mock.calls[0])[1];
		expect(args).toEqual(["lint", "--quiet", "--reporter", "json"]);
		expect(args).not.toContain("--path");
	});

	it("omits --path when file mode but targetFile is missing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: "" }));
		const scope = fileScope();
		delete (scope).targetFile;
		runSwiftLint(input(scope));
		const args = nonNull(spawnSyncMock.mock.calls[0])[1];
		expect(args).not.toContain("--path");
	});

	it("returns [] when swiftlint is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ error: enoent() }));
		expect(runSwiftLint(input(fileScope()))).toEqual([]);
	});

	it("falls through past a non-ENOENT spawn error to the stdout/parse path", () => {
		// error set but code !== ENOENT → not short-circuited; empty stdout → [].
		spawnSyncMock.mockReturnValue(
			spawnResult({ error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }) }),
		);
		expect(runSwiftLint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when stdout is empty/whitespace (the !output.trim() guard)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: "   \n  " }));
		expect(runSwiftLint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when stdout is undefined via the '' fallback", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: undefined }));
		expect(runSwiftLint(input(fileScope()))).toEqual([]);
	});

	it("parses findings: warning + error severities, rule_id:reason message, character→column", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: lintJson() }));
		const out = runSwiftLint(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "swiftlint",
				severity: "warning",
				file: TARGET,
				line: 10,
				column: 5,
				message: "force_cast: Force casts should be avoided.",
				ruleId: "force_cast",
			},
			{
				tool: "swiftlint",
				severity: "error",
				file: TARGET,
				line: 22,
				column: 1,
				message: "force_try: Force tries should be avoided.",
				ruleId: "force_try",
			},
		]);
	});

	it("filters to the target file when filterToFile is set (drops other-file finding)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: lintJsonOtherFile() }));
		const out = runSwiftLint(input(fileScope({ filterToFile: true })));
		expect(out).toEqual([]);
	});

	it("keeps the target-file finding when filterToFile is set", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: lintJson() }));
		const out = runSwiftLint(input(fileScope({ filterToFile: true })));
		expect(out).toHaveLength(2);
		expect(out.every((r) => r.file === TARGET)).toBe(true);
	});

	it("returns all findings (no filter) when filterToFile is falsy", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: lintJsonOtherFile() }));
		const out = runSwiftLint(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe(`${PROJECT_ROOT}/Sources/App/Other.swift`);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("kaboom");
		});
		expect(runSwiftLint(input(fileScope()))).toEqual([]);
	});
});

// ===========================================================================
// parseSwiftLintJson edge cases (exercised through runSwiftLint)
// ===========================================================================

describe("parseSwiftLintJson edge cases (via runSwiftLint)", () => {
	it("returns [] when the JSON is a non-array (object)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: JSON.stringify({ not: "an array" }) }));
		expect(runSwiftLint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when stdout is non-JSON garbage (parser catch)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ stdout: "not json at all {{{" }));
		expect(runSwiftLint(input(fileScope()))).toEqual([]);
	});

	it("defaults severity to warning when not 'error' (case-insensitive non-error)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				stdout: JSON.stringify([
					{
						file: TARGET,
						line: 1,
						character: 1,
						severity: "Style", // not "error" → warning
						type: "T",
						rule_id: "r",
						reason: "msg",
					},
				]),
			}),
		);
		expect(runSwiftLint(input(fileScope()))[0]?.severity).toBe("warning");
	});

	it("treats lowercase 'error' severity as error (toLowerCase branch)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				stdout: JSON.stringify([
					{ file: TARGET, line: 1, character: 1, severity: "error", type: "T", rule_id: "r", reason: "m" },
				]),
			}),
		);
		expect(runSwiftLint(input(fileScope()))[0]?.severity).toBe("error");
	});

	it("falls back to severity warning when severity is missing (optional-chain path)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				stdout: JSON.stringify([{ file: TARGET, line: 4, character: 2, type: "T", rule_id: "r", reason: "m" }]),
			}),
		);
		expect(runSwiftLint(input(fileScope()))[0]?.severity).toBe("warning");
	});

	it("uses line 0 and undefined column when line/character are absent", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				stdout: JSON.stringify([
					{ file: TARGET, severity: "Warning", type: "T", rule_id: "r", reason: "m" },
				]),
			}),
		);
		const out = runSwiftLint(input(fileScope()));
		expect(out[0]?.line).toBe(0);
		expect(out[0]?.column).toBeUndefined();
	});
});

// ===========================================================================
// runSwiftLintAsync
// ===========================================================================

describe("runSwiftLintAsync", () => {
	it("invokes runProcessAsync with json reporter + --path in file mode, cwd/timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: "" }));
		await runSwiftLintAsync(input(fileScope(), 4_321));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("swiftlint");
		expect(args).toEqual(["lint", "--quiet", "--reporter", "json", "--path", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("omits --path in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: "" }));
		await runSwiftLintAsync(input(fileScope({ mode: "project" })));
		const args = nonNull(runProcessAsyncMock.mock.calls[0])[1];
		expect(args).toEqual(["lint", "--quiet", "--reporter", "json"]);
	});

	it("returns [] when code === null (process never started, e.g. ENOENT)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: lintJson() }));
		expect(await runSwiftLintAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when stdout is empty/whitespace (the !output.trim() guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: "  \n " }));
		expect(await runSwiftLintAsync(input(fileScope()))).toEqual([]);
	});

	it("parses findings on a non-null code (e.g. exit 2 with lint output)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: lintJson() }));
		const out = await runSwiftLintAsync(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ tool: "swiftlint", severity: "warning", ruleId: "force_cast" });
		expect(out[1]?.severity).toBe("error");
	});

	it("filters to the target file when filterToFile is set", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: lintJsonOtherFile() }));
		expect(await runSwiftLintAsync(input(fileScope({ filterToFile: true })))).toEqual([]);
	});

	it("returns all findings (no filter) when filterToFile is falsy", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: lintJsonOtherFile() }));
		const out = await runSwiftLintAsync(input(fileScope()));
		expect(out).toHaveLength(1);
	});
});

// ===========================================================================
// runSwiftBuild (SPM type check, parses diagnostics from stderr+stdout)
// ===========================================================================

describe("runSwiftBuild", () => {
	const diag = `${TARGET}:12:9: error: cannot find 'foo' in scope\n`;
	const warnDiag = `${TARGET}:7:3: warning: variable 'x' was never used\n`;

	it("invokes `swift build --skip-update` with cwd/timeout/pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runSwiftBuild(input(fileScope({ projectRoot: "/my/root" }), 8_888));
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("swift");
		expect(args).toEqual(["build", "--skip-update"]);
		expect(opts).toMatchObject({
			cwd: "/my/root",
			timeout: 8_888,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when swift is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ error: enoent() }));
		expect(runSwiftBuild(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a clean build (status 0) even if streams have content", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stderr: diag }));
		expect(runSwiftBuild(input(fileScope()))).toEqual([]);
	});

	it("parses an error diagnostic from stderr on non-zero status", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: diag }));
		const out = runSwiftBuild(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "swift-build",
				severity: "error",
				file: TARGET,
				line: 12,
				column: 9,
				message: "cannot find 'foo' in scope",
			},
		]);
	});

	it("parses a warning diagnostic and reads from stdout too (stderr+stdout concat)", () => {
		// Diagnostic arrives on stdout, stderr empty → exercises the concat path.
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: warnDiag, stderr: "" }));
		const out = runSwiftBuild(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: "swift-build",
			severity: "warning",
			line: 7,
			column: 3,
			message: "variable 'x' was never used",
		});
	});

	it("ignores non-matching lines (progress output) and keeps only diagnostics", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stderr: `Compiling App Main.swift\nBuilding for debugging...\n${diag}`,
			}),
		);
		const out = runSwiftBuild(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("error");
	});

	it("returns [] on non-zero status with both streams empty (|| '' fallbacks, no match)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stdout: undefined, stderr: undefined }));
		expect(runSwiftBuild(input(fileScope()))).toEqual([]);
	});

	it("falls through past a non-ENOENT spawn error to the status check", () => {
		// error set but code !== ENOENT, and status 0 → []. Proves the ENOENT
		// guard is code-specific, not any-error.
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 0, error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }) }),
		);
		expect(runSwiftBuild(input(fileScope()))).toEqual([]);
	});

	it("filters diagnostics to the target file when filterToFile is set", () => {
		const otherDiag = `${PROJECT_ROOT}/Sources/App/Other.swift:1:1: error: boom\n`;
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: diag + otherDiag }));
		const out = runSwiftBuild(input(fileScope({ filterToFile: true })));
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe(TARGET);
	});

	it("returns all diagnostics (no filter) when filterToFile is falsy", () => {
		const otherDiag = `${PROJECT_ROOT}/Sources/App/Other.swift:1:1: error: boom\n`;
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: diag + otherDiag }));
		const out = runSwiftBuild(input(fileScope()));
		expect(out).toHaveLength(2);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("spawn EAGAIN");
		});
		expect(runSwiftBuild(input(fileScope()))).toEqual([]);
	});
});
