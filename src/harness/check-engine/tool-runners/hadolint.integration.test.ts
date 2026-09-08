import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral unit tests for the Hadolint tool runners (sync + async).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `hadolint` binary:
//   • node:child_process `spawnSync` — drives the sync runner.
//   • ../spawn-async.js `runProcessAsync` — drives the async runner.
// The real `parseHadolintJson` parser runs unmocked so we exercise the actual
// JSON → CheckResult[] mapping and the absolute→relative path rewrite branch.

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
const { runHadolint, runHadolintAsync } = await import("./hadolint.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = `${PROJECT_ROOT}/Dockerfile`;

/** A hadolint JSON payload whose `file` is ABSOLUTE (under projectRoot), a
 *  `warning`-level finding — exercises the relative-path rewrite branch. */
function hadolintWarningAbsolute(): string {
	return JSON.stringify([
		{
			line: 7,
			code: "DL3008",
			message: "Pin versions in apt get install.",
			level: "warning",
			file: `${PROJECT_ROOT}/Dockerfile`,
		},
	]);
}

/** A hadolint JSON payload whose `file` is already RELATIVE, an `error`-level
 *  finding — exercises both the no-rewrite branch and the error severity map. */
function hadolintErrorRelative(): string {
	return JSON.stringify([
		{
			line: 1,
			code: "DL3000",
			message: "Use absolute WORKDIR.",
			level: "error",
			file: "Dockerfile",
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

/** Build a minimal SpawnSyncReturns. `stdout` is widened to `string | undefined`
 *  so we can exercise the runner's `result.stdout || ""` fallback branch. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout">> & { stdout?: string | undefined },
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
// runHadolint (sync)
// ---------------------------------------------------------------------------

describe("runHadolint (sync)", () => {
	it("returns [] without spawning when mode is not 'file'", () => {
		const out = runHadolint(input(fileScope({ mode: "project" })));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("returns [] without spawning when targetFile is missing", () => {
		const scope = fileScope();
		delete (scope).targetFile;
		const out = runHadolint(input(scope));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("invokes hadolint with --format json on the target, cwd, timeout and pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runHadolint(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("hadolint");
		expect(args).toEqual(["--format", "json", TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when status === 0 (no issues) without parsing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: hadolintWarningAbsolute() }));
		expect(runHadolint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when result.error is set (spawn-level failure, e.g. ENOENT)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, error: new Error("spawn hadolint ENOENT") }),
		);
		expect(runHadolint(input(fileScope()))).toEqual([]);
	});

	it("parses a warning finding on status === 1 and relativizes the absolute path", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: hadolintWarningAbsolute() }));
		const out = runHadolint(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: "hadolint",
				severity: "warning",
				file: "Dockerfile",
				line: 7,
				message: "DL3008: Pin versions in apt get install.",
				ruleId: "DL3008",
			},
		]);
	});

	it("maps level 'error' to severity 'error' and leaves a relative path untouched", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: hadolintErrorRelative() }));
		const out = runHadolint(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: "hadolint",
			severity: "error",
			file: "Dockerfile",
			line: 1,
			ruleId: "DL3000",
		});
	});

	it("returns [] on status === 1 with undefined stdout via the '' fallback", () => {
		// stdout undefined → `result.stdout || ""` → parser gets "" → [].
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runHadolint(input(fileScope()))).toEqual([]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runHadolint(input(fileScope()))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// runHadolintAsync
// ---------------------------------------------------------------------------

describe("runHadolintAsync", () => {
	it("returns [] without spawning when mode is not 'file'", async () => {
		const out = await runHadolintAsync(input(fileScope({ mode: "project" })));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("returns [] without spawning when targetFile is missing", async () => {
		const scope = fileScope();
		delete (scope).targetFile;
		const out = await runHadolintAsync(input(scope));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("invokes runProcessAsync with --format json on the target, cwd and timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runHadolintAsync(input(fileScope(), 4_321));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("hadolint");
		expect(args).toEqual(["--format", "json", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("returns [] when code === 0 (no issues)", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 0, stdout: hadolintWarningAbsolute() }),
		);
		expect(await runHadolintAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === null (spawn never started)", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: null, stdout: hadolintWarningAbsolute() }),
		);
		expect(await runHadolintAsync(input(fileScope()))).toEqual([]);
	});

	it("parses a warning finding on code === 1 and relativizes the absolute path", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: hadolintWarningAbsolute() }),
		);
		const out = await runHadolintAsync(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: "hadolint",
				severity: "warning",
				file: "Dockerfile",
				line: 7,
				message: "DL3008: Pin versions in apt get install.",
				ruleId: "DL3008",
			},
		]);
	});

	it("maps level 'error' and leaves a relative path untouched on code === 1", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: hadolintErrorRelative() }));
		const out = await runHadolintAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).severity).toBe("error");
		expect(nonNull(out[0]).file).toBe("Dockerfile");
	});

	it("returns [] on code === 1 with empty stdout (parser yields nothing)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "" }));
		expect(await runHadolintAsync(input(fileScope()))).toEqual([]);
	});
});
