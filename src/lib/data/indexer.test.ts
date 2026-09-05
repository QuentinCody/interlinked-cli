import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexData } from "./indexer.js";
import { searchData } from "./search.js";
import { readDataEvidence } from "./evidence.js";
import { dataRow } from "./index-source.js";
import { dataView } from "./views.js";
import { withAsyncFileMutationLock } from "../file-mutation-lock.js";
import { dataIndexPath, openDataIndex } from "./index-schema.js";

let root: string;
let dir: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "interlinked-data-index-")); dir = join(root, ".interlinked"); mkdirSync(dir); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function row(id: string, text: string): string {
    return `${JSON.stringify({ ts: "2026-09-05T12:00:00Z", type: "tool_use", session: "session-a", tool_use_id: id, summary: text, tool_input: { file_path: "src/app.ts" } })}\n`;
}

describe("incremental evidence index", () => {
    it("serves a committed search snapshot while another connection owns a write transaction", async () => {
        writeFileSync(join(dir, "activity.jsonl"), row("a", "readable while importing"));
        await indexData(root);
        const writer = openDataIndex(root);
        writer.exec("BEGIN IMMEDIATE");
        try {
            expect(searchData(root, { text: "readable" }).rows).toHaveLength(1);
        } finally { writer.exec("ROLLBACK"); writer.close(); }
    });
    it("holds the importer lease across asynchronous work and preserves unique field counts", async () => {
        writeFileSync(join(dir, "activity.jsonl"), row("a", "one") + row("b", "two") + row("a", "one"));
        await indexData(root);
        await withAsyncFileMutationLock(dataIndexPath(root), async () => {
            await Promise.resolve();
            await expect(indexData(root)).rejects.toThrow();
        });
        await indexData(root);
        const schema = dataView(root, "schema", { source: "activity" });
        expect(schema.rows).toContainEqual(expect.objectContaining({ path: "summary", occurrences: 2 }));
    });
    it("searches text and dimensions and opens hash-verified raw evidence", async () => {
        writeFileSync(join(dir, "activity.jsonl"), row("a", "compiler rejected the import"));
        expect(await indexData(root)).toMatchObject({ inserted: 1, complete: true });
        const result = searchData(root, { text: "compiler import", session: "session-a", file: "src/app.ts" });
        expect(result.rows).toHaveLength(1);
        const id = String(result.rows[0]?.id);
        const evidence = await readDataEvidence(root, id);
        expect(evidence.hash_verified).toBe(true);
        expect(dataRow(evidence.record).tool_use_id).toBe("a");
    });
    it("resumes after restart and never commits an incomplete final row", async () => {
        const path = join(dir, "activity.jsonl");
        writeFileSync(path, `${row("a", "first")}{"summary":"pending"}`);
        expect(await indexData(root)).toMatchObject({ inserted: 1, complete: false });
        expect(await indexData(root)).toMatchObject({ inserted: 0 });
        appendFileSync(path, "\n");
        expect(await indexData(root)).toMatchObject({ inserted: 1, complete: true });
        expect(searchData(root).rows).toHaveLength(2);
    });
    it("preserves searchable history after rotation without counting archive copies twice", async () => {
        const path = join(dir, "activity.jsonl");
        const old = row("a", "historical compiler failure");
        writeFileSync(path, old);
        await indexData(root);
        mkdirSync(join(dir, "archive"));
        writeFileSync(join(dir, "archive", "activity-0001.jsonl.gz"), gzipSync(old));
        renameSync(path, join(dir, "old.backup"));
        writeFileSync(path, row("b", "latest success"));
        expect(await indexData(root)).toMatchObject({ inserted: 1 });
        expect(searchData(root).rows).toHaveLength(2);
        const historical = searchData(root, { text: "historical" }).rows[0];
        expect((await readDataEvidence(root, String(historical?.id))).hash_verified).toBe(true);
        expect(searchData(root, { archives: false }).rows).toHaveLength(1);
    });
    it("records parse failures with offsets and continues to later valid evidence", async () => {
        writeFileSync(join(dir, "custom.jsonl"), `invalid-json\n${row("a", "known after invalid")}`);
        expect(await indexData(root)).toMatchObject({ malformed: 1, inserted: 1 });
        expect(searchData(root, { category: "unknown" }).rows).toHaveLength(1);
    });
    it("reports a bounded pass and resumes the remaining records", async () => {
        writeFileSync(join(dir, "activity.jsonl"), row("a", "one") + row("b", "two") + row("c", "three"));
        expect(await indexData(root, { maxRecords: 1 })).toMatchObject({ inserted: 1, complete: false });
        expect(await indexData(root)).toMatchObject({ inserted: 2, complete: true });
        expect(searchData(root).rows).toHaveLength(3);
    });
});
