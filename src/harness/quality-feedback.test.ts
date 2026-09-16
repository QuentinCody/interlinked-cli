import { expect, it } from "vitest";
import { novelQualityFeedback } from "./quality-feedback.js";

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
