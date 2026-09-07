import { describe, expect, it } from "vitest";
import { findDeadCodeCandidates, type SurvivorLike } from "./dead-code-signal.js";

describe("survivor location precision", () => {
    it("does not combine separate conditions on one line", () => {
        const pair: SurvivorLike[] = [
            { id: "1", line: 1, column: 2, endLine: 1, endColumn: 4, mutatorName: "ConditionalExpression", replacement: "true" },
            { id: "2", line: 1, column: 8, endLine: 1, endColumn: 10, mutatorName: "ConditionalExpression", replacement: "false" },
        ];
        expect(findDeadCodeCandidates(pair)).toEqual([]);
    });
    it("does not infer an exact site from line-only legacy reports", () => {
        expect(findDeadCodeCandidates([
            { id: "1", line: 1, mutatorName: "ConditionalExpression", replacement: "true" },
            { id: "2", line: 1, mutatorName: "ConditionalExpression", replacement: "false" },
        ])).toEqual([]);
    });
    it("treats an observable function with weak assertions as a review candidate", () => {
        const answer = (condition: boolean) => condition ? 1 : 2;
        expect(answer(true)).not.toBe(answer(false));
        const candidates = findDeadCodeCandidates([true, false].map((value, id) => ({ id: String(id), line: 1, column: 0, endLine: 1, endColumn: 1,
            mutatorName: "ConditionalExpression", replacement: String(value) })));
        expect(candidates[0]?.reason).toContain("missing assertions/inputs");
        expect(candidates[0]?.reason).not.toContain("No test can kill");
    });
});
