import { describe, expect, it } from "vitest";
import { reviewExpectationDiff, isOraclePath } from "./review.js";
describe("expectation review", () => {
    it("surfaces expectation replacement in Python and TypeScript as advisory evidence", () => {
        for (const [path, removed, added] of [["test_api.py", "assert output == 'old'", "assert output == 'new'"], ["api.test.ts", "expect(output).toBe('old');", "expect(output).toBe('new');"]]) {
            const result = reviewExpectationDiff(path!, `@@ -3 +3 @@\n-${removed}\n+${added}`);
            expect(result?.kind).toBe("expectations-changed");
            expect(result?.message).toContain("requirement");
        }
    });
    it("does not count unchanged moved assertion text as a replacement", () => {
        expect(reviewExpectationDiff("a.test.ts", "@@ -1 +4 @@\n-expect(x).toBe(2);\n+expect(x).toBe(2);")).toBeNull();
    });
    it("reviews fixtures and collection settings without claiming a regression", () => {
        expect(reviewExpectationDiff("tests/fixtures/case.json", '@@ -1 +1 @@\n-{"a":1}\n+{"a":2}')?.kind).toBe("oracle-input-changed");
        expect(reviewExpectationDiff("pytest.ini", "@@ -1 +1 @@\n-testpaths = tests\n+testpaths = tests/unit")?.message).toContain("collection");
        expect(isOraclePath("src/business.py")).toBe(false);
    });
    it("asks for independently grounded expectations on new test files", () => {
        expect(reviewExpectationDiff("test_new.py", "new file mode 100644\n@@ -0,0 +1 @@\n+assert result == 4")?.kind).toBe("new-expectations");
    });
});
