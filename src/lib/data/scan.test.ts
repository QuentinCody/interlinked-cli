import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { scanLiveEvidence } from "./scan.js";
import { evidenceHash } from "../data-search/corpus.js";
import { dataIndexPath } from "./index-schema.js";

describe("direct retained evidence scan", () => {
    it("searches live and gzip records with no index and returns original text", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "interlinked-direct-scan-"));
        mkdirSync(join(cwd, ".interlinked"));
        const raw = '{"session":"s","message":"original café error"}';
        writeFileSync(join(cwd, ".interlinked", "tests.jsonl"), `${raw}\n`);
        writeFileSync(join(cwd, ".interlinked", "tests.jsonl.1.gz"), gzipSync('{"session":"s","message":"archived error"}\n'));
        const answer = await scanLiveEvidence(cwd, { text: "error", session: "s" }, { raw: true });
        expect(answer.total).toBe(2);
        expect(answer.coverage.complete).toBe(true);
        expect(answer.rows).toContainEqual(expect.objectContaining({ raw, hash: evidenceHash(raw) }));
        expect(existsSync(dataIndexPath(cwd))).toBe(false);
        expect((await scanLiveEvidence(cwd, {}, { maxRecords: 1 })).coverage.complete).toBe(false);
    });
    it("finds text beyond the index projection and normalizes absolute file paths", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "interlinked-full-text-scan-"));
        mkdirSync(join(cwd, ".interlinked"));
        writeFileSync(join(cwd, ".interlinked", "tests.jsonl"), `${JSON.stringify({ message: `${"x".repeat(40000)} needle-at-end`, file: join(cwd, "src/app.ts") })}\n`);
        expect((await scanLiveEvidence(cwd, { text: "needle-at-end", file: "src/app.ts" })).total).toBe(0);
        const complete = await scanLiveEvidence(cwd, { text: "needle-at-end", file: "src/app.ts" }, { fullText: true });
        expect(complete.total).toBe(1);
        expect(complete.coverage.complete).toBe(true);
        expect(complete.rows[0]?.text.length).toBeLessThan(40000);
    });
});
