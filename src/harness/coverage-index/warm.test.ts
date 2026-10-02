import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.fn((): { path: string; role: string; content: string }[] => [{ path: "src/a.ts", role: "product", content: "export const a = 1;\n" }]);
vi.mock("../../lib/metrics/inventory.js", () => ({ collectRepositoryInventory: (root: string) => ({ root, files: files(), gaps: [], issues: [] }) }));
const cleanup = vi.fn();
const createCoverageOverlay = vi.fn((_root: string, _path: string, _content: string) => ({ overlayRoot: "/overlay", cleanup }));
vi.mock("../coverage-overlay.js", () => ({ createCoverageOverlay: (root: string, path: string, content: string) => createCoverageOverlay(root, path, content) }));
const testWorkerBudget = vi.fn((_requested: number) => 1);
vi.mock("../test-execution.js", () => ({ testWorkerBudget: (requested: number) => testWorkerBudget(requested) }));
const release = vi.fn();
const budget = { reserveBytes: 1, maxRssBytes: 2 };
type Admission = { admitted: true; resourceBudget: typeof budget; release: () => void; wait_ms: number } | { admitted: false; reason: string; wait_ms: number };
const admitIndexedRun = vi.fn(async (_root: string, _deadline: number): Promise<Admission> => ({ admitted: true, resourceBudget: budget, release, wait_ms: 0 }));
vi.mock("./admission.js", () => ({ admitIndexedRun: (root: string, deadline: number) => admitIndexedRun(root, deadline) }));
const coverageIndexContext = vi.fn(async (..._args: unknown[]) => ({ fingerprint: "fp" }));
vi.mock("./context.js", () => ({ coverageIndexContext: (...args: unknown[]) => coverageIndexContext(...args) }));
const runIndexedCoverage = vi.fn(async (_options: unknown): Promise<{ indexed: boolean; reason: string | null; result: { testsPassed: boolean | null }; artifact?: { content: string; root: string; argv: string[] } }> => ({ indexed: true, reason: null, result: { testsPassed: true }, artifact: { content: "{}", root: "/overlay", argv: ["vitest"] } }));
const coverageIndexStatus = vi.fn(async (_context: unknown) => ({ present: true, generation: 1, valid: true, reasons: [], shards: 1, changedShards: 0 }));
vi.mock("./controller.js", () => ({ runIndexedCoverage: (options: unknown) => runIndexedCoverage(options), coverageIndexStatus: (context: unknown) => coverageIndexStatus(context) }));
const promoteMatchingProposal = vi.fn(async (_context: unknown) => true);
vi.mock("./staged-state.js", () => ({ promoteMatchingProposal: (context: unknown) => promoteMatchingProposal(context) }));
const recordWarmEvidence = vi.fn();
const recordWarmFailure = vi.fn();
vi.mock("./warm-evidence.js", () => ({ recordWarmEvidence: (...args: unknown[]) => recordWarmEvidence(...args), recordWarmFailure: (...args: unknown[]) => recordWarmFailure(...args) }));
const prepareCoverageRuntime = vi.fn();
vi.mock("./runtime-inputs.js", () => ({ prepareCoverageRuntime: (...args: unknown[]) => prepareCoverageRuntime(...args), captureCoverageRuntime: async () => ({ hash: "runtime" }) }));

const { warmCoverageIndex } = await import("./warm.js");

beforeEach(() => {
    for (const mock of [files, cleanup, createCoverageOverlay, testWorkerBudget, release, admitIndexedRun, coverageIndexContext, runIndexedCoverage, coverageIndexStatus, promoteMatchingProposal, recordWarmEvidence, recordWarmFailure, prepareCoverageRuntime]) mock.mockClear();
    files.mockReturnValue([{ path: "src/a.ts", role: "product", content: "export const a = 1;\n" }]);
    testWorkerBudget.mockReturnValue(1);
    runIndexedCoverage.mockReset();
    admitIndexedRun.mockResolvedValue({ admitted: true, resourceBudget: budget, release, wait_ms: 0 });
    runIndexedCoverage.mockResolvedValue({ indexed: true, reason: null, result: { testsPassed: true }, artifact: { content: "{}", root: "/overlay", argv: ["vitest"] } });
    promoteMatchingProposal.mockResolvedValue(true);
    coverageIndexContext.mockResolvedValue({ fingerprint: "fp" });
});

describe("warmCoverageIndex — positive (must fire)", () => {
    // test-contract: public-api — a warm run measures under ONE admitted instrumented worker, promotes the staged proposal, records the warm evidence and reports the index as established, always releasing the admission and the overlay
    it("P1: promotes, records evidence and releases the admission and overlay", async () => {
        const outcome = await warmCoverageIndex("/repo", 5000);
        expect(outcome).toMatchObject({ indexed: true, reason: null, status: { present: true, generation: 1 } });
        expect(runIndexedCoverage).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/overlay", full: true, maxWorkers: 1, resourceBudget: budget, timeoutMs: 5000 }));
        expect(testWorkerBudget).toHaveBeenCalledWith(1);
        expect(recordWarmEvidence).toHaveBeenCalledWith({ fingerprint: "fp" }, { content: "{}", root: "/overlay", argv: ["vitest"] }, expect.any(Number));
        expect(recordWarmFailure).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
    // test-contract: bug — a run the controller refused to certify records a warm failure with the controller's own reason (not a generic one) and reports it, with the tests-passed verdict preserved
    it("P2: a controller refusal is recorded and reported with its reason", async () => {
        runIndexedCoverage.mockResolvedValue({ indexed: false, reason: "Tests did not pass: src/a.test.ts", result: { testsPassed: false } });
        const outcome = await warmCoverageIndex("/repo", 5000);
        expect(outcome).toMatchObject({ indexed: false, reason: "Tests did not pass: src/a.test.ts" });
        expect(recordWarmFailure).toHaveBeenCalledWith({ fingerprint: "fp" }, { durationMs: expect.any(Number), reason: "Tests did not pass: src/a.test.ts", testsPassed: false });
        expect(promoteMatchingProposal).not.toHaveBeenCalled();
        expect(recordWarmEvidence).not.toHaveBeenCalled();
    });
    // test-contract: bug — when the repository changed during the run (fingerprint moved) nothing is promoted, and the generic reasons name the lost race instead of an empty string
    it("P3: a moved fingerprint is not promoted and gets the generic race reasons", async () => {
        coverageIndexContext.mockResolvedValueOnce({ fingerprint: "before" }).mockResolvedValueOnce({ fingerprint: "after" });
        runIndexedCoverage.mockResolvedValue({ indexed: true, reason: null, result: { testsPassed: true } });
        const outcome = await warmCoverageIndex("/repo", 5000);
        expect(outcome).toMatchObject({ indexed: false, reason: "Repository changed or manifest promotion lost a race" });
        expect(promoteMatchingProposal).not.toHaveBeenCalled();
        expect(recordWarmFailure).toHaveBeenCalledWith({ fingerprint: "before" }, expect.objectContaining({ reason: "Input changed or promotion failed", testsPassed: true }));
    });
    // test-contract: boundary — promotion that lost its compare-and-swap is a failure even with a certified run, and a promoted run without an artifact records no evidence
    it("P4: a lost promotion is a failure; a promotion without artifact records no evidence", async () => {
        promoteMatchingProposal.mockResolvedValueOnce(false);
        expect(await warmCoverageIndex("/repo", 5000)).toMatchObject({ indexed: false, reason: "Repository changed or manifest promotion lost a race" });
        expect(recordWarmFailure).toHaveBeenCalledTimes(1);
        runIndexedCoverage.mockResolvedValue({ indexed: true, reason: null, result: { testsPassed: true } });
        recordWarmFailure.mockClear();
        expect(await warmCoverageIndex("/repo", 5000)).toMatchObject({ indexed: true, reason: null });
        expect(recordWarmEvidence).not.toHaveBeenCalled();
        expect(recordWarmFailure).not.toHaveBeenCalled();
    });
});

describe("warmCoverageIndex — negative (must not fire)", () => {
    // test-contract: invariant — with no product source there is nothing to measure: refuse before any runtime capture or overlay exists
    it("N1: refuses a repository without product source", async () => {
        files.mockReturnValue([{ path: "src/a.test.ts", role: "test", content: "" }]);
        await expect(warmCoverageIndex("/repo", 5000)).rejects.toThrow("No product source available to measure");
        expect(createCoverageOverlay).not.toHaveBeenCalled();
        expect(prepareCoverageRuntime).not.toHaveBeenCalled();
    });
    // test-contract: invariant — a host with no capacity for even one instrumented worker never starts a capture, and the overlay is still removed
    it("N2: refuses when the host governor grants no worker", async () => {
        testWorkerBudget.mockReturnValue(0);
        await expect(warmCoverageIndex("/repo", 5000)).rejects.toThrow("Host CPU or memory capacity unavailable for a test worker");
        expect(admitIndexedRun).not.toHaveBeenCalled();
        expect(runIndexedCoverage).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
    // test-contract: invariant — a refused admission (capacity busy) is an error carrying the admission's reason, with no capture and no lease to release
    it("N3: refuses with the admission's reason and runs nothing", async () => {
        admitIndexedRun.mockResolvedValue({ admitted: false, reason: "Host test capacity busy; coverage index unavailable", wait_ms: 3 });
        await expect(warmCoverageIndex("/repo", 5000)).rejects.toThrow("Host test capacity busy; coverage index unavailable");
        expect(runIndexedCoverage).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
    // test-contract: invariant — the admission is released even when the capture throws, and the error reaches the caller
    it("N4: releases the admission and overlay when the capture throws", async () => {
        runIndexedCoverage.mockRejectedValue(new Error("capture exploded"));
        await expect(warmCoverageIndex("/repo", 5000)).rejects.toThrow("capture exploded");
        expect(release).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
});
