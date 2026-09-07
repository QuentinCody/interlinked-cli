import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { corpusRecords, readCorpus, verifyCorpus } from "./corpus.js";
import { createPrivateDirectory } from "./snapshot.js";
import { foldEvidenceText, queryTerms, validateEvidenceQuery } from "./query.js";
import { QUERY_DIMENSIONS, emptyCoverage, type EvidenceQuery } from "./types.js";

export interface AnalyticsScope { tenant: string; project: string; table: string; }
export interface R2SqlTarget extends AnalyticsScope { account: string; bucket: string; token: string; }
function sqlLiteral(value: string): string {
    if (value.includes("\0")) throw new Error("SQL string contains NUL");
    return `'${value.replaceAll("'", "''")}'`;
}
export function evidenceAnalyticsSql(scope: AnalyticsScope, query: EvidenceQuery): string {
    validateEvidenceQuery(query);
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(scope.table)) throw new Error("table must be namespace.table with simple identifiers");
    if (!scope.tenant || !scope.project) throw new Error("analytics query requires tenant and project");
    if (query.tenant !== undefined && query.tenant !== scope.tenant) throw new Error("foreign tenant");
    if (query.project !== undefined && query.project !== scope.project) throw new Error("foreign project");
    if (query.file !== undefined || query.check !== undefined) throw new Error("analytics array membership is not implemented; use a local engine for file/check filters");
    const conditions = analyticsConditions(scope, query);
    const table = scope.table.split(".").map((part) => `"${part}"`).join(".");
    return `SELECT DISTINCT "id", "event_ms" FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY "event_ms" DESC NULLS LAST, "id" LIMIT ${query.limit ?? 20} OFFSET ${query.offset ?? 0}`;
}
function analyticsConditions(scope: AnalyticsScope, query: EvidenceQuery): string[] {
    const conditions = [`"tenant"=${sqlLiteral(scope.tenant)}`, `"project"=${sqlLiteral(scope.project)}`];
    for (const key of QUERY_DIMENSIONS) {
        if (key === "tenant" || key === "project" || query[key] === undefined) continue;
        conditions.push(`"${key}"=${sqlLiteral(query[key])}`);
    }
    if (query.since !== undefined) conditions.push(`"event_ms">=${query.since}`);
    if (query.until !== undefined) conditions.push(`"event_ms"<=${query.until}`);
    for (const term of queryTerms(query)) conditions.push(`strpos("text_ascii_folded",${sqlLiteral(term)})>0`);
    return conditions;
}
/** Produces an explicit local ingestion artifact, not an Iceberg table or a raw-log replacement. */
export async function exportEvidenceAnalytics(root: string, out: string): Promise<unknown> {
    await verifyCorpus(root);
    createPrivateDirectory(out);
    const fd = openSync(join(out, "analytics.jsonl"), "wx", 0o600);
    const coverage = emptyCoverage();
    const seen = new Set<string>();
    let bytes = 0;
    try {
        for await (const record of corpusRecords(root, coverage)) {
            if (seen.has(record.id)) continue;
            seen.add(record.id);
            const { text, time, ...fields } = record;
            const line = `${JSON.stringify({ ...fields, event_ms: time, text_ascii_folded: foldEvidenceText(text) })}\n`;
            writeSync(fd, line); bytes += Buffer.byteLength(line);
        }
    } finally { closeSync(fd); }
    const receipt = { version: 1, corpus: readCorpus(root), records: seen.size, bytes, coverage,
        format: "JSONL ingestion artifact; event_ms is nullable float64, truncated is boolean, offsets are int64, files/checks are string arrays; remaining fields are nullable strings",
        next: "Create an R2 Data Catalog Iceberg table with this schema and ingest through an Iceberg writer or Cloudflare Pipelines. This command does not upload or create cloud resources." };
    writeFileSync(join(out, "analytics.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
    return receipt;
}
export async function queryR2Sql(target: R2SqlTarget, query: EvidenceQuery, request: typeof fetch = fetch): Promise<unknown> {
    if (!/^[a-f0-9]{32}$/i.test(target.account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(target.bucket) || !target.token) throw new Error("invalid R2 SQL account, bucket or token");
    const sql = evidenceAnalyticsSql(target, query);
    const endpoint = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${target.account}/r2-sql/query/${target.bucket}`;
    const response = await request(endpoint, { method: "POST", body: JSON.stringify({ query: sql }),
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`R2 SQL request failed: HTTP ${response.status}`);
    return { sql, response: await response.json(), coverage: "bounded analytics page; full ID-set correctness, catalog freshness and billing require a deployed evaluation" };
}
