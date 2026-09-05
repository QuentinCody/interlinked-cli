import { join } from "node:path";
import { lstatSync } from "node:fs";
import { MAX_CAPTURED_JSONL_LINE_BYTES } from "../bounded-file-io.js";
import { auditEvidenceSources } from "../audit-chain-io.js";
import { computeEntryHash } from "../audit-chain.js";
import { getDataDir } from "../config.js";
import { isJsonObject, type JsonObject } from "../json-types.js";
import { dataRecordHash } from "./normalize.js";
import { readDataLines } from "./stream.js";

async function readCheckpoint(cwd: string, id: string): Promise<JsonObject> {
    for await (const line of readDataLines(join(getDataDir(cwd), "audit-checkpoints.jsonl"))) {
        if (!line.text) continue;
        const row: unknown = JSON.parse(line.text);
        if (isJsonObject(row) && row.id === id && row.schema === "audit-checkpoint.v1") return row;
    }
    throw new Error("audit checkpoint not found");
}
interface BoundaryWalk { found: boolean; previous: string; chained: number; unchained: number; }
function validateCheckpointAnchor(raw: string, checkpoint: JsonObject): string | null {
    const anchor: unknown = JSON.parse(raw);
    if (!isJsonObject(anchor) || anchor.hash !== checkpoint.hash || computeEntryHash(anchor) !== checkpoint.hash) return "checkpoint-anchor-mismatch";
    return null;
}

function checkpointSources(cwd: string, checkpoint: JsonObject): Array<{ path: string; source: string; startOffset: number }> {
    const path = join(getDataDir(cwd), "activity.jsonl");
    const stat = lstatSync(path, { throwIfNoEntry: false });
    const identity = stat ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : null;
    if (identity === checkpoint.source_identity && typeof checkpoint.offset === "number" && Number.isSafeInteger(checkpoint.offset)) {
        return [{ path, source: "activity.jsonl", startOffset: Math.max(0, checkpoint.offset - MAX_CAPTURED_JSONL_LINE_BYTES - 2) }];
    }
    return auditEvidenceSources(cwd).map((source) => ({ ...source, startOffset: 0 }));
}
function verifyBoundaryLine(state: BoundaryWalk, checkpoint: JsonObject, raw: string): string | null {
    if (!state.found) {
        state.found = dataRecordHash(raw) === checkpoint.raw_hash;
        if (state.found) return validateCheckpointAnchor(raw, checkpoint);
        return null;
    }
    let row: unknown;
    try { row = JSON.parse(raw); } catch { return "malformed-json"; }
    if (!isJsonObject(row)) return "non-object-record";
    if (typeof row.hash !== "string") { state.unchained++; return null; }
    if (computeEntryHash(row) !== row.hash) return "payload-hash-mismatch";
    if (row.previousHash !== state.previous) return "predecessor-mismatch";
    state.previous = row.hash; state.chained++;
    return null;
}

/** Verification starts at an explicit boundary; the full historical verdict is unchanged. */
export async function verifyDataCheckpoint(cwd: string, id: string): Promise<JsonObject> {
    const checkpoint = await readCheckpoint(cwd, id);
    if (typeof checkpoint.hash !== "string") throw new Error("invalid checkpoint hash");
    const state: BoundaryWalk = { found: false, previous: checkpoint.hash, chained: 0, unchained: 0 };
    for (const source of checkpointSources(cwd, checkpoint)) {
        for await (const line of readDataLines(source.path, { startOffset: source.startOffset })) {
            const reason = !line.complete || line.text === undefined ? "incomplete-or-oversized-record" : verifyBoundaryLine(state, checkpoint, line.text);
            if (reason) return { valid: false, checkpoint: id, reason, source: source.source, offset: line.start, chained_after_boundary: state.chained };
        }
    }
    return { valid: state.found, checkpoint: id, boundary_found: state.found, chained_after_boundary: state.chained,
        unchained_after_boundary: state.unchained, last_hash: state.previous, scope: "after explicit checkpoint only; historical validity unchanged" };
}
