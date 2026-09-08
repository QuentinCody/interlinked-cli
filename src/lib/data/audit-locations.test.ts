import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeEntryHash, GENESIS_HASH } from "../audit-chain.js";
import { diagnoseDataAudit } from "./audit.js";
import { dataRecordHash } from "./normalize.js";

let cwd: string;
let dir: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "data-audit-location-")); dir = join(cwd, ".interlinked"); mkdirSync(join(dir, "archive"), { recursive: true }); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function chained(message: string, previousHash: string): string {
    const row = { type: "guard_allow", message, previousHash };
    return JSON.stringify({ ...row, hash: computeEntryHash(row) });
}

describe("physical audit failure locations", () => {
    it.each(["", "\t \r", "\u00a0"])("locates a broken archive row after whitespace %j", async (blank) => {
        const first = chained("first", GENESIS_HASH);
        const broken = chained("broken", "f".repeat(64));
        const segment = gzipSync(`${first}\n${blank}\n${broken}\n`);
        const path = join(dir, "archive", "activity-0001.jsonl.gz");
        writeFileSync(path, segment);
        writeFileSync(join(dir, "archive", "manifest.json"), JSON.stringify({ version: 1, segments: [{ seq: 1, file: "activity-0001.jsonl.gz" }] }));
        expect(await diagnoseDataAudit(cwd)).toMatchObject({
            valid: false, first_bad_line_number: 2,
            location: { source: "archive/activity-0001.jsonl.gz", source_line: 3,
                offset: Buffer.byteLength(`${first}\n${blank}\n`), raw_hash: dataRecordHash(broken) },
        });
        expect(readFileSync(path)).toEqual(segment);
    });
    it("counts live blank lines separately after an archive containing blank lines", async () => {
        const first = chained("first", GENESIS_HASH);
        const broken = chained("broken", "f".repeat(64));
        writeFileSync(join(dir, "archive", "activity-0001.jsonl.gz"), gzipSync(`${first}\n\n`));
        writeFileSync(join(dir, "archive", "manifest.json"), JSON.stringify({ version: 1, segments: [{ seq: 1, file: "activity-0001.jsonl.gz" }] }));
        const live = `\n${broken}\n`;
        writeFileSync(join(dir, "activity.jsonl"), live);
        expect(await diagnoseDataAudit(cwd)).toMatchObject({
            valid: false, first_bad_line_number: 3,
            location: { source: "activity.jsonl", source_line: 2, offset: 1, raw_hash: dataRecordHash(broken) },
        });
        expect(readFileSync(join(dir, "activity.jsonl"), "utf8")).toBe(live);
    });
});
