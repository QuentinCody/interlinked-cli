import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COVERAGE_FINAL_FILENAME, type SpawnFn } from "../coverage-runner.js";

// Only the supervised spawn is replaced: the real one starts a vitest child tree under a memory budget.
const supervisedCalls: { environment: NodeJS.ProcessEnv; budget: unknown }[] = [];
const supervisedSpawn = vi.fn<SpawnFn>(async () => ({ stdout: "", stderr: "", status: 0 }));
vi.mock("./discovery.js", async importOriginal => ({ ...await importOriginal<typeof import("./discovery.js")>(),
    coverageIndexSpawn: (environment: NodeJS.ProcessEnv, budget: unknown) => { supervisedCalls.push({ environment, budget }); return supervisedSpawn; } }));

const { captureVitestShards } = await import("./vitest.js");

let scratch = "";
const BUDGET = { reserveBytes: 1, maxRssBytes: 2 };
beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "cov-shards-indexed-"));
    supervisedCalls.length = 0;
    supervisedSpawn.mockClear();
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function plainSpawn(captureDir: string): SpawnFn {
    return async () => {
        mkdirSync(join(captureDir, "coverage"), { recursive: true });
        writeFileSync(join(captureDir, "coverage", COVERAGE_FINAL_FILENAME), "{}", "utf-8");
        return { stdout: "", stderr: "", status: 0 };
    };
}

describe("captureVitestShards — indexed route — positive (must fire)", () => {
    // test-contract: public-api — an indexed capture (frozen environment plus an admitted budget) runs the indexed command under the SUPERVISED spawn built from exactly that environment and budget, never the caller's plain spawn
    it("P1: uses the supervised spawn and the indexed command", async () => {
        const captureDir = join(scratch, ".capture"), environment = { PATH: "/usr/bin", VITEST: "true" };
        supervisedSpawn.mockImplementation(plainSpawn(captureDir));
        const plain = vi.fn<SpawnFn>(plainSpawn(captureDir));
        const result = await captureVitestShards({ projectRoot: process.cwd(), captureDir, environment, resourceBudget: BUDGET, maxWorkers: 2, selectedTests: ["src/a.test.ts"], spawn: plain, resolveV8Url: () => "file:///coverage-v8/index.js", timeoutMs: 5000 });
        expect(supervisedCalls).toEqual([{ environment, budget: BUDGET }]);
        expect(supervisedSpawn).toHaveBeenCalledTimes(1);
        expect(plain).not.toHaveBeenCalled();
        expect(result.runResult.ok).toBe(true);
        expect(result.argv?.at(-1)).toContain("startVitest");
        expect(result.argv?.at(-1)).toContain('"maxWorkers":2');
    });
});

describe("captureVitestShards — indexed route — negative (must not fire)", () => {
    // test-contract: invariant — an indexed capture without an admitted resource budget is refused outright: the child tree would run unsupervised, so nothing is spawned
    it("N1: refuses an environment without a budget and spawns nothing", async () => {
        const captureDir = join(scratch, ".capture"), plain = vi.fn<SpawnFn>(plainSpawn(captureDir));
        await expect(captureVitestShards({ projectRoot: process.cwd(), captureDir, environment: { PATH: "/usr/bin" }, spawn: plain, resolveV8Url: () => "file:///coverage-v8/index.js" }))
            .rejects.toThrow("Indexed capture requires an admitted resource budget");
        expect(plain).not.toHaveBeenCalled();
        expect(supervisedSpawn).not.toHaveBeenCalled();
    });
    // test-contract: invariant — the non-indexed capture ignores a budget it was given without an environment and uses the caller's spawn
    it("N2: a budget without an environment keeps the plain spawn", async () => {
        const captureDir = join(scratch, ".capture"), plain = vi.fn<SpawnFn>(plainSpawn(captureDir));
        const result = await captureVitestShards({ projectRoot: scratch, captureDir, resourceBudget: BUDGET, spawn: plain, resolveV8Url: () => "file:///coverage-v8/index.js" });
        expect(plain).toHaveBeenCalledTimes(1);
        expect(supervisedCalls).toEqual([]);
        expect(result.argv).toContain("--coverage.provider=custom");
    });
});
