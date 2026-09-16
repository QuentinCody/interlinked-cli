import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { parsePythonFunctionCoverage } from "../coverage-python-functions.js";
import { runSuiteAndScan, type CommitGateDeps, type GateContext } from "./commit-gate-suite.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "interlinked-python-commit-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const complexity: FunctionComplexityEntry = { name: "answer", line: 1, endLine: 2, cyclomatic: 1, language: "python" };

async function check(functions: unknown, blockOnCrap = true, analyzer: CommitGateDeps["cyclomaticFor"] = () => () => [complexity]) {
    const cov = { filePath: "answer.py", mtime: 0, functions: [], coveredLines: new Set([1, 2]), uncoveredLines: new Set<number>(),
        pythonFunctions: parsePythonFunctionCoverage(functions) };
    const ctx: GateContext = { projectRoot: root, ledgerRoot: root, sessionId: "python-commit", sources: [{ relPath: "answer.py", language: "python" }],
        suiteLanguages: ["python"], crapThreshold: 30, blockOnTestFailure: true, blockOnCrap, deletedPaths: [], warnings: [] };
    const recordDischarge = vi.fn();
    const deps: CommitGateDeps = {
        runnerFor: () => ({ run: async () => ({ ok: true, testsPassed: true, suiteMs: 1, perFile: new Map([["answer.py", cov]]) }) }),
        gitChangedFiles: () => [], cyclomaticFor: analyzer, clock: () => 0, readFile: () => "def answer():\n    return 42\n", recordDischarge,
    };
    return { decision: await runSuiteAndScan(ctx, deps), recordDischarge };
}

describe("commit obligations require measured Python function coverage", () => {
    it("keeps the obligation open and warns when the reporter lacks native regions", async () => {
        const result = await check(undefined);
        expect(result.decision).toMatchObject({ decision: "allow", warnings: [expect.stringContaining("Python CRAP not measured")] });
        expect(result.recordDischarge).not.toHaveBeenCalled();
    });
    it("discharges after a fully measured green check", async () => {
        const result = await check({ answer: { start_line: 1, executed_lines: [2], missing_lines: [], excluded_lines: [] } });
        expect(result.decision).toBeNull();
        expect(result.recordDischarge).toHaveBeenCalledWith(root, "answer.py", "python-commit", expect.any(String));
    });
    it("does not require CRAP attribution when that check is disabled", async () => {
        const result = await check(undefined, false);
        expect(result.decision).toBeNull();
        expect(result.recordDischarge).toHaveBeenCalledOnce();
    });
    it("retains obligations when the complexity analyzer is unavailable", async () => {
        const result = await check({}, true, () => null);
        expect(result.decision?.warnings?.join(" ")).toContain("no cyclomatic analysis");
        expect(result.recordDischarge).not.toHaveBeenCalled();
    });
});
