import { describe, expect, it } from "vitest";
import { checkSummaryFileCoverage } from "./summary-file-coverage.js";

// Historical Stop 2026-10-27; B5 bounded collection offsets 301546678,
// 301554469, 301590661, 301607318; Stop offset 500239871.
// These tests pin literal file mention coverage, not summary truth/usefulness.
const message = "Confirmed—you restarted it. The new VS Code extension host is at 0% CPU.\n\n- Stopped the four-day-old Vitest runner and worker.\n- Fixed Gitleaks retry loops and capped scans at two cores.\n- Rebuilt and restarted the harness.\n- Preserved pending verification evidence and updated the relevant skills.\n\nLatest sample: **68.5% CPU idle**, about **8 GB RAM unused**, and no Gitleaks process.\n\nValidation: **407 tests passed**, TypeScript checks passed, build passed.";
const touched = [
    "src/harness/hook-coverage-verification.ts",
    "src/harness/check-engine/tool-runners/generic.ts",
    "src/harness/hook-coverage-verification.test.ts",
    "src/harness/check-engine/tool-runners/generic.integration.test.ts"
];
const base = { root: "/repo", session: "01a17ef2-88da-7cd3-aae1-ea4428f6b380", complete: true, basis: "touched-files" as const };
describe("historical B5 omission regressions", () => {
    it.each(touched)("MUST-FIRE: historical final message omits %s", file => {
        expect(checkSummaryFileCoverage({ ...base, message, diffPaths: [file] })).toEqual([
            expect.objectContaining({ check: "summary_file_coverage", file, line: 1, message: expect.stringContaining("does not name") }),
        ]);
    });
    it("preserves all four observations from the same Stop", () => {
        expect(checkSummaryFileCoverage({ ...base, message, diffPaths: touched }).map(f => f.file)).toEqual(touched);
    });
    it("MUST-NOT-FIRE: actual mentions cover each target, and fenced example paths add no claim", () => {
        const corrected = message + "\n" + touched.join("\n") + "\n```text\nsrc/untouched-example.ts\n```";
        expect(checkSummaryFileCoverage({ ...base, message: corrected, diffPaths: touched })).toEqual([]);
    });
    it("fenced examples alone do not establish that the touched files were named", () => {
        const example = message + "\n```text\n" + touched.join("\n") + "\n```";
        expect(checkSummaryFileCoverage({ ...base, message: example, diffPaths: touched }).map(f => f.file)).toEqual(touched);
    });
    it("MUST-NOT-FIRE: missing capture never manufactures omissions", () => {
        expect(checkSummaryFileCoverage({ ...base, complete: false, message, diffPaths: touched })).toEqual([]);
    });
});
