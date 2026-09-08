import type { DataFileLine } from "./line-accumulator.js";
import { isJsonObject } from "../json-types.js";
import type { DiscoveredDataFile } from "./discovery.js";
import type { DataIndexDatabase } from "./index-schema.js";
import { dataTransaction } from "./index-schema.js";
import { assertDataSourceIdentity, updateDataSourceAnchor, type DataSourceCursor } from "./index-source.js";
import { normalizeDataRecord, type NormalizedDataRecord } from "./normalize.js";
import { dataStatement } from "./statement.js";

interface DataBatchContext { db: DataIndexDatabase; file: DiscoveredDataFile; source: DataSourceCursor; cwd: string; }
interface FieldCount { path: string; type: string; count: number; }
interface DataWriteContext extends DataBatchContext { fields: Map<string, FieldCount>; }
export interface DataBatchResult { parsed: number; inserted: number; malformed: number; oversized: number; cursor: number; }

function insertDimensions(context: DataWriteContext, record: NormalizedDataRecord): void {
    const db = context.db;
    const files = dataStatement(db, "INSERT OR IGNORE INTO data_files VALUES (?,?)");
    for (const file of record.files) files.run(record.id, file);
    const checks = dataStatement(db, "INSERT OR IGNORE INTO data_checks VALUES (?,?,?,?)");
    for (const check of record.checks) checks.run(record.id, check.id, check.status, check.severity);
    for (const field of record.fields) {
        const key = JSON.stringify([field.path, field.type]);
        const count = context.fields.get(key) ?? { ...field, count: 0 };
        count.count++; context.fields.set(key, count);
    }
}
function insertRecord(context: DataWriteContext, record: NormalizedDataRecord, bytes: number): boolean {
    const db = context.db;
    const result = dataStatement(db, `INSERT OR IGNORE INTO data_records
        (id,source,category,role,schema_name,event_ms,ingested_at,session,actor,parent_actor,provider,model,
         call_id,kind,phase,tool,decision,origin,text,text_truncated,raw_hash,raw_bytes,input_tokens,output_tokens,cache_read_tokens,row_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, record.source, record.category, record.role, record.schema, record.eventMs, new Date().toISOString(),
        record.session, record.actor, record.parentActor, record.provider, record.model, record.callId,
        record.kind, record.phase, record.tool, record.decision, record.origin, record.text, Number(record.textTruncated),
        record.rawHash, bytes, record.inputTokens, record.outputTokens, record.cacheReadTokens, JSON.stringify(record.summary));
    if (Number(result.changes) === 0) return false;
    dataStatement(db, "INSERT INTO data_text (record_id,text) VALUES (?,?)").run(record.id, record.text);
    insertDimensions(context, record);
    return true;
}
function recordParseError(context: DataBatchContext, line: DataFileLine, reason: string): void {
    context.db.prepare("INSERT OR REPLACE INTO data_parse_errors VALUES (?,?,?,?,?)")
        .run(context.source.id, line.start, line.nextOffset, line.oversized && !line.invalidUtf8 ? "oversized" : "malformed", reason.slice(0, 500));
}
function insertLine(context: DataWriteContext, line: DataFileLine, result: DataBatchResult): void {
    if (!line.nonEmpty) return;
    if (line.invalidUtf8) {
        result.malformed++;
        recordParseError(context, line, "record is not valid UTF-8; raw evidence retained");
        return;
    }
    if (line.oversized || line.text === undefined) {
        result.oversized++;
        recordParseError(context, line, "record exceeds materialization limit; raw evidence retained");
        return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(line.text); }
    catch (error) {
        result.malformed++;
        recordParseError(context, line, error instanceof Error ? error.message : String(error));
        return;
    }
    if (!isJsonObject(parsed)) {
        result.malformed++;
        recordParseError(context, line, "JSONL record is not an object");
        return;
    }
    const record = normalizeDataRecord(parsed, context.file.source, line.text, context.cwd);
    result.parsed++;
    if (insertRecord(context, record, line.end - line.start)) result.inserted++;
    dataStatement(context.db, "INSERT OR IGNORE INTO data_locations VALUES (?,?,?,?)")
        .run(context.source.id, line.start, line.nextOffset, record.id);
}

function writeFieldCounts(context: DataWriteContext): void {
    const insert = dataStatement(context.db, `INSERT INTO data_fields VALUES (?,?,?,?)
        ON CONFLICT(source,path,value_type) DO UPDATE SET occurrences=occurrences+excluded.occurrences`);
    for (const field of context.fields.values()) insert.run(context.file.source.name, field.path, field.type, field.count);
}

/** Records, evidence locations, parse failures and cursor advance commit together. */
export function writeDataBatch(context: DataBatchContext, lines: DataFileLine[]): DataBatchResult {
    return dataTransaction(context.db, () => {
        const state: DataWriteContext = { ...context, fields: new Map() };
        assertDataSourceIdentity(context.file);
        const result: DataBatchResult = { parsed: 0, inserted: 0, malformed: 0, oversized: 0, cursor: context.source.cursor };
        for (const line of lines) {
            if (!line.complete) break;
            insertLine(state, line, result);
            result.cursor = line.nextOffset;
        }
        writeFieldCounts(state);
        context.db.prepare(`UPDATE data_sources SET cursor=?,indexed_at=?,status='partial',error=NULL,
            malformed=malformed+?,oversized=oversized+? WHERE id=?`)
            .run(result.cursor, new Date().toISOString(), result.malformed, result.oversized, context.source.id);
        updateDataSourceAnchor(context.db, context.file, context.source.id, result.cursor);
        return result;
    });
}
