import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeStageRow, verifyCoverageProofs } from "./e2e-coverage-merge.mjs";
import { recordStage } from "./e2e-stage-ledger.mjs";

describe("merge stage ledger row", () => {
    // test-contract: invariant — a merge is ONE ledger row: summing post_ms over everything the merge writes equals the merge's wall time exactly once, and the per-phase profile rides in detail
    it("records the merge once, with the phase profile as detail rather than further post_ms rows", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-merge-row-"));
        const ledger = join(root, "stages.jsonl");
        try {
            const timings = { read_ms: 2700, read_files: 212, merge_ms: 400, convert_ms: 2700, converted_scripts: 5, summary_ms: 8 };
            expect(recordStage(root, mergeStageRow("passed", 5850, timings), { env: { INTERLINKED_STAGES_LEDGER: ledger } })).toBe(true);
            const rows = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
            expect(rows).toHaveLength(1);
            expect(rows.reduce((sum, row) => sum + (row.post_ms ?? 0), 0)).toBe(5850);
            expect(rows[0]).toMatchObject({ check: "e2e-merge", status: "passed", post_ms: 5850, detail: timings });
            expect(rows.filter((row) => row.check.startsWith("e2e-merge:"))).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it("records a failed merge with its elapsed time and an empty profile", () => {
        expect(mergeStageRow("failed", 12, {})).toEqual({ check: "e2e-merge", status: "failed", post_ms: 12, detail: {} });
    });
});

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
