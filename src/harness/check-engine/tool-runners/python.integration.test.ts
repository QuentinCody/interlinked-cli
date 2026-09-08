import { nonNull } from "../../../lib/non-null.js";
import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral unit tests for the Python tool runners (mypy + ruff lint + ruff
// format, sync + async).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `mypy` / `ruff` binary:
//   • node:child_process `spawnSync` — drives the sync runners.
//   • ../spawn-async.js `runProcessAsync` — drives the async runners.
// The real parsers (parseMypyOutput / parseRuffJson / parseRuffFormatOutput)
// run unmocked, so we exercise the actual text/JSON → CheckResult[] mapping
// rather than asserting against a stubbed parser.

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
const { runMypy, runRuff, runRuffFormat, runMypyAsync, runRuffAsync, runRuffFormatAsync } =
	await import("./python.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = `${PROJECT_ROOT}/app/models.py`;

// The S/B security+bugbear categories runRuff imposes on top of project config.
const ENFORCED = ["--extend-select=S,B", "--extend-ignore=S101"];

// ---------------------------------------------------------------------------
// Tool output fixtures (real shapes the parsers consume).
// ---------------------------------------------------------------------------

/** mypy line-oriented output: one error (with code) + one warning + one note. */
function mypyOutput(): string {
	return [
		`${TARGET}:12: error: Incompatible return value type (got "int", expected "str")  [return-value]`,
		`${TARGET}:30: warning: Returning Any from function declared to return "int"  [no-any-return]`,
		`${TARGET}:5: note: See https://example.test for more info`,
	].join("\n");
}

/** ruff JSON array: two findings for the target file. */
function ruffJson(): string {
	return JSON.stringify([
		{
			filename: TARGET,
			row: 7,
			column: 4,
			code: "F401",
			message: "`os` imported but unused",
		},
		{
			filename: TARGET,
			row: 19,
			column: 1,
			code: "E711",
			message: "Comparison to `None` should be `cond is None`",
		},
	]);
}

/** ruff JSON finding carrying an autofix — delta B surfaces its applicability. */
function ruffJsonWithFix(): string {
	return JSON.stringify([
		{
			filename: TARGET,
			row: 7,
			column: 4,
			code: "F401",
			message: "`os` imported but unused",
			fix: { applicability: "safe", message: "Remove unused import `os`" },
		},
	]);
}

/** `ruff format --check` stdout for a file that would be reformatted. */
function wouldReformat(file = TARGET): string {
	return `Would reformat: ${file}\n1 file would be reformatted\n`;
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
// runMypy (sync)
// ===========================================================================

describe("runMypy (sync)", () => {
	it("invokes mypy with summary/color flags + targetFile in file mode, cwd/timeout/pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runMypy(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("mypy");
		expect(args).toEqual(["--no-error-summary", "--no-color-output", TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("targets '.' in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runMypy(input(fileScope({ mode: "project" })));
		const args = nonNull(spawnSyncMock.mock.calls[0])[1];
		expect(args).toEqual(["--no-error-summary", "--no-color-output", "."]);
	});

	it("targets '.' when file mode but targetFile is missing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const scope = fileScope();
		delete (scope).targetFile;
		runMypy(input(scope));
		const args = nonNull(spawnSyncMock.mock.calls[0])[1];
		expect(args).toEqual(["--no-error-summary", "--no-color-output", "."]);
	});

	it("returns [] when mypy is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runMypy(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (clean) even if stdout has content", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: mypyOutput() }));
		expect(runMypy(input(fileScope()))).toEqual([]);
	});

	it("parses error + warning (skipping notes) from stdout on status === 1", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: mypyOutput() }));
		const out = runMypy(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "mypy",
				severity: "error",
				file: TARGET,
				line: 12,
				message: 'Incompatible return value type (got "int", expected "str")',
				ruleId: "return-value",
			},
			{
				tool: "mypy",
				severity: "warning",
				file: TARGET,
				line: 30,
				message: 'Returning Any from function declared to return "int"',
				ruleId: "no-any-return",
			},
		]);
	});

	it("reads diagnostics from stderr too (stdout+stderr concat path)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "", stderr: mypyOutput() }));
		const out = runMypy(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]?.ruleId).toBe("return-value");
	});

	it("returns [] on non-zero status with both streams undefined (|| '' fallbacks)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined, stderr: undefined }));
		expect(runMypy(input(fileScope()))).toEqual([]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runMypy(input(fileScope()))).toEqual([]);
	});

	it("treats a non-ENOENT spawn error as a real (non-zero) run and parses output", () => {
		// error set but code !== ENOENT → not short-circuited; status 1 → parse.
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: mypyOutput(),
				error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
			}),
		);
		expect(runMypy(input(fileScope()))).toHaveLength(2);
	});
});

// ===========================================================================
// runRuff (sync)
// ===========================================================================

describe("runRuff (sync)", () => {
	it("invokes ruff check with json output + imposed S/B flags + targetFile in file mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRuff(input(fileScope(), 8_888));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("ruff");
		expect(args).toEqual(["check", "--output-format=json", ...ENFORCED, TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 8_888,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("targets '.' in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRuff(input(fileScope({ mode: "project" })));
		const args = nonNull(spawnSyncMock.mock.calls[0])[1];
		expect(args).toEqual(["check", "--output-format=json", ...ENFORCED, "."]);
	});

	it("targets '.' when file mode but targetFile is missing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const scope = fileScope();
		delete (scope).targetFile;
		runRuff(input(scope));
		const args = nonNull(spawnSyncMock.mock.calls[0])[1];
		expect(args).toEqual(["check", "--output-format=json", ...ENFORCED, "."]);
	});

	it("returns [] when ruff is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (clean) even if stdout has content", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: ruffJson() }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("parses findings (all severity warning, code: message, column) on status === 1", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: ruffJson() }));
		const out = runRuff(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "ruff",
				severity: "warning",
				file: TARGET,
				line: 7,
				column: 4,
				message: "F401: `os` imported but unused",
				ruleId: "F401",
			},
			{
				tool: "ruff",
				severity: "warning",
				file: TARGET,
				line: 19,
				column: 1,
				message: "E711: Comparison to `None` should be `cond is None`",
				ruleId: "E711",
			},
		]);
	});

	it("appends a [safe autofix] hint when a finding carries a fix (delta B)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: ruffJsonWithFix() }));
		const out = runRuff(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toBe(
			"F401: `os` imported but unused [safe autofix: `ruff check --fix`]",
		);
	});

	it("does NOT add a fix hint when the finding has no fix (delta B gate)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: ruffJson() }));
		const out = runRuff(input(fileScope()));
		expect(out[0]?.message).toBe("F401: `os` imported but unused");
	});

	it("returns [] on status === 1 with empty stdout (the !output guard, pre-parse)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "" }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] on status === 1 with whitespace-only stdout (trim → '' guard)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "   \n  " }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] on status === 1 with undefined stdout (the '' fallback then guard)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] when ruff emits non-array JSON (parser guard, via status 1)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: JSON.stringify({ not: "an array" }) }),
		);
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] when ruff emits non-JSON garbage (parser catch, via status 1)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "not json {{{" }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("surfaces a loud failure on exit >= 2 (ruff itself errored) — never reads clean", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 2, stderr: "error: unexpected argument '--nope'" }),
		);
		const out = runRuff(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]?.tool).toBe("ruff");
		expect(out[0]?.message).toContain("ruff lint failed (exit 2)");
		expect(out[0]?.message).toContain("lint NOT validated");
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("kaboom");
		});
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("treats a non-ENOENT spawn error as a real (non-zero) run and parses output", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: ruffJson(),
				error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
			}),
		);
		expect(runRuff(input(fileScope()))).toHaveLength(2);
	});
});

// ===========================================================================
// runRuffFormat (sync) — delta A
// ===========================================================================

describe("runRuffFormat (sync)", () => {
	it("invokes `ruff format --check <target>` in file mode with cwd/timeout/pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRuffFormat(input(fileScope(), 7_777));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("ruff");
		expect(args).toEqual(["format", "--check", TARGET]);
		expect(opts).toMatchObject({ cwd: PROJECT_ROOT, timeout: 7_777, encoding: "utf-8" });
	});

	it("targets '.' in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRuffFormat(input(fileScope({ mode: "project" })));
		const args = nonNull(spawnSyncMock.mock.calls[0])[1];
		expect(args).toEqual(["format", "--check", "."]);
	});

	it("returns [] when ruff is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runRuffFormat(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (already formatted)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: wouldReformat() }));
		expect(runRuffFormat(input(fileScope()))).toEqual([]);
	});

	it("parses a `Would reformat:` line into a project-relative finding (status 1)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: wouldReformat() }));
		const out = runRuffFormat(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "ruff-format",
				severity: "warning",
				file: "app/models.py",
				line: 1,
				message: "not ruff-formatted — run `ruff format`",
			},
		]);
	});

	it("emits a generic dirty finding on status 1 with no parseable line (never reads clean)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "" }));
		const out = runRuffFormat(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]?.tool).toBe("ruff-format");
		expect(out[0]?.file).toBe("app/models.py");
		expect(out[0]?.message).toBe("not ruff-formatted — run `ruff format`");
	});

	it("surfaces a loud failure on exit >= 2", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stderr: "error: bad flag" }));
		const out = runRuffFormat(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("ruff format failed (exit 2)");
		expect(out[0]?.message).toContain("format NOT validated");
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("kaboom");
		});
		expect(runRuffFormat(input(fileScope()))).toEqual([]);
	});
});

// ===========================================================================
// runMypyAsync
// ===========================================================================

describe("runMypyAsync", () => {
	it("invokes runProcessAsync with summary/color flags + targetFile in file mode, cwd/timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runMypyAsync(input(fileScope(), 4_321));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("mypy");
		expect(args).toEqual(["--no-error-summary", "--no-color-output", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("targets '.' in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runMypyAsync(input(fileScope({ mode: "project" })));
		const args = nonNull(runProcessAsyncMock.mock.calls[0])[1];
		expect(args).toEqual(["--no-error-summary", "--no-color-output", "."]);
	});

	it("targets '.' when file mode but targetFile is missing", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		const scope = fileScope();
		delete (scope).targetFile;
		await runMypyAsync(input(scope));
		const args = nonNull(runProcessAsyncMock.mock.calls[0])[1];
		expect(args).toEqual(["--no-error-summary", "--no-color-output", "."]);
	});

	it("returns [] when code === null (process never started, e.g. ENOENT)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: mypyOutput() }));
		expect(await runMypyAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 0 (clean) even with stdout content", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: mypyOutput() }));
		expect(await runMypyAsync(input(fileScope()))).toEqual([]);
	});

	it("parses error + warning from stdout on a non-zero code", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: mypyOutput() }));
		const out = await runMypyAsync(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ tool: "mypy", severity: "error", line: 12, ruleId: "return-value" });
		expect(out[1]).toMatchObject({ severity: "warning", line: 30, ruleId: "no-any-return" });
	});

	it("reads diagnostics from stderr too (stdout+stderr concat path)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "", stderr: mypyOutput() }));
		expect(await runMypyAsync(input(fileScope()))).toHaveLength(2);
	});

	it("returns [] on a non-zero code with empty streams (parser yields nothing)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: "", stderr: "" }));
		expect(await runMypyAsync(input(fileScope()))).toEqual([]);
	});
});

// ===========================================================================
// runRuffAsync
// ===========================================================================

describe("runRuffAsync", () => {
	it("invokes runProcessAsync with json output + imposed S/B flags + targetFile in file mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runRuffAsync(input(fileScope(), 1_234));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("ruff");
		expect(args).toEqual(["check", "--output-format=json", ...ENFORCED, TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 1_234 });
	});

	it("targets '.' in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runRuffAsync(input(fileScope({ mode: "project" })));
		const args = nonNull(runProcessAsyncMock.mock.calls[0])[1];
		expect(args).toEqual(["check", "--output-format=json", ...ENFORCED, "."]);
	});

	it("targets '.' when file mode but targetFile is missing", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		const scope = fileScope();
		delete (scope).targetFile;
		await runRuffAsync(input(scope));
		const args = nonNull(runProcessAsyncMock.mock.calls[0])[1];
		expect(args).toEqual(["check", "--output-format=json", ...ENFORCED, "."]);
	});

	it("returns [] when code === null (process never started, e.g. ENOENT)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: ruffJson() }));
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 0 (clean) even with stdout content", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: ruffJson() }));
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("parses findings on a non-zero code", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: ruffJson() }));
		const out = await runRuffAsync(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ tool: "ruff", severity: "warning", ruleId: "F401", column: 4 });
		expect(out[1]).toMatchObject({ ruleId: "E711", line: 19 });
	});

	it("returns [] on a non-zero code with empty stdout (the !output guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "" }));
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a non-zero code with whitespace-only stdout (trim → '' guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "  \n  " }));
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when ruff emits non-array JSON on a non-zero code (parser guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: JSON.stringify({ not: "array" }) }),
		);
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("surfaces a loud failure on code >= 2", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stderr: "boom" }));
		const out = await runRuffAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("ruff lint failed (exit 2)");
	});
});

// ===========================================================================
// runRuffFormatAsync — delta A
// ===========================================================================

describe("runRuffFormatAsync", () => {
	it("invokes runProcessAsync with `format --check` + target, cwd/timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runRuffFormatAsync(input(fileScope(), 2_222));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("ruff");
		expect(args).toEqual(["format", "--check", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 2_222 });
	});

	it("returns [] when code === null (ENOENT)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: wouldReformat() }));
		expect(await runRuffFormatAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 0 (already formatted)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		expect(await runRuffFormatAsync(input(fileScope()))).toEqual([]);
	});

	it("parses a would-reformat finding on code 1", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: wouldReformat() }));
		const out = await runRuffFormatAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ tool: "ruff-format", file: "app/models.py", line: 1 });
	});

	it("surfaces a loud failure on code >= 2", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stderr: "bad" }));
		const out = await runRuffFormatAsync(input(fileScope()));
		expect(out[0]?.message).toContain("ruff format failed (exit 2)");
	});
});
