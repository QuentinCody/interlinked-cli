import { describe, expect, it, vi } from "vitest";
import { STRIP_PARSER_ENV, stripWithTypeScript } from "./shared-text-utils-ast.js";

describe("stripWithTypeScript — the shared stripper's contract, decided by the parser", () => {
    // test-contract: invariant — comments become spaces (newlines kept), string and template TEXT is removed with the delimiters kept, `${…}` expressions stay (their own strings stripped), regex literals stay intact, and the line count never changes (H2, 2026-10-02)
    it.each([
        ['const a = "x{y}"; // c {', 'const a = "";       '],
        ['const t = `a${b + "}"}c`; /* {x} */ f();', 'const t = `${b + ""}`;           f();'],
        ["const r = /[{}]/g; if (x) { y(); }", "const r = /[{}]/g; if (x) { y(); }"],
        ["const q = 'it\\'s';", "const q = '';"],
    ])("%s", (source, expected) => {
        expect(stripWithTypeScript(source, { strings: true })).toBe(expected);
    });

    // test-contract: bug — the line scanner treated `#` as a comment (a private field blanked the rest of its line, braces included) and `"/*"` inside a string as a block-comment opener (everything after it vanished); the parser reads both as code (H2 audit, 2026-10-02)
    it("keeps code after a private field and after a string holding a comment opener", () => {
        expect(stripWithTypeScript("class K { #p = 1; m() { return this.#p; } }", { strings: true })).toBe("class K { #p = 1; m() { return this.#p; } }");
        expect(stripWithTypeScript('const s = "/*"; const z = 1; // after', { strings: true })).toBe('const s = ""; const z = 1;         ');
    });

    it("preserves the line count of multi-line templates and block comments", () => {
        const source = "const t = `line1\nline2`;\n/* a\nb */\nend();";
        const stripped = stripWithTypeScript(source, { strings: true });
        expect(stripped?.split("\n")).toHaveLength(source.split("\n").length);
        expect(stripped).toBe("const t = `\n`;\n    \n    \nend();");
    });

    it("strips only comments when strings are kept", () => {
        expect(stripWithTypeScript('const a = "x"; // c', { strings: false })).toBe('const a = "x";     ');
    });

    it("parses JSX when plain TypeScript would not", () => {
        expect(stripWithTypeScript('const v = <p title="t">it\'s</p>; // c', { strings: true })).toBe("const v = <p title=\"\">it's</p>;     ");
    });
});

describe("stripWithTypeScript — negative (must not fire): input the parser cannot read falls back", () => {
    it.each(["def f(x):\n    return x  # python", "const a = (", "x = 'unterminated"])("returns null for %s", (source) => {
        expect(stripWithTypeScript(source, { strings: true })).toBeNull();
    });

    it("returns null when the operator turns the parser route off", () => {
        vi.stubEnv(STRIP_PARSER_ENV, "0");
        try {
            expect(stripWithTypeScript("const off = 1; // c", { strings: true })).toBeNull();
        } finally {
            vi.unstubAllEnvs();
        }
        expect(stripWithTypeScript("const off = 1; // c", { strings: true })).toBe("const off = 1;     ");
    });

    // test-contract: bug — 4,000 nested `f(` calls overflowed the parser's recursion and threw RangeError out of every inline check (assert-side-effects N11, 2026-10-02); deep nesting now falls back to the iterative line scanner
    it("returns null when nesting exhausts the parser's stack", () => {
        const deep = `${"f(".repeat(20_000)}${")".repeat(20_000)};`;
        expect(stripWithTypeScript(deep, { strings: true })).toBeNull();
    });});
