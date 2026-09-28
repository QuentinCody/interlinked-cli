import { describe, expect, it, vi } from "vitest";
import * as parser from "./checks/cyclomatic-ast.js";
import { compareGuardOwnership } from "./guard-ownership.js";

// User examples: adding a log must not silently make an existing return unconditional.
describe("guard ownership", () => {
    const before = "function check() { if (!manifest) return failure(); return success(); }";
    it.each([
        "function check() { if (!manifest) log(); return failure(); return success(); }",
        "function check() { if (!manifest)\n log();\n return failure(); return success(); }",
        "function check() { return failure(); if (!manifest) log(); return success(); }",
    ])("finds guard loss after insertion, replacement or movement", after => {
        expect(compareGuardOwnership(before, after, "check.ts")).toMatchObject({
            status: "measured", matched: 2,
            changes: [{ owner: "check", statement: "return failure ( ) ;", before: [{ condition: "! manifest", branch: "then" }], after: [] }],
        });
    });
    it("treats braces, indentation and comments as ownership-preserving", () => {
        const after = "function check() {\n if (!manifest) { /* explain */ return failure(); }\n return success();\n}";
        expect(compareGuardOwnership(before, after, "check.ts")).toMatchObject({ status: "measured", changes: [] });
    });
    it("finds changes of predicate, branch and nested ownership", () => {
        const before = "function f(){ if(a) { if(b) throw error; } }";
        const after = "function f(){ if(c) {} else { throw error; } }";
        expect(compareGuardOwnership(before, after, "a.ts").changes).toMatchObject([
            { before: [{ condition: "a", branch: "then" }, { condition: "b", branch: "then" }], after: [{ condition: "c", branch: "else" }] },
        ]);
    });
    it("does not guess which duplicate statement or duplicate function moved", () => {
        for (const source of ["function f(){if(a)return 1; return 1;}", "class A { f(){if(a)return 1;} } class B { f(){return 1;} }"]) {
            expect(compareGuardOwnership(source, source.replace("if(a)", ""), "a.ts")).toMatchObject({ status: "partial", changes: [] });
        }
    });
    it("does not transfer an outer guard into a callback's function scope", () => {
        const before = "if(a) { const callback = () => { return 1; }; }";
        const after = "const callback = () => { return 1; };";
        expect(compareGuardOwnership(before, after, "a.ts")).toMatchObject({ status: "measured", changes: [] });
    });
    it("does not warn about untouched ambiguous functions elsewhere in a file", () => {
        const untouched = "run(() => { if (a) return 1; return 1; });\n";
        expect(compareGuardOwnership(untouched + before, untouched + before.replace("failure()", "other()"), "a.ts").unmatched).toBe(1);
        expect(compareGuardOwnership(untouched + before, untouched + before.replace("if (!manifest)", "if (!manifest) /* explain */"), "a.ts").status).toBe("measured");
    });
    it("reports unmatched statements, anonymous scopes and syntax recovery without a clean claim", () => {
        expect(compareGuardOwnership(before, before.replace("failure()", "other()"), "a.ts").status).toBe("partial");
        expect(compareGuardOwnership("run(() => {if(a)return 1;});", "run(() => {return 1;});", "a.ts").status).toBe("partial");
        expect(compareGuardOwnership(before, "function f( {", "a.ts").status).toBe("unavailable");
        expect(compareGuardOwnership(before, before, "a.py").status).toBe("unsupported");
    });
    it("reports an absent optional parser as unavailable", () => {
        const unavailable = vi.spyOn(parser, "parseTsSource").mockReturnValue(null);
        try { expect(compareGuardOwnership(before, before, "a.ts").status).toBe("unavailable"); }
        finally { unavailable.mockRestore(); }
    });
});
