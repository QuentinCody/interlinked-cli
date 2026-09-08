import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { computeEntryHash, GENESIS_HASH, verifyAuditChainStreaming } from "../audit-chain.js";
import { auditEvidenceSources } from "../audit-chain-io.js";
import { getDataDir } from "../config.js";
import { withFileMutationLock } from "../file-mutation-lock.js";
import { isJsonObject, type JsonObject } from "../json-types.js";
import { appendCapturedData } from "./capture.js";
import { dataRecordHash } from "./normalize.js";
import { readDataLines } from "./stream.js";

interface AuditLocation { source: string; offset: number; end_offset: number; source_line: number; combined_line: number; raw_hash: string; }
async function locateFailure(cwd: string, wanted: number): Promise<AuditLocation | null> {
    let combined = 0;
    for (const source of auditEvidenceSources(cwd)) {
        let local = 0;
        for await (const line of readDataLines(source.path, { maxLineBytes: 16 * 1024 * 1024 })) {
            local++;
            // The verifier omits blank archive lines but counts physical live lines.
            if (source.source.startsWith("archive/") && line.text?.trim() === "") continue;
            combined++;
            if (combined === wanted && line.text !== undefined) return { source: source.source, offset: line.start,
                end_offset: line.nextOffset, source_line: local, combined_line: combined, raw_hash: dataRecordHash(line.text) };
        }
    }
    return null;
}

/** Invalid proves a continuity/integrity failure; it does not prove intent. */
export async function diagnoseDataAudit(cwd: string): Promise<JsonObject> {
    const result = await verifyAuditChainStreaming(cwd);
    const location = result.first_bad_line_number === undefined ? null : await locateFailure(cwd, result.first_bad_line_number);
    return { ...result, location, classification: result.valid ? "valid-within-retained-evidence" : "integrity-or-continuity-failure",
        interpretation: "A mismatch can result from concurrent writers, damage, or alteration; cause requires investigation. Historical evidence is never rewritten." };
}

interface CheckpointWalk { lastHash: string | null; lastOffset: number; rawHash: string | null; chained: number; continuityBreaks: number; }
function checkpointLine(state: CheckpointWalk, raw: string, nextOffset: number): void {
    let row: unknown;
    try { row = JSON.parse(raw); } catch { throw new Error("cannot checkpoint malformed live JSON"); }
    if (!isJsonObject(row)) throw new Error("cannot checkpoint a non-object live record");
    if (typeof row.hash !== "string") return;
    if (computeEntryHash(row) !== row.hash) throw new Error("cannot checkpoint a live tail with an invalid payload hash");
    if (state.lastHash !== null && row.previousHash !== state.lastHash && row.previousHash !== GENESIS_HASH) state.continuityBreaks++;
    state.lastHash = row.hash; state.lastOffset = nextOffset; state.rawHash = dataRecordHash(raw); state.chained++;
}

async function checkpointLiveTail(cwd: string, reason: string): Promise<JsonObject> {
    const path = join(getDataDir(cwd), "activity.jsonl");
    const before = lstatSync(path);
    const state: CheckpointWalk = { lastHash: null, lastOffset: 0, rawHash: null, chained: 0, continuityBreaks: 0 };
    for await (const line of readDataLines(path, { maxBytes: before.size })) {
        if (!line.complete) throw new Error("cannot checkpoint an unterminated live record");
        if (line.invalidUtf8) throw new Error("cannot checkpoint invalid UTF-8; raw evidence retained");
        if (line.text === undefined) throw new Error("cannot checkpoint an oversized live record");
        checkpointLine(state, line.text, line.nextOffset);
    }
    if (!state.lastHash) throw new Error("no payload-verified chained live record to checkpoint");
    return withFileMutationLock(path, () => persistCheckpoint(cwd, reason, before, state), { waitMs: 0 });
}

function persistCheckpoint(cwd: string, reason: string, before: Stats, state: CheckpointWalk): JsonObject {
    const after = lstatSync(join(getDataDir(cwd), "activity.jsonl"));
    if (before.ino !== after.ino || before.size > after.size) throw new Error("activity replaced while checkpointing; retry");
    if (before.size === after.size && before.mtimeMs !== after.mtimeMs) throw new Error("activity rewritten while checkpointing; retry");
    const checkpoint = { schema: "audit-checkpoint.v1", ts: new Date().toISOString(), id: randomUUID(), reason,
        source: "activity.jsonl", source_identity: `${after.dev}:${after.ino}:${after.birthtimeMs}`, offset: state.lastOffset,
        hash: state.lastHash, raw_hash: state.rawHash, verified_live_payloads: state.chained, snapshot_bytes: Number(before.size),
        observed_live_continuity_breaks: state.continuityBreaks, historical_validity: "unchanged; this records a new explicit observation boundary" };
    if (!appendCapturedData({ cwd, producer: "lib/data/audit" }, "audit-checkpoints", [checkpoint])) throw new Error("checkpoint receipt could not be written");
    return checkpoint;
}

/** Explicit local checkpoint: does not reset the chain or excuse historical failures. */
export async function createDataAuditCheckpoint(cwd: string, reason: string): Promise<JsonObject> {
    if (!reason.trim()) throw new Error("an investigation/recovery reason is required");
    return checkpointLiveTail(cwd, reason);
}
