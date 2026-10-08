import { expect, it } from "vitest";
import { bcaFunctions } from "./bca.js";

it("keeps raw per-function values separate from other implementations", () => {
    const report = {
        name: "a.ts",
        kind: "unit",
        start_line: 1,
        end_line: 10,
        spaces: [
            {
                name: "f",
                kind: "function",
                start_line: 2,
                end_line: 8,
                metrics: { cyclomatic: { sum: 3 }, loc: { sloc: 7 } },
                spaces: [],
            },
        ],
    };
    expect(bcaFunctions(report)).toEqual([
        {
            name: "f",
            startLine: 2,
            endLine: 8,
            metrics: { cyclomatic: { sum: 3 }, loc: { sloc: 7 } },
        },
    ]);
    expect(() =>
        bcaFunctions({ ...report, spaces: [{ kind: "function", start_line: "2" }] }),
    ).toThrow();
});
