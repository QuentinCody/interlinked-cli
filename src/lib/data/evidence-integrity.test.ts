import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexData } from "./indexer.js";
import { searchData } from "./search.js";
import { readDataEvidence } from "./evidence.js";
import { scanLiveEvidence } from "./scan.js";
import { openDataIndex } from "./index-schema.js";

let cwd: string;
let dir: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "data-byte-integrity-")); dir = join(cwd, ".interlinked"); mkdirSync(dir); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function malformedRecord(byte: number): Buffer {
    return Buffer.concat([Buffer.from('{"summary":"'), Buffer.from([byte]), Buffer.from('"}\n')]);
}

describe("retained evidence byte integrity", () => {
    it.each(["activity.jsonl", "activity.jsonl.1.gz"])("records invalid UTF-8 as malformed in %s and advances to valid evidence", async (name) => {
        const original = Buffer.concat([malformedRecord(0xff), Buffer.from('{"summary":"valid λ �"}\n')]);
        const bytes = name.endsWith(".gz") ? gzipSync(original) : original;
        const path = join(dir, name);
        writeFileSync(path, bytes);
        expect(await indexData(cwd)).toMatchObject({ inserted: 1, malformed: 1, oversized: 0, complete: true });
        expect(await indexData(cwd)).toMatchObject({ inserted: 0, malformed: 0 });
        const rows = searchData(cwd).rows;
        expect(rows).toHaveLength(1);
        expect(await readDataEvidence(cwd, String(rows[0]?.id))).toMatchObject({ hash_verified: true, record: { summary: "valid λ �" } });
        const scan = await scanLiveEvidence(cwd, {});
        expect(scan).toMatchObject({ total: 1, coverage: { complete: false, malformed: 1, oversized: 0 } });
        const db = openDataIndex(cwd);
        try {
            expect(db.prepare("SELECT kind,message FROM data_parse_errors").all()).toEqual([
                expect.objectContaining({ kind: "malformed", message: "record is not valid UTF-8; raw evidence retained" }),
            ]);
        } finally { db.close(); }
        expect(readFileSync(path)).toEqual(bytes);
    });
    it("refuses malformed bytes even when a preexisting index stores their lossy text hash", async () => {
        const path = join(dir, "activity.jsonl");
        writeFileSync(path, '{"summary":"�"}\n');
        await indexData(cwd);
        const id = String(searchData(cwd).rows[0]?.id);
        // Reproduce a prior index's offsets/hash for the shorter malformed byte record.
        const db = openDataIndex(cwd);
        try { db.prepare("UPDATE data_locations SET end_offset=? WHERE record_id=?").run(malformedRecord(0xff).length, id); }
        finally { db.close(); }
        for (const byte of [0xff, 0xfe]) {
            const bytes = malformedRecord(byte);
            writeFileSync(path, bytes);
            expect(await readDataEvidence(cwd, id)).toMatchObject({ available: false, hash_verified: false, errors: [expect.stringContaining("not valid UTF-8")] });
            expect(readFileSync(path)).toEqual(bytes);
        }
    });
});
