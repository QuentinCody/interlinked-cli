import type { FileLine } from "../bounded-file-io.js";
import { withAsyncFileMutationLock } from "../file-mutation-lock.js";
import { discoverDataFiles, type DiscoveredDataFile } from "./discovery.js";
import { clearDataIndex, dataIndexPath, openDataIndex, type DataIndexDatabase } from "./index-schema.js";
import { dataRow, dataString, resolveDataSourceCursor, type DataSourceCursor } from "./index-source.js";
import { writeDataBatch } from "./index-write.js";
import { readDataLines } from "./stream.js";

export interface DataIndexOptions {
    rebuild?: boolean | undefined;
    maxBytes?: number | undefined; maxRecords?: number | undefined; source?: string | undefined; archives?: boolean | undefined;
    onProgress?: (result: DataIndexProgress) => void;
}
export interface DataIndexProgress {
    files: number; records: number; inserted: number; bytes: number;
    malformed: number; oversized: number; complete: boolean;
    errors: Array<{ path: string; error: string }>;
}
interface IndexRun { db: DataIndexDatabase; cwd: string; options: DataIndexOptions; result: DataIndexProgress; maxBytes: number; maxRecords: number; }
interface FileImport { run: IndexRun; file: DiscoveredDataFile; source: DataSourceCursor; batch: FileLine[]; pending: boolean; exhausted: boolean; }
const BATCH_RECORDS = 250;
const BATCH_BYTES = 4 * 1024 * 1024;
const DEFAULT_RUN_BYTES = 256 * 1024 * 1024;
const DEFAULT_RUN_RECORDS = 250_000;

function commitBatch(state: FileImport): void {
    const { run, file, source } = state;
    const result = writeDataBatch({ db: run.db, cwd: run.cwd, file, source }, state.batch);
    run.result.bytes += result.cursor - source.cursor;
    run.result.records += result.parsed;
    run.result.inserted += result.inserted;
    run.result.malformed += result.malformed;
    run.result.oversized += result.oversized;
    source.cursor = result.cursor;
    state.batch = [];
    run.options.onProgress?.({ ...run.result });
}
function acceptLine(state: FileImport, line: FileLine): boolean {
    if (!line.complete) {
        state.pending = true;
        state.run.result.bytes += line.nextOffset - line.start;
        return false;
    }
    state.batch.push(line);
    if (state.batch.length >= BATCH_RECORDS || line.nextOffset - state.source.cursor >= BATCH_BYTES) commitBatch(state);
    state.exhausted = state.run.result.records + state.batch.length >= state.run.maxRecords;
    return !state.exhausted;
}
async function importFile(run: IndexRun, file: DiscoveredDataFile): Promise<void> {
    const source = resolveDataSourceCursor(run.db, file);
    if (file.compressed && source.status === "complete") return;
    const remaining = run.maxBytes - run.result.bytes;
    if (remaining <= 0) { run.result.complete = false; return; }
    const state: FileImport = { run, file, source, batch: [], pending: false, exhausted: false };
    for await (const line of readDataLines(file.path, { startOffset: source.cursor, maxBytes: remaining })) {
        if (!acceptLine(state, line)) break;
    }
    if (state.batch.length > 0) commitBatch(state);
    const bounded = state.exhausted || run.result.bytes >= run.maxBytes;
    const status = state.pending ? "pending-line" : bounded ? "partial" : "complete";
    run.db.prepare("UPDATE data_sources SET status=?,indexed_at=? WHERE id=?").run(status, new Date().toISOString(), source.id);
    if (state.pending || bounded) run.result.complete = false;
    run.result.files++;
}
async function importSafely(run: IndexRun, file: DiscoveredDataFile): Promise<void> {
    try { await importFile(run, file); }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.result.errors.push({ path: file.relativePath, error: message });
        run.result.complete = false;
        run.db.prepare("UPDATE data_sources SET status='error',error=? WHERE id=(SELECT source_id FROM data_heads WHERE path=?)")
            .run(message.slice(0, 1000), file.relativePath);
    }
}

/** Bounded background-capable projection. Existing evidence is never rewritten. */
async function indexUnlocked(cwd: string, options: DataIndexOptions): Promise<DataIndexProgress> {
    const discovery = discoverDataFiles(cwd);
    const result: DataIndexProgress = {
        files: 0, records: 0, inserted: 0, bytes: 0, malformed: 0, oversized: 0,
        complete: discovery.complete, errors: discovery.issues.map((issue) => ({ path: issue.path, error: issue.reason })),
    };
    const db = openDataIndex(cwd);
    const run: IndexRun = { db, cwd, options, result, maxBytes: options.maxBytes ?? DEFAULT_RUN_BYTES, maxRecords: options.maxRecords ?? DEFAULT_RUN_RECORDS };
    try {
        if (options.rebuild) clearDataIndex(db);
        if (discovery.complete) {
            const present = new Set(discovery.files.map((file) => file.relativePath));
            for (const row of db.prepare("SELECT path FROM data_heads").all()) {
                const path = dataString(dataRow(row), "path");
                if (!present.has(path)) db.prepare("UPDATE data_sources SET retained=0 WHERE path=?").run(path);
            }
        }
        const files = discovery.files.filter((file) => (!options.source || file.source.name === options.source) && (options.archives !== false || !file.archived));
        files.sort((a, b) => Number(a.archived) - Number(b.archived) || a.bytes - b.bytes);
        for (const file of files) {
            if (result.bytes >= run.maxBytes || result.records >= run.maxRecords) { result.complete = false; break; }
            await importSafely(run, file);
        }
        return result;
    } finally { db.close(); }
}

export async function indexData(cwd: string, options: DataIndexOptions = {}): Promise<DataIndexProgress> {
    for (const value of [options.maxBytes, options.maxRecords]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("index budgets must be positive safe integers");
    }
    // Create the private directory before obtaining the exclusive import lease.
    openDataIndex(cwd).close();
    return withAsyncFileMutationLock(dataIndexPath(cwd), () => indexUnlocked(cwd, options));
}
