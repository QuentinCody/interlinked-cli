import { describe, expect, it } from "vitest";
import { elementsToCoverage } from "./strict-elements.js";
import type { CanonicalCoverageElementSet } from "./types.js";

function elements(functionKey: string, statements = new Map<string, number>()): Map<string, CanonicalCoverageElementSet> {
    return new Map([["src/a.ts", { lines: new Map([[2, 1], [3, 0]]), functions: new Map([[functionKey, 1]]), branches: new Map(), statements }]]);
}

describe("elementsToCoverage", () => {
    it("computes function coverage from contained statements, including column boundaries", () => {
        const files = elements("[2,5,4,10]", new Map([
            ["[2,0,2,4]", 0], ["[2,5,3,0]", 1], ["[3,0,4,10]", 0], ["[4,11,4,20]", 0],
        ]));
        const result = elementsToCoverage(files).get("src/a.ts");
        expect(result?.functions).toEqual([{ name: "function@2:5", line: 2, endLine: 4, hits: 1, statement_pct: 50 }]);
        expect(result?.coveredLines).toEqual(new Set([2]));
        expect(result?.uncoveredLines).toEqual(new Set([3]));
    });

    it.each(["{}", "[2,5,4]", '["2",5,4,10]', "[2,5,1,10]", "[2,-1,4,10]"])("rejects malformed function span %s", (key) => {
        expect(() => elementsToCoverage(elements(key))).toThrow();
    });

    it("rejects malformed statement spans before reporting coverage", () => {
        expect(() => elementsToCoverage(elements("[2,5,4,10]", new Map([["[2,5,null,10]", 1]])))).toThrow();
    });
});
