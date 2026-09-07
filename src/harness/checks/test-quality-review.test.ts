import { describe, expect, it, vi } from "vitest";
import * as parser from "./cyclomatic-ast.js";
import { checkDuplicateTestBody } from "./test-duplicate-body.js";
import { checkMockReturnEcho } from "./test-mock-return-echo.js";
import { checkTautologicalAssertion } from "../taste-checks-test-assertions.js";

describe("existing tautology coverage — positive (must fire)", () => {
    it("already reports identical numeric literals", () => {
        expect(checkTautologicalAssertion("expect(1).toBe(1);", "widget.test.ts")).toEqual([
            { line: 1, text: "expect(1).toBe(1);" },
        ]);
    });
});

describe("test-quality review — negative (must not fire)", () => {
    it("does not compare setup when optional TypeScript is unavailable", () => {
        const unavailable = vi.spyOn(parser, "parseTsSource").mockReturnValue(null);
        try {
            const source = 'it("one", () => { expect(parse(value).valid).toBe(true); }); it("two", () => { expect(parse(value).valid).toBe(true); });';
            expect(checkDuplicateTestBody(source, "widget.test.ts")).toEqual([]);
        } finally {
            unavailable.mockRestore();
        }
    });

    it("does not compare duplicate bodies inside skipped suites", () => {
        const source = 'describe.skip("off", () => { it("one", () => { expect(parse(value).valid).toBe(true); }); it("two", () => { expect(parse(value).valid).toBe(true); }); });';
        expect(checkDuplicateTestBody(source, "widget.test.ts")).toEqual([]);
    });
    it("does not attribute a coarse result to an unrelated setup mock", () => {
        const source = `describe("clean", () => {
            beforeEach(() => { isRepo.mockReturnValue(true); read.mockReturnValue("dirty"); });
            it("cleans", () => { const result = clean(); expect(result.clean).toBe(true); });
        });`;
        expect(checkMockReturnEcho(source, "widget.test.ts")).toEqual([]);
    });

    it("counts a mock without a configured literal in the coarse ambiguity rule", () => {
        const source = `it("cleans", () => {
            const notify = vi.fn(); isRepo.mockReturnValue(true);
            const result = clean(notify); expect(result.clean).toBe(true);
        });`;
        expect(checkMockReturnEcho(source, "widget.test.ts")).toEqual([]);
    });

    it("treats a negated assertion as discrimination instead of an echo", () => {
        const source = `it("transforms", () => {
            dep.mockReturnValue("input"); const result = sut(dep);
            expect(result).not.toBe("input");
        });`;
        expect(checkMockReturnEcho(source, "widget.test.ts")).toEqual([]);
    });

    it("does not ignore a throwing contract beside an echoed return value", () => {
        const source = `it("validates", () => {
            dep.mockReturnValue("input"); const result = sut(dep);
            expect(result).toBe("input"); expect(() => sut(null)).toThrow("invalid");
        });`;
        expect(checkMockReturnEcho(source, "widget.test.ts")).toEqual([]);
    });

    it("does not treat a quoted object key as a returned literal", () => {
        const source = `it("computes", () => {
            dep.mockReturnValue({ "computed": "input" }); const result = sut(dep);
            expect(result).toBe("computed");
        });`;
        expect(checkMockReturnEcho(source, "widget.test.ts")).toEqual([]);
    });

    it("preserves whitespace inside setup literals when comparing fixtures", () => {
        const source = `describe("one", () => {
            const fixture = "a b";
            it("first", () => { expect(parse(fixture).valid).toBe(true); });
        });
        describe("two", () => {
            const fixture = "a  b";
            it("second", () => { expect(parse(fixture).valid).toBe(true); });
        });`;
        expect(checkDuplicateTestBody(source, "widget.test.ts")).toEqual([]);
    });

    it("includes setup hooks declared after the tests", () => {
        const source = `describe("one", () => {
            it("first", () => { expect(parse(fixture).valid).toBe(true); });
            beforeEach(() => { fixture = "first"; });
        });
        describe("two", () => {
            it("second", () => { expect(parse(fixture).valid).toBe(true); });
            beforeEach(() => { fixture = "second"; });
        });`;
        expect(checkDuplicateTestBody(source, "widget.test.ts")).toEqual([]);
    });
});
