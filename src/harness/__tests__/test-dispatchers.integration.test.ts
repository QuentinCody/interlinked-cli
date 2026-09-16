import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProfileForFile } from "../language-profiles.js";
import { TEST_DISPATCHERS } from "../quality-checks/test-dispatchers.js";
import { runBoundedTestProcess } from "../quality-checks/test-process-gate.js";
import { scheduleTests } from "../test-scheduler.js";
import type { TestExecution } from "../test-run-receipt.js";

vi.mock("../test-scheduler.js", () => ({ scheduleTests: vi.fn() }));
vi.mock("../quality-checks/test-process-gate.js", () => ({ runBoundedTestProcess: vi.fn() }));
const run = vi.mocked(runBoundedTestProcess);
beforeEach(() => { vi.mocked(scheduleTests).mockReset(); run.mockReset(); });
function input(file: string) {
    const profile = getProfileForFile(file);
    if (!profile) throw new Error("Fixture language missing");
    return { filePath: file, absPath: `/repo/${file}`, checkCwd: "/repo", profile,
        timeoutMs: 1234, severity: "error" as const, checkName: "affected_tests" };
}

function execution(status: TestExecution["status"], output = ""): TestExecution {
    return { status, output, reason: "missing evidence", runId: "fixture", reused: false, durationMs: 1,
        plan: { version: 1, snapshot: "fixture", changedPaths: [], mode: "full", tests: [], omitted: [],
            reasons: [], estimatedSerialMs: null, reusable: false } };
}

/** Model the runner boundary, keeping the real nonce-bound report reader. */
function completedProjectRun(language: string, code: number, stdout: string, stderr = ""): void {
    run.mockImplementation(async invocation => {
        if (language === "python") {
            expect(invocation.args.slice(0, 2)).toEqual(["-B", "-c"]);
            const report = invocation.args[3], identity = invocation.args[4];
            if (!report || !identity) throw new Error("Missing pytest report destination or identity");
            writeFileSync(report, JSON.stringify({ identity, finished: true, exit: code,
                collectionErrors: 0, collectionSkips: 0, cases: [
                    { id: "test_feature.py::test_behavior", phases: { setup: "passed", call: code === 0 ? "passed" : "failed", teardown: "passed" } },
                    { id: "test_feature.py::test_boundary", phases: { setup: "passed", call: "passed", teardown: "passed" } },
                ] }));
        }
        return { kind: "completed", code, stdout, stderr };
    });
}

describe("language dispatcher integration", () => {
    it.each([["typescript", "feature.ts"], ["python", "feature.py"], ["rust", "feature.rs"], ["go", "feature.go"]] as const)(
        "%s has a behavioral dispatcher", (language, file) => {
            expect(TEST_DISPATCHERS[input(file).profile.id]).toBe(TEST_DISPATCHERS[language]);
            expect(TEST_DISPATCHERS[language]).toBeTypeOf("function");
        });
    it.each(["swift", "java", "c_cpp"] as const)("does not claim an unimplemented %s adapter", language => {
        expect(TEST_DISPATCHERS[language]).toBeUndefined();
    });
    it.each([["python", "feature.py", "2 passed"], ["rust", "feature.rs", "test result: ok. 2 passed; 0 failed;"],
        ["go", "feature.go", '{"Action":"pass","Test":"TestFeature"}']] as const)(
        "%s runs observable assertions even without a companion filename", async (language, file, stdout) => {
            completedProjectRun(language, 0, stdout);
            expect(await TEST_DISPATCHERS[language]!(input(file))).toEqual([]);
            expect(run).toHaveBeenCalledOnce();
            expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", timeoutMs: 1234, waitForCapacity: false }));
        });
    it.each([["python", "feature.py"], ["rust", "feature.rs"], ["go", "feature.go"]] as const)(
        "%s keeps a current failure visible without claiming it was introduced", async (language, file) => {
            completedProjectRun(language, 1, "assertion failed", "diagnostic context");
            expect(await TEST_DISPATCHERS[language]!(input(file))).toEqual([expect.objectContaining({
                name: "affected_tests", severity: "warning", detail: "assertion failed\ndiagnostic context",
            })]);
        });
    it("does not accept Python terminal success text without fresh structured case evidence", async () => {
        run.mockResolvedValue({ kind: "completed", code: 0, stdout: "2 passed in 0.01s", stderr: "" });
        expect(await TEST_DISPATCHERS.python!(input("feature.py"))).toEqual([expect.objectContaining({
            name: "affected_tests_deferred", detail: expect.stringContaining("No fresh structured pytest case evidence"),
        })]);
    });
    it.each([["python", "feature.py"], ["rust", "feature.rs"], ["go", "feature.go"]] as const)(
        "%s does not certify missing tools or empty suites", async (language, file) => {
            run.mockResolvedValue({ kind: "deferred", reason: "unavailable" });
            expect(await TEST_DISPATCHERS[language]!(input(file))).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
            run.mockResolvedValue({ kind: "completed", code: 0, stdout: "", stderr: "" });
            expect(await TEST_DISPATCHERS[language]!(input(file))).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
        });
    it("TypeScript and JavaScript retain shared dependency-aware planning", async () => {
        vi.mocked(scheduleTests).mockResolvedValue(execution("passed"));
        for (const file of ["feature.ts", "feature.js"]) expect(await TEST_DISPATCHERS.typescript!(input(file))).toEqual([]);
        expect(scheduleTests).toHaveBeenCalledWith(expect.objectContaining({ paths: ["/repo/feature.ts"], maxTests: 150, waitForCapacity: false }));
        expect(run).not.toHaveBeenCalled();
    });
    it.each(["stale", "deferred", "empty"] as const)("TypeScript does not certify %s", async status => {
        vi.mocked(scheduleTests).mockResolvedValue(execution(status));
        expect(await TEST_DISPATCHERS.typescript!(input("feature.ts"))).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
    });
    it("TypeScript surfaces a failed plan and a rejected runner", async () => {
        vi.mocked(scheduleTests).mockResolvedValue(execution("failed", "assertion"));
        expect(await TEST_DISPATCHERS.typescript!(input("feature.ts"))).toEqual([expect.objectContaining({ name: "affected_tests", detail: "assertion" })]);
        vi.mocked(scheduleTests).mockRejectedValue(new Error("planning unavailable"));
        expect(await TEST_DISPATCHERS.typescript!(input("feature.ts"))).toEqual([expect.objectContaining({ name: "affected_tests_deferred" })]);
    });
});
import { writeFileSync } from "node:fs";
