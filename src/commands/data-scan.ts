import type { DataCommandOptions } from "./data.js";
import { resolveTimeBound } from "./query/filters.js";
import { scanLiveEvidence } from "../lib/data/scan.js";
import { QUERY_DIMENSIONS, type EvidenceQuery } from "../lib/data-search/types.js";

function scanQuery(options: DataCommandOptions, text: string | undefined): EvidenceQuery {
    const query: EvidenceQuery = { text: text ?? "" };
    for (const key of [...QUERY_DIMENSIONS, "file", "check"] as const) {
        if (key === "tenant" || key === "project") continue;
        const value = options[key];
        if (value !== undefined) query[key] = value;
    }
    if (options.since !== undefined) query.since = resolveTimeBound(options.since);
    if (options.until !== undefined) query.until = resolveTimeBound(options.until);
    if (options.limit !== undefined) query.limit = Number(options.limit);
    if (options.offset !== undefined) query.offset = Number(options.offset);
    return query;
}
export async function dataScanCommand(options: DataCommandOptions & { raw?: boolean; fullText?: boolean }, text?: string): Promise<void> {
    try {
        const query = scanQuery(options, text);
        console.log(JSON.stringify(await scanLiveEvidence(options.cwd ?? process.cwd(), query, {
            maxBytes: Number(options.maxMb ?? 32) * 1024 ** 2, maxRecords: Number(options.maxRecords ?? 25000), archives: options.archives, raw: options.raw, fullText: options.fullText,
        }), null, options.short ? undefined : 2));
    } catch (error) { console.error(JSON.stringify({ error: String(error) })); process.exitCode = 1; }
}
