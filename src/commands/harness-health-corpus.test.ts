import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { corpusPrecision } from "./harness-health-corpus.js";
it("counts only adjudicated live hits and preserves the unsampled denominator", () => {
    const root = mkdtempSync(join(tmpdir(), "precision-"));
    try {
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(join(root, ".interlinked/check-corpus.json"), JSON.stringify({ version: 1, checks: { nan_comparison: {
            files_scanned: 10, hits: ["a","b","c"], adjudications: { a: {verdict:"true_positive"}, b:{verdict:"false_positive"}, old:{verdict:"true_positive"} },
        } } }));
        expect(corpusPrecision(root)[0]).toMatchObject({ hits: 3, adjudicated: 2, unadjudicated: 1, precision: 0.5, scope: "legacy unknown" });
    } finally { rmSync(root, { recursive: true, force: true }); }
});
