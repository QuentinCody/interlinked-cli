// Branch coverage for `checkDuplicateTestNames`: a call whose span cannot be resolved, and describe ranges that share
// one body start. Both go through the public check only.
import { describe, expect, it } from "vitest";
import { checkDuplicateTestNames } from "./test-hygiene-quality.js";

describe("checkDuplicateTestNames — unresolved call spans and shared describe bodies", () => {
    // test-contract: boundary — a test call that never closes has no body to compare, so a same-named pair is reported as a naming collision, never as an equivalent duplicate
    it("reports a reused name as a collision when the second call never closes", () => {
        const source = ['it("dup", () => {', "  expect(1).toBe(1);", "});", 'it("dup", () => {', "  expect(2)", ""].join("\n");
        const findings = checkDuplicateTestNames(source, "sample.test.ts");
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(4);
        expect(findings[0]?.text).toContain("the case bodies differ");
    });

    // test-contract: invariant — two describe intros that open the same body brace describe one scope, so a reused name inside it is still reported once
    it("keeps one scope when two describe calls share the same body brace", () => {
        const source = [
            'describe("outer", describe("inner", () => {',
            '  it("dup", () => { expect(1).toBe(1); });',
            '  it("dup", () => { expect(2).toBe(2); });',
            "}));",
            "",
        ].join("\n");
        const findings = checkDuplicateTestNames(source, "sample.test.ts");
        expect(findings.map((finding) => finding.line)).toEqual([3]);
        expect(findings[0]?.text).toContain('test name "dup" reused on line 2');
    });
});
