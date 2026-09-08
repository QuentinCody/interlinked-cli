import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { evidenceIdentity } from "./evidence-identity.js";
import { runBehavioralEvidence, type EvidenceRunOptions } from "./evidence-run.js";
import { evidenceDirectory, loadEvidence, readEvidenceArtifact, saveEvidence } from "./evidence-store.js";
import { collectRepositoryInventory } from "./inventory.js";
import { collectCompositeScoreReport } from "./composite-report.js";

const roots: string[] = [];
const PRIVATE_VALUE = "ignored-runtime-secret-never-for-receipts";
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(beforeReport = ""): EvidenceRunOptions {
    const root = mkdtempSync(join(tmpdir(), "metrics-runtime-inputs-")); roots.push(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\n");
    writeFileSync(join(root, ".env"), `COVERAGE_MODE=covered\nPRIVATE_VALUE=${PRIVATE_VALUE}\n`);
    writeFileSync(join(root, "index.cjs"), "module.exports = 1;\n");
    const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 19 } };
    const report = { "index.cjs": { statementMap: { 0: location }, s: { 0: 1 }, branchMap: {}, b: {}, fnMap: {}, f: {} } };
    writeFileSync(join(root, "run.test.cjs"), `const fs = require('node:fs'); const report = ${JSON.stringify(report)};
        report['index.cjs'].s[0] = Number(fs.readFileSync('.env', 'utf8').includes('COVERAGE_MODE=covered'));
        ${beforeReport}
        fs.writeFileSync('report.json', JSON.stringify(report));`);
    return { root, kind: "coverage", artifact: "report.json", timeoutMs: 10_000, resume: true,
        runner: { argv: [process.execPath, "run.test.cjs"], version: process.version, operatorPolicy: "runtime-inputs" } };
}

it("reruns a Git-ignored .env change using its real copied value without persisting secrets", async () => {
    const options = fixture(), initialIdentity = evidenceIdentity(collectRepositoryInventory(options.root));
    const first = await runBehavioralEvidence(options);
    expect(first.evidence?.observations, first.issues.join()).toMatchObject({ state: "measured", coverage: [{ lines: { covered: 1, total: 1 } }] });
    expect((await runBehavioralEvidence(options)).cached).toBe(true);
    expect(collectCompositeScoreReport(options.root).metrics.find(row => row.id === "coverage.lines")?.state).toBe("measured");
    writeFileSync(join(options.root, ".env"), `COVERAGE_MODE=uncovered\nPRIVATE_VALUE=${PRIVATE_VALUE}\n`);
    expect(evidenceIdentity(collectRepositoryInventory(options.root))).toEqual(initialIdentity);
    expect(loadEvidence(collectRepositoryInventory(options.root)).entries[0]?.observations).toMatchObject({ state: "stale", issues: ["workspaceHash changed"] });
    const score = collectCompositeScoreReport(options.root);
    expect(score.metrics.find(row => row.id === "coverage.lines")?.state).toBe("stale");
    expect(score.groups.find(group => group.id === "coverage")?.reach).toBe(0);
    const changed = await runBehavioralEvidence(options);
    expect(changed.cached).toBe(false);
    expect(changed.evidence?.observations, changed.issues.join()).toMatchObject({ state: "measured", coverage: [{ lines: { covered: 0, total: 1 } }] });
    expect(changed.evidence?.receipt.runner.workspaceHash).not.toBe(first.evidence?.receipt.runner.workspaceHash);
    expect(readFileSync(join(options.root, ".env"), "utf8")).toContain("COVERAGE_MODE=uncovered");
    for (const name of readdirSync(evidenceDirectory(options.root))) {
        expect(readFileSync(join(evidenceDirectory(options.root), name), "utf8")).not.toContain(PRIVATE_VALUE);
    }
    expect(readFileSync(join(options.root, ".interlinked/metrics/executions.jsonl"), "utf8")).not.toContain(PRIVATE_VALUE);
});

it("binds installed dependency bytes behind a relative symlink", async () => {
    const options = fixture("report['index.cjs'].s[0] = require('runtime-dependency');");
    mkdirSync(join(options.root, "node_modules/.store"), { recursive: true });
    writeFileSync(join(options.root, "node_modules/.store/dependency.cjs"), "module.exports = 1;\n");
    symlinkSync(".store/dependency.cjs", join(options.root, "node_modules/runtime-dependency.js"));
    const first = await runBehavioralEvidence(options);
    expect(first.evidence?.observations.state, first.issues.join()).toBe("measured");
    expect((await runBehavioralEvidence(options)).cached).toBe(true);
    writeFileSync(join(options.root, "node_modules/.store/dependency.cjs"), "module.exports = 0;\n");
    expect(loadEvidence(collectRepositoryInventory(options.root)).entries[0]?.observations.state).toBe("stale");
    const changed = await runBehavioralEvidence(options);
    expect(changed.cached).toBe(false);
    expect(changed.evidence?.observations.coverage[0]?.lines.covered, changed.issues.join()).toBe(0);
    expect(changed.evidence?.receipt.runner.workspaceHash).not.toBe(first.evidence?.receipt.runner.workspaceHash);
});

it("withholds measured evidence when the runner changes an ignored input", async () => {
    const options = fixture("fs.writeFileSync('.env', 'COVERAGE_MODE=uncovered');");
    const result = await runBehavioralEvidence(options);
    expect(result.evidence?.observations.state).toBe("inconclusive");
    expect(result.issues).toContain("Runner changed runtime input: .env");
    expect(readFileSync(join(options.root, ".env"), "utf8")).toContain("COVERAGE_MODE=covered");
    expect((await runBehavioralEvidence(options)).cached).toBe(false);
});

it("withholds measured evidence when the original ignored input changes during the run", async () => {
    const options = fixture();
    writeFileSync(join(options.root, "run.test.cjs"), `${readFileSync(join(options.root, "run.test.cjs"), "utf8")}\nfs.writeFileSync(${JSON.stringify(join(options.root, ".env"))}, 'changed by original workspace');`);
    const result = await runBehavioralEvidence(options);
    expect(result.evidence?.observations.state).toBe("stale");
    expect(result.issues).toContain("Repository runtime inputs changed during evidence execution");
});

it("cannot resume earlier evidence when a copied input becomes unavailable", async () => {
    const options = fixture();
    expect((await runBehavioralEvidence(options)).evidence?.observations.state).toBe("measured");
    rmSync(join(options.root, ".env"));
    symlinkSync("missing-runtime-input", join(options.root, ".env"));
    const unavailable = loadEvidence(collectRepositoryInventory(options.root)).entries[0]?.observations;
    expect(unavailable?.state).toBe("inconclusive");
    expect(unavailable?.issues.join()).toContain("Local runtime inputs unavailable");
    const result = await runBehavioralEvidence(options);
    expect(result).toMatchObject({ outcome: "error", cached: false, evidence: null });
});

it.skipIf(process.platform === "win32")("preserves directory permissions and invalidates changed runtime permissions", async () => {
    const options = fixture("require('node:assert/strict').equal(fs.statSync('node_modules').mode & 511, 448);");
    mkdirSync(join(options.root, "node_modules"), { mode: 0o700 });
    const first = await runBehavioralEvidence(options);
    expect(first.evidence?.observations.state, first.issues.join()).toBe("measured");
    chmodSync(join(options.root, ".env"), 0o600);
    const changed = await runBehavioralEvidence(options);
    expect(changed.cached).toBe(false);
    expect(changed.evidence?.receipt.runner.workspaceHash).not.toBe(first.evidence?.receipt.runner.workspaceHash);
});

it.skipIf(process.platform === "win32")("cleans read-only copied directories without changing the original workspace", async () => {
    const options = fixture("require('node:assert/strict').equal(fs.statSync('node_modules').mode & 511, 320);");
    mkdirSync(join(options.root, "node_modules"));
    writeFileSync(join(options.root, "node_modules/runtime.txt"), "retained original");
    chmodSync(join(options.root, "node_modules"), 0o500);
    try {
        const result = await runBehavioralEvidence(options);
        expect(result.evidence?.observations.state, result.issues.join()).toBe("measured");
        expect(existsSync(result.evidence?.receipt.reportRoot ?? "")).toBe(false);
        expect(statSync(join(options.root, "node_modules")).mode & 0o777).toBe(0o500);
        expect(readFileSync(join(options.root, "node_modules/runtime.txt"), "utf8")).toBe("retained original");
    } finally { chmodSync(join(options.root, "node_modules"), 0o700); }
});

it("reads legacy receipts but reruns evidence without a copied-runtime digest", async () => {
    const options = fixture(), first = await runBehavioralEvidence(options);
    if (!first.evidence) throw new Error(first.issues.join());
    const { workspaceHash: _workspaceHash, ...legacyRunner } = first.evidence.receipt.runner;
    const content = readEvidenceArtifact(join(evidenceDirectory(options.root), `${first.evidence.id}.artifact.json`));
    rmSync(join(evidenceDirectory(options.root), `${first.evidence.id}.receipt.json`));
    const legacy = saveEvidence(collectRepositoryInventory(options.root), { ...first.evidence.receipt, runner: legacyRunner }, content);
    expect(legacy.observations.state).toBe("inconclusive");
    const resumed = await runBehavioralEvidence(options);
    expect(resumed.cached).toBe(false);
    expect(resumed.evidence?.observations.state).toBe("measured");
    expect(resumed.evidence?.receipt.runner.workspaceHash).toMatch(/^[a-f0-9]{64}$/);
});

it("revalidates the inherited runner environment before scoring local evidence", async () => {
    const options = fixture();
    vi.stubEnv("INTERLINKED_RUNTIME_SCORE_MODE", "before");
    expect((await runBehavioralEvidence(options)).evidence?.observations.state).toBe("measured");
    vi.stubEnv("INTERLINKED_RUNTIME_SCORE_MODE", "after");
    expect(loadEvidence(collectRepositoryInventory(options.root)).entries[0]?.observations).toMatchObject({ state: "stale", issues: ["environmentHash changed"] });
    expect(collectCompositeScoreReport(options.root).metrics.find(row => row.id === "coverage.lines")?.state).toBe("stale");
});

it("binds the normalized artifact selector even when the runner and copied inputs are unchanged", async () => {
    const options = fixture();
    const source = readFileSync(join(options.root, "run.test.cjs"), "utf8").replace("writeFileSync('report.json'", "writeFileSync('a.json'");
    writeFileSync(join(options.root, "run.test.cjs"), `${source}\nreport['index.cjs'].s[0] = 0; fs.writeFileSync('b.json', JSON.stringify(report));`);
    const first = await runBehavioralEvidence({ ...options, artifact: "a.json" });
    expect(first.evidence?.observations.coverage[0]?.lines.covered, first.issues.join()).toBe(1);
    const second = await runBehavioralEvidence({ ...options, artifact: "b.json" });
    expect(second.cached).toBe(false);
    expect(second.evidence?.observations.coverage[0]?.lines.covered, second.issues.join()).toBe(0);
    expect(second.evidence?.receipt.runner.workspaceHash).toBe(first.evidence?.receipt.runner.workspaceHash);
    expect(second.evidence?.receipt.runner.artifactSelector).toBe("b.json");
    expect((await runBehavioralEvidence({ ...options, artifact: "./unused/../b.json" })).cached).toBe(true);
});

it("does not reuse local validation after its deadline or later forget a failed save validation", async () => {
    const options = fixture(), first = await runBehavioralEvidence(options);
    if (!first.evidence) throw new Error(first.issues.join());
    const inventory = collectRepositoryInventory(options.root), expired = { deadline: Date.now() - 1 };
    const loaded = loadEvidence(inventory, expired);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]?.observations.state).toBe("inconclusive");
    expect(loaded.entries[0]?.observations.issues.join()).toContain("exceeded time budget");
    const content = readEvidenceArtifact(join(evidenceDirectory(options.root), `${first.evidence.id}.artifact.json`));
    const unverified = saveEvidence(inventory, first.evidence.receipt, content, expired);
    expect(unverified.observations.state).toBe("inconclusive");
    expect(loadEvidence(inventory).entries.find(entry => entry.id === unverified.id)?.observations.state).toBe("inconclusive");
});
