import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CAPTURED_JSONL_LINE_BYTES } from "../bounded-file-io.js";
import { computeEntryHash, GENESIS_HASH } from "../audit-chain.js";
import { createDataAuditCheckpoint } from "./audit.js";
import { verifyDataCheckpoint } from "./audit-checkpoint-verify.js";

let cwd: string;
let path: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "data-checkpoint-utf8-")); mkdirSync(join(cwd, ".interlinked")); path = join(cwd, ".interlinked", "activity.jsonl"); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("UTF-8 at audit checkpoint boundaries", () => {
    it("verifies a valid anchor when the bounded seek bisects an earlier multibyte character", async () => {
        const anchor = { type: "guard_allow", previousHash: GENESIS_HASH };
        const hash = computeEntryHash(anchor);
        const rawAnchor = JSON.stringify({ ...anchor, hash });
        const priorBytes = MAX_CAPTURED_JSONL_LINE_BYTES - 50;
        const seek = priorBytes + Buffer.byteLength(rawAnchor) - MAX_CAPTURED_JSONL_LINE_BYTES;
        const prefix = '{"message":"';
        const suffix = '"}';
        const beforeCharacter = "x".repeat(seek - 1 - Buffer.byteLength(prefix));
        const afterCharacter = "y".repeat(priorBytes - Buffer.byteLength(prefix + beforeCharacter + "λ" + suffix));
        const prior = prefix + beforeCharacter + "λ" + afterCharacter + suffix;
        writeFileSync(path, `${prior}\n${rawAnchor}\n`);
        const checkpoint = await createDataAuditCheckpoint(cwd, "verified retained boundary");
        const next = { type: "guard_allow", previousHash: hash };
        appendFileSync(path, `${JSON.stringify({ ...next, hash: computeEntryHash(next) })}\n`);
        expect(await verifyDataCheckpoint(cwd, String(checkpoint.id))).toMatchObject({ valid: true, boundary_found: true, chained_after_boundary: 1 });
    });
    it("reports invalid bytes after the anchor without treating them as a valid unchained row", async () => {
        const anchor = { type: "guard_allow", previousHash: GENESIS_HASH };
        writeFileSync(path, `${JSON.stringify({ ...anchor, hash: computeEntryHash(anchor) })}\n`);
        const checkpoint = await createDataAuditCheckpoint(cwd, "verified retained boundary");
        appendFileSync(path, Buffer.concat([Buffer.from('{"message":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
        expect(await verifyDataCheckpoint(cwd, String(checkpoint.id))).toMatchObject({ valid: false, reason: "invalid-utf8" });
    });
    it("keeps malformed bytes before the anchor outside the checkpoint verdict", async () => {
        const anchor = { type: "guard_allow", previousHash: GENESIS_HASH };
        const rawAnchor = `${JSON.stringify({ ...anchor, hash: computeEntryHash(anchor) })}\n`;
        writeFileSync(path, '{"message":"x"}\n' + rawAnchor);
        const checkpoint = await createDataAuditCheckpoint(cwd, "verified retained boundary");
        writeFileSync(path, Buffer.concat([Buffer.from('{"message":"'), Buffer.from([0xff]), Buffer.from('"}\n' + rawAnchor)]));
        expect(await verifyDataCheckpoint(cwd, String(checkpoint.id))).toMatchObject({ valid: true, boundary_found: true, chained_after_boundary: 0 });
    });
});
