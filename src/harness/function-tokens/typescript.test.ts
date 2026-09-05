import { describe, expect, it } from "vitest";
import { computeTypeScriptFunctionTokens } from "./typescript.js";

function entries(source: string, file = "src/example.ts") {
    const result = computeTypeScriptFunctionTokens(source, file);
    expect(result).not.toBeNull();
    return result ?? [];
}

describe("interlinked-ts-ast-v1 TypeScript adapter", () => {
    it("extracts implementation functions and excludes declarations", () => {
        const result = entries(`
            declare function absent(value: string): void;
            function present(value: string): string { return value; }
            const callback = (value: number) => value + 1;
        `);
        expect(result.map((entry) => entry.name)).toEqual(["present", "callback"]);
        expect(result.map((entry) => entry.declarationKind)).toEqual(["function", "lambda"]);
    });

    it("counts lexical tokens, not whitespace, comments, or identifier subwords", () => {
        const compact = entries("function longCamelCaseName(){return 'many words in one literal';}")[0];
        const spaced = entries(`
            // outside
            function longCamelCaseName ( ) {
                /* inside */ return 'many words in one literal' ;
            }
        `)[0];
        expect(compact?.canonicalTokens).toBe(spaced?.canonicalTokens);
        expect(compact?.canonicalTokens).toBe(9);
    });

    it("includes attached decorators but not documentation in the canonical span", () => {
        const source = `class Service {
            /** documentation */
            @memoize
            get value(): string { return "ok"; }
        }`;
        const entry = entries(source)[0];
        expect(entry?.declarationKind).toBe("getter");
        expect(entry?.startOffset).toBe(source.indexOf("@memoize"));
        expect(entry?.qualifiedName).toBe("Service.value");
    });

    it("counts a nested implementation in both its own and its outer source span", () => {
        const result = entries(`
            function outer() {
                const inner = () => 1;
                return inner();
            }
        `);
        expect(result.map((entry) => entry.qualifiedName)).toEqual(["outer", "outer.inner"]);
        expect(result[0]?.canonicalTokens).toBeGreaterThan(result[1]?.canonicalTokens ?? 0);
    });

    it("uses UTF-16 half-open offsets and parses JSX with the JSX scanner variant", () => {
        const source = "const emoji = '😀';\nexport function View(){ return <div>hello</div>; }";
        const entry = entries(source, "src/view.tsx")[0];
        expect(source.slice(entry?.startOffset, entry?.endOffset)).toContain("function View");
        expect(entry?.canonicalTokens).toBeGreaterThan(5);
    });
});
