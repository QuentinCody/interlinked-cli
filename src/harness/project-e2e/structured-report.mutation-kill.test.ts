import { describe, expect, it } from "vitest";
import { parseJUnitXml } from "./structured-report.js";

// Census fault: the `/<!DOCTYPE/i` guard lost its `i` flag and survived the
// companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("parseJUnitXml — entity machinery is refused in any letter case", () => {
    // test-contract: boundary — XML keywords are case-sensitive but a lowercase doctype still carries an internal subset, so the refusal must not depend on the writer's casing
    it("refuses a lowercase <!doctype> declaration with an internal entity subset", () => {
        const xml = `<!doctype testsuite [<!entity x SYSTEM "file:///etc/passwd">]><testsuite name="s"><testcase name="a"/></testsuite>`;
        expect(() => parseJUnitXml(xml)).toThrow(/DOCTYPE/);
    });
    // test-contract: boundary — mixed-case spelling is the same declaration
    it("refuses a mixed-case <!DocType> declaration", () => {
        expect(() => parseJUnitXml(`<!DocType testsuite><testsuite name="s"><testcase name="a"/></testsuite>`)).toThrow(/DOCTYPE/);
    });
});
