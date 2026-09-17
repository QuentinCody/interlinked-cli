import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Coverage backfill: runSuiteAndScan branches not reached by the Python-only
// scenarios above (dedup, degrade wording, ledgerRoot fallbacks, absolute
// paths, unreadable sources). See scratch/CAMPAIGN.md unit C.
// ---------------------------------------------------------------------------

describe("runSuiteAndScan — suite dedup and degrade wording", () => {
    it("dedupes the suite run across languages that share one runner id (js+ts run once)", async () => {
        let runs = 0;
        const ctx: GateContext = {
            projectRoot: root, ledgerRoot: root, sessionId: "s", sources: [],
            suiteLanguages: ["js", "ts"], crapThreshold: 30, blockOnTestFailure: true, blockOnCrap: true,
            deletedPaths: [], warnings: [],
        };
        const deps: CommitGateDeps = {
            runnerFor: () => ({
                id: "vitest",
                run: async () => {
                    runs++;
                    return { ok: true, testsPassed: true, suiteMs: 1, perFile: new Map() };
                },
            }),
            gitChangedFiles: () => [], cyclomaticFor: () => () => [], clock: () => 0, readFile: () => null,
        };
        const decision = await runSuiteAndScan(ctx, deps);
        expect(runs).toBe(1); // the second language's run is skipped — same runner id
        expect(decision).toBeNull();
    });

    it("falls back to a generic degrade message when a failed run carries no error string", async () => {
        const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const ctx: GateContext = {
            projectRoot: root, ledgerRoot: root, sessionId: "s", sources: [],
            suiteLanguages: ["js"], crapThreshold: 30, blockOnTestFailure: true, blockOnCrap: true,
            deletedPaths: [], warnings: [],
        };
        const deps: CommitGateDeps = {
            runnerFor: () => ({ run: async () => ({ ok: false, testsPassed: null, suiteMs: 1, perFile: new Map() }) }),
            gitChangedFiles: () => [], cyclomaticFor: () => () => [], clock: () => 0, readFile: () => null,
        };
        const decision = await runSuiteAndScan(ctx, deps);
        expect(decision).toBeNull(); // loud-degrade is fail-open
        const written = errSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(written).toContain("coverage run failed for js"); // the ?? fallback, not result.error
        errSpy.mockRestore();
    });

    it("treats testEvidence.complete === false as an incomplete measurement even on an already-red run", async () => {
        const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const ctx: GateContext = {
            projectRoot: root, sessionId: "s", sources: [],
            suiteLanguages: ["js"], crapThreshold: 30, blockOnTestFailure: false, blockOnCrap: true,
            deletedPaths: [], warnings: [],
        };
        const deps: CommitGateDeps = {
            runnerFor: () => ({
                run: async () => ({
                    ok: true, testsPassed: false, failingTests: ["x"],
                    testEvidence: { status: "failed", complete: false, collected: 0, passed: 0, failed: 0, skipped: 0, failingTests: ["x"] },
                    suiteMs: 1, perFile: new Map(),
                }),
            }),
            gitChangedFiles: () => [], cyclomaticFor: () => () => [], clock: () => 0, readFile: () => null,
        };
        const decision = await runSuiteAndScan(ctx, deps);
        expect(decision).toBeNull(); // loud-degrade discards the return value
        expect(ctx.warnings.some((w) => /RED/.test(w))).toBe(true); // the block_on_test_failure-off note still landed
        const written = errSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(written).toContain("test execution evidence is incomplete for js");
        errSpy.mockRestore();
    });
});

describe("runSuiteAndScan — ledgerRoot-absent fallbacks (runtimeRoot / cyclomatic cap / red-bar baseline)", () => {
    it("falls back runtimeRoot to projectRoot when ledgerRoot is unset", async () => {
        let capturedRuntimeRoot: string | undefined;
        const ctx: GateContext = {
            projectRoot: root, sessionId: "s", sources: [],
            suiteLanguages: ["js"], crapThreshold: 30, blockOnTestFailure: true, blockOnCrap: true,
            deletedPaths: [], warnings: [],
        };
        const deps: CommitGateDeps = {
            runnerFor: () => ({
                run: async (opts) => {
                    capturedRuntimeRoot = opts.runtimeRoot;
                    return { ok: true, testsPassed: true, suiteMs: 1, perFile: new Map() };
                },
            }),
            gitChangedFiles: () => [], cyclomaticFor: () => () => [], clock: () => 0, readFile: () => null,
        };
        await runSuiteAndScan(ctx, deps);
        expect(capturedRuntimeRoot).toBe(root);
    });

    it("resolves the cyclomatic cap against projectRoot when ledgerRoot is unset (clean pass)", async () => {
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "types.ts"), "export interface T { a: number }\n", "utf-8");
        const ctx: GateContext = {
            projectRoot: root, sessionId: "s", sources: [{ relPath: "types.ts", language: "ts" }],
            suiteLanguages: ["ts"], crapThreshold: 30, blockOnTestFailure: true, blockOnCrap: true,
            deletedPaths: [], warnings: [],
        };
        const deps: CommitGateDeps = {
            runnerFor: () => ({ run: async () => ({ ok: true, testsPassed: true, suiteMs: 1, perFile: new Map() }) }),
            gitChangedFiles: () => [], cyclomaticFor: () => () => [], clock: () => 0,
            readFile: (abs) => {
                try { return readFileSync(abs, "utf-8"); } catch { return null; }
            },
        };
        const decision = await runSuiteAndScan(ctx, deps);
        expect(decision).toBeNull(); // type-only source, no violations
    });

    it("blocks a red suite using projectRoot for the baseline lookup when ledgerRoot is unset", async () => {
        const ctx: GateContext = {
            projectRoot: root, sessionId: "s", sources: [],
            suiteLanguages: ["js"], crapThreshold: 30, blockOnTestFailure: true, blockOnCrap: true,
            deletedPaths: [], warnings: [],
        };
        const deps: CommitGateDeps = {
            runnerFor: () => ({
                run: async () => ({ ok: true, testsPassed: false, failingTests: ["boom"], suiteMs: 1, perFile: new Map() }),
            }),
            gitChangedFiles: () => [], cyclomaticFor: () => () => [], clock: () => 0, readFile: () => null,
        };
        const decision = await runSuiteAndScan(ctx, deps);
        expect(decision?.decision).toBe("block");
        expect(decision?.reason).toMatch(/RED/);
    });
});

describe("runSuiteAndScan — per-source path resolution", () => {
    it("reads an already-absolute changed-source path directly (isAbsolute branch)", async () => {
        mkdirSync(root, { recursive: true });
        const filePath = join(root, "abs.ts");
        writeFileSync(filePath, "export interface T { a: number }\n", "utf-8");
        let readPathSeen: string | undefined;
        const ctx: GateContext = {
            projectRoot: root, sessionId: "s", sources: [{ relPath: filePath, language: "ts" }],
            suiteLanguages: ["ts"], crapThreshold: 30, blockOnTestFailure: true, blockOnCrap: true,
            deletedPaths: [], warnings: [],
        };
        const deps: CommitGateDeps = {
            runnerFor: () => ({ run: async () => ({ ok: true, testsPassed: true, suiteMs: 1, perFile: new Map() }) }),
            gitChangedFiles: () => [], cyclomaticFor: () => () => [], clock: () => 0,
            readFile: (abs) => {
                readPathSeen = abs;
                try { return readFileSync(abs, "utf-8"); } catch { return null; }
            },
        };
        const decision = await runSuiteAndScan(ctx, deps);
        expect(readPathSeen).toBe(filePath); // used as-is, never re-resolved against projectRoot
        expect(decision).toBeNull();
    });

    it("records an unmeasured warning (and does not block) when a changed source cannot be read from disk", async () => {
        const ctx: GateContext = {
            projectRoot: root, sessionId: "s", sources: [{ relPath: "missing.ts", language: "ts" }],
            suiteLanguages: ["ts"], crapThreshold: 30, blockOnTestFailure: true, blockOnCrap: true,
            deletedPaths: [], warnings: [],
        };
        const deps: CommitGateDeps = {
            runnerFor: () => ({ run: async () => ({ ok: true, testsPassed: true, suiteMs: 1, perFile: new Map() }) }),
            gitChangedFiles: () => [], cyclomaticFor: () => () => [], clock: () => 0, readFile: () => null,
        };
        const decision = await runSuiteAndScan(ctx, deps);
        expect(decision?.decision).toBe("allow");
        expect(decision?.warnings?.some((w) => /could not read changed source missing\.ts/.test(w))).toBe(true);
    });
});
