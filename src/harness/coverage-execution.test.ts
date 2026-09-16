import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readMeasurementExecutions } from "../lib/metrics/execution-journal.js";
import { recordCoverageExecution } from "./coverage-execution.js";
import type { CoverageRunResult } from "./coverage-runner.js";
import type { HarnessEvent } from "./types.js";

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "interlinked-python-evidence-"));
    writeFileSync(join(root, "module.py"), "value = 1\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each([
    { testsPassed: true, complete: true, outcome: "measured" },
    { testsPassed: null, complete: false, outcome: "unavailable" },
    { testsPassed: false, complete: false, outcome: "unavailable" },
] as const)("records test verdict $testsPassed with completeness $complete as $outcome", row => {
    const result: CoverageRunResult = {
        ok: true, suiteMs: 10, testsPassed: row.testsPassed,
        perFile: new Map([["module.py", { filePath: "module.py", mtime: 0, functions: [] }]]),
        testEvidence: {
            status: row.testsPassed === null ? "unavailable" : row.testsPassed ? "passed" : "failed",
            complete: row.complete, collected: 1,
            passed: Number(row.testsPassed === true), failed: Number(row.testsPassed === false),
            skipped: 0, failingTests: [],
        },
    };
    const event: HarnessEvent = {
        hook_event: "PreToolUse", session_id: "python-evidence", agent_source: "codex",
        timestamp: "2026-09-15T12:00:00.000Z", cwd: root,
    };
    recordCoverageExecution({ projectRoot: root, relPath: "module.py", language: "python",
        proposed: "value = 1\n", editedLines: undefined, budgetMs: 1000 }, event, result, 0);
    const journal = readMeasurementExecutions(root);
    expect(journal.issues).toEqual([]);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({ outcome: row.outcome, testsPassed: row.testsPassed });
});
