import { existsSync } from "node:fs";
import type { JsonObject } from "../json-types.js";
import { dataIndexPath, openDataIndex, type DataIndexDatabase } from "./index-schema.js";
import { dataRow } from "./index-source.js";

export interface DataSearchOptions {
    text?: string | undefined; fts?: boolean | undefined; source?: string | undefined; category?: string | undefined;
    call?: string | undefined;
    session?: string | undefined; actor?: string | undefined; provider?: string | undefined; model?: string | undefined;
    file?: string | undefined; check?: string | undefined; kind?: string | undefined; decision?: string | undefined; origin?: string | undefined;
    sinceMs?: number | undefined; untilMs?: number | undefined; limit?: number | undefined; offset?: number | undefined; archives?: boolean | undefined;
}
export interface DataSearchResult { rows: JsonObject[]; more: boolean; scope: string; index: JsonObject; }
export interface DataSqlFilter { clauses: string[]; values: Array<string | number>; }
const MAX_SEARCH_ROWS = 1000;
const DEFAULT_SEARCH_ROWS = 20;
const FILTER_COLUMNS = ["source", "category", "session", "actor", "provider", "model", "kind", "decision", "origin"] as const;

function textQuery(text: string, raw: boolean): string {
    if (raw) return text;
    return text.trim().split(/\s+/).filter(Boolean).map((word) => `"${word.replace(/"/g, '""')}"`).join(" AND ");
}

function addTimeFilter(filter: DataSqlFilter, field: number | undefined, operator: ">=" | "<="): void {
    if (field === undefined) return;
    if (!Number.isFinite(field)) throw new Error("search timestamp must be finite");
    filter.clauses.push(`r.event_ms ${operator} ?`);
    filter.values.push(field);
}

export function dataSearchFilter(options: DataSearchOptions): DataSqlFilter {
    const result: DataSqlFilter = { clauses: [], values: [] };
    for (const key of FILTER_COLUMNS) {
        const value = options[key];
        if (value === undefined) continue;
        result.clauses.push(`r.${key} = ?`);
        result.values.push(value);
    }
    addTimeFilter(result, options.sinceMs, ">=");
    if (options.call !== undefined) { result.clauses.push("r.call_id = ?"); result.values.push(options.call); }
    addTimeFilter(result, options.untilMs, "<=");
    if (options.file !== undefined) {
        result.clauses.push("EXISTS (SELECT 1 FROM data_files f WHERE f.record_id=r.id AND f.file=?)");
        result.values.push(options.file.replace(/\\/g, "/"));
    }
    if (options.check !== undefined) {
        result.clauses.push("EXISTS (SELECT 1 FROM data_checks c WHERE c.record_id=r.id AND c.check_id=?)");
        result.values.push(options.check);
    }
    const archiveClause = options.archives === false ? " AND s.archived=0" : "";
    result.clauses.push(`EXISTS (SELECT 1 FROM data_locations l JOIN data_sources s ON s.id=l.source_id WHERE l.record_id=r.id AND s.retained=1${archiveClause})`);
    return result;
}

export function dataIndexSummary(db: DataIndexDatabase): JsonObject {
    const counts = dataRow(db.prepare(`SELECT count(*) records,
        sum(event_ms IS NULL) undated_records, sum(origin='unknown') unknown_origin_records,
        sum(text_truncated) text_truncated_records FROM data_records`).get());
    const sources = dataRow(db.prepare(`SELECT count(*) sources,
        sum(s.status!='complete') incomplete_sources,sum(s.malformed) malformed_records,
        sum(s.oversized) oversized_records,max(s.indexed_at) last_indexed_at
        FROM data_sources s JOIN data_heads h ON h.source_id=s.id`).get());
    return { ...counts, ...sources, scope: "indexed evidence; refresh the index to include later appends", timestamp_semantics: "event time; unknown dates excluded from time windows" };
}

export function requireDataIndex(cwd: string): DataIndexDatabase {
    if (!existsSync(dataIndexPath(cwd))) throw new Error("No data index yet — run interlinked data index");
    return openDataIndex(cwd, { readOnly: true });
}

/** Structured filters use bound parameters; optional --fts enables FTS5 query grammar. */
export function searchData(cwd: string, options: DataSearchOptions = {}): DataSearchResult {
    const limit = options.limit ?? DEFAULT_SEARCH_ROWS;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_ROWS) throw new Error(`search limit must be 1..${MAX_SEARCH_ROWS}`);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("search offset must be a nonnegative integer");
    const filter = dataSearchFilter(options);
    const hasText = Boolean(options.text?.trim());
    if (hasText) { filter.clauses.push("data_text MATCH ?"); filter.values.push(textQuery(options.text ?? "", options.fts ?? false)); }
    const textJoin = hasText ? " JOIN data_text ON data_text.record_id=r.id" : "";
    const snippet = hasText ? "snippet(data_text,1,'[',']','…',24)" : "substr(r.text,1,300)";
    const order = hasText ? "bm25(data_text),r.event_ms DESC,r.id" : "r.event_ms DESC,r.id";
    const db = requireDataIndex(cwd);
    try {
        const rows = db.prepare(`SELECT r.id,r.source,r.category,r.role,r.schema_name,r.event_ms,r.ingested_at,
            r.session,r.actor,r.parent_actor,r.provider,r.model,r.call_id,r.kind,r.phase,r.tool,r.decision,
            r.origin,r.text_truncated,${snippet} snippet FROM data_records r${textJoin}
            WHERE ${filter.clauses.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
            .all(...filter.values, limit + 1, offset).map(dataRow);
        return { rows: rows.slice(0, limit), more: rows.length > limit,
            scope: "unique raw records per logical source; duplicate physical locations retained separately", index: dataIndexSummary(db) };
    } finally { db.close(); }
}
