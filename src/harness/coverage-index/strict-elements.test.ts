import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { elementsToCoverage, strictElements } from "./strict-elements.js";

describe("strictElements — open-ended statement ends", () => {
    // test-contract: invariant — the V8→istanbul converter writes an open-ended statement end as `end.column: null` (most statements in a real report); the strict parser keeps that boundary as end-of-line instead of refusing the whole report, while a null end LINE is still malformed
    it("accepts a null end column as end-of-line and still rejects a null end line", () => {
        // The parser resolves report keys to real files, so the fixture is a real tree.
        const root = realpathSync(mkdtempSync(join(tmpdir(), "strict-elements-")));
        try {
            mkdirSync(join(root, "src"));
            const file = join(root, "src", "a.ts");
            writeFileSync(file, "export const a = 1;\nexport const b = 2;\n");
            const entry = { path: file, statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 2, column: null } } }, s: { 0: 3 }, fnMap: {}, f: {}, branchMap: {}, b: {} };
            const files = strictElements({ [file]: entry }, root);
            expect([...files.get("src/a.ts")?.statements ?? []]).toEqual([[`[2,0,2,${Number.MAX_SAFE_INTEGER}]`, 3]]);
            expect(files.get("src/a.ts")?.lines.get(2)).toBe(3);
            const malformed = { [file]: { ...entry, statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: null, column: 4 } } } } };
            expect(() => strictElements(malformed, root)).toThrow();
            // The converter's subtraction-derived implicit-else count can be negative ([23, -13] in this repo's report):
            // no evidence of execution, read as 0 hits — a non-integer count is still malformed.
            const branch = { loc: { start: { line: 1, column: 0 }, end: { line: 1, column: null } }, type: "if", locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: null } }, { start: {}, end: {} }], line: 1 };
            const negative = { [file]: { ...entry, branchMap: { 0: branch }, b: { 0: [23, -13] } } };
            expect([...strictElements(negative, root).get("src/a.ts")?.branches.values() ?? []]).toEqual([23, 0]);
            expect(() => strictElements({ [file]: { ...entry, branchMap: { 0: branch }, b: { 0: [23, 1.5] } } }, root)).toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
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

    // test-contract: invariant — a statement whose end is open-ended (converter `column: null`, kept as MAX_SAFE_INTEGER) on the function's LAST line is still the function's statement; the function's own end is a finite source column, and comparing the two dropped every terminal statement (review 2026-09-30)
    it("counts an open-ended terminal statement inside the function that ends on the same line", () => {
        const files = elements("[2,5,4,10]", new Map([["[2,5,3,0]", 1], [`[4,0,4,${Number.MAX_SAFE_INTEGER}]`, 0]]));
        expect(elementsToCoverage(files).get("src/a.ts")?.functions).toEqual([{ name: "function@2:5", line: 2, endLine: 4, hits: 1, statement_pct: 50 }]);
        // Past the function's last line it is not contained, open-ended or not.
        const after = elements("[2,5,4,10]", new Map([["[2,5,3,0]", 1], [`[5,0,5,${Number.MAX_SAFE_INTEGER}]`, 0]]));
        expect(elementsToCoverage(after).get("src/a.ts")?.functions[0]?.statement_pct).toBe(100);
        // An open-ended statement that STARTS after the closing column on the last line belongs to what follows.
        const beside = elements("[2,5,4,10]", new Map([["[2,5,3,0]", 1], [`[4,11,4,${Number.MAX_SAFE_INTEGER}]`, 0]]));
        expect(elementsToCoverage(beside).get("src/a.ts")?.functions[0]?.statement_pct).toBe(100);
    });

    it.each(["{}", "[2,5,4]", '["2",5,4,10]', "[2,5,1,10]", "[2,-1,4,10]"])("rejects malformed function span %s", (key) => {
        expect(() => elementsToCoverage(elements(key))).toThrow();
    });

    it("rejects malformed statement spans before reporting coverage", () => {
        expect(() => elementsToCoverage(elements("[2,5,4,10]", new Map([["[2,5,null,10]", 1]])))).toThrow();
    });
});
