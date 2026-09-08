import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import { inventoryWithOverrides } from "../../lib/metrics/inventory-overrides.js";
import { createCoverageOverlay } from "../coverage-overlay.js";
import { coverageIndexContext } from "./context.js";
import { runIndexedCoverage, coverageIndexStatus } from "./controller.js";
import { warmCoverageIndex } from "./warm.js";
import { indexStore, promoteMatchingProposal } from "./staged-state.js";
import { readAcceptedManifest } from "./store.js";
import { loadEvidence } from "../../lib/metrics/evidence-store.js";
import { collectCompositeScoreReport } from "../../lib/metrics/composite-report.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "coverage-index-integration-"))); roots.push(root);
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["*.test.ts"], maxWorkers: 1, coverage: { include: ["a.ts", "b.ts"] } } };');
    writeFileSync(join(root, "a.ts"), "export function answer(value: boolean) { return value ? 1 : 2; }\n");
    writeFileSync(join(root, "b.ts"), "export function other() { return 3; }\n");
    writeFileSync(join(root, "a.test.ts"), 'import { expect, test } from "vitest"; import { answer } from "./a"; test("true", () => expect(answer(true)).toBe(1)); test("false", () => expect(answer(false)).toBe(2));');
    writeFileSync(join(root, "b.test.ts"), 'import { expect, test } from "vitest"; import { other } from "./b"; test("other", () => expect(other()).toBe(3));');
    return root;
}
it("matches full coverage, reruns one shard and promotes only after the actual write", async () => {
    const root = fixture(), warm = await warmCoverageIndex(root, 30_000);
    expect(warm.reason).toBeNull(); expect(warm.indexed).toBe(true); expect(warm.status.shards).toBe(2);
    const proposed = "export function answer(value: boolean) { if (value) return 1; return 2; }\n";
    const changes = new Map([["a.ts", proposed]]), context = coverageIndexContext(inventoryWithOverrides(collectRepositoryInventory(root), changes), changes);
    const overlay = createCoverageOverlay(root, "a.ts", proposed);
    try {
        const measured = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs: 30_000 });
        expect(measured.reason).toBeNull(); expect(measured.indexed).toBe(true); expect(measured.selectedTests).toEqual(["a.test.ts"]);
        expect(measured.result.perFile.get("b.ts")?.functions[0]?.statement_pct).toBe(100);
        expect(promoteMatchingProposal(context)).toBe(false);
        expect(readAcceptedManifest(indexStore(root))?.generation).toBe(1);
        writeFileSync(join(root, "a.ts"), proposed);
        expect(promoteMatchingProposal(coverageIndexContext(collectRepositoryInventory(root)))).toBe(true);
        expect(coverageIndexStatus(coverageIndexContext(collectRepositoryInventory(root))).valid).toBe(true);
        const full = await runIndexedCoverage({ context: coverageIndexContext(collectRepositoryInventory(root)), workspace: overlay.overlayRoot, timeoutMs: 30_000, full: true });
        expect(full.indexed).toBe(true);
        expect([...full.result.perFile].map(([path, cov]) => [path, [...cov.coveredLines ?? []], cov.functions.map(fn => fn.statement_pct)]))
            .toEqual([...measured.result.perFile].map(([path, cov]) => [path, [...cov.coveredLines ?? []], cov.functions.map(fn => fn.statement_pct)]));
    } finally { overlay.cleanup(); }
}, 90_000);
it("invalidates test discovery and config changes and refuses corrupt contribution data", async () => {
    const root = fixture(); expect((await warmCoverageIndex(root, 30_000)).indexed).toBe(true);
    writeFileSync(join(root, "vitest.config.ts"), readFileSync(join(root, "vitest.config.ts"), "utf8") + "\n// changed config\n");
    expect(coverageIndexStatus(coverageIndexContext(collectRepositoryInventory(root))).valid).toBe(false);
    rmSync(join(root, "b.test.ts"));
    expect(coverageIndexStatus(coverageIndexContext(collectRepositoryInventory(root))).reasons.join()).toContain("testDiscoveryHash");
    const manifest = readAcceptedManifest(indexStore(root)), entry = manifest?.shards["a.test.ts"];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Missing expected shard");
    writeFileSync(join(indexStore(root), entry.contributionPath), "corrupt");
    expect(() => coverageIndexStatus(coverageIndexContext(collectRepositoryInventory(root)))).toThrow("corrupt");
}, 60_000);

it("warms the index while qualifying runtime-unverified coverage as inconclusive for scoring", async () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), "RUNTIME_MODE=before\n");
    const warm = await warmCoverageIndex(root, 30_000);
    expect(warm.indexed, warm.reason ?? "").toBe(true);
    expect(warm.status.valid).toBe(true);
    const receipt = loadEvidence(collectRepositoryInventory(root)).entries[0];
    expect(receipt?.observations.state).toBe("inconclusive");
    expect(receipt?.observations.issues.join()).toContain("run metrics evidence run");
    writeFileSync(join(root, ".env"), "RUNTIME_MODE=after\n");
    const score = collectCompositeScoreReport(root);
    expect(score.metrics.find(row => row.id === "coverage.lines")?.state).not.toBe("measured");
    expect(score.groups.find(group => group.id === "coverage")?.reach).toBe(0);
}, 60_000);
