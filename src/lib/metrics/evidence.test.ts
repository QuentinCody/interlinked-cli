import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseIstanbulEvidence } from "./evidence-coverage.js";
import { parseMutationEvidence } from "./evidence-mutation.js";
import { runEvidenceProcess } from "./evidence-process.js";
import { runBehavioralEvidence, type EvidenceRunOptions } from "./evidence-run.js";
import { evidenceDirectory, loadEvidence, validateEvidence } from "./evidence-store.js";
import { collectRepositoryInventory } from "./inventory.js";
import { collectCompositeScoreReport } from "./composite-report.js";

const roots: string[] = [];
const SOURCE = "module.exports = (x) => x + 1;\n";
const LOCATION = { start: { line: 1, column: 0 }, end: { line: 1, column: 29 } };
function coverage() {
    return { "index.cjs": { statementMap: { 0: LOCATION }, s: { 0: 1 }, branchMap: {}, b: {}, fnMap: { 0: { name: "increment", loc: LOCATION } }, f: { 0: 1 } } };
}
function fixture(): EvidenceRunOptions {
    const root = mkdtempSync(join(tmpdir(), "metrics-evidence-test-")); roots.push(root);
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "index.cjs"), SOURCE);
    writeFileSync(join(root, "tests/run.cjs"), `const assert = require('node:assert/strict'); assert.equal(require('../index.cjs')(1), 2); require('node:fs').writeFileSync('report.json', JSON.stringify(${JSON.stringify(coverage())}));`);
    return { root, kind: "coverage", artifact: "report.json", timeoutMs: 10_000, resume: true,
        runner: { argv: [process.execPath, "tests/run.cjs"], version: process.version, operatorPolicy: "istanbul-v1" } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("behavioral evidence provenance", () => {
    it("does not invalidate a Git repository receipt when its evidence directory is first created", async () => {
        const options = fixture();
        execFileSync("git", ["init", "--quiet"], { cwd: options.root });
        const first = await runBehavioralEvidence(options);
        expect(first.evidence?.observations.state).toBe("measured");
        const stored = loadEvidence(collectRepositoryInventory(options.root));
        expect(stored.entries[0]?.observations.state, stored.issues.join()).toBe("measured");
        expect((await runBehavioralEvidence(options)).cached).toBe(true);
    });
    it("runs a real assertion in an isolated workspace and reuses only matching evidence", async () => {
        const options = fixture(), first = await runBehavioralEvidence(options);
        expect(first.outcome, first.issues.join("; ")).toBe("passed");
        expect(first.evidence?.observations.state).toBe("measured");
        expect(readFileSync(join(options.root, "index.cjs"), "utf8")).toBe(SOURCE);
        const second = await runBehavioralEvidence(options);
        expect(second.cached).toBe(true);
        expect(second.evidence?.id).toBe(first.evidence?.id);
    });
    it("invalidates evidence on a test-only edit", async () => {
        const options = fixture();
        await runBehavioralEvidence(options);
        writeFileSync(join(options.root, "tests/additional.cjs"), "// Additional test input\n");
        const stored = loadEvidence(collectRepositoryInventory(options.root));
        expect(stored.entries[0]?.observations.state, stored.issues.join("; ")).toBe("stale");
        expect(stored.entries[0]?.observations.issues).toContain("testHash changed");
    });
    it("rejects artifact tampering and malformed report counts", async () => {
        const options = fixture(), result = await runBehavioralEvidence(options);
        const evidence = result.evidence;
        if (!evidence) throw new Error(result.issues.join("; "));
        expect(() => validateEvidence(collectRepositoryInventory(options.root), evidence.receipt, "{}")).toThrow("hash mismatch");
        const bad = coverage(); bad["index.cjs"].s[0] = -1;
        expect(() => parseIstanbulEvidence(bad, options.root)).toThrow("nonnegative");
    });
    it("rejects corrupted UTF-8 bytes even when lossy decoding preserves the artifact text", async () => {
        const options = fixture();
        const runner = join(options.root, "tests/run.cjs");
        writeFileSync(runner, readFileSync(runner, "utf8").replace("increment", "increment\uFFFD"));
        const result = await runBehavioralEvidence(options);
        if (!result.evidence) throw new Error(result.issues.join("; "));
        const inventory = collectRepositoryInventory(options.root);
        expect(loadEvidence(inventory).entries[0]?.observations.state).toBe("measured");
        const artifact = join(evidenceDirectory(options.root), `${result.evidence.id}.artifact.json`);
        const original = readFileSync(artifact);
        const offset = original.indexOf(Buffer.from("\uFFFD"));
        expect(offset).toBeGreaterThanOrEqual(0);
        const corrupted = Buffer.concat([original.subarray(0, offset), Buffer.from([0x80]), original.subarray(offset + 3)]);
        expect(corrupted.toString("utf8")).toBe(original.toString("utf8"));
        writeFileSync(artifact, corrupted);
        const stored = loadEvidence(inventory);
        expect(stored.entries).toEqual([]);
        expect(stored.issues.join()).toMatch(/utf-8/i);
    });
    it("invalidates evidence when an excluded fixture changes", async () => {
        const options = fixture();
        mkdirSync(join(options.root, "fixtures"));
        writeFileSync(join(options.root, "fixtures/input.txt"), "first");
        await runBehavioralEvidence(options);
        writeFileSync(join(options.root, "fixtures/input.txt"), "second");
        const stored = loadEvidence(collectRepositoryInventory(options.root));
        expect(stored.entries[0]?.observations.issues).toContain("supportHash changed");
        expect(stored.entries[0]?.observations.state).toBe("stale");
    });
    it("retains survivor and timeout outcomes and requires exact mutant source", () => {
        const options = fixture(), inventory = collectRepositoryInventory(options.root);
        const report = { files: { "index.cjs": { source: SOURCE, mutants: [{ id: "0", status: "Timeout", mutatorName: "ArithmeticOperator", replacement: "x - 1", location: LOCATION }] } } };
        expect(parseMutationEvidence(report, inventory).mutants[0]?.outcome).toBe("timeout");
        report.files["index.cjs"].source = "old source";
        expect(() => parseMutationEvidence(report, inventory)).toThrow("source mismatch");
    });
    it.each(["constructor", "toString", "__proto__"])("rejects inherited mutation status %s before it can remove scoring opportunities", async status => {
        const options = fixture();
        options.kind = "mutation";
        const report = { files: { "index.cjs": { source: SOURCE, mutants: [{ id: "0", status, mutatorName: "ArithmeticOperator", replacement: "x - 1", location: LOCATION }] } } };
        writeFileSync(join(options.root, "tests/run.cjs"), `const assert = require('node:assert/strict'); assert.equal(require('../index.cjs')(1), 2); require('node:fs').writeFileSync('report.json', JSON.stringify(${JSON.stringify(report)}));`);
        const result = await runBehavioralEvidence(options);
        expect(result.outcome).toBe("error");
        expect(result.issues.join()).toContain(`Unsupported mutant status: ${status}`);
        expect(result.evidence).toBeNull();
        expect(loadEvidence(collectRepositoryInventory(options.root)).entries).toEqual([]);
        const readings = collectCompositeScoreReport(options.root).metrics.filter(row => row.id.startsWith("mutation."));
        expect(readings.map(row => row.state)).toEqual(["missing", "missing"]);
    });
    it.each([
        ["absolute", "require('node:path').join(process.cwd(), 'index.cjs')"],
        ["relative", JSON.stringify("./index.cjs")],
    ])("rejects a duplicate %s coverage path before scoring the same source twice", async (_name, alias) => {
        const options = fixture();
        writeFileSync(join(options.root, "tests/run.cjs"), `const assert = require('node:assert/strict'); assert.equal(require('../index.cjs')(1), 2); const report = ${JSON.stringify(coverage())}; report[${alias}] = report['index.cjs']; require('node:fs').writeFileSync('report.json', JSON.stringify(report));`);
        const result = await runBehavioralEvidence(options);
        expect(result.outcome).toBe("error");
        expect(result.issues.join()).toContain("Duplicate coverage source path: index.cjs");
        expect(result.evidence).toBeNull();
        expect(loadEvidence(collectRepositoryInventory(options.root)).entries).toEqual([]);
        const reading = collectCompositeScoreReport(options.root).metrics.find(row => row.id === "coverage.lines");
        expect(reading?.state).toBe("missing");
        expect(reading?.score).toBeNull();
    });
    it("terminates bounded execution and honors pre-cancellation", async () => {
        const options = fixture();
        const timed = await runEvidenceProcess({ cwd: options.root, argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeoutMs: 100 });
        expect(timed.outcome).toBe("timeout");
        const controller = new AbortController(); controller.abort();
        const cancelled = await runEvidenceProcess({ cwd: options.root, argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 100, signal: controller.signal });
        expect(cancelled.outcome).toBe("cancelled");
    });
});
