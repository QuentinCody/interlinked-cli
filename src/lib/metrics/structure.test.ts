import { describe, expect, it } from "vitest";
import { measureStructure } from "./structure.js";

describe("model-free AST measurements", () => {
    it("counts code after templates and conserves nested token ownership", () => {
        const source = 'function outer(x: string) { const label = `a${x}b`; const inner = () => x ? 1 : 2; return inner(); }';
        const result = measureStructure(source, "src/example.ts");
        expect(result.state).toBe("measured");
        if (result.state !== "measured") throw new Error(result.reason);
        const [outer, inner] = result.functions;
        expect(outer?.tokens).toBeGreaterThan(inner?.tokens ?? Infinity);
        expect(outer?.tokens).toBe((outer?.exposure ?? 0) + (inner?.exposure ?? 0));
        expect(outer?.cyclomatic).toBe(1);
        expect(inner?.cyclomatic).toBe(2);
        expect(result.functions.reduce((sum, fn) => sum + fn.exposure, 0)).toBe(result.astTokens);
    });

    it("is invariant to comments, whitespace and identifier length", () => {
        const compact = measureStructure("function f(){return /a+b/.test('ab');}", "src/a.ts");
        const spaced = measureStructure("// outside\nfunction longerName ( ) { /* inside */ return /a+b/.test('ab'); }", "src/a.ts");
        if (compact.state !== "measured" || spaced.state !== "measured") throw new Error("Expected parsed source");
        expect(compact.functions[0]?.tokens).toBe(spaced.functions[0]?.tokens);
        expect(compact.functions[0]?.tokens).toBe(14);
    });

    it("excludes JSDoc from token and Halstead measurements while preserving literals", () => {
        const source = 'function f(x: string) { const marker = "/** literal */"; return x + marker; }';
        const documented = '/** @param {string} x Input. @returns {string} Output. */ ' + source;
        const bare = measureStructure(source, "src/a.ts");
        const withDocs = measureStructure(documented, "src/a.ts");
        if (bare.state !== "measured" || withDocs.state !== "measured") throw new Error("Expected parsed source");
        expect(withDocs.astTokens).toBe(bare.astTokens);
        const original = bare.functions[0];
        if (!original) throw new Error("Expected one function");
        const { tokens, exposure, cyclomatic, cognitive, difficulty, volume } = original;
        expect(withDocs.functions[0]).toMatchObject({ tokens, exposure, cyclomatic, cognitive, difficulty, volume });
        expect(bare.astTokens).toBe(19);
    });

    it("reports types as diagnostics without penalizing validated unknown", () => {
        const result = measureStructure("function valid(x: unknown): x is string { return typeof x === 'string'; }", "src/a.ts");
        expect(result.state).toBe("measured");
        if (result.state !== "measured") throw new Error(result.reason);
        expect(result.types).toMatchObject({ explicitAny: 0, unknown: 1 });
    });

    it("refuses parser recovery as a successful measurement", () => {
        expect(measureStructure("function broken( {", "src/broken.ts").state).toBe("unavailable");
    });
});
