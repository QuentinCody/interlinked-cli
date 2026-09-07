import { QUERY_DIMENSIONS, type EvidenceQuery, type EvidenceRecord } from "./types.js";
import { queryTerms, validateEvidenceQuery } from "./query.js";
import { isJsonObject } from "../json-types.js";

export function compactSqlFilter(query: EvidenceQuery): { where: string; values: Array<string | number> } {
    validateEvidenceQuery(query);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    for (const key of QUERY_DIMENSIONS) {
        if (query[key] !== undefined) { clauses.push(`r.${key}=?`); values.push(query[key]); }
    }
    if (query.since !== undefined) { clauses.push("r.time>=?"); values.push(query.since); }
    if (query.until !== undefined) { clauses.push("r.time<=?"); values.push(query.until); }
    for (const [key, field] of [["file", "files"], ["check", "checks"]] as const) {
        if (query[key] !== undefined) { clauses.push(`EXISTS (SELECT 1 FROM json_each(r.extra,'$.${field}') WHERE value=?)`); values.push(query[key]); }
    }
    for (const term of queryTerms(query)) { clauses.push("instr(lower(r.text),?)>0"); values.push(term); }
    return { where: clauses.length ? clauses.join(" AND ") : "1=1", values };
}

export function unpackSqlRecord(value: unknown): EvidenceRecord {
    if (!isJsonObject(value) || typeof value.extra !== "string") throw new Error("invalid index record");
    const extra: unknown = JSON.parse(value.extra);
    if (!isJsonObject(extra)) throw new Error("invalid index metadata");
    const { rid: _rid, extra: _extra, ...columns } = value;
    // SAFETY: records are exclusively produced by insertCompactRecord from EvidenceRecord.
    return { ...columns, ...extra } as unknown as EvidenceRecord;
}
