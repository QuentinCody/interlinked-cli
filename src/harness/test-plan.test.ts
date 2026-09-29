import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { buildTestPlan, type TestPlanInput } from "./test-plan.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input(changedPaths: string[]): TestPlanInput {
    const root = mkdtempSync(join(tmpdir(), "test-plan-")); roots.push(root);
    const files = { "a.ts": "export const a = 1;", "b.ts": "export const b = 2;",
        "a.test.ts": 'import { a } from "./a";', "b.test.ts": 'import { b } from "./b";',
        "io.test.ts": 'import fs from "node:fs";', "helper.ts": 'import { a } from "./a";',
        "indirect.test.ts": 'import "./helper";', "vitest.config.ts": "export default {};" };
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    return { inventory: collectRepositoryInventory(root), tests: ["a.test.ts", "b.test.ts", "io.test.ts", "indirect.test.ts"], supportFiles: ["vitest.config.ts"], changedPaths };
}

/** The fixture without its opaque test (io.test.ts reads node:fs): every closure resolves inside the inventory. */
function transparentInput(changedPaths: string[]): TestPlanInput {
    const base = input(changedPaths);
    return { ...base, tests: base.tests.filter(test => test !== "io.test.ts") };
}

// test-contract: invariant — an explicitly requested full run is reusable evidence only when every input is tracked: no untracked input and no opaque closure (an opaque test may read an external fixture, the network or the clock)
it("makes a requested full run reusable only when every closure resolves and nothing is untracked", () => {
    const requested = buildTestPlan({ ...transparentInput([]), full: true });
    expect(requested).toMatchObject({ mode: "full", reusable: true, reasons: ["Full reconciliation requested"] });
    expect(requested.tests.map(test => test.path)).toEqual(["a.test.ts", "b.test.ts", "indirect.test.ts"]);
    const opaque = buildTestPlan({ ...input([]), full: true });
    expect(opaque).toMatchObject({ mode: "full", reusable: false });
    const uncertain = buildTestPlan({ ...transparentInput([]), full: true, uncertainty: ["Native test discovery unavailable: x"] });
    expect(uncertain).toMatchObject({ mode: "full", reusable: false });
    const unknown = buildTestPlan({ ...transparentInput(["gone.ts"]), full: true });
    expect(unknown).toMatchObject({ mode: "full", reusable: false });
    expect(unknown.reasons).toContain("Unknown or deleted input: gone.ts");
});

// test-contract: invariant — an opaque SHARED setup file (it runs in every test and may read an external fixture) makes any run fresh-only, selected or full, even when nothing changed
it("makes every run fresh-only when a shared setup file is opaque", () => {
    const base = transparentInput([]);
    const root = base.inventory.root;
    writeFileSync(join(root, "setup.ts"), 'import fs from "node:fs"; fs.readFileSync("/outside/fixture.txt");');
    const withOpaqueSetup = { ...base, inventory: collectRepositoryInventory(root), supportFiles: ["vitest.config.ts", "setup.ts"] };
    expect(buildTestPlan({ ...withOpaqueSetup, full: true })).toMatchObject({ mode: "full", reusable: false });
    // A changed path beside an opaque setup file widens to the whole suite (scope) and stays fresh-only (uncertainty of what setup reads).
    expect(buildTestPlan({ ...withOpaqueSetup, changedPaths: ["a.test.ts"] })).toMatchObject({ mode: "full", reusable: false });
    expect(buildTestPlan({ ...base, full: true })).toMatchObject({ mode: "full", reusable: true });
});

// test-contract: invariant — discovered tests the inventory does not carry have unresolved dependencies: the whole suite runs and the result is fresh-only
it("makes a full run caused by tests outside the inventory fresh-only", () => {
    const plan = buildTestPlan({ ...transparentInput([]), outsideInventory: ["scripts/audit.test.mjs", "src/x/__fixtures__/f.test.ts"] });
    expect(plan).toMatchObject({ mode: "full", reusable: false, reasons: ["Discovered tests outside analyzed inventory: 2"] });
});

// test-contract: invariant — a changed shared setup file is a SCOPE reason: the whole suite runs and, with every closure resolved, the result stays reusable
it("keeps a full run caused by a shared configuration change reusable when closures resolve", () => {
    const plan = buildTestPlan(transparentInput(["vitest.config.ts"]));
    expect(plan).toMatchObject({ mode: "full", reusable: true });
    expect(plan.reasons).toEqual(["Shared setup or configuration changed: vitest.config.ts"]);
    expect(buildTestPlan(input(["vitest.config.ts"]))).toMatchObject({ mode: "full", reusable: false });
});

it("runs edited tests and keeps independent tests out of the union", () => {
    const plan = buildTestPlan(input(["a.test.ts"]));
    expect(plan.tests.map(test => test.path)).toEqual(["a.test.ts", "io.test.ts"]);
    expect(plan.tests[0]?.reasons).toEqual(["Test changed: a.test.ts"]);
    expect(plan.omitted).toEqual(["b.test.ts", "indirect.test.ts"]);
});
it("unions direct, transitive and opaque consumers once", () => {
    const plan = buildTestPlan(input(["a.ts", "helper.ts", "a.ts"]));
    expect(plan.tests.map(test => test.path)).toEqual(["a.test.ts", "indirect.test.ts", "io.test.ts"]);
    expect(plan.mode).toBe("selected");
    expect(plan.reusable).toBe(false);
});
it.each(["vitest.config.ts", "removed.ts"])("widens %s to the complete universe", changed => {
    const plan = buildTestPlan(input([changed]));
    expect(plan.mode).toBe("full");
    expect(plan.tests).toHaveLength(4);
    expect(plan.omitted).toEqual([]);
});
it("includes declared fixtures and recorded runtime consumers", () => {
    const plan = buildTestPlan({ ...input(["fixture.txt"]), dependencies: { "a.test.ts": ["fixture.txt"] },
        historical: { "b.test.ts": { dependencies: ["fixture.txt"], durationMs: 10 } } });
    expect(plan.tests.map(test => test.path)).toEqual(["a.test.ts", "b.test.ts", "io.test.ts"]);
    expect(plan.tests[0]?.reasons).toEqual(["Declared dependency changed: fixture.txt"]);
    expect(plan.tests[1]?.reasons).toEqual(["Recorded dependency changed: fixture.txt"]);
});

it("includes a companion of an indirect importer even without a test import", () => {
    const data = input(["a.ts"]), root = data.inventory.root;
    writeFileSync(join(root, "helper.test.ts"), "export {};");
    const plan = buildTestPlan({ ...data, inventory: collectRepositoryInventory(root), tests: [...data.tests, "helper.test.ts"] });
    expect(plan.tests.find(test => test.path === "helper.test.ts")?.reasons).toContain("Transitive dependency changed: a.ts");
});

it("widens an unchanged opaque global setup when another source changes", () => {
    const data = input(["a.ts"]), root = data.inventory.root;
    writeFileSync(join(root, "setup.ts"), 'import fs from "node:fs";');
    const plan = buildTestPlan({ ...data, inventory: collectRepositoryInventory(root), supportFiles: ["setup.ts"] });
    expect(plan.mode).toBe("full");
    expect(plan.reasons).toContain("Opaque shared setup or configuration");
    expect(plan.omitted).toEqual([]);
});
