// Direct unit coverage for `relativizeFromRoot`, the small path-stripping
// helper `runPytestDispatcher` uses to turn an absolute candidate test path
// into one relative to `checkCwd`. Exercised through `__test_only__` (see
// its export at the bottom of test-dispatchers.ts) rather than through a
// full dispatcher run — this is a pure function with no fs/process seam,
// so a direct call is the smallest test that reaches its fallback branch.
// Fuller dispatcher-level coverage lives in
// src/harness/__tests__/test-dispatchers.integration.test.ts and
// src/harness/quality-checks/planned-dispatcher.test.ts.

import { describe, expect, it, vi } from "vitest";
import { getProfileForFile } from "../language-profiles.js";
import { scheduleTests } from "../test-scheduler.js";
import { runLanguageTestSuite } from "./language-test-suite.js";
import { __test_only__ } from "./test-dispatchers.js";

vi.mock("./language-test-suite.js", () => ({ runLanguageTestSuite: vi.fn() }));
vi.mock("../test-scheduler.js", () => ({ scheduleTests: vi.fn() }));

const { relativizeFromRoot } = __test_only__;

describe("relativizeFromRoot", () => {
	it("does not strip a shared directory-name prefix from an outside path", () => {
		expect(relativizeFromRoot("/repo-other/tests/test_foo.py", "/repo")).toBe("/repo-other/tests/test_foo.py");
	});
	it.each(["/repo", "/repo/"])("strips the full directory boundary for root %s", (root) => {
		expect(relativizeFromRoot("/repo/tests/test_foo.py", root)).toBe("tests/test_foo.py");
	});
	// test-contract: invariant — when absPath is not rooted under `root`,
	// relativizeFromRoot must return it verbatim (no partial stripping),
	// since runPytestDispatcher passes this value straight to pytest's argv.
	it("returns the path unchanged when it does not start with root", () => {
		// Neither /repo nor /elsewhere is a prefix of the other, so the
		// `absPath.startsWith(root)` guard fails and the function falls
		// through to its final line — returning absPath verbatim rather
		// than a stripped/relative form.
		const result = relativizeFromRoot("/elsewhere/tests/foo.test.py", "/repo/checkout");
		expect(result).toBe("/elsewhere/tests/foo.test.py");
	});
});

it("keeps the actionable Python error alongside an unavailable suite verdict", async () => {
    vi.mocked(runLanguageTestSuite).mockResolvedValueOnce({ status: "unavailable", reason: "pytest collection failed",
        output: "ImportError: missing_project_dependency", durationMs: 12, scope: "project", reusable: false });
    const result = await __test_only__.runPytestDispatcher({ filePath: "feature.py", absPath: "/repo/feature.py",
        checkCwd: "/repo", profile: getProfileForFile("feature.py")!, timeoutMs: 1000, severity: "error", checkName: "affected_tests" });
    expect(result).toEqual([expect.objectContaining({ name: "affected_tests_deferred",
        detail: "pytest collection failed\nImportError: missing_project_dependency" })]);
});

// test-contract: bug — a thrown (not rejected-with-verdict) suite runner must
// still surface as an unavailable deferral instead of propagating, so a
// language runner crash never bricks the caller's check loop.
it("reports an unavailable deferral when the project suite runner throws", async () => {
    vi.mocked(runLanguageTestSuite).mockRejectedValueOnce(new Error("suite runner crashed"));
    const result = await __test_only__.runPytestDispatcher({ filePath: "feature.py", absPath: "/repo/feature.py",
        checkCwd: "/repo", profile: getProfileForFile("feature.py")!, timeoutMs: 1000, severity: "error", checkName: "affected_tests" });
    expect(result).toEqual([expect.objectContaining({ name: "affected_tests_deferred", detail: "Error: suite runner crashed" })]);
});

describe("runVitestDispatcher", () => {
    // test-contract: invariant — when the profile carries no test_runner at
    // all (the `??` fallback in the includes() guard), the dispatcher must
    // still default to the Vitest command rather than treating it as an
    // unconfigured runner.
    it("falls back to the default vitest command when the profile has no test_runner configured", async () => {
        vi.mocked(scheduleTests).mockResolvedValueOnce({ status: "passed", output: "", reason: "", runId: "r1",
            reused: false, durationMs: 1, plan: { version: 1, snapshot: "s", changedPaths: [], mode: "full",
                tests: [], omitted: [], reasons: [], estimatedSerialMs: null, reusable: false } });
        const profile = { ...getProfileForFile("feature.ts")!, test_runner: null };
        const result = await __test_only__.runVitestDispatcher({ filePath: "feature.ts", absPath: "/repo/feature.ts",
            checkCwd: "/repo", profile, timeoutMs: 1000, severity: "error", checkName: "affected_tests" });
        expect(result).toEqual([]);
        expect(scheduleTests).toHaveBeenCalledWith(expect.objectContaining({ paths: ["/repo/feature.ts"] }));
    });

    // test-contract: invariant — a rejection that is not an Error instance
    // (e.g. a thrown string) must still produce a readable deferral detail
    // rather than surfacing "[object Object]" or throwing out of the dispatcher.
    it("uses a generic message when scheduleTests rejects with a non-Error value", async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal -- exercising the non-Error ternary branch
        vi.mocked(scheduleTests).mockRejectedValueOnce("scheduler exploded");
        const result = await __test_only__.runVitestDispatcher({ filePath: "feature.ts", absPath: "/repo/feature.ts",
            checkCwd: "/repo", profile: getProfileForFile("feature.ts")!, timeoutMs: 1000, severity: "error", checkName: "affected_tests" });
        expect(result).toEqual([expect.objectContaining({ name: "affected_tests_deferred", detail: "Test planning unavailable" })]);
    });
});
