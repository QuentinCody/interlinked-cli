import { describe, expect, it, vi } from "vitest";

vi.mock("../checks/cyclomatic-ast.js", async importOriginal => {
    const actual = await importOriginal<typeof import("../checks/cyclomatic-ast.js")>();
    return { ...actual, parseTsSource: () => null };
});

import { computeTypeScriptFunctionTokens } from "./typescript.js";
import { functionTokenProvenance, isFunctionTokenProvenance } from "./provenance.js";
import { compareFunctionTokens, resetFunctionTokenWarningsForTesting } from "../evaluator/function-token-write-guard.js";

describe("unavailable function-token parser", () => {
    it("returns unmeasured and emits a gate warning when TypeScript is absent", () => {
        resetFunctionTokenWarningsForTesting();
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            expect(computeTypeScriptFunctionTokens("function f(){}", "a.ts")).toBeNull();
            expect(compareFunctionTokens("", "function f(){}", "a.ts", "/tmp")).toBeNull();
            expect(stderr).toHaveBeenCalledWith(expect.stringContaining("not-measured"));
            expect(functionTokenProvenance(["typescript"]).adapters).toEqual([
                { language: "typescript", tokenizer: "interlinked-ts-ast-v1", parserVersion: null },
            ]);
        } finally { stderr.mockRestore(); }
    });

    it.each([null, {}, { contract: "v2", adapters: [null] },
        { contract: "v2", adapters: [{ language: "typescript", tokenizer: "ast", parserVersion: 5 }] }])(
        "rejects malformed measurement provenance: %j", value => {
            expect(isFunctionTokenProvenance(value)).toBe(false);
        },
    );
});
