import { expect, it } from "vitest";
import { compactQualityResults, novelQualityFeedback } from "./quality-feedback.js";

it("deduplicates line drift, preserves another file, and re-notifies after scoped resolution", () => {
    const session = {};
    const finding = { name: "typescript", severity: "warning" as const, file: "a.ts", message: "type error", detail: "a.ts(12): TS2304: Missing name" };
    expect(novelQualityFeedback(session, "/p", [finding], ["typescript"], "a.ts")).toHaveLength(1);
    expect(novelQualityFeedback(session, "/p", [{ ...finding, detail: "a.ts(22): TS2304: Missing name" }], ["typescript"], "a.ts")).toHaveLength(0);
    expect(novelQualityFeedback(session, "/p", [{ ...finding, file: "b.ts" }], ["typescript"], "b.ts")).toHaveLength(1);
    novelQualityFeedback(session, "/p", [], ["typescript"], "b.ts");
    expect(novelQualityFeedback(session, "/p", [finding], [], "a.ts")).toHaveLength(0);
    novelQualityFeedback(session, "/p", [], ["typescript"], "a.ts");
    expect(novelQualityFeedback(session, "/p", [finding], [], "a.ts")).toHaveLength(1);
});

it("summarizes existing debt without changing its raw diagnostics", () => {
    const finding = { name: "typescript", severity: "warning" as const, novelty: "pre-existing" as const, findingCount: 18, message: "old diagnostics", detail: "full old diagnostic text" };
    const shown = compactQualityResults([finding]);
    expect(shown[0]?.message).toContain("18 pre-existing");
    expect(shown[0]?.detail).toBeUndefined();
    expect(finding.detail).toBe("full old diagnostic text");
});

it("deduplicates unavailable prerequisites across files without suppressing real findings", () => {
    const session = {};
    const deferred = { name: "affected_tests_deferred", severity: "warning" as const, message: "Affected tests not measured", detail: "pytest collected no tests; no behavioral evidence", file: "a.py" };
    expect(novelQualityFeedback(session, "/project", [deferred], [])).toHaveLength(1);
    expect(novelQualityFeedback(session, "/project", [{ ...deferred, file: "b.py" }], [])).toHaveLength(0);
    expect(novelQualityFeedback(session, "/project", [deferred], ["affected_tests"])).toHaveLength(0);
    const failure = { name: "affected_tests", severity: "warning" as const, message: "Tests failed", file: "b.py" };
    expect(novelQualityFeedback(session, "/project", [failure], ["affected_tests"])).toEqual([failure]);
    expect(novelQualityFeedback(session, "/project", [deferred], [])).toHaveLength(1);
    expect(novelQualityFeedback(session, "/other", [deferred], [])).toHaveLength(1);
});
