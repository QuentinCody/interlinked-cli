import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withVerifyTimings } from "./check-timing.js";
import { runPerFileChecks } from "./file-checks.js";
import { toIssues } from "./file-checks-shared.js";
import { emptyResults } from "./tool-results-types.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

it("forwards detector arguments and defers work once the check budget is exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-budget-")); roots.push(root);
    const detector = vi.fn((text: string, line: number) => [{ text, line }]);
    expect(toIssues("example", "a.ts", detector, "finding", 7)).toEqual([
        { check: "example", file: "a.ts", line: 7, message: "finding" },
    ]);
    detector.mockClear();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const previous = process.exitCode;
    try {
        await withVerifyTimings(root, () => {
            expect(toIssues("example", "a.ts", detector, "deferred", 9)).toEqual([]);
        }, { budgetMs: 0, onFinish: run => {
            expect(run.rows.get("example")).toMatchObject({ calls: 0, skipped: 1, errors: 0 });
        } });
        expect(detector).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(75);
    } finally { process.exitCode = previous; }
});

it("reports strong-typing input as deferred rather than silently clearing an exhausted scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-typing-budget-")); roots.push(root);
    const args = { file: join(root, "input.ts"), content: "const value: any = 1;", cwd: root,
        moduleExportsCache: new Map<string, string[]>(), allEnvRefs: new Map<string, Array<{ file: string; line: number }>>(), piiOpts: {} };
    const complete = emptyResults();
    runPerFileChecks({ ...args, r: complete });
    expect(complete.strongTyping).toHaveLength(1);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const previous = process.exitCode;
    try {
        const deferred = emptyResults();
        await withVerifyTimings(root, () => runPerFileChecks({ ...args, r: deferred }), {
            budgetMs: 0, onFinish: run => {
                expect(run.rows.get("findAnyTypes")).toMatchObject({ calls: 0, skipped: 1 });
            },
        });
        expect(deferred.strongTyping).toEqual([]);
        expect(process.exitCode).toBe(75);
    } finally { process.exitCode = previous; }
});
