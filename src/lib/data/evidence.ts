import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getDataDir } from "../config.js";
import { isJsonObject, type JsonObject } from "../json-types.js";
import { dataNumber, dataRow, dataString } from "./index-source.js";
import { dataRecordHash } from "./normalize.js";
import { requireDataIndex } from "./search.js";
import { readDataLines } from "./stream.js";

function evidencePath(root: string, path: string): string {
    const canonicalRoot = realpathSync(root);
    const candidate = realpathSync(resolve(canonicalRoot, path));
    const rel = relative(canonicalRoot, candidate);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error("indexed evidence path escapes the data directory");
    }
    return candidate;
}

async function readLocation(cwd: string, row: JsonObject, expectedHash: string): Promise<JsonObject> {
    const path = evidencePath(getDataDir(cwd), dataString(row, "path"));
    const offset = dataNumber(row, "offset");
    const bytes = dataNumber(row, "end_offset") - offset;
    for await (const line of readDataLines(path, { startOffset: offset, maxBytes: bytes })) {
        if (!line.complete || line.text === undefined || dataRecordHash(line.text) !== expectedHash) throw new Error("evidence bytes no longer match the indexed hash");
        const record: unknown = JSON.parse(line.text);
        if (!isJsonObject(record)) throw new Error("indexed evidence is not a JSON object");
        return { record, location: { ...row, path: join(getDataDir(cwd), dataString(row, "path")) }, hash_verified: true };
    }
    throw new Error("indexed evidence is no longer readable at its recorded offset");
}

/** Open the raw retained bytes and verify their hash, trying alternate archive locations. */
export async function readDataEvidence(cwd: string, id: string): Promise<JsonObject> {
    const db = requireDataIndex(cwd);
    try {
        const value = db.prepare("SELECT raw_hash FROM data_records WHERE id=?").get(id);
        if (value === undefined) throw new Error(`unknown evidence record: ${id}`);
        const hash = dataString(dataRow(value), "raw_hash");
        const rows = db.prepare(`SELECT s.path,s.id generation,s.compressed,s.retained,l.offset,l.end_offset
            FROM data_locations l JOIN data_sources s ON s.id=l.source_id WHERE l.record_id=?
            ORDER BY s.retained DESC,s.compressed ASC`).all(id).map(dataRow);
        const errors: string[] = [];
        for (const row of rows) {
            try { return await readLocation(cwd, row, hash); }
            catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        }
        return { id, hash_verified: false, available: false, errors };
    } finally { db.close(); }
}
