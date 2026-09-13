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
