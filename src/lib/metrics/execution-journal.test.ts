import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { coverageExecutionReach, recordCoverageExecution } from "../../harness/coverage-execution.js";
import { readMeasurementExecutions } from "./execution-journal.js";
import { runBehavioralEvidence } from "./evidence-run.js";
import { hashBytes } from "./inventory.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "metrics-execution-")); roots.push(root); writeFileSync(join(root, "a.ts"), "export const a = 1;"); return root; }
it("reports a proposed coverage measurement as stale until its source actually lands", () => {
    const root = fixture(), proposed = "export const a = 2;", ctx = { projectRoot: root, relPath: "a.ts", proposed, language: "ts" as const, editedLines: new Set([1]), budgetMs: 1000 };
    recordCoverageExecution(ctx, { hook_event: "PreToolUse", session_id: "fixture", agent_source: "codex", timestamp: "2026-07-02T00:00:00Z" }, { ok: true, testsPassed: true, suiteMs: 25,
        perFile: new Map([["a.ts", { filePath: "a.ts", mtime: 0, functions: [] }]]) }, 1_783_000_000_000);
    expect(coverageExecutionReach(root, ["a.ts"]).measured).toBe(0);
    writeFileSync(join(root, "a.ts"), proposed);
    expect(coverageExecutionReach(root, ["a.ts"])).toMatchObject({ measured: 1, stale: 0, attempts: 1, p95Ms: 25 });
    writeFileSync(join(root, "a.test.ts"), "// changed test input");
    expect(coverageExecutionReach(root, ["a.ts"]).measured).toBe(0);
});
it("does not resume an older pass after a newer cancelled attempt with identical inputs", async () => {
    const root = fixture();
    const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 19 } };
    const report = { "a.ts": { statementMap: { 0: location }, s: { 0: 1 }, fnMap: {}, f: {}, branchMap: {}, b: {} } };
    const options = { root, kind: "coverage" as const, artifact: "report.json", timeoutMs: 10000, resume: true,
        runner: { argv: [process.execPath, "-e", `require('node:fs').writeFileSync('report.json', ${JSON.stringify(JSON.stringify(report))})`], version: process.version, operatorPolicy: "fixture", environmentHash: hashBytes("fixture") } };
    expect((await runBehavioralEvidence(options)).evidence?.observations.state).toBe("measured");
    const controller = new AbortController(); controller.abort();
    expect((await runBehavioralEvidence({ ...options, resume: false, signal: controller.signal })).outcome).toBe("cancelled");
    expect(readMeasurementExecutions(root).entries.at(-1)?.testsPassed).toBeNull();
    expect((await runBehavioralEvidence(options)).cached).toBe(false);
});
