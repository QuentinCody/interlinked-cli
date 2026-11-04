import { describe, expect, it } from "vitest";
import type { FunctionTokenEntry } from "../function-tokens/types.js";
import { buildFunctionEmbeddingInput, normalizeEmbeddingSource } from "./function-input.js";
import { EMBEDDING_MODEL_REGISTRY } from "./model-registry.js";

const manifest = EMBEDDING_MODEL_REGISTRY[0];
if (manifest === undefined) throw new Error("semantic test requires a registry model");

const entry: FunctionTokenEntry = {
    name: "alpha",
    qualifiedName: "Box.alpha",
    declarationKind: "method",
    language: "typescript",
    startOffset: 0,
    endOffset: 48,
    line: 1,
    endLine: 3,
    canonicalTokens: 12,
    identityKind: "named",
};

describe("function embedding input", () => {
    it("normalizes newlines and trailing whitespace without adding location noise", () => {
        const source = "alpha(value: number) {  \r\n  return value + 1;\t\r\n}";
        const input = buildFunctionEmbeddingInput(source, { ...entry, endOffset: source.length }, manifest);
        expect(input.code).toBe("alpha(value: number) {\n  return value + 1;\n}");
        expect(input.text).toContain("symbol: Box.alpha");
        expect(input.text).toContain("documentation:\n\ncode:\n");
        expect(input.text).not.toContain(process.cwd());
        expect(input.inputHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("makes CRLF and LF inputs canonical", () => {
        expect(normalizeEmbeddingSource("a  \r\nb\r")).toBe(normalizeEmbeddingSource("a\nb\n"));
    });

    it("includes an immediately attached documentation comment without putting it in code", () => {
        const documentation = "/**\n * Adds one to the input.\n */\n";
        const code = "function alpha(value: number) { return value + 1; }";
        const input = buildFunctionEmbeddingInput(
            `${documentation}${code}`,
            { ...entry, startOffset: documentation.length, endOffset: documentation.length + code.length },
            manifest,
        );
        expect(input.documentation).toBe("Adds one to the input.");
        expect(input.code).toBe(code);
        expect(input.text).toContain("documentation:\nAdds one to the input.\ncode:");
    });

    it("MUST-NOT-FIRE: unrelated earlier documentation and code do not change this function's input", () => {
        const code = "function beta(value: number) { return value + 2; }";
        const attached = "/** Adds two, including a literal /** marker in this comment. */\n";
        const inputs = [
            "/** Earlier documentation. */\nfunction alpha() { return 1; }\n",
            "/** Completely different earlier documentation. */\nfunction unrelated() { throw new Error('unrelated'); }\n",
        ].map(earlier => {
            const content = earlier + attached + code;
            return buildFunctionEmbeddingInput(content, {
                ...entry, name: "beta", qualifiedName: "beta",
                startOffset: earlier.length + attached.length, endOffset: content.length,
            }, manifest);
        });
        expect(inputs[0]?.documentation).toBe("Adds two, including a literal /** marker in this comment.");
        expect(inputs[0]?.inputHash).toBe(inputs[1]?.inputHash);
        expect(inputs[0]?.text).not.toContain("function alpha");
    });

    it("MUST-NOT-FIRE: a non-documentation comment breaks attachment to earlier JSDoc", () => {
        const before = "/** Not attached to alpha. */\n/* ordinary comment */\n";
        const code = "function alpha() { return 1; }";
        const input = buildFunctionEmbeddingInput(before + code, {
            ...entry, startOffset: before.length, endOffset: before.length + code.length,
        }, manifest);
        expect(input.documentation).toBe("");
    });
});
