import { compactPlainLog, type PlainCompactResult, type PlainLogName } from "../../commands/compact-plain.js";
import { withFileMutationLock } from "../file-mutation-lock.js";
import { discoverDataFiles } from "./discovery.js";
import { dataIndexPath, dataTransaction, openDataIndex, type DataIndexDatabase } from "./index-schema.js";
import { resolveDataSourceCursor, updateDataSourceAnchor } from "./index-source.js";

interface RotationMapping { old: string; archive: string; live: string; cut: number; }
function moveLocations(db: DataIndexDatabase, mapping: RotationMapping): void {
    const { old, archive, live, cut } = mapping;
    db.prepare(`INSERT OR IGNORE INTO data_locations SELECT ?,offset,end_offset,record_id FROM data_locations
        WHERE source_id=? AND end_offset<=?`).run(archive, old, cut);
    db.prepare(`INSERT OR IGNORE INTO data_locations SELECT ?,offset-?,end_offset-?,record_id FROM data_locations
        WHERE source_id=? AND offset>=?`).run(live, cut, cut, old, cut);
    db.prepare(`INSERT OR IGNORE INTO data_parse_errors SELECT ?,offset,end_offset,kind,message FROM data_parse_errors
        WHERE source_id=? AND end_offset<=?`).run(archive, old, cut);
    db.prepare(`INSERT OR IGNORE INTO data_parse_errors SELECT ?,offset-?,end_offset-?,kind,message FROM data_parse_errors
        WHERE source_id=? AND offset>=?`).run(live, cut, cut, old, cut);
}
function updateRotatedCursor(db: DataIndexDatabase, id: string, cursor: number, total: number): void {
    db.prepare(`UPDATE data_sources SET cursor=?,status=?,indexed_at=?,
        malformed=(SELECT count(*) FROM data_parse_errors WHERE source_id=? AND kind='malformed'),
        oversized=(SELECT count(*) FROM data_parse_errors WHERE source_id=? AND kind='oversized') WHERE id=?`)
        .run(cursor, cursor >= total ? "complete" : "partial", new Date().toISOString(), id, id, id);
}
function relinkRotation(db: DataIndexDatabase, cwd: string, result: PlainCompactResult, old: string, cursor: number): void {
    const files = discoverDataFiles(cwd).files;
    const archive = files.find((file) => file.relativePath === `archive/${result.segment}`);
    const live = files.find((file) => file.relativePath === `${result.log}.jsonl`);
    if (!archive || !live) throw new Error("rotated evidence files could not be discovered");
    const archived = resolveDataSourceCursor(db, archive);
    const current = resolveDataSourceCursor(db, live);
    // Recovery can finalize an already-replaced live file. Its pointers are already relative to the suffix.
    if (current.id === old) return;
    dataTransaction(db, () => {
        const cut = result.archived_bytes;
        moveLocations(db, { old, archive: archived.id, live: current.id, cut });
        updateRotatedCursor(db, archived.id, Math.min(cursor, cut), cut);
        updateRotatedCursor(db, current.id, Math.max(0, cursor - cut), live.bytes);
        updateDataSourceAnchor(db, live, current.id, Math.max(0, cursor - cut));
    });
}

/** Translate existing byte pointers in the same maintenance operation as lossless rotation. */
export function rotateIndexedData(cwd: string, log: PlainLogName, keepRecentBytes: number): PlainCompactResult {
    openDataIndex(cwd).close();
    return withFileMutationLock(dataIndexPath(cwd), () => {
        const db = openDataIndex(cwd);
        try {
            const file = discoverDataFiles(cwd).files.find((entry) => entry.relativePath === `${log}.jsonl`);
            if (!file) return compactPlainLog(log, { cwd, keepRecentBytes });
            const prior = resolveDataSourceCursor(db, file);
            const result = compactPlainLog(log, { cwd, keepRecentBytes });
            if (result.compacted) relinkRotation(db, cwd, result, prior.id, prior.cursor);
            return result;
        } finally { db.close(); }
    }, { waitMs: 0 });
}
