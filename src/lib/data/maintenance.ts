import { compactPlainLog, PLAIN_COMPACTABLE_LOGS, type PlainLogName } from "../../commands/compact-plain.js";
import { rotateIndexedData } from "./rotation.js";
import { appendCapturedData, recordCaptureReceipt } from "./capture.js";
import { readDataConfig, type DataConfig } from "./config.js";
import { discoverDataFiles, type DiscoveredDataFile } from "./discovery.js";
import { indexData } from "./indexer.js";

const MIB = 1024 * 1024;
function retentionAction(file: DiscoveredDataFile, config: DataConfig): string {
    if (file.archived) return "preserve-archive";
    if (file.source.retention === "preserve") return "preserve-authoritative-evidence";
    if (file.source.name === "activity") return "explicit-compact-required-for-audit-and-sync-cursors";
    if (!PLAIN_COMPACTABLE_LOGS.some((name) => name === file.source.name)) return "preserve-until-domain-readers-support-rotation";
    return file.bytes >= config.compact_at_mb * MIB ? "eligible-for-lossless-rotation" : "keep-live";
}

interface MaintenanceOptions { execute?: boolean; compact?: boolean; index?: boolean; }
function rotateForMaintenance(cwd: string, log: PlainLogName, bytes: number, indexed: boolean) {
    return indexed ? rotateIndexedData(cwd, log, bytes) : compactPlainLog(log, { cwd, keepRecentBytes: bytes });
}
async function runDataMaintenance(cwd: string, options: MaintenanceOptions) {
    const config = readDataConfig(cwd);
    const discovery = discoverDataFiles(cwd);
    const plan = discovery.files.map((file) => ({ path: file.relativePath, bytes: file.bytes,
        category: file.source.category, role: file.source.role, retention: file.source.retention, action: retentionAction(file, config) }));
    if (!options.execute) return { executed: false, config, plan, deletion_policy: "no evidence deletion", discovery_complete: discovery.complete };
    const shouldIndex = options.index ?? config.auto_index;
    const indexing = shouldIndex ? await indexData(cwd, { maxBytes: config.index_max_mb * MIB, maxRecords: config.index_max_records }) : null;
    const rotations = [];
    if (options.compact || config.auto_compact) {
        for (const log of PLAIN_COMPACTABLE_LOGS) {
            if (!plan.some((file) => file.path === `${log}.jsonl` && file.action === "eligible-for-lossless-rotation")) continue;
            rotations.push(rotateForMaintenance(cwd, log, config.keep_live_mb * MIB, shouldIndex));
        }
    }
    const result = { executed: true, ts: new Date().toISOString(), config, indexing, rotations,
        next_action: "JSONL retained; indexes may be stale after rotation; use data index explicitly to ingest archives and bounded backlog" };
    appendCapturedData({ cwd, producer: "lib/data/maintenance" }, "data-maintenance", [result]);
    return result;
}

export async function maintainData(cwd: string, options: MaintenanceOptions = {}): Promise<Awaited<ReturnType<typeof runDataMaintenance>>> {
    try { return await runDataMaintenance(cwd, options); }
    catch (error) {
        recordCaptureReceipt({ cwd, producer: "lib/data/maintenance" }, { source: "data-maintenance", status: "failed", error: "maintenance-operation-failed" });
        throw error;
    }
}

/** Existing SessionEnd resource governor supplies scheduling and process isolation. */
export function dataMaintenanceJobs(cwd: string): Array<{ name: string; argv: string[] }> {
    try {
        const config = readDataConfig(cwd);
        if (!config.auto_index && !config.auto_compact) return [];
        return [{ name: "data-maintenance", argv: ["data", "maintain", "--execute", "--json"] }];
    } catch {
        recordCaptureReceipt({ cwd, producer: "lib/data/maintenance" }, { source: "data-maintenance", status: "failed", error: "invalid-configuration" });
        return [];
    }
}
