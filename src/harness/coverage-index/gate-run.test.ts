import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateContext } from "../evaluator/coverage-write-guard.js";
import type { CoverageRunner, CoverageRunOpts, CoverageRunResult } from "../coverage-runner.js";

let storeDirectory = "";
vi.mock("../../lib/metrics/inventory.js", () => ({ collectRepositoryInventory: (root: string) => ({ root, files: [], gaps: [], issues: [] }) }));
const inventoryWithOverrides = vi.fn((inventory: unknown, _changes: ReadonlyMap<string, string | null>) => inventory);
vi.mock("../../lib/metrics/inventory-overrides.js", () => ({ inventoryWithOverrides: (inventory: unknown, changes: ReadonlyMap<string, string | null>) => inventoryWithOverrides(inventory, changes) }));
const budget = { reserveBytes: 1, maxRssBytes: 2 };
const readResourceBudget = vi.fn((): typeof budget | null => budget);
vi.mock("../resource-budget.js", () => ({ readResourceBudget: () => readResourceBudget() }));
const testWorkerBudget = vi.fn((_requested: number) => 1);
vi.mock("../test-execution.js", () => ({ testWorkerBudget: (requested: number) => testWorkerBudget(requested) }));
const coverageIndexContext = vi.fn(async (..._args: unknown[]) => ({ fingerprint: "fp" }));
vi.mock("./context.js", () => ({ coverageIndexContext: (...args: unknown[]) => coverageIndexContext(...args) }));
type Measured = { indexed: boolean; reason: string | null; selectedTests: string[] | undefined; result: CoverageRunResult };
const certified: CoverageRunResult = { ok: true, perFile: new Map(), testsPassed: true, suiteMs: 4 };
const runIndexedCoverage = vi.fn(async (_options: unknown): Promise<Measured> => ({ indexed: true, reason: null, selectedTests: ["a.test.ts"], result: certified }));
vi.mock("./controller.js", () => ({ runIndexedCoverage: (options: unknown) => runIndexedCoverage(options) }));
const promoteMatchingProposal = vi.fn(async (_context: unknown) => true);
vi.mock("./staged-state.js", () => ({ indexStore: () => storeDirectory, promoteMatchingProposal: (context: unknown) => promoteMatchingProposal(context) }));

const { hasCoverageIndex, runCoverageForGate } = await import("./gate-run.js");

const directories: string[] = [];
beforeEach(() => {
    storeDirectory = mkdtempSync(join(tmpdir(), "gate-run-"));
    directories.push(storeDirectory);
    for (const mock of [inventoryWithOverrides, readResourceBudget, testWorkerBudget, coverageIndexContext, runIndexedCoverage, promoteMatchingProposal]) mock.mockClear();
    readResourceBudget.mockReturnValue(budget);
    testWorkerBudget.mockReturnValue(1);
    runIndexedCoverage.mockResolvedValue({ indexed: true, reason: null, selectedTests: ["a.test.ts"], result: certified });
});
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function establishIndex(): void { writeFileSync(join(storeDirectory, "manifest.json"), "{}"); }
function gateContext(overrides: Partial<GateContext> = {}): GateContext {
    // SAFETY: runCoverageForGate reads only projectRoot, language, budgetMs, relPath, proposed and overlayFiles; the rest of the gate context is never touched here.
    return { projectRoot: "/repo", language: "ts", budgetMs: 30_000, relPath: "src/a.ts", proposed: "export const a = 2;\n", ...overrides } as unknown as GateContext;
}
// SAFETY: the gate forwards these options untouched; only projectRoot and selectedTests are read here.
const options: CoverageRunOpts = { projectRoot: "/repo-overlay", selectedTests: ["x.test.ts"] } as unknown as CoverageRunOpts;
function fallbackRunner(result: CoverageRunResult): { runner: CoverageRunner; run: ReturnType<typeof vi.fn> } {
    const run = vi.fn(async (_opts: CoverageRunOpts) => result);
    // SAFETY: the gate calls only runner.run.
    return { runner: { run } as unknown as CoverageRunner, run };
}
const fallback: CoverageRunResult = { ok: true, perFile: new Map(), testsPassed: true, suiteMs: 9 };

describe("hasCoverageIndex", () => {
    // test-contract: public-api — only TypeScript/JavaScript projects with an accepted manifest on disk route through the index
    it("P1: needs a manifest and a TS/JS language", () => {
        expect(hasCoverageIndex("/repo", "ts")).toBe(false);
        establishIndex();
        expect(hasCoverageIndex("/repo", "ts")).toBe(true);
        expect(hasCoverageIndex("/repo", "js")).toBe(true);
        expect(hasCoverageIndex("/repo", "python")).toBe(false);
    });
});

describe("runCoverageForGate — positive (must fire)", () => {
    // test-contract: public-api — with an accepted index the gate measures the PROPOSED content (plus overlay files, deletions as null) under the daemon's budget and worker cap, and the result is a full-universe verdict
    it("P1: runs the indexed route over the proposed content and overlay files", async () => {
        establishIndex();
        const { runner, run } = fallbackRunner(fallback);
        const overlayFiles = [{ relPath: "src/b.ts", content: "export const b = 1;\n" }, { relPath: "src/c.ts", delete: true, content: "" }];
        const outcome = await runCoverageForGate(gateContext({ overlayFiles }), runner, options);
        expect(outcome).toEqual({ result: certified, fullUniverse: true, selectedTests: ["a.test.ts"] });
        expect(run).not.toHaveBeenCalled();
        expect(promoteMatchingProposal).toHaveBeenCalledTimes(1);
        expect([...(inventoryWithOverrides.mock.calls[0]?.[1] ?? [])]).toEqual([["src/b.ts", "export const b = 1;\n"], ["src/c.ts", null], ["src/a.ts", "export const a = 2;\n"]]);
        expect(runIndexedCoverage).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/repo-overlay", timeoutMs: 30_000, maxWorkers: 1, resourceBudget: budget }));
    });
    // test-contract: invariant — an index that cannot certify yields an UNMEASURED failure naming the reason, never a pass and never a universe claim, keeping the controller's selected tests
    it("P2: an uncertified run is an unmeasured failure with the reason", async () => {
        establishIndex();
        runIndexedCoverage.mockResolvedValue({ indexed: false, reason: "Tests did not pass: src/a.test.ts", selectedTests: ["a.test.ts"], result: { ...certified, ok: true, testsPassed: false } });
        const outcome = await runCoverageForGate(gateContext(), fallbackRunner(fallback).runner, options);
        expect(outcome).toMatchObject({ fullUniverse: false, selectedTests: ["a.test.ts"], result: { ok: false, testsPassed: false, error: "Incremental coverage unmeasured: Tests did not pass: src/a.test.ts" } });
    });
});

describe("runCoverageForGate — negative (must not fire)", () => {
    // test-contract: boundary — without an index the gate runs the ordinary runner and its universe claim follows the caller's selection (undefined selection means the whole suite)
    it("N1: falls back to the plain runner when no index exists", async () => {
        const full = fallbackRunner(fallback);
        const { selectedTests: _selection, ...wholeSuite } = options;
        expect(await runCoverageForGate(gateContext(), full.runner, wholeSuite)).toEqual({ result: fallback, fullUniverse: true, selectedTests: undefined });
        const scoped = fallbackRunner(fallback);
        expect(await runCoverageForGate(gateContext(), scoped.runner, options)).toEqual({ result: fallback, fullUniverse: false, selectedTests: ["x.test.ts"] });
        expect(scoped.run).toHaveBeenCalledWith(options);
        expect(runIndexedCoverage).not.toHaveBeenCalled();
    });
    // test-contract: invariant — a non-JS language never takes the index route even when a manifest exists
    it("N2: a python project uses the plain runner despite a manifest", async () => {
        establishIndex();
        const { runner, run } = fallbackRunner(fallback);
        const outcome = await runCoverageForGate(gateContext({ language: "python" }), runner, options);
        expect(outcome.result).toBe(fallback);
        expect(run).toHaveBeenCalledWith(options);
        expect(runIndexedCoverage).not.toHaveBeenCalled();
    });
    // test-contract: invariant — with no readable host memory reserve the gate cannot supervise the capture, so it refuses with an unmeasured result and starts nothing
    it("N3: refuses when the memory reserve is unavailable", async () => {
        establishIndex();
        readResourceBudget.mockReturnValue(null);
        const outcome = await runCoverageForGate(gateContext(), fallbackRunner(fallback).runner, options);
        expect(outcome).toMatchObject({ fullUniverse: false, selectedTests: undefined, result: { ok: false, testsPassed: null, error: "Coverage index unavailable: Host memory reserve unavailable" } });
        expect(runIndexedCoverage).not.toHaveBeenCalled();
    });
    // test-contract: invariant — a host that grants no instrumented worker refuses the capture instead of running with zero workers
    it("N4: refuses when the governor grants no worker", async () => {
        establishIndex();
        testWorkerBudget.mockReturnValue(0);
        const outcome = await runCoverageForGate(gateContext(), fallbackRunner(fallback).runner, options);
        expect(outcome.result.error).toBe("Coverage index unavailable: Host CPU or memory capacity unavailable for a test worker");
        expect(runIndexedCoverage).not.toHaveBeenCalled();
    });
    // test-contract: boundary — any failure on the index route (an Error or a non-Error throw) degrades to an unavailable result, never to a thrown gate crash
    it("N5: converts thrown errors to an unavailable result", async () => {
        establishIndex();
        runIndexedCoverage.mockRejectedValueOnce(new Error("capture exploded"));
        expect((await runCoverageForGate(gateContext(), fallbackRunner(fallback).runner, options)).result.error).toBe("Coverage index unavailable: capture exploded");
        coverageIndexContext.mockRejectedValueOnce("not an error object");
        expect((await runCoverageForGate(gateContext(), fallbackRunner(fallback).runner, options)).result.error).toBe("Coverage index unavailable: unknown error");
    });
});
