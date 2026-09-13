import { parseWire, wireArray, wireString } from "../../lib/value-validation.js";
import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { scheduleTests } = vi.hoisted(() => ({ scheduleTests: vi.fn() }));
vi.mock("../test-scheduler.js", () => ({ scheduleTests }));

// Mock child_process BEFORE importing the dispatchers — the dispatchers call
// spawnSync at module scope resolution, so mocking after import is too late.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));
vi.mock("../quality-checks/test-process-gate.js", async () => {
	const { spawnSync } = await import("node:child_process");
	return {
		runBoundedTestProcess: async (spec: {
			command: string;
			args: string[];
			cwd: string;
			timeoutMs: number;
		}) => {
			const result = spawnSync(spec.command, spec.args, {
				shell: false,
				timeout: spec.timeoutMs,
				cwd: spec.cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (result.error || result.status === null) {
				return { kind: "deferred" as const, reason: "unavailable" as const };
			}
			return {
				kind: "completed" as const,
				code: result.status,
				stdout: result.stdout || "",
				stderr: result.stderr || "",
				timedOut: false,
			};
		},
	};
});
// Mock existsSync so runPytestDispatcher's candidate lookup deterministically
// finds (or doesn't find) a test file regardless of the host filesystem.
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

import { spawnSync as mockedSpawnSync } from "node:child_process";
import { existsSync as mockedExistsSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import { getProfileForFile } from "../language-profiles.js";
import {
	TEST_DISPATCHERS,
} from "../quality-checks/test-dispatchers.js";

const spawnSyncMock = vi.mocked(mockedSpawnSync);
const existsSyncMock = vi.mocked(mockedExistsSync);

function mkSpawnResult(opts: {
	status?: number | null;
	stdout?: string;
	stderr?: string;
	error?: NodeJS.ErrnoException;
}): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, opts.stdout ?? "", opts.stderr ?? ""],
		stdout: opts.stdout ?? "",
		stderr: opts.stderr ?? "",
		status: opts.status === undefined ? 0 : opts.status,
		signal: null,
		...(opts.error ? { error: opts.error } : {}),
	};
}

beforeEach(() => {
    scheduleTests.mockReset();
    scheduleTests.mockResolvedValue({ status: "passed" });
	spawnSyncMock.mockReset();
	existsSyncMock.mockReset();
	existsSyncMock.mockReturnValue(false);
});

describe("TEST_DISPATCHERS — registry", () => {
	it("registers typescript, python, rust, go", () => {
		expect(TEST_DISPATCHERS.typescript).toBeDefined();
		expect(TEST_DISPATCHERS.python).toBeDefined();
		expect(TEST_DISPATCHERS.rust).toBeDefined();
		expect(TEST_DISPATCHERS.go).toBeDefined();
	});

	it("does NOT register swift, java, c_cpp (silent-skip for now)", () => {
		expect("swift" in TEST_DISPATCHERS).toBe(false);
		expect("java" in TEST_DISPATCHERS).toBe(false);
		expect("c_cpp" in TEST_DISPATCHERS).toBe(false);
	});
});

describe("runPytestDispatcher", () => {
	const filePath = "/repo/src/m.py";
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error("python profile missing");
	const dispatcher = TEST_DISPATCHERS.python;
	if (!dispatcher) throw new Error("python dispatcher not registered");

	it("returns empty when no test-candidate file exists", async () => {
		existsSyncMock.mockReturnValue(false);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/m.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("reports no verdict when pytest is unavailable", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: null,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}),
			}),
		);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/m.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("reports no verdict for an errored pytest process even when status is nonzero", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}),
			}),
		);
		const out = await dispatcher({
			filePath: "/repo/src/pytest-enoent.py",
			absPath: "/repo/src/pytest-enoent.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("classifies ImportError as pre-existing (no result)", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 2,
				stdout: "",
				stderr: "ImportError: cannot import name 'foo' from 'bar'",
			}),
		);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/m.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("reports an edit-introduced failure", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "FAILED tests/test_m.py::test_adds - AssertionError: 1 != 2",
			}),
		);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/m.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).name).toBe("affected_tests");
		expect(nonNull(out[0]).file).toBe(filePath);
		expect(nonNull(out[0]).message).toContain("pytest");
	});

	it("uses the exact pytest command and spawn options", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		await dispatcher({
			filePath: "/repo/src/command.py",
			absPath: "/repo/src/command.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 4321,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"python",
			["-m", "pytest", "-x", "--tb=short", "-q", "src/test_command.py"],
			{
				shell: false,
				timeout: 4321,
				cwd: "/repo",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	});

	it("treats a null pytest status as an explicit no-verdict result", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: null }));
		const out = await dispatcher({
			filePath: "/repo/src/pytest-null.py",
			absPath: "/repo/src/pytest-null.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("keeps pytest-failure baselines distinct for different candidate files", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stdout: "AssertionError: pytest baseline" }),
		);
		const run = (name: string) =>
			dispatcher({
				filePath: `/repo/src/${name}.py`,
				absPath: `/repo/src/${name}.py`,
				profile,
				checkCwd: "/repo",
				timeoutMs: 5000,
				severity: "error",
				checkName: "affected_tests",
			});
		expect(await run("pytest-baseline-a")).toHaveLength(1);
		expect(await run("pytest-baseline-b")).toHaveLength(1);
	});
});

describe("runCargoTestDispatcher", () => {
	const filePath = "/repo/src/lib.rs";
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error("rust profile missing");
	const dispatcher = TEST_DISPATCHERS.rust;
	if (!dispatcher) throw new Error("rust dispatcher not registered");

	it("classifies unresolved import as pre-existing", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 101,
				stdout: "",
				stderr: "error[E0432]: unresolved import `foo`",
			}),
		);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("reports compile error from cargo test --no-run", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 101,
				stdout: "",
				stderr: "error[E0308]: mismatched types: expected `u32`, found `&str`",
			}),
		);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("cargo test");
	});

	it("reports no verdict when cargo is unavailable", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: null,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}),
			}),
		);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("reports no verdict for an errored cargo process even when status is nonzero", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}),
			}),
		);
		const out = await dispatcher({
			filePath: "/repo/src/cargo-enoent.rs",
			absPath: "/repo/src/cargo-enoent.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("passes --no-run flag", async () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"cargo",
			["test", "--no-run", "--message-format=short"],
			{
				shell: false,
				timeout: 15000,
				cwd: "/repo",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	});

	it("treats a null cargo status as an explicit no-verdict result", async () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: null }));
		const out = await dispatcher({
			filePath: "/repo/src/cargo-null.rs",
			absPath: "/repo/src/cargo-null.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("keeps cargo-failure baselines distinct for different project roots", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 101, stderr: "error[E0308]: baseline mismatch" }),
		);
		const run = (root: string) =>
			dispatcher({
				filePath: `${root}/src/lib.rs`,
				absPath: `${root}/src/lib.rs`,
				profile,
				checkCwd: root,
				timeoutMs: 15000,
				severity: "error",
				checkName: "affected_tests",
			});
		expect(await run("/repo/cargo-baseline-a")).toHaveLength(1);
		expect(await run("/repo/cargo-baseline-b")).toHaveLength(1);
	});
});

describe("runGoTestDispatcher", () => {
	const filePath = "/repo/src/pkg/m.go";
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error("go profile missing");
	const dispatcher = TEST_DISPATCHERS.go;
	if (!dispatcher) throw new Error("go dispatcher not registered");

	it("scopes `go test` to the package directory, not project-wide", async () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		const args = parseWire(nonNull(spawnSyncMock.mock.calls[0])[1], wireArray(wireString), "test JSON value");
		expect(args[0]).toBe("test");
		// Scopes to ./src/pkg — NOT ./... — so unrelated failing packages
		// don't drown the agent in noise unrelated to the current edit.
		expect(args).toContain("./src/pkg");
		expect(args).not.toContain("./...");
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"go",
			["test", "-count=1", "./src/pkg"],
			{
				shell: false,
				timeout: 15000,
				cwd: "/repo",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	});

	it("reports no verdict for an errored go process even when status is nonzero", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}),
			}),
		);
		const out = await dispatcher({
			filePath: "/repo/src/pkg/go-enoent.go",
			absPath: "/repo/src/pkg/go-enoent.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("classifies `cannot find package` as pre-existing", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "",
				stderr: "cannot find package foo/bar in /go/src/foo/bar",
			}),
		);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("reports a genuine test failure", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout:
					"--- FAIL: TestAdd (0.00s)\n    m_test.go:12: expected 2, got 1\nFAIL\n",
			}),
		);
		const out = await dispatcher({
			filePath,
			absPath: "/repo/src/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(filePath);
		expect(nonNull(out[0]).message).toBe("Tests failed for /repo/src/pkg/m.go (go test ./src/pkg)");
	});
});

describe("runVitestDispatcher — shared execution", () => {
    const profile = getProfileForFile("/repo/src/a.ts");
    async function run() {
        if (!profile || !TEST_DISPATCHERS.typescript) throw new Error("missing TypeScript dispatcher");
        return TEST_DISPATCHERS.typescript({ profile, absPath: "/repo/src/a.ts", filePath: "src/a.ts",
            checkCwd: "/repo", timeoutMs: 5000, severity: "error", checkName: "affected_tests" });
    }
    it("reports a failed shared execution without a second fallback process", async () => {
        scheduleTests.mockResolvedValue({ status: "failed", output: "AssertionError: mismatch" });
        expect(await run()).toEqual([expect.objectContaining({ name: "affected_tests", detail: "AssertionError: mismatch" })]);
        expect(scheduleTests).toHaveBeenCalledTimes(1);
        expect(spawnSyncMock).not.toHaveBeenCalled();
    });
    it.each(["stale", "deferred", "empty"])("does not certify %s execution", async status => {
        scheduleTests.mockResolvedValue({ status, reason: "No current verdict" });
        expect(await run()).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
    });
    it("reports planning failures as retained work", async () => {
        scheduleTests.mockRejectedValue(new Error("discovery unavailable"));
        expect(await run()).toEqual([expect.objectContaining({ detail: "discovery unavailable" })]);
    });
});

describe("runGoTestDispatcher — path scoping branches", () => {
	const profile = getProfileForFile("/repo/m.go");
	if (!profile) throw new Error("go profile missing");
	const dispatcher = TEST_DISPATCHERS.go;
	if (!dispatcher) throw new Error("go dispatcher not registered");

	it("uses '.' as the package arg when the file sits in the project root", async () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		await dispatcher({
			filePath: "m.go",
			absPath: "/repo/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = parseWire(nonNull(spawnSyncMock.mock.calls[0])[1], wireArray(wireString), "test JSON value");
		// relative("/repo","/repo") === "" → falls back to "."
		expect(args).toContain(".");
		expect(args).toEqual(["test", "-count=1", "."]);
	});

	it("prefixes a non-dot package path with ./ and forward slashes", async () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		await dispatcher({
			filePath: "internal/svc/m.go",
			absPath: "/repo/internal/svc/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = parseWire(nonNull(spawnSyncMock.mock.calls[0])[1], wireArray(wireString), "test JSON value");
		expect(args).toContain("./internal/svc");
	});

	it("keeps a parent-relative ('..') package path as-is (no extra ./ prefix)", async () => {
		// pkgDir resolves OUTSIDE checkCwd → relative() starts with ".." →
		// the `relPkg.startsWith(".")` branch keeps it verbatim.
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		await dispatcher({
			filePath: "../sibling/m.go",
			absPath: "/repo/sibling/m.go",
			profile,
			checkCwd: "/repo/app",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = parseWire(nonNull(spawnSyncMock.mock.calls[0])[1], wireArray(wireString), "test JSON value");
		const pkgArg = args[2];
		expect(nonNull(pkgArg).startsWith("..")).toBe(true);
		expect(nonNull(pkgArg).startsWith("./..")).toBe(false);
	});

	it("classifies a generic build failure (undefined symbol) as pre-existing", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 2,
				stderr: "build failed: ./m.go:3:5: undefined: helperFn",
			}),
		);
		const out = await dispatcher({
			filePath: "pkg/m.go",
			absPath: "/repo/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("reports no verdict when the go binary is unavailable", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: null,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}),
			}),
		);
		const out = await dispatcher({
			filePath: "pkg/m.go",
			absPath: "/repo/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("returns empty when go test passes (status 0)", async () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0, stdout: "ok\t./pkg\t0.01s" }));
		const out = await dispatcher({
			filePath: "pkg/m.go",
			absPath: "/repo/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("treats a null go status as an explicit no-verdict result", async () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: null }));
		const out = await dispatcher({
			filePath: "/repo/src/pkg/go-null.go",
			absPath: "/repo/src/pkg/go-null.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
	});

	it("keeps go-failure baselines distinct for different package paths", async () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stdout: "--- FAIL: TestBaseline\nFAIL" }),
		);
		const run = (pkg: string) =>
			dispatcher({
				filePath: `/repo/src/${pkg}/m.go`,
				absPath: `/repo/src/${pkg}/m.go`,
				profile,
				checkCwd: "/repo",
				timeoutMs: 15000,
				severity: "error",
				checkName: "affected_tests",
			});
		expect(await run("go-baseline-a")).toHaveLength(1);
		expect(await run("go-baseline-b")).toHaveLength(1);
	});
});

describe("test-candidate path construction", () => {
	it("derives Python candidates from the extension, directory, and basename", async () => {
		const filePath = "/repo/src/candidate.py";
		const profile = getProfileForFile(filePath);
		if (!profile) throw new Error("python profile missing");
		const dispatcher = TEST_DISPATCHERS.python;
		if (!dispatcher) throw new Error("python dispatcher not registered");
		const seen: string[] = [];
		existsSyncMock.mockImplementation((candidate) => {
			seen.push(String(candidate));
			return false;
		});
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		await dispatcher({
			filePath,
			absPath: filePath,
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(seen).toEqual([
			"/repo/src/test_candidate.py",
			"/repo/src/candidate_test.py",
			"/repo/src/tests/test_candidate.py",
			"/repo/tests/test_candidate.py",
			"/repo/src/candidate.test.py",
			"/repo/src/candidate.spec.py",
			"/repo/src/__tests__/candidate.test.py",
			"/repo/src/__tests__/candidate.spec.py",
		]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});

describe("runPytestDispatcher — additional branches", () => {
	const profile = getProfileForFile("/repo/src/m.py");
	if (!profile) throw new Error("python profile missing");
	const dispatcher = TEST_DISPATCHERS.python;
	if (!dispatcher) throw new Error("python dispatcher not registered");

	it("returns empty when pytest passes (status 0)", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0, stdout: "1 passed" }));
		const out = await dispatcher({
			filePath: "/repo/src/pass.py",
			absPath: "/repo/src/pass.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("emits the configured severity (warning) on a genuine failure", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "FAILED tests/test_warn.py::t - AssertionError: 1 != 2",
			}),
		);
		const out = await dispatcher({
			filePath: "/repo/src/warn.py",
			absPath: "/repo/src/warn.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "warning",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).severity).toBe("warning");
	});

	it("relativizes the test path against checkCwd in the pytest invocation", async () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		await dispatcher({
			filePath: "src/rel.py",
			absPath: "/repo/src/rel.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = parseWire(nonNull(spawnSyncMock.mock.calls[0])[1], wireArray(wireString), "test JSON value");
		// First existing candidate for src/rel.py is the sibling test_rel.py.
		const relArg = args[args.length - 1];
		expect(nonNull(relArg).startsWith("/")).toBe(false);
		expect(relArg).toContain("rel");
	});
});

describe("runGoTestDispatcher — build-tag parity", () => {
	const profile = getProfileForFile("/repo/src/pkg/m.go");
	if (!profile) throw new Error("go profile missing");
	const dispatcher = TEST_DISPATCHERS.go;
	if (!dispatcher) throw new Error("go dispatcher not registered");

	// An arrow const, not a function declaration: TS keeps the `profile` /
	// `dispatcher` narrowing from the guards above for a const-bound closure.
	const argvWithGoflags = async (goflags: string | undefined): Promise<string[]> => {
		const saved = process.env.INTERLINKED_GOFLAGS;
		if (goflags === undefined) delete process.env.INTERLINKED_GOFLAGS;
		else process.env.INTERLINKED_GOFLAGS = goflags;
		try {
			spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
			await dispatcher({
				filePath: "/repo/src/pkg/m.go",
				absPath: "/repo/src/pkg/m.go",
				profile,
				checkCwd: "/repo",
				timeoutMs: 15000,
				severity: "error",
				checkName: "affected_tests",
			});
			return parseWire(nonNull(spawnSyncMock.mock.calls[0])[1], wireArray(wireString), "test JSON value");
		} finally {
			if (saved === undefined) delete process.env.INTERLINKED_GOFLAGS;
			else process.env.INTERLINKED_GOFLAGS = saved;
		}
	};

	it("P1: threads the configured -tags into `go test`, before the package arg", async () => {
		expect(await argvWithGoflags("-tags=integration")).toEqual([
			"test",
			"-count=1",
			"-tags=integration",
			"./src/pkg",
		]);
	});

	it("N1: adds no tag argv when no build tags are configured", async () => {
		expect(await argvWithGoflags(undefined)).toEqual(["test", "-count=1", "./src/pkg"]);
	});
});
