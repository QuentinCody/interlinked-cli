import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral unit tests for the Taplo tool runners (sync + async).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `taplo` binary:
//   • node:child_process `spawnSync` — drives the sync runner.
//   • ../spawn-async.js `runProcessAsync` — drives the async runner.
// The real `parseTaploOutput` parser runs unmocked so we exercise the actual
// stderr → CheckResult[] mapping and the absolute→relative path rewrite branch.

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
const { runTaplo, runTaploAsync } = await import("./taplo.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = `${PROJECT_ROOT}/Cargo.toml`;

/** A taplo `check` stderr blob with one error carrying an ABSOLUTE `--> file`
 *  location (under projectRoot), exercising the relative-path rewrite. */
function taploErrorAbsolute(): string {
	return [
		"error: invalid key",
		`  --> ${PROJECT_ROOT}/Cargo.toml:5:3`,
		"   |",
	].join("\n");
}

/** A taplo error whose location line is omitted, so the parser falls back to
 *  the passed-in `filePath` (which is the relative target → no rewrite). */
function taploErrorNoLocation(): string {
	return "error[schema]: expected string\n";
}

/** A taplo error whose `--> file` location is ALREADY relative, so the runner's
 *  `startsWith("/")` rewrite is skipped (the false branch of the ternary). */
function taploErrorRelative(): string {
	return ["error: dangling key", "  --> Cargo.toml:9:1", "   |"].join("\n");
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
// runTaplo (sync)
// ---------------------------------------------------------------------------

describe("runTaplo (sync)", () => {
	it("returns [] without spawning when mode is not 'file'", () => {
		const out = runTaplo(input(fileScope({ mode: "project" })));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("returns [] without spawning when targetFile is missing", () => {
		const scope = fileScope();
		delete (scope).targetFile;
		const out = runTaplo(input(scope));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("invokes taplo check on the target with cwd, timeout and pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runTaplo(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("taplo");
		expect(args).toEqual(["check", TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when status === 0 (TOML valid) without parsing", () => {
		// stderr carries a would-be diagnostic, but status 0 short-circuits first.
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stderr: taploErrorAbsolute() }));
		expect(runTaplo(input(fileScope()))).toEqual([]);
	});

	it("returns [] when result.error is set (spawn-level failure, e.g. ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, error: new Error("spawn taplo ENOENT") }));
		expect(runTaplo(input(fileScope()))).toEqual([]);
	});

	it("parses an error from stderr on non-zero status and relativizes the path", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: taploErrorAbsolute() }));
		const out = runTaplo(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: "taplo",
				severity: "error",
				file: "Cargo.toml",
				line: 5,
				column: 3,
				message: "invalid key",
				ruleId: undefined,
			},
		]);
	});

	it("merges stdout into the parsed output (stdout + stderr concat)", () => {
		// Diagnostic delivered via stdout, stderr empty — exercises the stdout half.
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: taploErrorAbsolute(), stderr: "" }),
		);
		const out = runTaplo(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("Cargo.toml");
		expect(nonNull(out[0]).line).toBe(5);
	});

	it("falls back to the relative targetFile when no '-->' location is present (no rewrite)", () => {
		// No location line → parser uses filePath (the absolute target). Since the
		// target itself starts with "/", it is relativized against projectRoot.
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: taploErrorNoLocation() }));
		const out = runTaplo(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("Cargo.toml");
		expect(nonNull(out[0]).line).toBe(0);
		expect(nonNull(out[0]).ruleId).toBe("schema");
		expect(nonNull(out[0]).message).toBe("expected string");
	});

	it("leaves an already-relative '-->' path untouched (no leading-slash rewrite)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: taploErrorRelative() }));
		const out = runTaplo(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("Cargo.toml");
		expect(nonNull(out[0]).line).toBe(9);
		expect(nonNull(out[0]).column).toBe(1);
		expect(nonNull(out[0]).message).toBe("dangling key");
	});

	it("handles undefined stdout/stderr via the '' fallback (parser yields nothing)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: undefined, stderr: undefined }),
		);
		expect(runTaplo(input(fileScope()))).toEqual([]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runTaplo(input(fileScope()))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// runTaploAsync
// ---------------------------------------------------------------------------

describe("runTaploAsync", () => {
	it("returns [] without spawning when mode is not 'file'", async () => {
		const out = await runTaploAsync(input(fileScope({ mode: "project" })));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("returns [] without spawning when targetFile is missing", async () => {
		const scope = fileScope();
		delete (scope).targetFile;
		const out = await runTaploAsync(input(scope));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("invokes runProcessAsync with taplo check on the target, cwd and timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runTaploAsync(input(fileScope(), 4_321));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("taplo");
		expect(args).toEqual(["check", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("returns [] when code === 0 (TOML valid)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stderr: taploErrorAbsolute() }));
		expect(await runTaploAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === null (spawn never started)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stderr: taploErrorAbsolute() }));
		expect(await runTaploAsync(input(fileScope()))).toEqual([]);
	});

	it("parses an error on code === 1 and relativizes the absolute path", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stderr: taploErrorAbsolute() }));
		const out = await runTaploAsync(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: "taplo",
				severity: "error",
				file: "Cargo.toml",
				line: 5,
				column: 3,
				message: "invalid key",
				ruleId: undefined,
			},
		]);
	});

	it("merges stdout + stderr (template-literal concat) on code === 1", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: taploErrorAbsolute() }));
		const out = await runTaploAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("Cargo.toml");
	});

	it("leaves an already-relative '-->' path untouched on code === 1", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stderr: taploErrorRelative() }));
		const out = await runTaploAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("Cargo.toml");
		expect(nonNull(out[0]).line).toBe(9);
	});

	it("returns [] on code === 1 with empty output (parser yields no errors)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "", stderr: "" }));
		expect(await runTaploAsync(input(fileScope()))).toEqual([]);
	});
});
