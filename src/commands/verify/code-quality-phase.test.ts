import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodeQualityPhase } from "./code-quality-phase.js";
import { streamAllCqSections } from "./streaming-output.js";
import { runCodeQualityChecksProgressive } from "./tool-results.js";
import { emptyResults } from "./tool-results-types.js";

vi.mock("./tool-results.js", async original => ({
    ...await original<typeof import("./tool-results.js")>(),
    runCodeQualityChecksProgressive: vi.fn(),
}));
vi.mock("./streaming-output.js", () => ({ streamAllCqSections: vi.fn() }));
vi.mock("./verify-summary.js", () => ({ streamUndocumentedEnvVars: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("verify code quality filter audit", () => {
    it.each([false, true])("preserves reported findings and audits suppression only when requested (%s)", async enabled => {
        vi.spyOn(Date, "now").mockReturnValue(1000);
        const cq = emptyResults();
        cq.functionArgCount.push({ check: "function_arg_count", file: "/repo/src/a.ts", line: 1, message: "Too many arguments in this function" });
        vi.mocked(runCodeQualityChecksProgressive).mockImplementation(async (_files, _cwd, progress) => {
            if (enabled) {
                progress?.start("checks");
                progress?.advance("/repo/src/a.ts", 6000);
            }
            return cq;
        });
        const reported: number[] = [];
        vi.mocked(streamAllCqSections).mockImplementation(results => { reported.push(results.functionArgCount.length); });
        const chunks: string[] = [];
        vi.spyOn(process.stderr, "write").mockImplementation(chunk => { chunks.push(String(chunk)); return true; });

        await runCodeQualityPhase({ files: ["/repo/src/a.ts"], cwd: "/repo", skipChecks: new Set(),
            details: false, allFlaggedFiles: new Set(), startedAt: enabled ? -5000 : 1000,
            ...(enabled ? { fpFilter: { minP: 0.99 } } : {}) });

        expect(reported).toEqual([1]);
        expect(cq.functionArgCount).toEqual([]);
        expect(chunks.join("")).toContain("code quality checks completed");
        if (enabled) {
            expect(chunks.join("")).toContain("1 / 1 [heuristic] findings would be suppressed");
            expect(chunks.join("")).toContain("/repo/src/a.ts");
        }
        else expect(chunks.join("")).not.toContain("fp_filter");
    });
});
