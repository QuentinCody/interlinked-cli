import { describe, expect, it } from "vitest";
import { functionLocationKey } from "./function-location.js";

const source = [
    "export function gate(names: string[]): boolean {",
    "\treturn names.some((name) =>",
    "\t\t/^harness(-.+)?\\.sock$/.test(name),",
    "\t);",
    "}",
    "export const render = {",
    "\tjson: () => ({",
    "\t\tok: true,",
    "\t}),",
    "\tnormal: () => gate([]),",
    "};",
    "",
].join("\n");

function entry(decl: [number, number], locStart: [number, number], endLine: number): unknown {
    return { name: "(anonymous)", decl: { start: { line: decl[0], column: decl[1] }, end: { line: decl[0], column: decl[1] + 1 } },
        loc: { start: { line: locStart[0], column: locStart[1] }, end: { line: endLine, column: null } } };
}

describe("functionLocationKey — open-ended ends (positive, must fire)", () => {
    // test-contract: invariant — an open-ended function end is resolved from `loc.start` (istanbul's loc is the body, always inside the function node) even when the converter's source-mapped `decl` for an anonymous function landed on the enclosing call or the property key outside the arrow; the resolved end is the body's real end
    it("P1: anchors on the body when decl fell outside the arrow (enclosing call)", () => {
        // decl at `some` on line 2 (outside the arrow), loc = the expression body on line 3.
        expect(functionLocationKey(entry([2, 14], [3, 2], 3), source, "a.ts")).toBe(JSON.stringify([3, 2, 3, 36]));
    });
    it("P2: anchors on the body when decl is the property key of an arrow member", () => {
        expect(functionLocationKey(entry([7, 1], [7, 13], 9), source, "a.ts")).toBe(JSON.stringify([7, 13, 9, 3]));
        expect(functionLocationKey(entry([10, 1], [10, 15], 10), source, "a.ts")).toBe(JSON.stringify([10, 15, 10, 23]));
    });
    it("P3: still resolves a named declaration from its decl when loc.start is the block", () => {
        expect(functionLocationKey(entry([1, 16], [1, 47], 5), source, "a.ts")).toBe(JSON.stringify([1, 47, 5, 1]));
    });
});

describe("functionLocationKey — open-ended ends (negative, must not fire)", () => {
    it("N1: a body ending on another line than the report says is unresolvable", () => {
        expect(() => functionLocationKey(entry([2, 14], [3, 2], 4), source, "a.ts")).toThrow("Cannot resolve open-ended coverage function");
    });
    it("N2: a closed end needs no parser and keeps its columns", () => {
        const closed = { name: "f", decl: { start: { line: 1, column: 16 }, end: { line: 1, column: 20 } }, loc: { start: { line: 1, column: 47 }, end: { line: 5, column: 1 } } };
        expect(functionLocationKey(closed, "not even typescript {", "a.ts")).toBe(JSON.stringify([1, 47, 5, 1]));
    });
});
