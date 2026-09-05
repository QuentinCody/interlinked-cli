import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendChainedAuditRecord, computeEntryHash, GENESIS_HASH } from "../audit-chain.js";
import { createDataAuditCheckpoint, diagnoseDataAudit } from "./audit.js";
import { verifyDataCheckpoint } from "./audit-checkpoint-verify.js";
import { indexData } from "./indexer.js";
import { rotateIndexedData } from "./rotation.js";
import { searchData } from "./search.js";
import { readDataEvidence } from "./evidence.js";
import { dataIndexStatus } from "./health.js";

let cwd: string;
let dir: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "data-recovery-")); dir = join(cwd, ".interlinked"); mkdirSync(dir); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
const line = (id: number): string => JSON.stringify({ id, text: `evidence ${id} ${"x".repeat(200)}` }) + "\n";

describe("evidence recovery", () => {
    it("translates archive and retained-suffix locations without reimport or double counting", async () => {
        writeFileSync(join(dir, "collection.jsonl"), Array.from({ length: 20 }, (_, i) => line(i)).join(""));
        await indexData(cwd);
        expect(rotateIndexedData(cwd, "collection", 500).compacted).toBe(true);
        const records = searchData(cwd).rows;
        expect(records).toHaveLength(20);
        for (const record of records) expect((await readDataEvidence(cwd, String(record.id))).hash_verified).toBe(true);
        expect(dataIndexStatus(cwd).fresh).toBe(true);
        expect((await indexData(cwd)).inserted).toBe(0);
        expect((await indexData(cwd, { rebuild: true })).inserted).toBe(20);
    });
    it("can rotate a source that has not yet reached the bounded importer", async () => {
        writeFileSync(join(dir, "timeline.jsonl"), Array.from({ length: 10 }, (_, i) => line(i)).join(""));
        expect(rotateIndexedData(cwd, "timeline", 300).compacted).toBe(true);
        expect((await indexData(cwd)).inserted).toBe(10);
    });
    it("detects a rewrite beyond the file head even when more bytes were appended", async () => {
        const path = join(dir, "activity.jsonl");
        const prefix = Array.from({ length: 30 }, (_, i) => line(i)).join("");
        writeFileSync(path, prefix + line(100)); expect((await indexData(cwd)).errors).toEqual([]);
        writeFileSync(path, prefix + line(200) + line(300)); expect((await indexData(cwd)).errors).toEqual([]);
        expect(searchData(cwd, { limit: 100 }).rows).toHaveLength(32);
        expect(searchData(cwd, { text: "100" }).rows).toHaveLength(0);
    });
    it("keeps the historical failure while verifying subsequent evidence from an explicit boundary", async () => {
        appendChainedAuditRecord({ type: "guard_allow", ts: "2026-09-05T12:00:00Z" }, cwd);
        const duplicate = { type: "guard_warn", previousHash: GENESIS_HASH, message: "independent old writer" };
        appendFileSync(join(dir, "activity.jsonl"), JSON.stringify({ ...duplicate, hash: computeEntryHash(duplicate) }) + "\n");
        const before = readFileSync(join(dir, "activity.jsonl"), "utf8");
        const checkpoint = await createDataAuditCheckpoint(cwd, "investigated writer continuity");
        expect(readFileSync(join(dir, "activity.jsonl"), "utf8")).toBe(before);
        appendChainedAuditRecord({ type: "guard_allow", message: "subsequent" }, cwd);
        expect((await verifyDataCheckpoint(cwd, String(checkpoint.id))).valid).toBe(true);
        const broken = { type: "guard_warn", previousHash: "f".repeat(64), message: "new discontinuity" };
        appendFileSync(join(dir, "activity.jsonl"), JSON.stringify({ ...broken, hash: computeEntryHash(broken) }) + "\n");
        expect((await verifyDataCheckpoint(cwd, String(checkpoint.id))).valid).toBe(false);
        expect(await diagnoseDataAudit(cwd)).toMatchObject({ valid: false, classification: "integrity-or-continuity-failure", location: { source: "activity.jsonl" } });
    });
});
