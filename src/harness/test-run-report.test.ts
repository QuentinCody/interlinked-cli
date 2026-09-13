import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { testReportIssue } from "./test-run-report.js";
import type { TestPlan } from "./test-plan.js";

it("refuses a runner that passed while omitting the requested test", () => {
    const root = mkdtempSync(join(tmpdir(), "test-report-")), report = join(root, "report.json");
    const plan: TestPlan = { version: 1, snapshot: "s", changedPaths: [], mode: "selected", tests: [{ path: "a.test.ts", reasons: [], durationMs: null }], omitted: [], reasons: [], reusable: false, estimatedSerialMs: null };
    try {
        writeFileSync(report, JSON.stringify({ success: true, numPassedTests: 1, testResults: [{ name: join(root, "b.test.ts") }] }));
        expect(testReportIssue(root, report, plan)).toBe("Executed test files differ from the plan");
        writeFileSync(report, JSON.stringify({ success: true, numPassedTests: 1, testResults: [{ name: join(root, "a.test.ts") }] }));
        expect(testReportIssue(root, report, plan)).toBeNull();
        writeFileSync(report, JSON.stringify({ success: true, numPassedTests: 0, numTotalTests: 1, testResults: [{ name: join(root, "a.test.ts") }] }));
        expect(testReportIssue(root, report, plan)).toBe("Missing completed nonempty Vitest report");
    } finally { rmSync(root, { recursive: true, force: true }); }
});
