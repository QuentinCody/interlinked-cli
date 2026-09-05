import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { readFileRange } from "../bounded-file-io.js";
import { isJsonObject, type JsonObject } from "../json-types.js";
import type { DiscoveredDataFile } from "./discovery.js";
import type { DataIndexDatabase } from "./index-schema.js";
import { dataTransaction } from "./index-schema.js";
import { dataRecordHash } from "./normalize.js";

const HEAD_BYTES = 4096;
export interface DataSourceCursor { id: string; cursor: number; status: string; }

export function dataRow(value: unknown): JsonObject {
    if (!isJsonObject(value)) throw new Error("invalid data-index row");
    return value;
}
export function dataNumber(row: JsonObject, key: string): number {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid data-index number: ${key}`);
    return value;
}
export function dataString(row: JsonObject, key: string): string {
    const value = row[key];
    if (typeof value !== "string") throw new Error(`invalid data-index string: ${key}`);
    return value;
}
function headHash(path: string, bytes: number): string {
    return dataRecordHash(readFileRange(path, 0, bytes, HEAD_BYTES).toString("base64"));
}
function canResume(db: DataIndexDatabase, row: JsonObject, file: DiscoveredDataFile): boolean {
    if (row.identity !== file.identity) return false;
    if (!file.compressed && dataNumber(row, "cursor") > file.bytes) return false;
    if (file.bytes === row.size && file.modifiedMs !== row.modified_ms) return false;
    if (file.compressed && (file.bytes !== row.size || file.modifiedMs !== row.modified_ms)) return false;
    const bytes = dataNumber(row, "head_bytes");
    return file.bytes >= bytes && row.head_hash === headHash(file.path, bytes) && anchorMatches(db, row, file);
}

function anchorMatches(db: DataIndexDatabase, source: JsonObject, file: DiscoveredDataFile): boolean {
    const found = db.prepare("SELECT * FROM data_source_anchors WHERE source_id=?").get(dataString(source, "id"));
    if (found === undefined || file.compressed) return true;
    const anchor = dataRow(found);
    const start = dataNumber(anchor, "start"), bytes = dataNumber(anchor, "bytes");
    return file.bytes >= start + bytes && anchor.hash === dataRecordHash(readFileRange(file.path, start, start + bytes, HEAD_BYTES).toString("base64"));
}

export function updateDataSourceAnchor(db: DataIndexDatabase, file: DiscoveredDataFile, id: string, cursor: number): void {
    if (file.compressed) return;
    const bytes = Math.min(HEAD_BYTES, cursor), start = cursor - bytes;
    const hash = dataRecordHash(readFileRange(file.path, start, start + bytes, HEAD_BYTES).toString("base64"));
    db.prepare("INSERT OR REPLACE INTO data_source_anchors VALUES (?,?,?,?)").run(id, start, bytes, hash);
}
function insertSource(db: DataIndexDatabase, file: DiscoveredDataFile): DataSourceCursor {
    const id = randomUUID();
    const bytes = Math.min(HEAD_BYTES, file.bytes);
    db.prepare(`INSERT INTO data_sources
        (id,path,logical_name,identity,head_bytes,head_hash,size,modified_ms,archived,compressed)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, file.relativePath, file.source.name, file.identity,
        bytes, headHash(file.path, bytes), file.bytes, file.modifiedMs, Number(file.archived), Number(file.compressed));
    db.prepare("UPDATE data_sources SET retained=0 WHERE path=? AND id!=?").run(file.relativePath, id);
    db.prepare("INSERT INTO data_heads VALUES (?,?) ON CONFLICT(path) DO UPDATE SET source_id=excluded.source_id")
        .run(file.relativePath, id);
    return { id, cursor: 0, status: "pending" };
}

/** Detect ordinary rotation, truncation and replacement before resuming a byte cursor. */
export function resolveDataSourceCursor(db: DataIndexDatabase, file: DiscoveredDataFile): DataSourceCursor {
    return dataTransaction(db, () => {
        const found = db.prepare("SELECT s.* FROM data_sources s JOIN data_heads h ON h.source_id=s.id WHERE h.path=?").get(file.relativePath);
        if (found !== undefined) {
            const row = dataRow(found);
            if (canResume(db, row, file)) {
                const bytes = Math.min(HEAD_BYTES, file.bytes);
                db.prepare("UPDATE data_sources SET size=?,modified_ms=?,retained=1,head_bytes=?,head_hash=? WHERE id=?")
                    .run(file.bytes, file.modifiedMs, bytes, headHash(file.path, bytes), dataString(row, "id"));
                return { id: dataString(row, "id"), cursor: dataNumber(row, "cursor"), status: dataString(row, "status") };
            }
        }
        return insertSource(db, file);
    });
}
export function assertDataSourceIdentity(file: DiscoveredDataFile): void {
    const stat = lstatSync(file.path);
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (!stat.isFile() || identity !== file.identity || stat.size < file.bytes) {
        throw new Error(`source replaced or truncated during indexing: ${file.relativePath}`);
    }
    if (stat.size === file.bytes && stat.mtimeMs !== file.modifiedMs) {
        throw new Error(`source rewritten during indexing: ${file.relativePath}`);
    }
}
