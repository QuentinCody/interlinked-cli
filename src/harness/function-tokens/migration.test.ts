import { describe, expect, it } from "vitest";
import { measureStructure } from "../../lib/metrics/structure.js";
import { computeTypeScriptFunctionTokens } from "./typescript.js";

describe("parser-resolved function-token migration", () => {
    it("keeps cached measurements isolated from source edits and caller-owned rows", () => {
        const source = "function f(){return 1;}";
        const first = computeTypeScriptFunctionTokens(source, "cache.ts");
        const row = first?.[0];
        if (!row) throw new Error("Missing fixture function");
        row.canonicalTokens = 0;
        expect(computeTypeScriptFunctionTokens(source, "cache.ts")?.[0]?.canonicalTokens).toBe(9);
        expect(computeTypeScriptFunctionTokens("function f(){return 1+2;}", "cache.ts")?.[0]?.canonicalTokens).toBe(11);
    });
    it.each([
        // Template head/middle/tail each form one token, including their delimiters.
        ["template.ts", "function f(x){ return `a${x + 1}b${x * 2}c`; }", 18],
        ["regex.ts", "function f(x){ return /a[b/c]+/gi.test(x); }", 15],
        ["view.tsx", "function View(){ return <div>hello world</div>; }", 16],
        ["types.ts", "function f(x: Array<Array<number>>): number { return x[0][0]; }", 26],
    ])("counts %s with parser context and agrees with scoring", (file, source, expected) => {
        const gate = computeTypeScriptFunctionTokens(source, file);
        const score = measureStructure(source, file);
        expect(gate?.[0]?.canonicalTokens).toBe(expected);
        expect(score.state).toBe("measured");
        if (score.state === "measured") expect(score.functions[0]?.tokens).toBe(expected);
    });

    it("excludes nested JSDoc and preserves exclusive ownership", () => {
        const source = "function outer(){ /** @param x docs */ function inner(x){return x;} return inner(1); }";
        const gate = computeTypeScriptFunctionTokens(source, "a.ts");
        const score = measureStructure(source, "a.ts");
        expect(gate?.map(row => row.canonicalTokens)).toEqual([22, 10]);
        expect(score.state).toBe("measured");
        if (score.state === "measured") expect(score.functions.map(row => row.exposure)).toEqual([12, 10]);
    });

    it.each(["function f( {", "function f(){ return `unterminated; }", "const view = () => <div>;"])(
        "does not certify a recovered parse: %s", source => {
            expect(computeTypeScriptFunctionTokens(source, "a.tsx")).toBeNull();
        },
    );
});
