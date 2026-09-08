import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process BEFORE importing the SUT (matches the existing
// integration-test convention) so every spawnSync call is deterministic.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

// Spy on the real parsers (not fully replaced) so we can assert on the
// EXACT string handed to them — this is what distinguishes the
// `(result.stderr || "") + (result.stdout || "")`-shaped mutants where the
// "" fallback literal is replaced with "Stryker was here!": the parse
// output alone is often still [] either way, but the argument differs.
vi.mock("../output-parsers.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../output-parsers.js")>();
	return {
		...actual,
		parseGccOutput: vi.fn(actual.parseGccOutput),
		parseClangTidyOutput: vi.fn(actual.parseClangTidyOutput),
	};
});

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { parseClangTidyOutput, parseGccOutput } from "../output-parsers.js";
import type { ToolRunnerInput } from "../types.js";
import { runCCompile, runClangTidy } from "./c-cpp.js";

const spawnMock = vi.mocked(spawnSync);
const gccParseSpy = vi.mocked(parseGccOutput);
const tidyParseSpy = vi.mocked(parseClangTidyOutput);

type SpawnRet = Partial<SpawnSyncReturns<string>>;
const ret = (r: SpawnRet): SpawnSyncReturns<string> => ({
	pid: 1, signal: null, status: 0, stdout: "", stderr: "",
	output: [null, r.stdout ?? "", r.stderr ?? ""], ...r,
});
const versionOk = (): SpawnRet => ({ status: 0, stdout: "v1", stderr: "" });

const fileInput = (targetFile: string, projectRoot = "/proj"): ToolRunnerInput => ({
	scope: { projectRoot, mode: "file", targetFile },
	timeoutMs: 5_000,
});

beforeEach(() => {
	spawnMock.mockReset();
	gccParseSpy.mockClear();
	tidyParseSpy.mockClear();
});

afterEach(() => {
	spawnMock.mockReset();
	gccParseSpy.mockClear();
	tidyParseSpy.mockClear();
});

// =====================================================================
// Module-level: C_EXTENSIONS regex end-anchor (mutantId 05047890ac91d9d0)
// =====================================================================

describe("C_EXTENSIONS regex end-anchor", () => {
	// test-contract: invariant — removing the trailing $ anchor makes
	// the regex match ".c" as a mid-string substring instead of requiring
	// it at the end of the path.
	it("does not treat a.c.txt as a C/C++ file (dotted suffix after .c)", () => {
		expect(runCCompile(fileInput("/proj/a.c.txt"))).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});

// =====================================================================
// detectCompiler — exact --version probe args (8 mutants)
// =====================================================================

describe("detectCompiler — exact probe arguments", () => {
	// test-contract: invariant — full-call toEqual pins the args array
	// (["--version"]), the timeout/encoding/stdio option values, and every
	// element of the stdio triple in one shot.
	it("probes gcc with exact args and options", () => {
		spawnMock.mockReturnValueOnce(ret(versionOk()));
		spawnMock.mockReturnValueOnce(ret({ status: 0, stdout: "", stderr: "" }));
		runCCompile(fileInput("/proj/a.c"));
		expect(spawnMock.mock.calls[0]).toEqual([
			"gcc",
			["--version"],
			{ timeout: 3_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		]);
	});
});

// =====================================================================
// runCCompile — scope-guard boolean logic (mutants: whole-cond->false,
// ||->&&, inner-cond->false)
// =====================================================================

describe("runCCompile — guard boolean structure", () => {
	// test-contract: invariant — runCCompile's file-mode guard
	// (`scope.mode !== "file" || !scope.targetFile`) must short-circuit on
	// the `mode !== "file"` operand alone when targetFile is present.
	it("returns [] and never probes when mode is project even with a targetFile set", () => {
		const input: ToolRunnerInput = {
			scope: { projectRoot: "/proj", mode: "project", targetFile: "/proj/a.c" },
			timeoutMs: 5_000,
		};
		expect(runCCompile(input)).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});

describe("runClangTidy — guard boolean structure", () => {
	// test-contract: invariant — same shape as runCCompile's guard test.
	it("returns [] and never spawns when mode is project even with a targetFile set", () => {
		const input: ToolRunnerInput = {
			scope: { projectRoot: "/proj", mode: "project", targetFile: "/proj/a.cpp" },
			timeoutMs: 5_000,
		};
		expect(runClangTidy(input)).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});

// =====================================================================
// runCCompile — exact compile-call args/options (5 mutants)
// =====================================================================

describe("runCCompile — exact compile invocation", () => {
	// test-contract: invariant — pins encoding "utf-8" and every stdio
	// element via a full-call toEqual.
	it("passes exact -fsyntax-only options (encoding, stdio, cwd, timeout)", () => {
		spawnMock.mockReturnValueOnce(ret(versionOk())); // gcc probe
		spawnMock.mockReturnValueOnce(ret({ status: 0, stdout: "", stderr: "" })); // compile
		runCCompile(fileInput("/proj/a.c", "/my/root"));
		expect(spawnMock.mock.calls[1]).toEqual([
			"gcc",
			["-fsyntax-only", "-Wall", "/proj/a.c"],
			{ cwd: "/my/root", timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		]);
	});
});

describe("runClangTidy — exact invocation", () => {
	// test-contract: invariant — pins encoding "utf-8" and every stdio
	// element via a full-call toEqual.
	it("passes exact options (encoding, stdio, cwd, timeout)", () => {
		spawnMock.mockReturnValueOnce(ret({ status: 0, stdout: "", stderr: "" }));
		runClangTidy(fileInput("/proj/a.cpp", "/my/root2"));
		expect(spawnMock.mock.calls[0]).toEqual([
			"clang-tidy",
			["/proj/a.cpp", "--quiet"],
			{ cwd: "/my/root2", timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		]);
	});
});

// =====================================================================
// runCCompile — ENOENT-branch condition/body mutants
// =====================================================================

describe("runCCompile — ENOENT-branch behavior", () => {
	const withGcc = (compile: SpawnRet) => {
		spawnMock.mockReturnValueOnce(ret(versionOk())).mockReturnValueOnce(ret(compile));
	};

	// test-contract: invariant — runCCompile's ENOENT guard, `result.error
	// && (result.error as NodeJS.ErrnoException).code === "ENOENT"`, must
	// short-circuit to [] before parseGccOutput ever sees the stdout text.
	it("ignores stdout content and returns [] when spawnSync reports real ENOENT", () => {
		withGcc({
			error: Object.assign(new Error("no such file"), { code: "ENOENT" }),
			status: 1,
			stdout: "/proj/a.c:1:1: error: bogus\n",
			stderr: "",
		});
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
	});

	// test-contract: invariant — the same ENOENT guard must NOT match a
	// non-ENOENT error code (ETIMEDOUT); the compile output has to reach
	// parseGccOutput and produce a real diagnostic.
	it("falls through to parsing when the spawn error code is not ENOENT", () => {
		withGcc({
			error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
			status: 1,
			stdout: "/proj/a.c:1:1: error: bogus\n",
			stderr: "",
		});
		const results = runCCompile(fileInput("/proj/a.c"));
		expect(results).toHaveLength(1);
	});

	// test-contract: invariant — error.code is the empty string.
	// Original: "" !== "ENOENT" -> falls through to parsing (1 result).
	// Mutating the "ENOENT" literal to "" makes the comparison true and
	// wrongly short-circuits to [].
	it("falls through to parsing when the spawn error code is the empty string", () => {
		withGcc({
			error: Object.assign(new Error("boom"), { code: "" }),
			status: 1,
			stdout: "/proj/a.c:1:1: error: bogus\n",
			stderr: "",
		});
		const results = runCCompile(fileInput("/proj/a.c"));
		expect(results).toHaveLength(1);
	});

	// test-contract: invariant — status 0 WITH parseable stdout
	// content. Original returns [] (status-0 short-circuit ignores
	// content); flipping `status === 0` to `false` falls through to
	// parsing and produces a non-empty result.
	it("ignores stdout content and returns [] on a clean (status 0) compile", () => {
		withGcc({ status: 0, stdout: "/proj/a.c:1:1: error: bogus\n", stderr: "" });
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
	});


});

describe("runClangTidy — ENOENT-branch behavior", () => {
	// test-contract: invariant — real ENOENT + non-zero status +
	// parseable stdout. Mirrors the runCCompile case above.
	it("ignores stdout content and returns [] when clang-tidy reports real ENOENT", () => {
		spawnMock.mockReturnValueOnce(
			ret({
				error: Object.assign(new Error("no such file"), { code: "ENOENT" }),
				status: 1,
				stdout: "/proj/a.cpp:1:1: warning: x [my-check]\n",
				stderr: "",
			}),
		);
		expect(runClangTidy(fileInput("/proj/a.cpp"))).toEqual([]);
	});

	// test-contract: invariant — error present but not ENOENT; original
	// falls through to parsing (1 result).
	it("falls through to parsing when the spawn error code is not ENOENT", () => {
		spawnMock.mockReturnValueOnce(
			ret({
				error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
				status: 1,
				stdout: "/proj/a.cpp:1:1: warning: x [my-check]\n",
				stderr: "",
			}),
		);
		const results = runClangTidy(fileInput("/proj/a.cpp"));
		expect(results).toHaveLength(1);
	});

	// test-contract: invariant — error.code is the empty string.
	it("falls through to parsing when the spawn error code is the empty string", () => {
		spawnMock.mockReturnValueOnce(
			ret({
				error: Object.assign(new Error("boom"), { code: "" }),
				status: 1,
				stdout: "/proj/a.cpp:1:1: warning: x [my-check]\n",
				stderr: "",
			}),
		);
		const results = runClangTidy(fileInput("/proj/a.cpp"));
		expect(results).toHaveLength(1);
	});

	// test-contract: invariant — status 0 with parseable stdout;
	// original ignores it and returns [].
	it("ignores stdout content and returns [] on a clean (status 0) run", () => {
		spawnMock.mockReturnValueOnce(
			ret({ status: 0, stdout: "/proj/a.cpp:1:1: warning: x [my-check]\n", stderr: "" }),
		);
		expect(runClangTidy(fileInput("/proj/a.cpp"))).toEqual([]);
	});


});
