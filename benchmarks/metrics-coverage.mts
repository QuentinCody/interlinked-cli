import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectRepositoryInventory } from "../src/lib/metrics/inventory.js";
import { inventoryWithOverrides } from "../src/lib/metrics/inventory-overrides.js";
import { createCoverageOverlay } from "../src/harness/coverage-overlay.js";
import { coverageIndexContext } from "../src/harness/coverage-index/context.js";
import { runIndexedCoverage } from "../src/harness/coverage-index/controller.js";
import { warmCoverageIndex } from "../src/harness/coverage-index/warm.js";
import { promoteMatchingProposal } from "../src/harness/coverage-index/staged-state.js";

function fixture(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-coverage-benchmark-")));
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["*.test.ts"], maxWorkers: 1, coverage: { include: ["unit*.ts"], exclude: ["*.test.ts"] } } };');
    for (let index = 0; index < 8; index++) {
        writeFileSync(join(root, `unit${index}.ts`), `export function value(flag: boolean) { return flag ? ${index} : -1; }\n`);
        writeFileSync(join(root, `unit${index}.test.ts`), `import { test, expect } from "vitest"; import { value } from "./unit${index}";
test("both branches", async () => { await new Promise(resolve => setTimeout(resolve, 80)); expect(value(true)).toBe(${index}); expect(value(false)).toBe(-1); });`);
    }
    return root;
}
async function incremental(root: string, round: number) {
    const proposed = `export function value(flag: boolean) { return flag ? 0 : -1; }\n// edit ${round}\n`, changes = new Map([["unit0.ts", proposed]]);
    const started = performance.now(), context = coverageIndexContext(inventoryWithOverrides(collectRepositoryInventory(root), changes), changes);
    const overlay = createCoverageOverlay(root, "unit0.ts", proposed);
    try {
        const result = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs: 30_000 });
        if (!result.indexed || result.selectedTests?.length !== 1 || result.result.perFile.size !== 8) throw new Error(result.reason ?? "Incremental scope/aggregate mismatch");
        writeFileSync(join(root, "unit0.ts"), proposed);
        if (!promoteMatchingProposal(coverageIndexContext(collectRepositoryInventory(root)))) throw new Error("Proposal did not promote");
        return { totalMs: performance.now() - started, suiteMs: result.result.suiteMs, rerunTests: result.selectedTests.length, measuredFiles: result.result.perFile.size };
    } finally { overlay.cleanup(); }
}
const root = fixture();
try {
    const cold = await warmCoverageIndex(root, 30_000);
    if (!cold.indexed) throw new Error(cold.reason ?? "Warm failed");
    const rounds = [];
    for (let index = 0; index < 3; index++) {
        const edit = await incremental(root, index), full = await warmCoverageIndex(root, 30_000);
        if (!full.indexed) throw new Error(full.reason ?? "Full run failed");
        rounds.push({ incremental: edit, fullMs: full.durationMs });
    }
    console.log(JSON.stringify({ schemaVersion: 1, kind: "controlled-fixture", node: process.version, platform: process.platform,
        testFiles: 8, perTestDelayMs: 80, coldMs: cold.durationMs, rounds, limitations: ["Controlled fixture, not an estimate for Interlinked CLI's full suite", "Three timing samples; machine load affects results"], modelCalls: 0 }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
