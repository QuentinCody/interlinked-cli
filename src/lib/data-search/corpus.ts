import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isJsonObject } from "../json-types.js";
import { DATA_CATALOG, dataSourceForPath } from "../data/catalog.js";
import { normalizeDataRecord } from "../data/normalize.js";
import { readDataLines } from "../data/stream.js";
import type { DataFileLine } from "../data/line-accumulator.js";
import { type EvidenceCorpus, type CorpusFile, type EvidenceRecord, type SearchCoverage, type EvidenceQuery, type EvidenceAnswer, emptyCoverage } from "./types.js";
import { EvidenceResults } from "./query.js";

export function evidenceHash(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export async function hashEvidenceFile(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}
export function corpusPath(root: string, path: string): string {
    const base = realpathSync(root);
    const candidate = realpathSync(resolve(base, path));
    const rel = relative(base, candidate);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !lstatSync(candidate).isFile()) throw new Error("evidence path escapes corpus or is not a file");
    return candidate;
}
function validCorpusFile(file: unknown): boolean {
    if (!isJsonObject(file)) return false;
    if (!["path", "source", "sha256"].every((key) => typeof file[key] === "string")) return false;
    if (typeof file.native !== "boolean" || !/^[a-f0-9]{64}$/.test(String(file.sha256))) return false;
    return ["bytes", "records"].every((key) => typeof file[key] === "number" && Number.isSafeInteger(file[key]) && file[key] >= 0);
}
export function readCorpus(root: string): EvidenceCorpus {
    const path = corpusPath(root, "corpus.json");
    if (lstatSync(path).size > 8 * 1024 * 1024) throw new Error("corpus manifest exceeds 8 MiB");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parseEvidenceCorpus(value);
}
export function parseEvidenceCorpus(value: unknown): EvidenceCorpus {
    if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.files)) throw new Error("invalid corpus manifest");
    if (!["tenant", "project", "sampling", "created"].every((key) => typeof value[key] === "string")) throw new Error("invalid corpus metadata");
    if (typeof value.complete !== "boolean" || !["synthetic", "interlinked-snapshot", "claude-snapshot"].includes(String(value.kind))) throw new Error("invalid corpus scope");
    if (!value.files.every(validCorpusFile)) throw new Error("invalid corpus file");
    // SAFETY: the manifest and every consumed per-file field were validated above.
    return value as unknown as EvidenceCorpus;
}
export function projectEvidence(raw: string, file: CorpusFile, corpus: EvidenceCorpus, offset: number, end: number, normalizationRoot = "/"): EvidenceRecord | null {
    const value: unknown = JSON.parse(raw);
    if (!isJsonObject(value)) return null;
    const source = DATA_CATALOG.find((entry) => entry.name === file.source)
        ?? dataSourceForPath(file.source.endsWith(".jsonl") ? file.source : `${file.source}.jsonl`);
    const record = normalizeDataRecord(value, { ...source, name: file.source }, raw, normalizationRoot);
    const hash = evidenceHash(raw);
    return { id: evidenceHash(`${corpus.tenant}\0${corpus.project}\0${file.source}\0${hash}`), hash,
        source: file.source, category: record.category, tenant: corpus.tenant, project: corpus.project,
        session: record.session, actor: record.actor, provider: record.provider, model: record.model,
        call: record.callId, kind: record.kind, decision: record.decision, origin: record.origin,
        time: record.eventMs, files: record.files, checks: record.checks.map((check) => check.id),
        text: record.text, truncated: record.textTruncated, path: file.path, offset, end };
}
function parseCorpusLine(line: DataFileLine, file: CorpusFile, corpus: EvidenceCorpus, coverage: SearchCoverage): EvidenceRecord | null {
    coverage.bytes += line.nextOffset - line.start;
    if (!line.complete) { coverage.incomplete++; coverage.complete = false; return null; }
    if (!line.nonEmpty) return null;
    if (line.invalidUtf8) { coverage.malformed++; coverage.complete = false; return null; }
    if (line.oversized || line.text === undefined) { coverage.oversized++; coverage.complete = false; return null; }
    let record: EvidenceRecord | null;
    try { record = projectEvidence(line.text, file, corpus, line.start, line.end); }
    catch { record = null; }
    if (!record) { coverage.malformed++; coverage.complete = false; return null; }
    coverage.records++;
    coverage.truncated += Number(record.truncated);
    return record;
}
export async function* corpusRecords(root: string, coverage: SearchCoverage = emptyCoverage()): AsyncGenerator<EvidenceRecord> {
    const corpus = readCorpus(root);
    for (const file of corpus.files) yield* corpusFileRecords(root, file, corpus, coverage);
}
async function* corpusFileRecords(root: string, file: CorpusFile, corpus: EvidenceCorpus, coverage: SearchCoverage): AsyncGenerator<EvidenceRecord> {
    coverage.files++;
    try {
        const path = corpusPath(root, file.path);
        if (lstatSync(path).size !== file.bytes) throw new Error(`corpus source size changed: ${file.path}`);
        for await (const line of readDataLines(path)) {
            const record = parseCorpusLine(line, file, corpus, coverage);
            if (record) yield record;
        }
    } catch (error) { coverage.complete = false; coverage.errors.push(String(error)); }
}
export async function scanCorpus(root: string, query: EvidenceQuery): Promise<EvidenceAnswer> {
    const coverage = emptyCoverage();
    const result = new EvidenceResults(query);
    for await (const record of corpusRecords(root, coverage)) result.add(record);
    return result.answer("scan", coverage);
}
export async function verifyCorpus(root: string): Promise<void> {
    for (const file of readCorpus(root).files) {
        if (await hashEvidenceFile(corpusPath(root, file.path)) !== file.sha256) throw new Error(`corpus hash mismatch: ${file.path}`);
    }
}
export async function readCorpusEvidence(root: string, record: EvidenceRecord): Promise<string> {
    const manifest = readCorpus(root);
    if (record.tenant !== manifest.tenant || record.project !== manifest.project) throw new Error("evidence scope does not match corpus");
    if (!manifest.files.some((file) => file.path === record.path && file.source === record.source)) throw new Error("unknown corpus source");
    const id = evidenceHash(`${record.tenant}\0${record.project}\0${record.source}\0${record.hash}`);
    if (id !== record.id) throw new Error("evidence ID mismatch");
    for await (const line of readDataLines(corpusPath(root, record.path), { startOffset: record.offset, maxBytes: record.end - record.offset + 1 })) {
        if (line.text !== undefined && evidenceHash(line.text) === record.hash) return line.text;
        break;
    }
    throw new Error("original evidence hash mismatch or unavailable");
}
