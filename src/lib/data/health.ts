import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config.js";
import { isJsonObject, type JsonObject } from "../json-types.js";
import { scanJsonlTail } from "../../commands/query/reverse-reader.js";
import { DATA_CATALOG } from "./catalog.js";
import { discoverDataFiles } from "./discovery.js";
import { dataIndexPath } from "./index-schema.js";
import { dataRow } from "./index-source.js";
import { dataIndexSummary, requireDataIndex } from "./search.js";
import { accumulateReceipt, indexFileCoverage } from "./health-coverage.js";

function recentReceipts(cwd: string): Map<string, Record<string, unknown>> {
    const receipts = new Map<string, Record<string, unknown>>();
    scanJsonlTail(join(getDataDir(cwd), "capture-receipts.jsonl"), { maxBytes: 4 * 1024 * 1024, maxRecords: 10_000 }, (row) => {
        const capture = isJsonObject(row.capture) ? row.capture : {};
        const key = JSON.stringify([row.source, row.producer, capture.provider]);
        const latest = receipts.get(key) ?? { ...row };
        accumulateReceipt(latest, row);
        if (typeof row.source === "string") receipts.set(key, latest);
    });
    return receipts;
}

function sourceHealth(receipts: Record<string, unknown>[], present: boolean): string {
    if (receipts.some((receipt) => receipt.status === "failed")) return "failed";
    if (receipts.some((receipt) => receipt.status === "written")) return "observed";
    return receiptState(receipts[0], present);
}

function receiptState(receipt: Record<string, unknown> | undefined, present: boolean): string {
    if (!receipt) return present ? "unmeasured" : "not-observed";
    if (receipt.status === "written") return "observed";
    if (typeof receipt.status === "string") return receipt.status;
    return "unknown";
}

export function dataIndexStatus(cwd: string): JsonObject {
    if (!existsSync(dataIndexPath(cwd))) return { available: false, action: "interlinked data index" };
    const discovery = discoverDataFiles(cwd);
    const db = requireDataIndex(cwd);
    try {
        const indexed = new Map(db.prepare("SELECT s.* FROM data_sources s JOIN data_heads h ON h.source_id=s.id").all().map((value) => {
            const row = dataRow(value); return [row.path, row];
        }));
        const stale = discovery.files.filter((file) => {
            const row = indexed.get(file.relativePath);
            return !row || row.size !== file.bytes || row.modified_ms !== file.modifiedMs || row.identity !== file.identity;
        }).map((file) => file.relativePath);
        const missing = [...indexed.keys()].filter((path) => !discovery.files.some((file) => file.relativePath === path));
        const summary = dataIndexSummary(db);
        return { available: true, ...summary, stale_files: stale, missing_files: missing,
            files: discovery.files.map((file) => indexFileCoverage(file, indexed.get(file.relativePath))),
            discovery_complete: discovery.complete, fresh: discovery.complete && stale.length === 0 && missing.length === 0 && Number(summary.incomplete_sources) === 0 };
    } finally { db.close(); }
}

/** A quiet event-driven producer is not failed merely because its file is old. */
export function dataHealth(cwd: string): JsonObject {
    const discovery = discoverDataFiles(cwd);
    const receipts = recentReceipts(cwd);
    const sources = DATA_CATALOG.map((source) => {
        const files = discovery.files.filter((file) => file.source.name === source.name);
        const producers = [...receipts.values()].filter((receipt) => receipt.source === source.name);
        return { ...source, state: sourceHealth(producers, files.length > 0),
            files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
            last_modified_ms: files.length ? Math.max(...files.map((file) => file.modifiedMs)) : null,
            receipts: JSON.parse(JSON.stringify(producers)) };
    });
    return { sources, files: discovery.files.map((file) => ({ path: file.relativePath, source: file.source.name,
        category: file.source.category, bytes: file.bytes, archived: file.archived, compressed: file.compressed })),
        discovery_complete: discovery.complete, issues: discovery.issues,
        receipt_scope: "latest per source/producer/provider in newest 10,000 receipts / 4 MiB; no receipt means unmeasured",
        index: dataIndexStatus(cwd) };
}
