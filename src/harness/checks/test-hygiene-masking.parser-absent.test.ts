// `maskCommentsAndStrings` asks the TypeScript parser first and falls back to the char-level heuristic when the
// parser route answers null (an install without the optional `typescript`). This file removes the parser route.
import { describe, expect, it, vi } from "vitest";
import { maskCommentsAndStrings, maskCommentsAndStringsHeuristic } from "./test-hygiene-masking.js";

vi.mock("./test-hygiene-masking-ast.js", () => ({ maskWithTypeScript: () => null }));

describe("maskCommentsAndStrings — parser route unavailable", () => {
    // test-contract: public-api — with no parser the public masker returns the heuristic's output
    it("falls back to the heuristic mask", () => {
        const source = "const a = 'x'; // c\nlet b = `y`;";
        expect(maskCommentsAndStrings(source, "sample.ts")).toBe(maskCommentsAndStringsHeuristic(source));
        expect(maskCommentsAndStrings(source, "sample.ts")).toBe(`const a = ${" ".repeat(3)}; ${" ".repeat(4)}\nlet b = ${" ".repeat(3)};`);
    });
});
