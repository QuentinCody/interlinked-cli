import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mergeChildReports, mergeStageRow, verifyCoverageProofs } from "./e2e-coverage-merge.mjs";
import { recordStage } from "./e2e-stage-ledger.mjs";

describe("filtered child coverage merge", () => {
    const roots = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    function fixture() {
        const root = mkdtempSync(join(tmpdir(), "e2e report merge "));
        roots.push(root);
        const v8Directory = join(root, "v8");
        mkdirSync(v8Directory);
        return { root, v8Directory, children: [{ pid: 1, clean: true }, { pid: 2, clean: true }] };
    }
    function script(url, count) {
        return { scriptId: "0", url, functions: [
            { functionName: "called", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 20, count }] },
            { functionName: "uncalled", isBlockCoverage: true, ranges: [{ startOffset: 20, endOffset: 30, count: 0 }] },
        ] };
    }
    function report(fixture, pid, result) {
        writeFileSync(join(fixture.v8Directory, `coverage-${pid}-fixture.json`), JSON.stringify({ result, "source-map-cache": { unused: "payload" } }));
    }
    it("adds every child and grandchild hit, preserves zero hits, and excludes non-bundle scripts", () => {
        const f = fixture();
        const bundle = pathToFileURL(join(f.root, "dist/server.js")).href;
        const zero = pathToFileURL(join(f.root, "dist/never.js")).href;
        report(f, 1, [script(bundle, 1), script("node:internal/fs", 100)]);
        report(f, 2, [script(bundle, 2), script(pathToFileURL(join(f.root, "dist-other/server.js")).href, 100)]);
        report(f, 3, [script(bundle, 3), script(zero, 0)]);
        const { merged, timings } = mergeChildReports(f);
        expect(merged.result.map(row => row.url).sort()).toEqual([bundle, zero].sort());
        expect(merged.result.find(row => row.url === bundle).functions.map(fn => fn.ranges[0].count)).toEqual([6, 0]);
        expect(merged.result.find(row => row.url === zero).functions.map(fn => fn.ranges[0].count)).toEqual([0, 0]);
        expect(timings).toMatchObject({ read_files: 3, read_scripts: 6, retained_scripts: 4, merged_scripts: 2 });
    });
    it("prefers original block coverage over function-only hits across all reports", () => {
        const f = fixture();
        const url = pathToFileURL(join(f.root, "dist/server.js")).href;
        for (const [pid, count] of [[1, 5], [2, 7]]) {
            report(f, pid, [{ scriptId: "0", url, functions: [{ functionName: "called", isBlockCoverage: false,
                ranges: [{ startOffset: 0, endOffset: 20, count }] }] }]);
        }
        report(f, 3, [{ scriptId: "0", url, functions: [{ functionName: "called", isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: 20, count: 1 }, { startOffset: 5, endOffset: 10, count: 0 }] }] }]);
        // An incremental merge turns 5+7 function-only hits into a block model
        // and incorrectly adds them to the real block model's single hit.
        expect(mergeChildReports(f).merged.result[0].functions[0].ranges).toEqual([
            { startOffset: 0, endOffset: 20, count: 1 }, { startOffset: 5, endOffset: 10, count: 0 },
        ]);
    });
    it("refuses missing or unclean child evidence before accepting any coverage", () => {
        const f = fixture();
        report(f, 1, []);
        expect(() => mergeChildReports(f)).toThrow("Child 2 did not flush");
        report(f, 2, []);
        f.children[1].clean = false;
        expect(() => mergeChildReports(f)).toThrow("Child 2 did not exit cleanly");
        expect(() => mergeChildReports({ ...f, children: [] })).toThrow("No child process coverage");
    });
    it("refuses malformed extra reports instead of publishing a partial merge", () => {
        const f = fixture();
        report(f, 1, []);
        report(f, 2, []);
        writeFileSync(join(f.v8Directory, "coverage-3-fixture.json"), "{invalid");
        expect(() => mergeChildReports(f)).toThrow();
    });
});

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
