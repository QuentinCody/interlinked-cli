import { basename, resolve } from "node:path";
import { discoverDataFiles, type DiscoveredDataFile } from "./discovery.js";
import { readDataLines } from "./stream.js";
import { projectEvidence } from "../data-search/corpus.js";
import { EvidenceResults } from "../data-search/query.js";
import { emptyCoverage, type EvidenceAnswer, type EvidenceCorpus, type EvidenceQuery, type SearchCoverage } from "../data-search/types.js";

export interface DirectScanOptions { maxBytes?: number; maxRecords?: number; archives?: boolean | undefined; raw?: boolean | undefined; fullText?: boolean | undefined; }
interface ScanState { cwd: string; coverage: SearchCoverage; results: EvidenceResults; corpus: EvidenceCorpus; options: DirectScanOptions; maxBytes: number; maxRecords: number; inspected: number; }
function exhausted(state: ScanState): boolean { return state.coverage.bytes >= state.maxBytes || state.inspected >= state.maxRecords; }
async function scanLiveFile(file: DiscoveredDataFile, state: ScanState): Promise<void> {
    const descriptor = { path: file.relativePath, source: file.source.name, bytes: file.bytes, records: 0, sha256: "", native: false };
    state.coverage.files++;
    try {
        for await (const line of readDataLines(file.path, { maxBytes: state.maxBytes - state.coverage.bytes })) {
            state.coverage.bytes += line.nextOffset - line.start;
            state.inspected++;
            acceptLiveLine(line, descriptor, state);
            if (exhausted(state)) { state.coverage.complete = false; break; }
        }
    } catch (error) { state.coverage.complete = false; state.coverage.errors.push(String(error)); }
}
function acceptLiveLine(line: import("./line-accumulator.js").DataFileLine, file: import("../data-search/types.js").CorpusFile, state: ScanState): void {
    const coverage = state.coverage;
    if (!line.complete) { coverage.incomplete++; coverage.complete = false; return; }
    if (!line.nonEmpty) return;
    if (line.invalidUtf8) { coverage.malformed++; coverage.complete = false; return; }
    if (line.text === undefined || line.oversized) { coverage.oversized++; coverage.complete = false; return; }
    try {
        const record = projectEvidence(line.text, file, state.corpus, line.start, line.end, state.cwd);
        if (!record) throw new Error("non-object record");
        coverage.records++; coverage.truncated += Number(record.truncated);
        state.results.add({ ...record, ...(state.options.raw ? { raw: line.text } : {}) }, state.options.fullText ? fullStringValues(line.text) : undefined);
    } catch { coverage.malformed++; coverage.complete = false; }
}
function fullStringValues(raw: string): string {
    const pending: unknown[] = [JSON.parse(raw)];
    const values: string[] = [];
    while (pending.length) {
        const value = pending.pop();
        if (typeof value === "string") values.push(value);
        else if (value && typeof value === "object") for (const child of Object.values(value)) pending.push(child);
    }
    return values.join("\n");
}
/** Searches retained files directly without creating a corpus copy or SQLite database. */
export async function scanLiveEvidence(cwd: string, query: EvidenceQuery, options: DirectScanOptions = {}): Promise<EvidenceAnswer & { scope: Record<string, unknown> }> {
    const maxBytes = options.maxBytes ?? 32 * 1024 ** 2;
    const maxRecords = options.maxRecords ?? 25_000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3) throw new Error("scan byte budget must be 1..1073741824");
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) throw new Error("scan record budget must be 1..1000000");
    const discovery = discoverDataFiles(cwd);
    const files = discovery.files.filter((file) => (options.archives !== false || !file.archived)
        && (query.source === undefined || file.source.name === query.source) && (query.category === undefined || file.source.category === query.category))
        .sort((a, b) => b.modifiedMs - a.modifiedMs || a.relativePath.localeCompare(b.relativePath));
    const corpus: EvidenceCorpus = { version: 1, tenant: "local", project: basename(resolve(cwd)), created: new Date().toISOString(), kind: "interlinked-snapshot", complete: false, sampling: "live bounded scan", files: [] };
    const state: ScanState = { cwd, coverage: emptyCoverage(), results: new EvidenceResults(query), corpus, options, maxBytes, maxRecords, inspected: 0 };
    state.coverage.complete = discovery.complete;
    for (const file of files) {
        if (exhausted(state)) { state.coverage.complete = false; break; }
        await scanLiveFile(file, state);
    }
    return { ...state.results.answer("live-jsonl", state.coverage), scope: { sourceFiles: files.length, maxBytes, maxRecords, inspected: state.inspected,
        order: "complete-line prefixes of most recently modified files; retained gzip archives included unless disabled", live: true,
        text: options.fullText ? "all decoded string values within each readable complete JSONL record" : "bounded normalized string projection",
        retrieval: "use --raw to return the exact observed record text with its SHA-256; scan IDs are separate from data show index IDs" } };
}
