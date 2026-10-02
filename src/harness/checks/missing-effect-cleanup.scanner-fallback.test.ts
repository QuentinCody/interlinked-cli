// The line scanner in missing-effect-cleanup.ts is the documented fallback when the optional `typescript` package is
// absent. With the parser installed (always, in this checkout) every call takes the parser route, so nothing else
// exercises the scanner: this file removes the parser route and re-runs the scanner-era suites and the shared
// fixture cases against the fallback, so its behavior stays pinned.
import { describe, expect, it, vi } from "vitest";
import { effectCleanupCases } from "./__fixtures__/effect-cleanup-cases.js";
import { checkMissingEffectCleanup } from "./missing-effect-cleanup.js";

vi.mock("./missing-effect-cleanup-ast.js", () => ({ effectCleanupFindingsAst: () => null }));

// Their describe blocks register here, under the mock above.
await import("./missing-effect-cleanup.test.js");
await import("./missing-effect-cleanup.mutation-kill-w60.test.js");

describe("scanner fallback — a return whose bracket group never closes", () => {
    const effect = (returned: string): string => `useEffect(() => {\n  setInterval(tick, 1);\n  ${returned}`;

    // test-contract: boundary — an unbalanced `<` generic list cannot start an arrow function, so the return reads as JSX/value and no cleanup is recognised
    it("flags an effect whose returned generic list `<T` is never closed", () => {
        expect(checkMissingEffectCleanup(effect("return <T"), "Widget.tsx").map((finding) => finding.line)).toEqual([1]);
    });

    // test-contract: boundary — an unbalanced `(` is neither a method shorthand nor an arrow function, so the return falls through to the value test and the returned identifier counts as a cleanup
    it("accepts an effect that returns an identifier inside an unclosed paren `(a`", () => {
        expect(checkMissingEffectCleanup(effect("return (a"), "Widget.tsx")).toEqual([]);
    });

    // test-contract: boundary — an unbalanced generic list followed by a parameter list cannot be an arrow function, so the return reads as JSX and no cleanup is recognised
    it("flags an effect whose returned generic list is closed but whose parameter list `(a` is not", () => {
        expect(checkMissingEffectCleanup(effect("return <A>(a"), "Widget.tsx").map((finding) => finding.line)).toEqual([1]);
    });

    // test-contract: boundary — a return whose remainder is only a carriage return carries no expression, so it is no cleanup
    it("flags an effect whose bare `return` ends the file on a carriage return", () => {
        expect(checkMissingEffectCleanup(effect("return\r"), "Widget.tsx").map((finding) => finding.line)).toEqual([1]);
    });
});

describe("scanner fallback — the shared fixture cases", () => {
    // test-contract: bug — React disposes a subscription only through the value the effect callback returns (https://react.dev/reference/react/useEffect#parameters); the fallback agrees with the parser on every case not marked parserOnly
    it.each(effectCleanupCases.filter((entry) => !("parserOnly" in entry)))("$name", ({ content, path, lines }) => {
        expect(checkMissingEffectCleanup(content, path).map((finding) => finding.line)).toEqual(lines);
    });
});
