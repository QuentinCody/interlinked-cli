import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../check-engine/types.js";

const { run, release } = vi.hoisted(() => ({ run: vi.fn(), release: vi.fn() }));
vi.mock("../check-engine/index.js", () => ({
    configNameToToolId: (name: string) => name === "lint_import" ? "lint-import" : name,
    getOrCreateEngine: () => ({ runChecksAsync: run }),
}));
vi.mock("../project-heavy-process-lock.js", () => ({
    acquireProjectHeavyProcessLease: async () => release,
    tryAcquireProjectHeavyProcessLease: () => release,
}));
import { createChangeSetExternalBatch } from "./change-set-external.js";

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coverage-file-recovery-"));
    for (const path of ["a.sh", "b.sh"]) writeFileSync(join(root, path), "#!/bin/sh\necho ok\n");
    run.mockReset();
    release.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function report(): CheckReport {
    return { results: [], toolsRun: [{ id: "shellcheck", available: true }], toolsSkipped: [],
        skipped: [], metrics: [], elapsedMs: 1, deduplicatedCount: 0 };
}
function batch(recovery = true) {
    return createChangeSetExternalBatch({ cwd: root, paths: [join(root, "a.sh"), join(root, "b.sh")], recovery,
        checks: { shellcheck: { enabled: true, command: "shellcheck", file_types: [".sh"], timeout_ms: 5000, severity: "warning" } } });
}

describe("file-only external recovery", () => {
    it("requests bounded runner admission only in background batches", async () => {
        for (const recovery of [false, true]) {
            run.mockClear().mockResolvedValue({ ...report(), toolsRun: [{ id: "lint-import", available: true }] });
            const check = createChangeSetExternalBatch({ cwd: root, paths: [join(root, "a.sh")], recovery,
                checks: { lint_import: { enabled: true, command: "interlinked lint check", file_types: [".sh"], timeout_ms: 5000, severity: "warning" } } });
            await check.resultsForFile(join(root, "a.sh"));
            expect(run.mock.calls[0]?.[1].waitForCapacity).toBe(recovery ? true : undefined);
        }
    });

    it("checks each exact file once, attributes findings, and records completed evidence", async () => {
        run.mockResolvedValueOnce(report()).mockResolvedValueOnce({ ...report(),
            results: [{ tool: "shellcheck", severity: "warning", file: "b.sh", line: 2, message: "Quote this expansion" }] });
        const check = batch();
        const a = await check.resultsForFile(join(root, "a.sh")), b = await check.resultsForFile(join(root, "b.sh"));
        expect(a).toEqual([]);
        expect(b).toEqual([expect.objectContaining({ name: "shellcheck", file: join(root, "b.sh") })]);
        expect(run.mock.calls.map(([scope]) => scope)).toEqual(["a.sh", "b.sh"].map(path => ({ projectRoot: root, mode: "file", targetFile: join(root, path) })));
        expect(run.mock.calls.every(([, options]) => options.admissionAlreadyHeld && options.timeoutMs <= 5000)).toBe(true);
        expect(await check.evidenceForFile(join(root, "a.sh"))).toMatchObject({ checks: ["shellcheck"], unavailable: [] });
        expect(await check.evidenceForFile(join(root, "b.sh"))).toMatchObject({ checks: ["shellcheck"], unavailable: [] });
        expect(run).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("does not turn one completed sibling into a clean batch after a tool failure", async () => {
        run.mockResolvedValueOnce(report()).mockResolvedValueOnce({ ...report(), toolsRun: [],
            skipped: [{ check: "shellcheck", category: "timeout", reason: "process timed out" }] });
        const check = batch();
        const evidence = await check.evidenceForFile(join(root, "b.sh"));
        expect(evidence.unavailable.join(" ")).toContain("process timed out");
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("bounds the whole file group, leaving unrun files explicitly unavailable", async () => {
        let now = 0;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        run.mockImplementation(async () => { now += 30_001; return report(); });
        const evidence = await batch().evidenceForFile(join(root, "b.sh"));
        expect(run).toHaveBeenCalledTimes(1);
        expect(evidence.unavailable.join(" ")).toContain("file recovery deadline");
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("keeps foreground multi-file checks deferred", async () => {
        const evidence = await batch(false).evidenceForFile(join(root, "a.sh"));
        expect(run).not.toHaveBeenCalled();
        expect(evidence.checks).toEqual([]);
        expect(evidence.unavailable.join(" ")).toContain("file-only");
    });
});
