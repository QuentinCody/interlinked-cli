// `maskCommentsAndStringsHeuristic` is the parser-free fallback of `maskCommentsAndStrings`. Every consumer takes the
// TypeScript-parser route when `typescript` is installed, so this file calls the exported heuristic directly and pins
// its exact output: blanked characters become spaces, newlines stay, and the length never changes.
import { describe, expect, it } from "vitest";
import { maskCommentsAndStringsHeuristic } from "./test-hygiene-masking.js";

/** The expected mask of `text`: every character except a newline becomes a space. */
const blank = (text: string): string => text.replace(/[^\n]/g, " ");

describe("maskCommentsAndStringsHeuristic — comments", () => {
    // test-contract: public-api — a line comment is blanked up to, but not including, its newline
    it("blanks a line comment and keeps the newline and the next line", () => {
        const source = "a // note\nb";
        expect(maskCommentsAndStringsHeuristic(source)).toBe(`a ${blank("// note")}\nb`);
    });

    // test-contract: boundary — a line comment that ends the file has no newline to stop it
    it("blanks a line comment that runs to the end of the content", () => {
        expect(maskCommentsAndStringsHeuristic("a // tail")).toBe(`a ${blank("// tail")}`);
    });

    // test-contract: public-api — a block comment is blanked across lines and its newlines stay
    it("blanks a multi-line block comment and keeps its newlines", () => {
        const source = "a /* x\ny */ b";
        expect(maskCommentsAndStringsHeuristic(source)).toBe(`a ${blank("/* x")}\n${blank("y */")} b`);
    });
});

describe("maskCommentsAndStringsHeuristic — strings", () => {
    // test-contract: public-api — each of the three quote kinds opens and closes its own literal
    it.each([
        ["single", "x = 'ab' + 1", `x = ${blank("'ab'")} + 1`],
        ["double", 'x = "ab" + 1', `x = ${blank('"ab"')} + 1`],
        ["template", "x = `ab` + 1", `x = ${blank("`ab`")} + 1`],
    ])("blanks a %s-quoted string and resumes code after the closing quote", (_kind, source, expected) => {
        expect(maskCommentsAndStringsHeuristic(source)).toBe(expected);
    });

    // test-contract: invariant — a quote of another kind inside a string never closes it
    it("does not close a string on a different quote kind", () => {
        expect(maskCommentsAndStringsHeuristic(`x = 'a"b\`c' + 1`)).toBe(`x = ${blank(`'a"b\`c'`)} + 1`);
    });

    // test-contract: invariant — a template literal keeps the newlines it spans
    it("keeps the newline inside a template literal", () => {
        expect(maskCommentsAndStringsHeuristic("`a\nb`")).toBe("  \n  ");
    });

    // test-contract: boundary — a backslash escapes the quote that follows it, so the string stays open
    it("honours a backslash escape before the closing quote", () => {
        expect(maskCommentsAndStringsHeuristic(`'a\\'b' + 1`)).toBe(`${blank(`'a\\'b'`)} + 1`);
    });

    // test-contract: boundary — a backslash that ends the content has nothing to escape
    it("blanks a trailing backslash at the end of the content", () => {
        expect(maskCommentsAndStringsHeuristic('"a\\')).toBe("   ");
    });

    // test-contract: boundary — a backslash before a newline (a line continuation) keeps the newline
    it("keeps the newline after a backslash line continuation inside a string", () => {
        expect(maskCommentsAndStringsHeuristic('"a\\\nb" + 1')).toBe(`${blank('"a\\')}\n${blank('b"')} + 1`);
    });

    // test-contract: invariant — blanking never changes the length of the content
    it("preserves the length of mixed content", () => {
        const source = "const a = 'x'; // c\n/* d */ `e${1}`;\n";
        expect(maskCommentsAndStringsHeuristic(source)).toHaveLength(source.length);
    });
});

describe("maskCommentsAndStringsHeuristic — regex literals", () => {
    // test-contract: public-api — a `/` where an operand cannot precede it opens a regex that the next `/` closes
    it("blanks a regex literal after an operator", () => {
        expect(maskCommentsAndStringsHeuristic("x = /a/g;")).toBe(`x = ${blank("/a/")}g;`);
    });

    // test-contract: boundary — a quote inside a regex is not a string opener
    it("does not open a string at a quote inside a regex", () => {
        expect(maskCommentsAndStringsHeuristic('x = /"/; y')).toBe(`x = ${blank('/"/')}; y`);
    });

    // test-contract: boundary — a regex literal cannot span lines, so a newline ends it
    it("ends an unterminated regex at the newline", () => {
        expect(maskCommentsAndStringsHeuristic("x = /abc\nfoo")).toBe(`x = ${blank("/abc")}\nfoo`);
    });

    // test-contract: boundary — an escaped newline in a regex does not continue it onto the next line
    it("ends a regex at a backslash-newline and resumes code on the next line", () => {
        expect(maskCommentsAndStringsHeuristic("x = /a\\\nb/")).toBe(`x = ${blank("/a\\")}\nb/`);
    });

    // test-contract: boundary — a backslash that ends the content inside a regex has nothing to escape
    it("blanks a trailing backslash at the end of a regex", () => {
        expect(maskCommentsAndStringsHeuristic("x = /a\\")).toBe(`x = ${blank("/a\\")}`);
    });

    // test-contract: invariant — an escaped slash and a slash inside a character class do not close the regex
    it("keeps an escaped slash and a class slash inside the regex", () => {
        expect(maskCommentsAndStringsHeuristic("x = /a\\/[/]b/g;")).toBe(`x = ${blank("/a\\/[/]b/")}g;`);
    });
});

describe("maskCommentsAndStringsHeuristic — division or regex after a token", () => {
    // test-contract: invariant — after an operand the `/` divides and nothing is blanked
    it.each([
        ["an identifier", "a / b / c"],
        ["a closing bracket", "a[0] / 2 / 3"],
        ["a non-control closing paren", "f(a) / 2 / 3"],
        ["a postfix increment", "i++ / 2 / 3"],
        ["a postfix decrement", "i-- / 2 / 3"],
        ["an unmatched closing paren", "a) / 2 / 3"],
    ])("treats a slash after %s as division", (_name, source) => {
        expect(maskCommentsAndStringsHeuristic(source)).toBe(source);
    });

    // test-contract: invariant — a plus or minus that is not doubled is a binary operator, so a `/` after it opens a regex
    it.each([
        ["a single plus", "a + /x/g", `a + ${blank("/x/")}g`],
        ["a single minus", "a - /x/g", `a - ${blank("/x/")}g`],
        ["a plus then minus", "a +- /x/g", `a +- ${blank("/x/")}g`],
    ])("treats a slash after %s as a regex opener", (_name, source, expected) => {
        expect(maskCommentsAndStringsHeuristic(source)).toBe(expected);
    });

    // test-contract: bug — the `)` of an `if (…)` header is no operand, so a regex follows it (review 2026-09-30)
    it("treats a slash after a control-header paren as a regex opener", () => {
        expect(maskCommentsAndStringsHeuristic("if (a) /x/.test(b)")).toBe(`if (a) ${blank("/x/")}.test(b)`);
    });

    // test-contract: invariant — a keyword operand takes an expression, so its `/` opens a regex
    it("treats a slash after `return` as a regex opener", () => {
        expect(maskCommentsAndStringsHeuristic("return /\"/")).toBe(`return ${blank('/"/')}`);
    });

    // test-contract: invariant — a closed string literal is an operand, so a `/` after it divides
    it("treats a slash after a closed string as division", () => {
        expect(maskCommentsAndStringsHeuristic("'a' / 2 / 3")).toBe(`${blank("'a'")} / 2 / 3`);
    });
});
