import { describe, expect, it } from "vitest";
import { verifyCoverageProofs } from "./e2e-coverage-merge.mjs";

describe("child coverage acceptance proofs", () => {
    it("requires executed daemon and hook functions, not just module initialization", () => {
        const summary = { "src/harness/server/pre-tool-pipeline.ts": { lines: { covered: 1 } }, "src/hook-entry-cold-gates.ts": { lines: { covered: 1 } }, "src/harness/break-glass.ts": { functions: { total: 1, covered: 0 }, lines: { total: 2, covered: 1 } } };
        expect(() => verifyCoverageProofs(summary)).toThrow("never called");
        const models = Object.fromEntries([["src/harness/server/pre-tool-pipeline.ts", "runPreToolPipeline"], ["src/hook-entry-cold-gates.ts", "coldDestructiveCommandBlockReason"]].map(([path, name]) => [path, { fnMap: { 0: { name } }, f: { 0: 1 } }]));
        expect(() => verifyCoverageProofs(summary, models)).not.toThrow();
    });
    it("rejects a missing daemon or hook-only proof", () => {
        expect(() => verifyCoverageProofs({})).toThrow("proof");
        expect(() => verifyCoverageProofs({ "src/hook-entry-cold-gates.ts": { lines: { covered: 1 } } })).toThrow("proof");
    });
});
