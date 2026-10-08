import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";
import { loadTestPlan, normalizeTestInput, readTestDependencies, srcFixtureModules } from "./test-plan-inputs.js";

const boundary = vi.hoisted(() => ({ inventory: vi.fn(), discover: vi.fn(), runtime: vi.fn(), manifest: vi.fn() }));
vi.mock("../lib/metrics/inventory.js", async original => ({
    ...await original<typeof import("../lib/metrics/inventory.js")>(), collectRepositoryInventory: boundary.inventory,
}));
vi.mock("./coverage-shards/discovery.js", () => ({ discoverVitestUniverse: boundary.discover,
    captureVitestEnvironment: () => ({ environment: {} }) }));
vi.mock("./test-runtime.js", () => ({ captureTestRuntime: boundary.runtime }));
vi.mock("./coverage-index/store.js", async original => ({
    ...await original<typeof import("./coverage-index/store.js")>(), readAcceptedManifest: boundary.manifest,
}));

let cwd: string;
let inventory: RepositoryInventory;
beforeEach(() => {
    vi.clearAllMocks();
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "planning-inputs-")));
    inventory = { version: "interlinked-source-roles-v3", root: cwd, discovery: "git", gaps: [], excluded: [],
        issues: [], inputHash: "input", sourceHash: "source", files: [
            { path: "a.test.ts", content: 'import "./a";', role: "test", language: "typescript", sha256: "test" },
            { path: "a.ts", content: "export const a = 1;", role: "product", language: "typescript", sha256: "source" },
        ] };
    boundary.inventory.mockReturnValue(inventory);
    boundary.discover.mockResolvedValue({ tests: ["a.test.ts"], supportFiles: [] });
    boundary.runtime.mockResolvedValue({ hash: "runtime-v1" });
    boundary.manifest.mockReturnValue(null);
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

it("binds a runtime even when default full execution is not reusable", async () => {
    const plan = await loadTestPlan(cwd, ["a.ts"], 10_000);
    expect(plan).toMatchObject({ mode: "full", reusable: false, runtimeHash: "runtime-v1", changedPaths: ["a.ts"] });
    expect(plan.tests.map(test => test.path)).toEqual(["a.test.ts"]);
    expect(boundary.runtime).toHaveBeenCalledWith(cwd, expect.any(Number));
});

it("uses recorded dependencies and durations without overriding the runtime identity", async () => {
    inventory.files.push({ path: "data.ts", content: "export {};", role: "product", language: "typescript", sha256: "data" });
    boundary.manifest.mockReturnValue({ shards: { historical: {
        testPaths: ["a.test.ts"], dependencyHashes: { "data.ts": "previous" }, lastDurationMs: 125,
    } } });
    const plan = await loadTestPlan(cwd, ["data.ts"], 10_000, false, { staticSelection: true });
    expect(plan).toMatchObject({ mode: "selected", reusable: true, estimatedSerialMs: 125, runtimeHash: "runtime-v1" });
    expect(plan.tests).toEqual([{ path: "a.test.ts", reasons: ["Recorded dependency changed: data.ts"], durationMs: 125 }]);
});

it.each([new Error("discovery timed out"), "untyped failure"])("falls back to inventoried tests on discovery failure: %s", async error => {
    boundary.discover.mockRejectedValue(error);
    const plan = await loadTestPlan(cwd, ["a.ts"], 10_000, false, { staticSelection: true });
    expect(plan).toMatchObject({ mode: "full", reusable: false, runtimeHash: "runtime-v1" });
    expect(plan.tests.map(test => test.path)).toEqual(["a.test.ts"]);
    expect(plan.reasons).toContain(`Native test discovery unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
});

it("runs discovered tests outside inventory but never claims reusable evidence for them", async () => {
    boundary.discover.mockResolvedValue({ tests: ["a.test.ts", "scripts/extra.test.ts"], supportFiles: [] });
    const plan = await loadTestPlan(cwd, ["a.ts"], 10_000, true, { staticSelection: true });
    expect(plan).toMatchObject({ mode: "full", reusable: false });
    expect(plan.tests.map(test => test.path)).toEqual(["a.test.ts", "scripts/extra.test.ts"]);
    expect(plan.reasons).toContain("Discovered tests outside analyzed inventory: 1");
});

it.each([false, true])("retains runtime failure and forbids reuse with static selection %s", async staticSelection => {
    boundary.runtime.mockResolvedValue({ issue: "snapshot changed during capture" });
    const plan = await loadTestPlan(cwd, ["a.ts"], 10_000, false, { staticSelection });
    expect(plan).toMatchObject({ mode: "full", reusable: false });
    expect(plan.runtimeHash).toBeUndefined();
    expect(plan.runtimeIssue).toContain("snapshot changed during capture");
    if (staticSelection) expect(plan.reasons).toContain("Runtime validation unavailable: snapshot changed during capture");
});

it("loads only readable bounded source fixtures and leaves missing or oversized fixtures unresolved", () => {
    mkdirSync(join(cwd, "src/fixtures"), { recursive: true });
    writeFileSync(join(cwd, "src/fixtures/cases.ts"), "export const cases = [1];");
    writeFileSync(join(cwd, "src/fixtures/large.ts"), "é".repeat(1024 * 1024 + 1));
    inventory.excluded = ["cases.ts", "large.ts", "gone.ts", "data.json"].map(name => ({
        path: `src/fixtures/${name}`, role: "fixture", reason: "fixture role",
    }));
    inventory.excluded.push({ path: "generated.ts", role: "generated", reason: "generated role" });
    expect(srcFixtureModules(inventory)).toEqual([{ path: "src/fixtures/cases.ts", content: "export const cases = [1];" }]);
    mkdirSync(join(cwd, "src/fixtures/directory.ts"));
    inventory.excluded = [{ path: "src/fixtures/directory.ts", role: "fixture", reason: "fixture role" }];
    expect(() => srcFixtureModules(inventory)).toThrow(expect.objectContaining({ code: "EISDIR" }));
});

it("rejects invalid declaration documents and propagates non-missing path errors", () => {
    mkdirSync(join(cwd, ".interlinked"));
    writeFileSync(join(cwd, ".interlinked/test-dependencies.json"), '{"version":2,"tests":{}}');
    expect(() => readTestDependencies(cwd)).toThrow("Expected test-dependencies.json");
    symlinkSync("loop.ts", join(cwd, "loop.ts"));
    expect(() => normalizeTestInput(cwd, "loop.ts")).toThrow(expect.objectContaining({ code: "ELOOP" }));
});
