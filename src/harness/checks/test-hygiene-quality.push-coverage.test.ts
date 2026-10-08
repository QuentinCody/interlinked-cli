import { expect, it } from "vitest";
import { checkDuplicateTestNames, checkHappyPathOnlyTest } from "./test-hygiene-quality.js";

it("classifies a truncated duplicate declaration as a collision without claiming equivalent bodies", () => {
    const source = 'it("value", () => run());\nit("value", () => run(';
    expect(checkDuplicateTestNames(source, "value.test.ts")).toEqual([{
        line: 2,
        text: 'test name "value" reused on line 1 in the same describe scope, but the case bodies differ — this is a naming collision, not a duplicate. Rename one of the two titles so the reporter output stays unambiguous.',
    }]);
});

it("does not count a skipped failure case as executed negative evidence", () => {
    const positive = ['it("one", () => expect(run(1)).toBe(1));',
        'it("two", () => expect(run(2)).toBe(2));', 'it("three", () => expect(run(3)).toBe(3));'].join("\n");
    const skipped = '\nit.skip("throws", () => expect(run()).toThrow());';
    expect(checkHappyPathOnlyTest(positive + skipped, "value.test.ts")).toEqual(
        checkHappyPathOnlyTest(positive, "value.test.ts"),
    );
    expect(checkHappyPathOnlyTest(positive, "value.test.ts")).toHaveLength(1);
    expect(checkHappyPathOnlyTest(positive + skipped.replace("it.skip", "it"), "value.test.ts")).toEqual([]);
});
