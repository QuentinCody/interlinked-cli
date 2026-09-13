import { expect, it } from "vitest";
import { formatTestPlan } from "../tests.js";

it("explains selected tests, unknown cost, and conditional reuse without claiming a pass", () => {
    const text = formatTestPlan({ version: 1, snapshot: "abc", changedPaths: ["a.ts"], mode: "selected",
        tests: [{ path: "a.test.ts", reasons: ["Transitive dependency changed: a.ts"], durationMs: null }], omitted: ["b.test.ts"], reasons: [], estimatedSerialMs: null, reusable: true });
    expect(text).toContain("1 test files; 1 omitted; estimated serial time unmeasured");
    expect(text).toContain("eligible after runtime validation");
    expect(text).toContain("a.test.ts: Transitive dependency changed: a.ts");
});
