import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import { copyVitestRuntime } from "./__tests__/fixtures/vitest-runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "coverage-index-integration-"))); roots.push(root);
    copyVitestRuntime(root);
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["*.test.ts"], maxWorkers: 1, coverage: { include: ["a.ts", "b.ts"] } } };');
    writeFileSync(join(root, "a.ts"), "export function answer(value: boolean) { return value ? 1 : 2; }\n");
    writeFileSync(join(root, "b.ts"), "export function other() { return 3; }\n");
    writeFileSync(join(root, "a.test.ts"), 'import { expect, test } from "vitest"; import { answer } from "./a"; test("true", () => expect(answer(true)).toBe(1)); test("false", () => expect(answer(false)).toBe(2));');
    writeFileSync(join(root, "b.test.ts"), 'import { expect, test } from "vitest"; import { other } from "./b"; test("other", () => expect(other()).toBe(3));');
    return root;
}
it("keeps a pure shard reusable when an unrelated opaque shard exists", async () => {
    const root = fixture();
    writeFileSync(join(root, "io.test.ts"), 'import {test,expect} from "vitest"; import {readFileSync} from "node:fs"; test("io",()=>expect(readFileSync("a.ts","utf8")).toContain("export"));');
    expect((await warmCoverageIndex(root, 60_000)).indexed).toBe(true);
    const proposed = "export function answer(value: boolean) { if (value) return 1; return 2; }\n";
    const changes = new Map([["a.ts", proposed]]), overlay = createCoverageOverlay(root, "a.ts", proposed);
    try {
        const context = await coverageIndexContext(inventoryWithOverrides(collectRepositoryInventory(root), changes), changes, { workspace: overlay.overlayRoot });
        const selected = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs: 60_000 });
        expect(selected.indexed, selected.reason ?? "").toBe(true);
        expect(selected.selectedTests).toEqual(["a.test.ts", "io.test.ts"]);
        const full = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs: 60_000, full: true });
        const measured = [...selected.result.perFile].map(([path, { mtime: _mtime, ...coverage }]) => [path, coverage]);
        expect(measured).toEqual([...full.result.perFile].map(([path, { mtime: _mtime, ...coverage }]) => [path, coverage]));
    } finally { overlay.cleanup(); }
}, 120_000);
it("matches full coverage, reruns one shard and promotes only after the actual write", async () => {
    const root = fixture(), warm = await warmCoverageIndex(root, 30_000);
    expect(warm.reason).toBeNull(); expect(warm.indexed).toBe(true); expect(warm.status.shards).toBe(2);
    const proposed = "export function answer(value: boolean) { if (value) return 1; return 2; }\n";
    const changes = new Map([["a.ts", proposed]]);
    const overlay = createCoverageOverlay(root, "a.ts", proposed);
    try {
        const context = await coverageIndexContext(inventoryWithOverrides(collectRepositoryInventory(root), changes), changes, { workspace: overlay.overlayRoot });
        const measured = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs: 30_000 });
        expect(measured.reason).toBeNull(); expect(measured.indexed).toBe(true); expect(measured.selectedTests).toEqual(["a.test.ts"]);
        expect(measured.result.perFile.get("b.ts")?.functions[0]?.statement_pct).toBe(100);
        expect(await promoteMatchingProposal(context)).toBe(false);
        expect(readAcceptedManifest(indexStore(root))?.generation).toBe(1);
        writeFileSync(join(root, "a.ts"), proposed);
        expect(await promoteMatchingProposal(await coverageIndexContext(collectRepositoryInventory(root)))).toBe(true);
        expect((await coverageIndexStatus(await coverageIndexContext(collectRepositoryInventory(root)))).valid).toBe(true);
        const full = await runIndexedCoverage({ context: await coverageIndexContext(collectRepositoryInventory(root)), workspace: overlay.overlayRoot, timeoutMs: 30_000, full: true });
        expect(full.indexed).toBe(true);
        expect([...full.result.perFile].map(([path, cov]) => [path, [...cov.coveredLines ?? []], cov.functions.map(fn => fn.statement_pct)]))
            .toEqual([...measured.result.perFile].map(([path, cov]) => [path, [...cov.coveredLines ?? []], cov.functions.map(fn => fn.statement_pct)]));
    } finally { overlay.cleanup(); }
}, 90_000);
it("invalidates test discovery and config changes and refuses corrupt contribution data", async () => {
    const root = fixture(); expect((await warmCoverageIndex(root, 30_000)).indexed).toBe(true);
    writeFileSync(join(root, "vitest.config.ts"), readFileSync(join(root, "vitest.config.ts"), "utf8") + "\n// changed config\n");
    expect((await coverageIndexStatus(await coverageIndexContext(collectRepositoryInventory(root)))).valid).toBe(false);
    rmSync(join(root, "b.test.ts"));
    expect((await coverageIndexStatus(await coverageIndexContext(collectRepositoryInventory(root)))).reasons.join()).toContain("testDiscoveryHash");
    const manifest = readAcceptedManifest(indexStore(root)), entry = manifest?.shards["a.test.ts"];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Missing expected shard");
    writeFileSync(join(indexStore(root), entry.contributionPath), "corrupt");
    await expect(coverageIndexStatus(await coverageIndexContext(collectRepositoryInventory(root)))).rejects.toThrow("corrupt");
}, 60_000);

it("discovers executable tests beside helpers and reruns all shards after ignored config input changes", async () => {
    const root = fixture();
    mkdirSync(join(root, "__tests__"));
    writeFileSync(join(root, "__tests__/helper.ts"), "export const helper = 1;\n");
    writeFileSync(join(root, "__tests__/setup.ts"), "export const setup = true;\n");
    writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\n.interlinked/\n");
    writeFileSync(join(root, ".env"), "before");
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "vitest.config.ts"), 'import { readFileSync } from "node:fs"; export default { define: { __MODE__: JSON.stringify(readFileSync(".env", "utf8")) }, test: { include: ["**/*.test.ts"], setupFiles: ["./__tests__/setup.ts"], maxWorkers: 1, coverage: { include: ["a.ts", "b.ts"] } } };');
    writeFileSync(join(root, "b.ts"), 'export function other(mode: string) { return mode === "before" ? 3 : 4; }\n');
    writeFileSync(join(root, "b.test.ts"), 'import { expect, test } from "vitest"; import { other } from "./b"; test("runtime mode", () => expect(other(__MODE__)).toBe(__MODE__ === "before" ? 3 : 4));');
    expect(collectRepositoryInventory(root).files.some(file => file.path === ".env")).toBe(false);
    const warm = await warmCoverageIndex(root, 60_000);
    expect(warm.indexed, warm.reason ?? "").toBe(true);
    expect(warm.status.shards).toBe(2);
    const fresh = await coverageIndexContext(collectRepositoryInventory(root));
    const reused = await runIndexedCoverage({ context: fresh, workspace: root, timeoutMs: 60_000 });
    expect(reused.selectedTests).toEqual([]);
    writeFileSync(join(root, ".env"), "after");
    await expect(runIndexedCoverage({ context: fresh, workspace: root, timeoutMs: 60_000 })).rejects.toThrow("runtime inputs changed");
    const proposed = "export function answer(value: boolean) { if (value) return 1; return 2; }\n";
    const changes = new Map([["a.ts", proposed]]), overlay = createCoverageOverlay(root, "a.ts", proposed);
    try {
        const context = await coverageIndexContext(inventoryWithOverrides(collectRepositoryInventory(root), changes), changes, { workspace: overlay.overlayRoot });
        const measured = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs: 60_000 });
        expect(measured.indexed, measured.reason ?? "").toBe(true);
        expect(measured.selectedTests).toBeUndefined();
        expect(measured.result.testsPassed).toBe(true);
    } finally { overlay.cleanup(); }
    const beforeSupport = await coverageIndexContext(collectRepositoryInventory(root));
    writeFileSync(join(root, "__tests__/helper.ts"), "export const helper = 2;\n");
    const afterSupport = await coverageIndexContext(collectRepositoryInventory(root));
    expect(afterSupport.validity.coverageConfigHash).not.toBe(beforeSupport.validity.coverageConfigHash);
    expect(afterSupport.testFiles).toEqual(["a.test.ts", "b.test.ts"]);
}, 180_000);

it("rejects stale copied runtime bytes and a changed intended environment before reuse", async () => {
    const root = fixture();
    writeFileSync(join(root, ".env"), "before");
    const overlay = createCoverageOverlay(root, "a.ts", readFileSync(join(root, "a.ts"), "utf8"));
    try {
        writeFileSync(join(root, ".env"), "after");
        await expect(coverageIndexContext(collectRepositoryInventory(root), new Map(), { workspace: overlay.overlayRoot })).rejects.toThrow("overlay differs");
        const context = await coverageIndexContext(collectRepositoryInventory(root));
        const previous = process.env.INTERLINKED_INDEX_ENV_REGRESSION;
        try {
            process.env.INTERLINKED_INDEX_ENV_REGRESSION = "changed-after-context";
            await expect(runIndexedCoverage({ context, workspace: root, timeoutMs: 30_000 })).rejects.toThrow("environment changed");
            await expect(coverageIndexStatus(context)).rejects.toThrow("environment changed");
        } finally {
            if (previous === undefined) delete process.env.INTERLINKED_INDEX_ENV_REGRESSION;
            else process.env.INTERLINKED_INDEX_ENV_REGRESSION = previous;
        }
    } finally { overlay.cleanup(); }
}, 60_000);

it("reruns every shard when product-named setup changes the shared test contract", async () => {
    const root = fixture();
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["*.test.ts"], maxWorkers: 1, setupFiles: ["./bootstrap.ts", "setup-package"], coverage: { include: ["a.ts", "b.ts"] } } };');
    mkdirSync(join(root, "node_modules/setup-package"));
    writeFileSync(join(root, "node_modules/setup-package/package.json"), '{"name":"setup-package","type":"module","exports":"./index.js"}');
    writeFileSync(join(root, "node_modules/setup-package/index.js"), "export {};\n");
    const setup = 'import { expect } from "vitest"; expect.extend({ toBeFixture(value) { return { pass: value === 1 || value === 3, message: () => "fixture" }; } });';
    writeFileSync(join(root, "bootstrap.ts"), setup);
    writeFileSync(join(root, "a.test.ts"), 'import { test, expect } from "vitest"; import { answer } from "./a"; test("a", () => expect(answer(true)).toBeFixture());');
    writeFileSync(join(root, "b.test.ts"), 'import { test, expect } from "vitest"; import { other } from "./b"; test("b", () => expect(other()).toBeFixture());');
    expect((await warmCoverageIndex(root, 60_000)).indexed).toBe(true);
    writeFileSync(join(root, "bootstrap.ts"), setup.replace("value === 1 || value === 3", "value === 1"));
    const proposed = "export function answer(value: boolean) { if (value) return 1; return 2; }\n", changes = new Map([["a.ts", proposed]]);
    const overlay = createCoverageOverlay(root, "a.ts", proposed);
    try {
        const context = await coverageIndexContext(inventoryWithOverrides(collectRepositoryInventory(root), changes), changes, { workspace: overlay.overlayRoot });
        const measured = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs: 60_000 });
        expect(measured.selectedTests).toBeUndefined();
        expect(measured.result.testsPassed).toBe(false);
        expect(measured.indexed).toBe(false);
    } finally { overlay.cleanup(); }
}, 90_000);

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
