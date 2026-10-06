import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import { qualifyCurrentCorpus } from "./corpus-current.js";
import { corpusSatisfied } from "./corpus.js";
it("qualifies clean edits without changing stored evidence and detects a hit even if the stored list was erased", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-current-"));
    const id = "nan_comparison";
    try {
        mkdirSync(join(root, "src")); mkdirSync(join(root, ".interlinked"));
        const store = join(root, ".interlinked/check-corpus.json");
        const original = JSON.stringify({ version: 1, checks: { [id]: { files_scanned: 999, hits: [], adjudications: {} } } });
        writeFileSync(store, original);
        for (const source of ["export const x = 1;", "export const x = 2;"]) {
            writeFileSync(join(root, "src/a.ts"), source);
            const result = qualifyCurrentCorpus(root, [id], CHECK_REGISTRY);
            expect(corpusSatisfied(result.records[id], result.bindings[id])).toBe(true);
        }
        writeFileSync(join(root, "src/a.ts"), "export const bad = value === NaN;");
        const result = qualifyCurrentCorpus(root, [id], CHECK_REGISTRY);
        expect(result.records[id]?.hits).toHaveLength(1);
        expect(corpusSatisfied(result.records[id], result.bindings[id])).toBe(false);
        expect(readFileSync(store, "utf8")).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
