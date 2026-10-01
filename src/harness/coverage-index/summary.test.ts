import { describe, expect, it, vi } from "vitest";
import type { FileCoverageMetrics } from "./types.js";

const runIndexedCoverage = vi.fn();
const coverageIndexContext = vi.fn();
vi.mock("./controller.js", () => ({ runIndexedCoverage: (...args: unknown[]) => runIndexedCoverage(...args) }));
vi.mock("./context.js", () => ({ coverageIndexContext: (...args: unknown[]) => coverageIndexContext(...args) }));
vi.mock("../../lib/metrics/inventory.js", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/metrics/inventory.js")>(), collectRepositoryInventory: (root: string) => ({ root, files: [], gaps: [], issues: [] }) }));
const testWorkerBudget = vi.fn((_requested: number) => 3);
vi.mock("../test-execution.js", () => ({ testWorkerBudget: (requested: number) => testWorkerBudget(requested) }));
const release = vi.fn();
const budget = { reserveBytes: 1, maxRssBytes: 2 ** 31 };
const admitIndexedRun = vi.fn(async () => ({ admitted: true, resourceBudget: budget, release, wait_ms: 0 }) as { admitted: true; resourceBudget: typeof budget; release: () => void; wait_ms: number } | { admitted: false; reason: string; wait_ms: number });
vi.mock("./admission.js", () => ({ admitIndexedRun: (...args: unknown[]) => admitIndexedRun(...(args as [])) }));
const promoteMatchingProposal = vi.fn(async () => true);
vi.mock("./staged-state.js", () => ({ promoteMatchingProposal: (...args: unknown[]) => promoteMatchingProposal(...(args as [])) }));

const { indexedCoverageSummary, metricsToSummary } = await import("./summary.js");

function metrics(lines: [number, number], branches: [number, number], functions: [number, number], statements: [number, number] | null): FileCoverageMetrics {
    const counts = ([covered, total]: [number, number]) => ({ covered, total, pct: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100 });
    return { lines: counts(lines), branches: counts(branches), functions: counts(functions), statements: statements ? counts(statements) : null };
}

describe("metricsToSummary — positive (must fire)", () => {
    // test-contract: public-api — the index's per-file counts become the ratchet's summary shape: pct plus covered/total per dimension, keyed by repo-relative path, statements omitted when the engine reported none
    it("P1: converts every dimension and omits absent statements", () => {
        const summary = metricsToSummary(new Map([["src/a.ts", metrics([9, 10], [1, 4], [2, 2], [9, 12])], ["src/b.ts", metrics([0, 3], [0, 0], [0, 1], null)]]));
        expect(summary).toEqual({
            "src/a.ts": { lines: { pct: 90, covered: 9, total: 10 }, branches: { pct: 25, covered: 1, total: 4 }, functions: { pct: 100, covered: 2, total: 2 }, statements: { pct: 75, covered: 9, total: 12 } },
            "src/b.ts": { lines: { pct: 0, covered: 0, total: 3 }, branches: { pct: 100, covered: 0, total: 0 }, functions: { pct: 0, covered: 0, total: 1 } },
        });
    });
});

describe("indexedCoverageSummary — negative (must not fire): unavailable evidence is never a summary", () => {
    // test-contract: invariant — when the index cannot certify (tests failed, runtime changed, quarantine), the caller gets the reason and NO summary; when it can, the summary spans the full universe and reports how much re-ran
    it("N1: returns the controller's reason without a summary", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: ["a.test.ts", "b.test.ts"] });
        runIndexedCoverage.mockResolvedValue({ indexed: false, reason: "Coverage index quarantined", selectedTests: ["a.test.ts"], result: { ok: false } });
        const outcome = await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 });
        expect(outcome).toMatchObject({ indexed: false, reason: "Coverage index quarantined" });
        expect("summary" in outcome).toBe(false);
    });
    it("N2: a certified run yields the full-universe summary and the re-run share", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: ["a.test.ts", "b.test.ts", "c.test.ts"] });
        runIndexedCoverage.mockResolvedValue({ indexed: true, reason: null, selectedTests: ["a.test.ts"], result: { ok: true }, metrics: new Map([["src/a.ts", metrics([1, 1], [0, 0], [1, 1], null)]]) });
        const outcome = await indexedCoverageSummary({ root: "/repo", storeRoot: "/source", timeoutMs: 1000 });
        expect(outcome).toMatchObject({ indexed: true, rerunTests: 1, universeTests: 3, summary: { "src/a.ts": { lines: { pct: 100, covered: 1, total: 1 } } } });
        expect(coverageIndexContext).toHaveBeenLastCalledWith(expect.objectContaining({ root: "/repo" }), new Map(), expect.objectContaining({ storeRoot: "/source" }));
        expect(runIndexedCoverage).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: "/repo", timeoutMs: 1000, full: false, maxWorkers: 3, resourceBudget: budget }));
    });
    // test-contract: invariant — the index route is ADMITTED like a scheduled test run (project lease + host slot + memory budget, review 2026-09-30): the capture runs only under a granted admission, the admitted budget supervises it, and the leases are released whether the run certified or threw
    it("N6: an admission refusal is unavailable with the admission's reason and no capture", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: ["a.test.ts"] });
        admitIndexedRun.mockResolvedValueOnce({ admitted: false, reason: "Host test capacity busy; coverage index unavailable", wait_ms: 12 });
        runIndexedCoverage.mockClear();
        expect(await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).toMatchObject({ indexed: false, reason: "Host test capacity busy; coverage index unavailable" });
        expect(runIndexedCoverage).not.toHaveBeenCalled();
    });
    it("N7: the admission is released after a certified run and after a thrown one", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: ["a.test.ts"] });
        release.mockClear();
        runIndexedCoverage.mockResolvedValueOnce({ indexed: true, reason: null, selectedTests: ["a.test.ts"], result: { ok: true }, metrics: new Map([["src/a.ts", metrics([1, 1], [0, 0], [1, 1], null)]]) });
        expect((await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).indexed).toBe(true);
        expect(release).toHaveBeenCalledTimes(1);
        runIndexedCoverage.mockRejectedValueOnce(new Error("Runner changed measured input: src/a.ts"));
        expect((await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).indexed).toBe(false);
        expect(release).toHaveBeenCalledTimes(2);
    });
    // test-contract: invariant — a run that captured shards accepts its proposal BEFORE returning (the next revision could never match it; review 2026-09-30); a proposal the current bytes no longer match is no verdict; a reuse run staged nothing and promotes nothing
    it("N8: a captured run promotes its proposal; a rejected promotion is unavailable; a reuse run promotes nothing", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: ["a.test.ts", "b.test.ts"] });
        promoteMatchingProposal.mockClear();
        const measured = { indexed: true, reason: null, selectedTests: ["a.test.ts"], result: { ok: true }, metrics: new Map([["src/a.ts", metrics([1, 1], [0, 0], [1, 1], null)]]) };
        runIndexedCoverage.mockResolvedValueOnce(measured);
        expect((await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).indexed).toBe(true);
        expect(promoteMatchingProposal).toHaveBeenCalledTimes(1);
        runIndexedCoverage.mockResolvedValueOnce(measured);
        promoteMatchingProposal.mockResolvedValueOnce(false);
        expect(await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).toMatchObject({ indexed: false, reason: "Measured coverage index was not accepted: inputs changed after the run" });
        runIndexedCoverage.mockResolvedValueOnce({ ...measured, selectedTests: [] });
        expect(await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).toMatchObject({ indexed: true, rerunTests: 0 });
        expect(promoteMatchingProposal).toHaveBeenCalledTimes(2);
    });
    // test-contract: invariant — the instrumented capture obeys the same host governor as every test lane: the memory-bounded worker budget caps its workers, and no budget means no run (unavailable), never an uncapped capture
    it("N9: the requested worker cap reaches the governor, default 1 (instrumented workers are heavier than plain ones)", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: ["a.test.ts"] });
        runIndexedCoverage.mockResolvedValue({ indexed: false, reason: "stub", selectedTests: [], result: { ok: false } });
        testWorkerBudget.mockClear();
        await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 });
        expect(testWorkerBudget).toHaveBeenLastCalledWith(1);
        await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000, workers: 2 });
        expect(testWorkerBudget).toHaveBeenLastCalledWith(2);
    });
    it("N5: no worker budget is unavailable before any capture runs", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: ["a.test.ts"] });
        testWorkerBudget.mockReturnValueOnce(0);
        runIndexedCoverage.mockClear();
        expect(await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).toMatchObject({ indexed: false, reason: "Host CPU or memory capacity unavailable for a test worker" });
        expect(runIndexedCoverage).not.toHaveBeenCalled();
    });
    // test-contract: invariant — a certification failure the index RAISES (runtime deadline, quarantine, corrupt contribution, a test outside the inventory) is the same unavailable outcome as one it returns: its message is the reason and the time it cost is kept, so the command records a stage row instead of a generic error
    it("N4: a thrown certification failure is unavailable with its reason and elapsed time", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: ["a.test.ts"] });
        runIndexedCoverage.mockRejectedValue(new Error("Coverage index quarantined; run metrics coverage warm to establish stability"));
        const outcome = await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 });
        expect(outcome).toMatchObject({ indexed: false, reason: "Coverage index quarantined; run metrics coverage warm to establish stability" });
        expect(outcome.validate_ms).toBeGreaterThanOrEqual(0);
        expect(outcome.exec_ms).toBeGreaterThanOrEqual(0);
        coverageIndexContext.mockRejectedValue(new Error("Discovered test outside measured source inventory; index unavailable"));
        expect(await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).toMatchObject({ indexed: false, reason: "Discovered test outside measured source inventory; index unavailable", validate_ms: 0 });
    });
    it("N3: a certified run with no metrics is unavailable, never an empty summary", async () => {
        coverageIndexContext.mockResolvedValue({ testFiles: [] });
        runIndexedCoverage.mockResolvedValue({ indexed: true, reason: null, selectedTests: [], result: { ok: true } });
        expect(await indexedCoverageSummary({ root: "/repo", timeoutMs: 1000 })).toMatchObject({ indexed: false, reason: "Index produced no per-file metrics" });
    });
});
