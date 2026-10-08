import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHookCoverageChecker } from "./hook-coverage-checks.js";
import { HookCoverageLedger } from "./hook-coverage-ledger.js";
import { HookCoverageVerification } from "./hook-coverage-verification.js";
import { completeTestRequests, pendingTests } from "./test-requests.js";
import type { ScheduleTestsOptions } from "./test-scheduler.js";
import type { QualityCheckOptions } from "./quality-checks.js";

const mocks = vi.hoisted(() => ({ schedule: vi.fn(), quality: vi.fn() }));
vi.mock("./test-scheduler.js", () => ({ scheduleTests: mocks.schedule }));
vi.mock("./project-heavy-process-lock.js", () => ({
    acquireProjectHeavyProcessLease: async () => () => {}, tryAcquireProjectHeavyProcessLease: () => () => {},
}));
vi.mock("./quality-checks.js", () => ({ runQualityChecks: mocks.quality, resolveQualityCheckTarget: () => ({ filePath: "eligible" }) }));

const roots: string[] = [], verifiers: HookCoverageVerification[] = [];
beforeEach(() => {
    vi.resetAllMocks();
    mocks.quality.mockImplementation(async (_event, _checks, _root, options: QualityCheckOptions) => {
        options.outChecksRan?.push("strong_typing"); return [];
    });
    mocks.schedule.mockImplementation(async (options: ScheduleTestsOptions) => {
        completeTestRequests(options.root, pendingTests(options.root).ids);
        return { status: "passed", runId: "fresh-project-run", durationMs: 1, reused: false, output: "passed", reason: "",
            plan: { version: 1, snapshot: "source", changedPaths: options.paths, mode: "full", tests: [], omitted: [], reasons: [], estimatedSerialMs: null, reusable: false } };
    });
});
afterEach(() => {
    verifiers.splice(0).forEach(verifier => verifier.stop());
    roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function fixture(count = 65, extension = "ts") {
    const root = mkdtempSync(join(tmpdir(), "coverage-project-")); roots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    const paths = Array.from({ length: count }, (_, index) => join(root, `file-${index}.${extension}`));
    paths.forEach(path => writeFileSync(path, extension === "py" ? "value = 1\n" : "export const value = 1;\n"));
    mkdirSync(join(root, ".interlinked"));
    const ledger = new HookCoverageLedger(join(root, ".interlinked/hook-coverage.json"));
    const reconcile = () => ledger.observeBatch(paths.map(path => ({ path,
        identity: createHash("sha256").update(readFileSync(path)).digest("hex"), scope: "reservation" })));
    reconcile();
    const checker = createHookCoverageChecker(root, () => ({ affected_tests: {
        enabled: true, file_types: [""], timeout_ms: 1000, severity: "error",
    } }));
    const verifier = new HookCoverageVerification({ ledger, reconcile, ready: () => true }, checker);
    verifiers.push(verifier);
    return { root, paths, ledger, verifier };
}

it("drains three receipt batches with one complete test run and no re-created test requests", async () => {
    const { root, paths, ledger, verifier } = fixture();
    verifier.start();
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    expect(verifier.status()).toMatchObject({ total: 65, processed: 65, checked: 65, findings: 0, unmeasured: [] });
    expect(ledger.observation().pending).toEqual([]);
    expect(pendingTests(root).ids).toEqual([]);
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ paths, root, maxWorkers: 2 }));
    const receipts = ledger.snapshot().checks;
    expect(receipts).toHaveLength(65);
    expect(receipts.every(receipt => receipt.checks.includes("affected_tests"))).toBe(true);
    expect(receipts.every(receipt => receipt.scopes?.every(scope => scope.inputs.length <= 32))).toBe(true);
});

it("finishes all batches with one unavailable attempt and keeps every version pending", async () => {
    const { paths, ledger, verifier } = fixture();
    mocks.schedule.mockResolvedValue({ status: "deferred", reason: "host memory unavailable", output: "", durationMs: 0 });
    verifier.start();
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    expect(verifier.status()).toMatchObject({ total: 65, processed: 65, checked: 0 });
    expect(verifier.status()?.unmeasured.join(" ")).toContain("host memory unavailable");
    expect(ledger.observation().pending).toHaveLength(65);
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ paths }));
});

it("does not credit later batches from a shared run after an input changes", async () => {
    const { paths, ledger, verifier } = fixture();
    mocks.quality.mockImplementationOnce(async (_event, _checks, _root, options: QualityCheckOptions) => {
        options.outChecksRan?.push("strong_typing");
        writeFileSync(paths[64]!, "export const value = 2;\n"); return [];
    });
    verifier.start();
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    expect(verifier.status()).toMatchObject({ total: 65, processed: 65, checked: 32 });
    expect(ledger.observation().pending).toHaveLength(33);
    expect(verifier.status()?.unmeasured.join(" ")).toContain("inputs changed");
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
});

it("does not send unscoped Python files into this TypeScript project's test queue", async () => {
    const { root, ledger, verifier } = fixture(65, "py");
    verifier.start();
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    expect(verifier.status()).toMatchObject({ total: 65, processed: 65, checked: 0 });
    expect(verifier.status()?.unmeasured.join(" ")).toContain("No python project marker");
    expect(ledger.observation().pending).toHaveLength(65);
    expect(pendingTests(root).ids).toEqual([]);
    expect(mocks.schedule).not.toHaveBeenCalled();
});
