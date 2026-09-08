import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral unit tests for the ShellCheck tool runners (sync + async).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `shellcheck` binary:
//   • node:child_process `spawnSync` — drives the sync runner.
//   • ../spawn-async.js `runProcessAsync` — drives the async runner.
// The real `parseShellcheckJson` parser runs unmocked so we exercise the
// actual JSON1 → CheckResult[] mapping and the relative-path rewrite branch.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
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
const { runShellcheck, runShellcheckAsync } = await import("./shellcheck.js");

const PROJECT_ROOT = "/work/repo";

/** A shellcheck JSON1 payload whose `file` is absolute (under projectRoot). */
function jsonAbsolute(): string {
	return JSON.stringify({
		comments: [
			{
				file: `${PROJECT_ROOT}/scripts/deploy.sh`,
				line: 12,
				column: 3,
				level: "warning",
				code: 2086,
				message: "Double quote to prevent globbing.",
			},
		],
	});
}

/** A shellcheck JSON1 payload whose `file` is already relative. */
function jsonRelative(): string {
	return JSON.stringify({
		comments: [
			{
				file: "scripts/deploy.sh",
				line: 4,
				column: 1,
				level: "error",
				code: 1009,
				message: "The mentioned syntax error.",
			},
		],
	});
}

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: `${PROJECT_ROOT}/scripts/deploy.sh`,
		...overrides,
	};
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** Build a minimal SpawnSyncReturns shaped for the runner's reads. `stdout`
 *  is intentionally widened to `string | undefined` so we can exercise the
 *  runner's `result.stdout || ""` fallback branch. */
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
// runShellcheck (sync)
// ---------------------------------------------------------------------------

describe("runShellcheck (sync)", () => {
	it("returns [] without spawning when mode is not 'file'", () => {
		const out = runShellcheck(input(fileScope({ mode: "project" })));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("returns [] without spawning when targetFile is missing", () => {
		const scope = fileScope();
		delete (scope).targetFile;
		const out = runShellcheck(input(scope));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("invokes shellcheck with json1 + severity flags, cwd, timeout and pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runShellcheck(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("shellcheck");
		expect(args).toEqual([
			"--format=json1",
			"--severity=warning",
			`${PROJECT_ROOT}/scripts/deploy.sh`,
		]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when status === 0 (clean, no issues)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: jsonAbsolute() }));
		expect(runShellcheck(input(fileScope()))).toEqual([]);
	});

	it("returns [] when result.error is set (spawn-level failure)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: null, error: new Error("ENOENT") }),
		);
		expect(runShellcheck(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status > 1 (shellcheck internal error)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stdout: jsonAbsolute() }));
		expect(runShellcheck(input(fileScope()))).toEqual([]);
	});

	it("parses findings on status === 1 and relativizes an absolute path", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: jsonAbsolute() }));
		const out = runShellcheck(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "shellcheck",
				severity: "warning",
				file: "scripts/deploy.sh",
				line: 12,
				column: 3,
				message: "Double quote to prevent globbing.",
				ruleId: "SC2086",
			},
		]);
	});

	it("leaves an already-relative path untouched (no leading-slash rewrite)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: jsonRelative() }));
		const out = runShellcheck(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("scripts/deploy.sh");
		expect(nonNull(out[0]).severity).toBe("error");
		expect(nonNull(out[0]).ruleId).toBe("SC1009");
	});

	it("handles status === 1 with empty/undefined stdout via the '' fallback", () => {
		// stdout undefined → `result.stdout || ""` → parser gets "" → [].
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runShellcheck(input(fileScope()))).toEqual([]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runShellcheck(input(fileScope()))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// runShellcheckAsync
// ---------------------------------------------------------------------------

describe("runShellcheckAsync", () => {
	it("returns [] without spawning when mode is not 'file'", async () => {
		const out = await runShellcheckAsync(input(fileScope({ mode: "project" })));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("returns [] without spawning when targetFile is missing", async () => {
		const scope = fileScope();
		delete (scope).targetFile;
		const out = await runShellcheckAsync(input(scope));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("invokes runProcessAsync with json1 + severity flags, cwd and timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runShellcheckAsync(input(fileScope(), 4_321));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("shellcheck");
		expect(args).toEqual([
			"--format=json1",
			"--severity=warning",
			`${PROJECT_ROOT}/scripts/deploy.sh`,
		]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("returns [] when code === 0 (clean)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: jsonAbsolute() }));
		expect(await runShellcheckAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === null (spawn never started)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: jsonAbsolute() }));
		expect(await runShellcheckAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code > 1 (shellcheck internal error)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: jsonAbsolute() }));
		expect(await runShellcheckAsync(input(fileScope()))).toEqual([]);
	});

	it("parses findings on code === 1 and relativizes an absolute path", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: jsonAbsolute() }));
		const out = await runShellcheckAsync(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "shellcheck",
				severity: "warning",
				file: "scripts/deploy.sh",
				line: 12,
				column: 3,
				message: "Double quote to prevent globbing.",
				ruleId: "SC2086",
			},
		]);
	});

	it("leaves an already-relative path untouched on code === 1", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: jsonRelative() }));
		const out = await runShellcheckAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("scripts/deploy.sh");
		expect(nonNull(out[0]).ruleId).toBe("SC1009");
	});

	it("returns [] on code === 1 with empty stdout (parser yields no comments)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "" }));
		expect(await runShellcheckAsync(input(fileScope()))).toEqual([]);
	});
});
