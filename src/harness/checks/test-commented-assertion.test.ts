import { describe, expect, it } from "vitest";
import { checkCommentedOutAssertion as check } from "./test-commented-assertion.js";

describe("commented assertions — positive (must fire)", () => {
    it("reports a line comment at its actual line", () => {
        const code = 'it("claim", () => {\n // expect(result).toBe(3);\n});';
        expect(check(code, "api.test.ts").map((finding) => finding.line)).toEqual([2]);
    });
    it("finds block-comment assertions and async assertions", () => {
        const code = 'test("claim", () => {\n /*\n * expect(result).toEqual([3]);\n */\n // await expect(p).rejects.toThrow("bad");\n});';
        expect(check(code, "api.test.ts").map((finding) => finding.line)).toEqual([3, 5]);
    });
});

describe("commented assertions — negative (must not fire)", () => {
    it.each([
        'it("fixture", () => { const text = "// expect(x).toBe(1)"; });',
        'it("fixture", () => { const text = `\n// expect(x).toBe(1)\n`; });',
        'it("prose", () => {\n // Use expect(x).toBe(1) for the contract.\n});',
        '// expect(x).toBe(1)\nit("real", () => { expect(x).toBe(2); });',
        'describe.skip("off", () => { it("claim", () => {\n // expect(x).toBe(1)\n}); });',
        'it("incomplete", () => {\n // expect(x)\n});',
    ])("ignores non-disabled code: %s", (code) => {
        expect(check(code, "api.test.ts")).toEqual([]);
    });
});
