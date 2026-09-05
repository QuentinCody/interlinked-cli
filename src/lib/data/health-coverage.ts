import type { JsonObject } from "../json-types.js";
import type { DiscoveredDataFile } from "./discovery.js";

export function indexFileCoverage(file: DiscoveredDataFile, row: JsonObject | undefined): JsonObject {
    const cursor = typeof row?.cursor === "number" ? row.cursor : 0;
    const size = typeof row?.size === "number" ? row.size : 0;
    return { path: file.relativePath, bytes: file.bytes, compressed: file.compressed,
        indexed_at: row?.indexed_at ?? null, status: row?.status ?? "not-indexed",
        cursor_uncompressed: cursor, unindexed_live_bytes: file.compressed ? null : Math.max(0, file.bytes - cursor),
        bytes_since_index_snapshot: row?.identity === file.identity ? Math.max(0, file.bytes - size) : null,
        malformed: row?.malformed ?? 0, oversized: row?.oversized ?? 0 };
}

export function accumulateReceipt(latest: Record<string, unknown>, row: Record<string, unknown>): void {
    latest.receipts_in_window = Number(latest.receipts_in_window ?? 0) + 1;
    latest.failed_receipts_in_window = Number(latest.failed_receipts_in_window ?? 0) + Number(row.status === "failed");
    latest.records_written_in_window = Number(latest.records_written_in_window ?? 0) + (typeof row.records === "number" ? row.records : 0);
    if (row.status === "written" && !latest.last_append_at) latest.last_append_at = row.ts;
    if (row.status === "failed" && !latest.last_failure_at) latest.last_failure_at = row.ts;
}
