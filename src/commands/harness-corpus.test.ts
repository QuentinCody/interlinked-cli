import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scanCheckCorpus, corpusStatus } from "./harness-corpus.js";
it("records a real eligible scan and refuses qualification after a dirty input edit", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-cli-"));
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src/a.ts"), "const fine = Number.isNaN(value);");
        expect(scanCheckCorpus(root, ["nan_comparison"])[0]).toMatchObject({ qualified: true, hits: 0, files: 1 });
        writeFileSync(join(root, "src/a.ts"), "const bad = value === NaN;");
        expect(corpusStatus(root)[0]?.qualified).toBe(false);
        expect(scanCheckCorpus(root, ["nan_comparison"])[0]).toMatchObject({ qualified: false, unadjudicated: 1 });
        expect(() => scanCheckCorpus(root, ["invented"])).toThrow(/Unknown check/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
it("does not overwrite malformed retained corpus evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-malformed-"));
    try {
        mkdirSync(join(root, ".interlinked"));
        const file = join(root, ".interlinked/check-corpus.json");
        writeFileSync(file, "{original-truncated");
        expect(() => scanCheckCorpus(root, ["nan_comparison"])).toThrow();
        expect(readFileSync(file, "utf8")).toBe("{original-truncated");
    } finally { rmSync(root, { recursive: true, force: true }); }
});
