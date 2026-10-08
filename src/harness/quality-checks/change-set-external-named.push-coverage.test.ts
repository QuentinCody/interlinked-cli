import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RecoveryTestRuns } from "../recovery-test-runs.js";
import { scheduleTests } from "../test-scheduler.js";
import { runLanguageTestSuite } from "./language-test-suite.js";
import { runNamedChecksAdmitted } from "./change-set-external-named.js";
import type { DeferredCheck, NamedExternalCandidate } from "./change-set-external-candidates.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "./result-types.js";

vi.mock("../test-scheduler.js", () => ({ scheduleTests: vi.fn() }));
vi.mock("./language-test-suite.js", () => ({ runLanguageTestSuite: vi.fn() }));

const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(marker: string, extension: string) {
    const root = mkdtempSync(join(tmpdir(), "named-recovery-push-"));
    roots.push(root);
    writeFileSync(join(root, marker), marker === "package.json" ? "{}" : "");
    const path = join(root, `feature${extension}`);
    writeFileSync(path, "");
    const recoveryTests = new RecoveryTestRuns(root, [path], Date.now() + 5000);
    const candidate: NamedExternalCandidate = { name: "affected_tests", check: {
        enabled: true, file_types: [extension], timeout_ms: 5000, severity: "error",
    } };
    return { root, path, recoveryTests, candidate };
}

it("defers a failed shared Vitest recovery request without starting a separate scheduler run", async () => {
    const { root, path, recoveryTests, candidate } = fixture("package.json", ".ts");
    const shared = vi.spyOn(recoveryTests, "vitest").mockRejectedValueOnce(new Error("Recovery test inputs changed"));
    const resultMap = new Map<string, QualityCheckResult[]>();
    const deferred: DeferredCheck[] = [];
    const outChecksRan: string[] = [];
    await runNamedChecksAdmitted({ recovery: true, recoveryTests, outChecksRan }, resultMap,
        root, [path], candidate, undefined, deferred);

    expect(shared).toHaveBeenCalledExactlyOnceWith({
        root, paths: [path], timeoutMs: 5000, maxWorkers: 2, waitForCapacity: true, stage: "edit",
    }, candidate.check);
    expect(scheduleTests).not.toHaveBeenCalled();
    expect(outChecksRan).toEqual([]);
    expect(resultMap.size).toBe(0);
    expect(deferred).toEqual([{ name: "affected_tests", reason: "Error: Recovery test inputs changed" }]);
});

it("attributes a failed shared Python recovery suite to the changed file and records its completed check", async () => {
    const { root, path, recoveryTests, candidate } = fixture("pyproject.toml", ".py");
    const shared = vi.spyOn(recoveryTests, "language").mockResolvedValueOnce({
        status: "failed", reason: "pytest failed", output: "test_feature: expected 2, got 1",
        durationMs: 25, scope: "project", reusable: false,
    });
    const resultMap = new Map<string, QualityCheckResult[]>();
    const deferred: DeferredCheck[] = [];
    const outChecksRan: string[] = [];
    const outToolMetrics: ToolBreakdownEntry[] = [];
    await runNamedChecksAdmitted({ recovery: true, recoveryTests, outChecksRan, outToolMetrics }, resultMap,
        root, [path], candidate, undefined, deferred);

    expect(shared).toHaveBeenCalledExactlyOnceWith({ root, language: "python", timeoutMs: 5000, recovery: true }, [path], candidate.check);
    expect(runLanguageTestSuite).not.toHaveBeenCalled();
    expect(deferred).toEqual([]);
    expect(outChecksRan).toEqual(["affected_tests"]);
    expect(outToolMetrics).toEqual([{ tool: "affected-tests-python", ms: 25, finding_count: 1 }]);
    expect(resultMap.get(path)).toEqual([{
        name: "affected_tests", severity: "warning", file: path,
        message: "pytest failed", detail: "test_feature: expected 2, got 1",
    }]);
});
