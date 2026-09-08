import type { JsonObject } from "../json-types.js";
import { dataRow } from "./index-source.js";
import { dataIndexSummary, dataSearchFilter, requireDataIndex, type DataSearchOptions } from "./search.js";

export type DataView = "sessions" | "files" | "checks" | "usage" | "schema" | "suggestions";
const VIEW_SQL: Record<Exclude<DataView, "schema">, { select: string; join: string; group: string }> = {
    suggestions: { select: "c.check_id,r.source,r.decision,count(*) records,sum(json_extract(r.row_json,'$.shown')=1) shown,sum(json_extract(r.row_json,'$.suppressed')=1) suppressed,avg(json_extract(r.row_json,'$.score')) mean_candidate_score", join: "JOIN data_checks c ON c.record_id=r.id", group: "c.check_id,r.source,r.decision" },
    sessions: { select: "r.session,r.actor,r.provider,count(*) records,count(DISTINCT r.call_id) correlated_ids,min(r.event_ms) first_event_ms,max(r.event_ms) last_event_ms", join: "", group: "r.session,r.actor,r.provider" },
    files: { select: "f.file,count(*) records,count(DISTINCT r.session) sessions,min(r.event_ms) first_event_ms,max(r.event_ms) last_event_ms", join: "JOIN data_files f ON f.record_id=r.id", group: "f.file" },
    checks: { select: "c.check_id,c.status,c.severity,count(*) records,count(DISTINCT r.session) sessions", join: "JOIN data_checks c ON c.record_id=r.id", group: "c.check_id,c.status,c.severity" },
    usage: { select: "r.source,r.session,r.provider,r.model,count(*) records,count(r.input_tokens) measured_input_records,sum(r.input_tokens) input_tokens,sum(r.output_tokens) output_tokens,sum(r.cache_read_tokens) cache_read_tokens", join: "", group: "r.source,r.session,r.provider,r.model" },
};

/** Evidence aggregates; state ledgers must be folded by their domain readers. */
export function dataView(cwd: string, view: DataView, options: DataSearchOptions = {}): JsonObject {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("view limit must be 1..1000");
    const db = requireDataIndex(cwd);
    try {
        if (view === "schema") {
            const rows = db.prepare("SELECT * FROM data_fields WHERE (? IS NULL OR source=?) ORDER BY source,path,value_type LIMIT ?")
                .all(options.source ?? null, options.source ?? null, limit + 1).map(dataRow);
            return { rows: rows.slice(0, limit), more: rows.length > limit, index: dataIndexSummary(db), scope: "observed field shapes; bounded projection, not a validation schema" };
        }
        const filter = dataSearchFilter(options);
        if (view === "suggestions") filter.clauses.push("r.source IN ('suggestion-telemetry','suggestion-outcomes')");
        const query = VIEW_SQL[view];
        const scope = filter.clauses.join(" AND ");
        const where = view === "usage" ? "usage_rank=1 AND (r.input_tokens IS NOT NULL OR r.output_tokens IS NOT NULL)" : scope;
        const rows = db.prepare(`SELECT ${query.select},min(r.id) example_evidence_id FROM ${viewRecordTable(view, scope)} r ${query.join}
            WHERE ${where} GROUP BY ${query.group} ORDER BY records DESC LIMIT ?`)
            .all(...filter.values, limit + 1).map(dataRow);
        return { rows: rows.slice(0, limit), more: rows.length > limit, index: dataIndexSummary(db),
            scope: "indexed unique raw evidence; counts are observations, not causality or execution counts",
            usage_semantics: "costs usage-delta.v1 deduplicated by provider message identity; legacy rows remain observations; never sum across sources" };
    } finally { db.close(); }
}

function viewRecordTable(view: DataView, scope: string): string {
    if (view !== "usage") return "data_records";
    return `(SELECT *,row_number() OVER (PARTITION BY source,
        CASE WHEN source='costs' AND schema_name='usage-delta.v1' THEN call_id ELSE id END
        ORDER BY ingested_at DESC,id) usage_rank FROM data_records r WHERE ${scope})`;
}
