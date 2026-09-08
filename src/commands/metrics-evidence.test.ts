import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { output } from "../lib/output.js";
import { metricsEvidenceRunCommand, type MetricsEvidenceOptions } from "./metrics-evidence.js";
import { evidenceDirectory, loadEvidence } from "../lib/metrics/evidence-store.js";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";

vi.mock("../lib/output.js", async importOriginal => ({ ...await importOriginal<typeof import("../lib/output.js")>(), output: vi.fn() }));
const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
    vi.unstubAllEnvs(); vi.clearAllMocks(); process.exitCode = originalExitCode;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): MetricsEvidenceOptions & { cwd: string } {
    const root = mkdtempSync(join(tmpdir(), "metrics-command-environment-")); roots.push(root);
    writeFileSync(join(root, "index.js"), "export const value = 1;\n");
    const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 23 } };
    const report = { "index.js": { statementMap: { 0: location }, s: { 0: 1 }, branchMap: {}, b: {}, fnMap: {}, f: {} } };
    const script = `const report = ${JSON.stringify(report)}; report['index.js'].s[0] = Number(process.env.INTERLINKED_TEST_COVERAGE_MODE === 'covered'); require('node:fs').writeFileSync('report.json', JSON.stringify(report));`;
    return { cwd: root, kind: "coverage", command: JSON.stringify([process.execPath, "-e", script]), artifact: "report.json", runnerVersion: process.version,
        policy: "environment-regression", timeout: "10000", resume: true, json: true };
}

it("reruns the public evidence command when an inherited feature variable changes", async () => {
    const options = fixture();
    vi.stubEnv("INTERLINKED_TEST_COVERAGE_MODE", "covered");
    vi.stubEnv("INTERLINKED_TEST_PRIVATE_VALUE", "fixture-secret-not-for-receipts");
    await metricsEvidenceRunCommand(options);
    expect(vi.mocked(output).mock.lastCall?.[1]).toMatchObject({ outcome: "passed", cached: false,
        evidence: { observations: { state: "measured", coverage: [{ lines: { covered: 1, total: 1 } }] } } });
    await metricsEvidenceRunCommand(options);
    expect(vi.mocked(output).mock.lastCall?.[1]).toMatchObject({ outcome: "passed", cached: true });
    vi.stubEnv("INTERLINKED_TEST_COVERAGE_MODE", "uncovered");
    await metricsEvidenceRunCommand(options);
    expect(vi.mocked(output).mock.lastCall?.[1]).toMatchObject({ outcome: "passed", cached: false,
        evidence: { observations: { state: "measured", coverage: [{ lines: { covered: 0, total: 1 } }] } } });
    const store = loadEvidence(collectRepositoryInventory(options.cwd));
    expect(store.entries).toHaveLength(2);
    expect(new Set(store.entries.map(entry => entry.receipt.runner.environmentHash)).size).toBe(2);
    expect(JSON.stringify(store.entries)).not.toContain("fixture-secret-not-for-receipts");
    for (const path of readdirSync(evidenceDirectory(options.cwd))) {
        expect(readFileSync(join(evidenceDirectory(options.cwd), path), "utf8")).not.toContain("fixture-secret-not-for-receipts");
    }
    expect(readFileSync(join(options.cwd, ".interlinked/metrics/executions.jsonl"), "utf8")).not.toContain("fixture-secret-not-for-receipts");
});
