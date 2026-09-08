import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readDataLines } from "./stream.js";

const roots: string[] = [];
function fixture(body: Buffer | string, name = "events.jsonl"): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-data-stream-"));
    roots.push(root);
    const path = join(root, name);
    writeFileSync(path, body);
    return path;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bounded evidence streams", () => {
    it.each(["events.jsonl", "events.jsonl.gz"])("rejects invalid UTF-8 in %s without losing later records", async (name) => {
        const bytes = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}\n{"text":"valid λ �"}\n')]);
        const path = fixture(name.endsWith(".gz") ? gzipSync(bytes) : bytes, name);
        const rows = [];
        for await (const row of readDataLines(path)) rows.push(row);
        expect(rows[0]).toMatchObject({ complete: true, invalidUtf8: true, oversized: false });
        expect(rows[0]?.text).toBeUndefined();
        expect(rows[1]).toMatchObject({ complete: true, text: '{"text":"valid λ �"}' });
        expect(rows[1]?.invalidUtf8).toBeUndefined();
    });
    it("retains a valid multibyte character across stream chunk boundaries", async () => {
        const text = `${"x".repeat(64 * 1024 - 1)}λ`;
        const rows = [];
        for await (const row of readDataLines(fixture(`${text}\n`))) rows.push(row);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ text, complete: true });
        expect(rows[0]?.invalidUtf8).toBeUndefined();
    });
    it("rejects a multibyte sequence cut off by a newline", async () => {
        const rows = [];
        for await (const row of readDataLines(fixture(Buffer.from([0xe2, 0x82, 0x0a])))) rows.push(row);
        expect(rows[0]).toMatchObject({ complete: true, invalidUtf8: true, nextOffset: 3 });
        expect(rows[0]?.text).toBeUndefined();
    });
    it("retains exact UTF-8 offsets and exposes a pending unterminated row", async () => {
        const first = '{"text":"λ"}\n';
        const path = fixture(`${first}{"pending":true}`);
        const rows = [];
        for await (const row of readDataLines(path)) rows.push(row);
        expect(rows.map((row) => [row.start, row.nextOffset, row.complete])).toEqual([
            [0, Buffer.byteLength(first), true],
            [Buffer.byteLength(first), Buffer.byteLength(`${first}{"pending":true}`), false],
        ]);
    });
    it("resumes a gzip archive using uncompressed byte offsets", async () => {
        const path = fixture(gzipSync("one\ntwo\nthree\n"), "events.jsonl.gz");
        const rows = [];
        for await (const row of readDataLines(path, { startOffset: 4 })) rows.push(row);
        expect(rows.map((row) => [row.start, row.text])).toEqual([[4, "two"], [8, "three"]]);
    });
    it("bounds oversized line materialization without losing subsequent records", async () => {
        const path = fixture("abcdefghij\nok\n");
        const rows = [];
        for await (const row of readDataLines(path, { maxLineBytes: 4 })) rows.push(row);
        expect(rows[0]).toMatchObject({ oversized: true, complete: true, nextOffset: 11 });
        expect(rows[1]).toMatchObject({ text: "ok", start: 11 });
    });
    it("does not turn a byte-budget cut into a complete record", async () => {
        const path = fixture("one\ntwo\n");
        const rows = [];
        for await (const row of readDataLines(path, { maxBytes: 6 })) rows.push(row);
        expect(rows.map((row) => [row.text, row.complete])).toEqual([["one", true], ["tw", false]]);
    });
});
