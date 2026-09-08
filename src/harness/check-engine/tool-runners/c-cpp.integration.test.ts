import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process BEFORE importing the SUT so the runners capture the mock.
// This makes every branch (compiler-present / -absent, clean / dirty exit,
// ENOENT / other-error, spawn-throws) deterministic regardless of whether
// gcc / clang / clang-tidy are actually installed on the host.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import type { ToolRunnerInput } from "../types.js";
import { runCCompile, runClangTidy } from "./c-cpp.js";

const spawnMock = vi.mocked(spawnSync);

/** A spawnSync return shape good enough for the runners under test. */
type SpawnRet = {
	status?: number | null;
	stdout?: string | null;
	stderr?: string | null;
	error?: (Error & { code?: string }) | undefined;
};
const ret = (r: SpawnRet): ReturnType<typeof spawnSync> => {
	// SAFETY: null/absent stdio is intentional malformed process output; these cases exercise the runners' fallback handling.
	return { pid: 123, output: [], signal: null, status: null, stdout: "", stderr: "", ...r } as ReturnType<typeof spawnSync>;
};

/** Standard "this binary exists" answer for a `--version` probe. */
const versionOk = (): SpawnRet => ({ status: 0, stdout: "v1", stderr: "" });
/** A `--version` probe that failed to spawn (binary missing). */
const versionMissing = (): SpawnRet => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });

const fileInput = (targetFile: string, projectRoot = "/proj"): ToolRunnerInput => ({
	scope: { projectRoot, mode: "file", targetFile },
	timeoutMs: 5_000,
});
const projectInput = (): ToolRunnerInput => ({
	scope: { projectRoot: "/proj", mode: "project" },
	timeoutMs: 5_000,
});

beforeEach(() => {
	spawnMock.mockReset();
});

afterEach(() => {
	spawnMock.mockReset();
});

// =====================================================================
// runCCompile — early-return guards (no compiler probe should happen)
// =====================================================================

describe("runCCompile — scope guards", () => {
	it("returns [] in project mode without ever probing a compiler", () => {
		expect(runCCompile(projectInput())).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("returns [] in file mode when targetFile is missing", () => {
		const input: ToolRunnerInput = {
			scope: { projectRoot: "/proj", mode: "file" },
			timeoutMs: 5_000,
		};
		expect(runCCompile(input)).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("returns [] for a non-C/C++ file extension (regex miss)", () => {
		expect(runCCompile(fileInput("/proj/src/index.ts"))).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it.each([
		"/proj/a.c",
		"/proj/a.h",
		"/proj/a.m",
		"/proj/a.cpp",
		"/proj/a.cxx",
		"/proj/a.cc",
		"/proj/a.hpp",
		"/proj/a.hxx",
		"/proj/a.mm",
	])("treats %s as a C/C++ file (passes the extension gate)", (path) => {
		// No compiler available so it bails after the probe — but it MUST get
		// past the extension gate, which means it probes for a compiler.
		spawnMock.mockReturnValue(ret(versionMissing()));
		expect(runCCompile(fileInput(path))).toEqual([]);
		expect(spawnMock).toHaveBeenCalled();
	});
});

// =====================================================================
// runCCompile — detectCompiler() branch matrix
// =====================================================================

describe("runCCompile — compiler detection", () => {
	it("returns [] when neither gcc nor clang is available", () => {
		// Both --version probes fail to spawn.
		spawnMock.mockReturnValue(ret(versionMissing()));
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
		// Two probes: gcc then clang.
		expect(spawnMock).toHaveBeenCalledTimes(2);
		expect(spawnMock.mock.calls[0]?.[0]).toBe("gcc");
		expect(spawnMock.mock.calls[1]?.[0]).toBe("clang");
	});

	it("falls back to clang when gcc probe throws (catch branch in detectCompiler)", () => {
		spawnMock
			.mockImplementationOnce(() => {
				throw new Error("spawn gcc EACCES");
			}) // gcc probe throws -> caught -> continue
			.mockReturnValueOnce(ret(versionOk())) // clang probe ok -> detected
			.mockReturnValueOnce(ret({ status: 0, stdout: "", stderr: "" })); // clang syntax check clean
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
		// gcc(probe-throws) + clang(probe) + clang(syntax-check) = 3 calls.
		expect(spawnMock).toHaveBeenCalledTimes(3);
		expect(spawnMock.mock.calls[2]?.[0]).toBe("clang");
	});

	it("prefers gcc when its probe succeeds (early return, clang never probed)", () => {
		spawnMock
			.mockReturnValueOnce(ret(versionOk())) // gcc probe ok -> detected, loop returns
			.mockReturnValueOnce(ret({ status: 0, stdout: "", stderr: "" })); // gcc syntax check clean
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
		expect(spawnMock).toHaveBeenCalledTimes(2);
		expect(spawnMock.mock.calls[0]?.[0]).toBe("gcc");
		// syntax check also runs gcc, not clang
		expect(spawnMock.mock.calls[1]?.[0]).toBe("gcc");
	});

	it("falls back to clang when gcc probe returns an error object (no throw)", () => {
		spawnMock
			.mockReturnValueOnce(ret(versionMissing())) // gcc probe: result.error set -> not returned
			.mockReturnValueOnce(ret(versionOk())) // clang probe ok
			.mockReturnValueOnce(ret({ status: 0, stdout: "", stderr: "" })); // clang clean
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
		expect(spawnMock.mock.calls[2]?.[0]).toBe("clang");
	});
});

// =====================================================================
// runCCompile — syntax-check result branches
// =====================================================================

describe("runCCompile — syntax check outcomes", () => {
	/** Make gcc the detected compiler, then queue the syntax-check answer. */
	const withGcc = (syntax: SpawnRet) => {
		spawnMock.mockReturnValueOnce(ret(versionOk())).mockReturnValueOnce(ret(syntax));
	};

	it("returns [] when the compile invocation reports ENOENT", () => {
		withGcc(versionMissing()); // status undefined, error ENOENT
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
	});

	it("returns [] on a clean compile (status 0)", () => {
		withGcc({ status: 0, stdout: "", stderr: "" });
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
	});

	it("parses gcc errors from stderr when status is non-zero", () => {
		withGcc({
			status: 1,
			stdout: "",
			stderr: "/proj/a.c:3:5: error: expected ';' before '}' token\n",
		});
		const results = runCCompile(fileInput("/proj/a.c"));
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			tool: "c-compile",
			severity: "error",
			file: "/proj/a.c",
			line: 3,
			column: 5,
			message: "expected ';' before '}' token",
		});
	});

	it("parses a warning (with -W flag) into a ruleId", () => {
		withGcc({
			status: 1,
			stdout: "",
			stderr: "/proj/a.c:2:9: warning: unused variable 'x' [-Wunused-variable]\n",
		});
		const results = runCCompile(fileInput("/proj/a.c"));
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			severity: "warning",
			ruleId: "-Wunused-variable",
			message: "unused variable 'x'",
		});
	});

	it("includes stdout in the parsed output (stderr || '' + stdout || '')", () => {
		// stderr empty/null, diagnostic arrives on stdout instead.
		withGcc({
			status: 1,
			stdout: "/proj/a.c:1:1: fatal error: no input\n",
			stderr: null,
		});
		const results = runCCompile(fileInput("/proj/a.c"));
		expect(results).toHaveLength(1);
		expect(results[0]?.severity).toBe("error");
	});

	it("handles non-zero status with both stderr and stdout null (empty parse)", () => {
		withGcc({ status: 2, stdout: null, stderr: null });
		// No parseable lines -> empty result, exercises both `|| ""` fallbacks.
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
	});

	it("falls through to status check when error is set but code is not ENOENT", () => {
		// result.error truthy but code !== 'ENOENT' -> skip the ENOENT early return,
		// then status 0 short-circuits to [].
		withGcc({
			status: 0,
			error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
			stdout: "",
			stderr: "",
		});
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
	});

	it("returns [] when spawnSync throws during the compile (catch branch)", () => {
		spawnMock
			.mockReturnValueOnce(ret(versionOk())) // gcc detected
			.mockImplementationOnce(() => {
				throw new Error("spawn EAGAIN");
			}); // compile spawn throws
		expect(runCCompile(fileInput("/proj/a.c"))).toEqual([]);
	});

	it("passes -fsyntax-only -Wall and the target file, cwd = projectRoot", () => {
		withGcc({ status: 0, stdout: "", stderr: "" });
		runCCompile(fileInput("/proj/a.c", "/my/root"));
		const compileCall = spawnMock.mock.calls[1];
		expect(compileCall?.[0]).toBe("gcc");
		expect(compileCall?.[1]).toEqual(["-fsyntax-only", "-Wall", "/proj/a.c"]);
		expect(compileCall?.[2]?.cwd).toBe("/my/root");
	});
});

// =====================================================================
// runClangTidy — scope guards
// =====================================================================

describe("runClangTidy — scope guards", () => {
	it("returns [] in project mode without spawning", () => {
		expect(runClangTidy(projectInput())).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("returns [] in file mode when targetFile is missing", () => {
		const input: ToolRunnerInput = {
			scope: { projectRoot: "/proj", mode: "file" },
			timeoutMs: 5_000,
		};
		expect(runClangTidy(input)).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("returns [] for a non-C/C++ file extension", () => {
		expect(runClangTidy(fileInput("/proj/main.py"))).toEqual([]);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});

// =====================================================================
// runClangTidy — result branches
// =====================================================================

describe("runClangTidy — outcomes", () => {
	it("returns [] when clang-tidy is not installed (ENOENT)", () => {
		spawnMock.mockReturnValueOnce(ret(versionMissing()));
		expect(runClangTidy(fileInput("/proj/a.cpp"))).toEqual([]);
		expect(spawnMock.mock.calls[0]?.[0]).toBe("clang-tidy");
	});

	it("returns [] on a clean run (status 0)", () => {
		spawnMock.mockReturnValueOnce(ret({ status: 0, stdout: "", stderr: "" }));
		expect(runClangTidy(fileInput("/proj/a.cpp"))).toEqual([]);
	});

	it("parses clang-tidy warnings from stdout when status is non-zero", () => {
		spawnMock.mockReturnValueOnce(
			ret({
				status: 1,
				stdout: "/proj/a.cpp:10:3: warning: use nullptr [modernize-use-nullptr]\n",
				stderr: "",
			}),
		);
		const results = runClangTidy(fileInput("/proj/a.cpp"));
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			tool: "clang-tidy",
			severity: "warning",
			file: "/proj/a.cpp",
			line: 10,
			column: 3,
			message: "use nullptr",
			ruleId: "modernize-use-nullptr",
		});
	});

	it("reads diagnostics from stderr too (stdout || '' + stderr || '')", () => {
		// stdout null -> falls back to stderr for the diagnostic line.
		spawnMock.mockReturnValueOnce(
			ret({
				status: 1,
				stdout: null,
				stderr: "/proj/a.cpp:4:1: error: bad thing [clang-diagnostic-error]\n",
			}),
		);
		const results = runClangTidy(fileInput("/proj/a.cpp"));
		expect(results).toHaveLength(1);
		expect(results[0]?.severity).toBe("error");
	});

	it("handles non-zero status with both streams null (empty parse)", () => {
		spawnMock.mockReturnValueOnce(ret({ status: 1, stdout: null, stderr: null }));
		expect(runClangTidy(fileInput("/proj/a.cpp"))).toEqual([]);
	});

	it("falls through to status check when error is set but code is not ENOENT", () => {
		spawnMock.mockReturnValueOnce(
			ret({
				status: 0,
				error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
				stdout: "",
				stderr: "",
			}),
		);
		expect(runClangTidy(fileInput("/proj/a.cpp"))).toEqual([]);
	});

	it("returns [] when spawnSync throws (catch branch)", () => {
		spawnMock.mockImplementationOnce(() => {
			throw new Error("spawn EAGAIN");
		});
		expect(runClangTidy(fileInput("/proj/a.cpp"))).toEqual([]);
	});

	it("invokes clang-tidy with --quiet, the target file, cwd = projectRoot", () => {
		spawnMock.mockReturnValueOnce(ret({ status: 0, stdout: "", stderr: "" }));
		runClangTidy(fileInput("/proj/a.cpp", "/my/root"));
		const call = spawnMock.mock.calls[0];
		expect(call?.[0]).toBe("clang-tidy");
		expect(call?.[1]).toEqual(["/proj/a.cpp", "--quiet"]);
		expect(call?.[2]?.cwd).toBe("/my/root");
	});
});

// =====================================================================
// Original behavioral cases (preserved): array-shape on empty project mode.
// These now run against the mock; the contract (Array result) still holds.
// =====================================================================

describe("C/C++ runners — array-shape contract (preserved)", () => {
	it("runCCompile returns an array in project mode (no .c/.cpp files)", () => {
		const out = runCCompile(projectInput());
		expect(Array.isArray(out)).toBe(true);
		expect(out).toEqual([]);
	});

	it("runClangTidy returns an array in project mode", () => {
		const out = runClangTidy(projectInput());
		expect(Array.isArray(out)).toBe(true);
		expect(out).toEqual([]);
	});
});
