import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecoveryTestRuns } from "../recovery-test-runs.js";
import { requestTests } from "../test-requests.js";
import type { CheckReport } from "../check-engine/types.js";
import type { QualityCheckConfig } from "../types.js";
import { createChangeSetExternalBatch } from "./change-set-external.js";

const { run, release, admit } = vi.hoisted(() => ({ run: vi.fn(), release: vi.fn(), admit: vi.fn() }));
vi.mock("../check-engine/index.js", () => ({
    configNameToToolId: (name: string) => name,
    getOrCreateEngine: () => ({ runChecksAsync: run }),
}));
vi.mock("../project-heavy-process-lock.js", () => ({
    acquireProjectHeavyProcessLease: admit,
    tryAcquireProjectHeavyProcessLease: admit,
}));
vi.mock("../test-requests.js", () => ({ requestTests: vi.fn() }));

let root: string;
beforeEach(() => {
    vi.clearAllMocks();
    run.mockReset();
    admit.mockReset().mockResolvedValue(release);
    root = mkdtempSync(join(tmpdir(), "external-recovery-push-"));
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
});

it("retains affected inputs through the shared recovery cohort even when process admission is unavailable", async () => {
    const path = join(root, "feature.ts");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(path, "export const value = 1;");
    const recoveryTests = new RecoveryTestRuns(root, [path], Date.now() + 5000);
    const retain = vi.spyOn(recoveryTests, "retainVitest");
    const check: QualityCheckConfig = { enabled: true, file_types: [".ts"], timeout_ms: 5000, severity: "warning" };
    admit.mockResolvedValueOnce(null);
    const batch = createChangeSetExternalBatch({ cwd: root, paths: [path], recovery: true, recoveryTests,
        checks: { affected_tests: check } });

    const result = await batch.resultsForFile(path);
    expect(retain).toHaveBeenCalledExactlyOnceWith(root, [path], check);
    expect(requestTests).toHaveBeenCalledExactlyOnceWith(root, [path], false);
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual([expect.objectContaining({
        name: "external_check_deferred",
        detail: expect.stringContaining("capacity is busy; affected test requests are retained"),
    })]);
});

it("keeps file-runner exceptions unavailable while checking the next file and releasing admission", async () => {
    const a = join(root, "a.sh"), b = join(root, "b.sh");
    for (const path of [a, b]) writeFileSync(path, "#!/bin/sh\necho ok\n");
    const report: CheckReport = { results: [], toolsRun: [{ id: "shellcheck", available: true }],
        toolsSkipped: [], skipped: [], metrics: [], elapsedMs: 1, deduplicatedCount: 0 };
    run.mockRejectedValueOnce(new Error("shellcheck process failed")).mockResolvedValueOnce(report);
    const batch = createChangeSetExternalBatch({ cwd: root, paths: [a, b], recovery: true,
        checks: { shellcheck: { enabled: true, command: "shellcheck", file_types: [".sh"], timeout_ms: 5000, severity: "warning" } } });

    const evidence = await batch.evidenceForFile(a);
    expect(evidence.unavailable.join(" ")).toContain("shellcheck process failed");
    expect(run.mock.calls.map(([scope]) => scope.targetFile)).toEqual([a, b]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await batch.resultsForFile(a)).toEqual([expect.objectContaining({
        name: "external_check_deferred", detail: expect.stringContaining("shellcheck process failed"),
    })]);
});
