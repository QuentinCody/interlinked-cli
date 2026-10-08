import { describe, expect, it } from "vitest";
import { testLegitimacyCases } from "./__fixtures__/test-legitimacy-cases.js";
import { checkTestLegitimacy } from "./test-legitimacy.js";

describe("test legitimacy behavioral examples", () => {
    // test-contract: public-api — review real test code, ignore fixture text, and require a standalone specific receipt for each mutation-directed case.
    it.each(testLegitimacyCases)("$name", ({ content, path, lines }) => {
        const findings = checkTestLegitimacy(content, path);
        expect(findings.map((finding) => finding.line)).toEqual(lines);
    });
});
