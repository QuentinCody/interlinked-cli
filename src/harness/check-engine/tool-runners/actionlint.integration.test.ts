import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral unit tests for the actionlint tool runners (sync + async).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `actionlint` binary:
//   • node:child_process `spawnSync` — drives the sync runner.
//   • ../spawn-async.js `runProcessAsync` — drives the async runner.
// The real `parseActionlintOutput` parser runs unmocked so we exercise the
// actual "file:line:col: message [rule]" → CheckResult[] mapping and the
// absolute→relative path rewrite branch. Unlike taplo/hadolint, actionlint
// runs in BOTH file and project mode (the argv differs), so the mode branch
// is covered here rather than guarded out.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { RunProcessResult } from "../spawn-async.js";
import type { CheckResult, CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn<SpawnSyncStub>();
const runProcessAsyncMock = vi.fn<typeof import("../spawn-async.js").runProcessAsync>();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: Parameters<SpawnSyncStub>) => spawnSyncMock(...args),
}));

vi.mock("../spawn-async.js", () => ({
	runProcessAsync: (...args: Parameters<typeof runProcessAsyncMock>) => runProcessAsyncMock(...args),
}));

// Imported after the mocks are registered.
const { runActionlint, runActionlintAsync } = await import("./actionlint.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = `${PROJECT_ROOT}/.github/workflows/ci.yml`;

/** An actionlint diagnostic carrying a `[rule]` suffix and an ABSOLUTE path
 *  (under projectRoot) — exercises ruleId capture + the relative-path rewrite. */
function actionlintWithRuleAbsolute(): string {
	return `${PROJECT_ROOT}/.github/workflows/ci.yml:9:5: property "runs_on" is not defined [expression]\n`;
}

/** An actionlint diagnostic WITHOUT a `[rule]` suffix and an already-relative
 *  path — exercises ruleId undefined + the no-rewrite branch. */
function actionlintNoRuleRelative(): string {
	return ".github/workflows/ci.yml:3:1: could not parse as YAML\n";
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

/** Build a minimal SpawnSyncReturns. `stdout`/`stderr` are widened to
 *  `string | undefined` so we can exercise the `result.x || ""` fallbacks. */
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

beforeEach(() => {
	spawnSyncMock.mockReset();
	runProcessAsyncMock.mockReset();
});

// ---------------------------------------------------------------------------
// runActionlint (sync)
// ---------------------------------------------------------------------------

describe("runActionlint (sync)", () => {
	it("invokes actionlint with the single target file in file mode (cwd/timeout/pipes)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runActionlint(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("actionlint");
		expect(args).toEqual([TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("invokes actionlint with -oneline in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runActionlint(input(fileScope({ mode: "project" })));
		expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(["-oneline"]);
	});

	it("invokes actionlint with -oneline in file mode when targetFile is missing", () => {
		const scope = fileScope();
		delete (scope).targetFile;
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runActionlint(input(scope));
		expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(["-oneline"]);
	});

	it("returns [] when status === 0 (no problems) without parsing", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 0, stdout: actionlintWithRuleAbsolute() }),
		);
		expect(runActionlint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when result.error is set (spawn-level failure, e.g. ENOENT)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, error: new Error("spawn actionlint ENOENT") }),
		);
		expect(runActionlint(input(fileScope()))).toEqual([]);
	});

	it("parses a diagnostic with a [rule] suffix on non-zero status and relativizes the path", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: actionlintWithRuleAbsolute() }),
		);
		const out = runActionlint(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: "actionlint",
				severity: "warning",
				file: ".github/workflows/ci.yml",
				line: 9,
				column: 5,
				message: 'property "runs_on" is not defined',
				ruleId: "expression",
			},
		]);
	});

	it("emits ruleId undefined and leaves a relative path untouched when no [rule] suffix", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: actionlintNoRuleRelative() }));
		const out = runActionlint(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			file: ".github/workflows/ci.yml",
			line: 3,
			column: 1,
			message: "could not parse as YAML",
		});
		expect(nonNull(out[0]).ruleId).toBeUndefined();
	});

	it("reads a diagnostic from stderr when stdout is undefined ('' fallback)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: undefined, stderr: actionlintWithRuleAbsolute() }),
		);
		const out = runActionlint(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).ruleId).toBe("expression");
	});

	it("returns [] on non-zero status with undefined stdout/stderr (parser yields nothing)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: undefined, stderr: undefined }),
		);
		expect(runActionlint(input(fileScope()))).toEqual([]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runActionlint(input(fileScope()))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// runActionlintAsync
// ---------------------------------------------------------------------------

describe("runActionlintAsync", () => {
	it("invokes runProcessAsync with the single target file in file mode (cwd/timeout)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runActionlintAsync(input(fileScope(), 4_321));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("actionlint");
		expect(args).toEqual([TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("invokes runProcessAsync with -oneline in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runActionlintAsync(input(fileScope({ mode: "project" })));
		expect(runProcessAsyncMock.mock.calls[0]?.[1]).toEqual(["-oneline"]);
	});

	it("returns [] when code === 0 (no problems)", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 0, stdout: actionlintWithRuleAbsolute() }),
		);
		expect(await runActionlintAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === null (spawn never started)", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: null, stdout: actionlintWithRuleAbsolute() }),
		);
		expect(await runActionlintAsync(input(fileScope()))).toEqual([]);
	});

	it("parses a diagnostic on code === 1 and relativizes the absolute path", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: actionlintWithRuleAbsolute() }),
		);
		const out = await runActionlintAsync(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: "actionlint",
				severity: "warning",
				file: ".github/workflows/ci.yml",
				line: 9,
				column: 5,
				message: 'property "runs_on" is not defined',
				ruleId: "expression",
			},
		]);
	});

	it("merges stdout + stderr (template-literal concat); reads from stderr alone", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: "", stderr: actionlintNoRuleRelative() }),
		);
		const out = await runActionlintAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(".github/workflows/ci.yml");
		expect(nonNull(out[0]).ruleId).toBeUndefined();
	});

	it("returns [] on code === 1 with empty output (parser yields nothing)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "", stderr: "" }));
		expect(await runActionlintAsync(input(fileScope()))).toEqual([]);
	});
});
