import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { explorationOutcome } from "./evidence-exploration-summary.mts";
it("distinguishes executed success, failure, zero tests, all-skipped tests and missing output", () => {
    const dir = mkdtempSync(join(tmpdir(), "exploration-report-")), file = join(dir, "report.json");
    try {
        expect(explorationOutcome(file).status).toBe("unavailable");
        for (const [success, count, expected] of [[true, 3, "passed"], [false, 3, "failed"], [true, 0, "failed"]] as const) {
            writeFileSync(file, JSON.stringify({ success, numTotalTests: count, numPassedTests: count, numFailedTests: success ? 0 : 1 }));
            expect(explorationOutcome(file).status).toBe(expected);
        }
        writeFileSync(file, JSON.stringify({ success: true, numTotalTests: 3, numPassedTests: 0, numFailedTests: 0 }));
        expect(explorationOutcome(file).status).toBe("failed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
