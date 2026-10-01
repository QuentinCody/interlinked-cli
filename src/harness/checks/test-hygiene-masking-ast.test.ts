import { describe, expect, it } from "vitest";
import { astComplexityAvailable } from "./cyclomatic-ast.js";
import { maskWithTypeScript } from "./test-hygiene-masking-ast.js";

const blank = (text: string): string => text.replace(/[^\n]/g, " ");

describe("maskWithTypeScript — positive (must fire): literals and comments are blanked by the parser's tokens", () => {
    // test-contract: invariant — the TypeScript parser decides what is a comment, string, template, regex or JSX text; a quote inside a regex, a division after any operand form, a control-statement paren or a comment between keywords never changes what code stays visible (review 2026-09-30, round 6)
    it("P1: blanks a regex literal containing a quote and keeps the import after it", () => {
        const source = 'function pattern() { return /"/; }\nimport { x } from "./private/parser";';
        expect(maskWithTypeScript(source, "a.test.ts")).toBe(`function pattern() { return ${blank('/"/')}; }\nimport { x } from ${blank('"./private/parser"')};`);
    });
    it("P2: blanks strings, templates with substitutions, block and line comments, and a trailing EOF comment", () => {
        const source = 'const a = "x"; /* c1 */ const b = `p${a}q`; // c2\nconst c = 1; /* c3 */';
        expect(maskWithTypeScript(source, "a.test.ts")).toBe(`const a = ${blank('"x"')}; ${blank("/* c1 */")} const b = ${blank("`p${")}a${blank("}q`")}; ${blank("// c2")}\nconst c = 1; ${blank("/* c3 */")}`);
    });
    it("P3: blanks JSX text and leaves the assertion after a closing tag visible", () => {
        const source = "const view = <div>{value}</div>; expect(view).toBeTruthy();";
        expect(maskWithTypeScript(source, "a.test.tsx")).toBe(source);
        const text = "const view = <p>hello</p>;";
        expect(maskWithTypeScript(text, "a.test.tsx")).toBe(`const view = <p>${blank("hello")}</p>;`);
    });
});

describe("maskWithTypeScript — negative (must not fire): division and code stay untouched", () => {
    it("N1: a slash after a non-null assertion, a unicode identifier, `of`, a postfix operator or a completed literal is division", () => {
        const source = 'const half = count! / 2; const r = π / 2; const s = of / 2; const t = count++ / 2; const u = "ab".length / 2; expect(half).toBeTruthy();';
        expect(maskWithTypeScript(source, "a.test.ts")).toBe(source.replace('"ab"', blank('"ab"')));
    });
    it("N2: a regex after a control-statement paren or after a comment-separated keyword is a literal, not division", () => {
        const control = 'if (ready) /"/.test(text);\nimport { x } from "./private/parser";';
        expect(maskWithTypeScript(control, "a.test.ts")).toBe(`if (ready) ${blank('/"/')}.test(text);\nimport { x } from ${blank('"./private/parser"')};`);
        const separated = 'function f() { return/*comment*/typeof /"/; }\nimport { x } from "./private/parser";';
        expect(maskWithTypeScript(separated, "a.test.ts")).toBe(`function f() { return${blank("/*comment*/")}typeof ${blank('/"/')}; }\nimport { x } from ${blank('"./private/parser"')};`);
    });
    it("N3: the parser is available in this checkout, so the AST route is the one in use", () => {
        expect(astComplexityAvailable()).toBe(true);
        expect(maskWithTypeScript("const a = 1;", "a.test.ts")).toBe("const a = 1;");
    });
});
