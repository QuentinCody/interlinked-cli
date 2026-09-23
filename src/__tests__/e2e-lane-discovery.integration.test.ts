import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { discoveredTests } from "../../scripts/e2e-evidence.mjs";

function intended(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = join(directory, entry.name);
        return entry.isDirectory() ? intended(file) : /\.test\.(?:ts|mjs|mts)$/.test(file) ? [file] : [];
    });
}

it("Vitest actually discovers disjoint, complete lanes and base = unit + integration", async () => {
    const root = process.cwd();
    const sets: string[][] = [];
    for (const config of ["vitest.config.ts", "vitest.unit.config.ts", "vitest.integration.config.ts", "vitest.e2e.config.ts"]) {
        sets.push((await discoveredTests(root, resolve(root, config))).tests);
    }
    const [base = [], unit = [], integration = [], e2e = []] = sets;
    expect(e2e.length).toBeGreaterThan(0);
    expect(new Set([...unit, ...integration, ...e2e]).size).toBe(unit.length + integration.length + e2e.length);
    expect(base.sort()).toEqual([...unit, ...integration].sort());
    const all = ["src", "landing/src"].flatMap((path) => intended(resolve(root, path)));
    all.push(...intended(resolve(root, "scripts")).filter((path) => /\.test\.m[jt]s$/.test(path)));
    all.push(resolve(root, "test/agent-driven/run-scenario.test.ts"));
    expect([...unit, ...integration, ...e2e].sort()).toEqual(all.sort());
}, 60_000);
