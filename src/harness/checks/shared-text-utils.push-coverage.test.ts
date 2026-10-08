import { describe, expect, it } from "vitest";
import { scanLinesStripped, stripCommentsByLine } from "./shared-text-utils.js";

describe("line-scanner fallback comment boundaries", () => {
    it("blanks both Python single-line docstring delimiters without moving following code", () => {
        expect(stripCommentsByLine('"""doc"""; run()\n\'\'\'doc\'\'\'; run()')).toBe(
            "         ; run()\n         ; run()",
        );
    });

    it("preserves escaped quotes and comment markers in strings while blanking trailing comments", () => {
        const literal = 'value = "escaped \\" # inside"; ';
        expect(stripCommentsByLine(literal + "# outside")).toBe(literal + "         ");
        expect(stripCommentsByLine('value = "unterminated # inside')).toBe('value = "unterminated # inside');
        expect(stripCommentsByLine('value = "trailing\\')).toBe('value = "trailing\\');
    });

    it("resumes scanning code after a multiline block ends and masks subsequent comments", () => {
        expect(stripCommentsByLine("/* a\ninside\n*/ run(); /* b */ // c")).toBe(
            "    \n      \n   run();" + " ".repeat(13),
        );
    });

    it("caps findings and skips lines missing from either input array", () => {
        expect(scanLinesStripped([" hit ", "hit"], ["hit", "hit"], /hit/, 1)).toEqual([{ line: 1, text: "hit" }]);
        expect(scanLinesStripped(["hit"], [], /hit/, 10)).toEqual([]);
        const original = ["first", "second", "third"];
        delete original[1];
        expect(scanLinesStripped(original, ["miss", "hit", "hit"], /hit/, 10)).toEqual([{ line: 3, text: "third" }]);
    });
});
