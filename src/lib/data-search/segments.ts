import { gunzipSync, gzipSync } from "node:zlib";
import { isJsonObject } from "../json-types.js";
import { readDataLines } from "../data/stream.js";
import { corpusPath, evidenceHash, parseEvidenceCorpus, projectEvidence, readCorpus, verifyCorpus } from "./corpus.js";
import { EvidenceResults } from "./query.js";
import { emptyCoverage, type CorpusFile, type EvidenceAnswer, type EvidenceCorpus, type EvidenceQuery, type SearchCoverage } from "./types.js";

export interface EvidenceObjectStore {
    get(key: string): Promise<Uint8Array>;
    put(key: string, bytes: Uint8Array): Promise<void>;
}
export interface EvidenceSegment {
    key: string; hash: string; storedHash: string; bytes: number; expandedBytes: number;
    file: CorpusFile; start: number; records: number; minTime: number | null; maxTime: number | null;
    sessions: string[] | null;
}
export interface SegmentManifest {
    version: 1; corpus: EvidenceCorpus; segments: EvidenceSegment[]; coverage: SearchCoverage;
}
export const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

function segmentPrefix(corpus: EvidenceCorpus): string {
    return `${evidenceHash(corpus.tenant)}/${evidenceHash(corpus.project)}/`;
}
function describeSegment(raw: Buffer, file: CorpusFile, start: number, corpus: EvidenceCorpus): Omit<EvidenceSegment, "key" | "storedHash" | "bytes"> {
    let offset = start;
    let minTime: number | null = null;
    let maxTime: number | null = null;
    let records = 0;
    const sessions = new Set<string>();
    for (const line of raw.toString("utf8").split("\n")) {
        if (!line.trim()) { offset += Buffer.byteLength(line) + 1; continue; }
        const record = projectEvidence(line, file, corpus, offset, offset + Buffer.byteLength(line));
        offset += Buffer.byteLength(line) + 1;
        if (!record) throw new Error("segment contains a non-object record");
        records++;
        if (record.session) sessions.add(record.session);
        if (record.time !== null) { minTime = Math.min(minTime ?? record.time, record.time); maxTime = Math.max(maxTime ?? record.time, record.time); }
    }
    return { file, start, records, hash: evidenceHash(raw), expandedBytes: raw.length, minTime, maxTime, sessions: sessions.size <= 64 ? [...sessions] : null };
}
async function publishSegment(store: EvidenceObjectStore, raw: Buffer, file: CorpusFile, start: number, corpus: EvidenceCorpus): Promise<EvidenceSegment> {
    const descriptor = describeSegment(raw, file, start, corpus);
    const compressed = gzipSync(raw);
    const storedHash = evidenceHash(compressed);
    const key = `${segmentPrefix(corpus)}${storedHash}.jsonl.gz`;
    await store.put(key, compressed);
    if (evidenceHash(await store.get(key)) !== storedHash) throw new Error("segment durable read-back hash mismatch");
    return { ...descriptor, key, storedHash, bytes: compressed.length };
}
async function segmentFile(root: string, file: CorpusFile, manifest: SegmentManifest, store: EvidenceObjectStore, targetBytes: number): Promise<void> {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let start = 0;
    for await (const line of readDataLines(corpusPath(root, file.path))) {
        if (!line.complete || line.text === undefined) throw new Error("cannot segment incomplete or oversized evidence");
        const raw = Buffer.from(`${line.text}\n`);
        if (raw.length > MAX_SEGMENT_BYTES) throw new Error("single evidence record exceeds segment limit; original preserved");
        if (bytes && bytes + raw.length > targetBytes) {
            manifest.segments.push(await publishSegment(store, Buffer.concat(chunks), file, start, manifest.corpus));
            chunks = []; bytes = 0;
        }
        if (!bytes) start = line.start;
        chunks.push(raw); bytes += raw.length;
        manifest.coverage.bytes += raw.length; manifest.coverage.records++;
    }
    if (bytes) manifest.segments.push(await publishSegment(store, Buffer.concat(chunks), file, start, manifest.corpus));
    manifest.coverage.files++;
}
export async function buildSegments(root: string, store: EvidenceObjectStore, targetBytes = 256 * 1024): Promise<SegmentManifest> {
    if (!Number.isSafeInteger(targetBytes) || targetBytes < 1024 || targetBytes > MAX_SEGMENT_BYTES) throw new Error("invalid segment size");
    await verifyCorpus(root);
    const corpus = readCorpus(root);
    const manifest: SegmentManifest = { version: 1, corpus, segments: [], coverage: emptyCoverage() };
    for (const file of corpus.files) await segmentFile(root, file, manifest, store, targetBytes);
    return manifest;
}
export function segmentMayMatch(segment: EvidenceSegment, query: EvidenceQuery): boolean {
    if (query.source !== undefined && query.source !== segment.file.source) return false;
    if (query.session !== undefined && segment.sessions !== null && !segment.sessions.includes(query.session)) return false;
    if (query.since !== undefined && (segment.maxTime === null || segment.maxTime < query.since)) return false;
    if (query.until !== undefined && (segment.minTime === null || segment.minTime > query.until)) return false;
    return true;
}
export async function readSegment(store: EvidenceObjectStore, manifest: SegmentManifest, segment: EvidenceSegment): Promise<Buffer> {
    if (!segment.key.startsWith(segmentPrefix(manifest.corpus))) throw new Error("segment crosses tenant/project boundary");
    if (segment.expandedBytes > MAX_SEGMENT_BYTES) throw new Error("segment expansion exceeds limit");
    const stored = await store.get(segment.key);
    if (evidenceHash(stored) !== segment.storedHash) throw new Error("stored segment hash mismatch");
    const raw = gunzipSync(stored, { maxOutputLength: MAX_SEGMENT_BYTES });
    if (raw.length !== segment.expandedBytes || evidenceHash(raw) !== segment.hash) throw new Error("segment evidence hash mismatch");
    return raw;
}
/** Recompute pruning metadata before trusting an uploaded catalog. */
export async function verifySegmentDescriptor(store: EvidenceObjectStore, manifest: SegmentManifest, segment: EvidenceSegment): Promise<void> {
    const raw = await readSegment(store, manifest, segment);
    const expected = describeSegment(raw, segment.file, segment.start, manifest.corpus);
    for (const key of ["hash", "expandedBytes", "records", "minTime", "maxTime", "sessions"] as const) {
        if (JSON.stringify(expected[key]) !== JSON.stringify(segment[key])) throw new Error(`segment synopsis mismatch: ${key}`);
    }
}
function searchSegment(raw: Buffer, manifest: SegmentManifest, segment: EvidenceSegment, results: EvidenceResults, coverage: SearchCoverage): void {
    let offset = segment.start;
    for (const line of raw.toString("utf8").split("\n")) {
        if (!line.trim()) { offset += Buffer.byteLength(line) + 1; continue; }
        const record = projectEvidence(line, segment.file, manifest.corpus, offset, offset + Buffer.byteLength(line));
        offset += Buffer.byteLength(line) + 1;
        if (!record) throw new Error("invalid segment record");
        coverage.records++; coverage.truncated += Number(record.truncated); results.add({ ...record, object: segment.key });
    }
}
export async function searchSegments(manifest: SegmentManifest, store: EvidenceObjectStore, query: EvidenceQuery): Promise<EvidenceAnswer> {
    const results = new EvidenceResults(query);
    const coverage = { ...emptyCoverage(), complete: manifest.coverage.complete, errors: [...manifest.coverage.errors] };
    if (query.tenant !== undefined && query.tenant !== manifest.corpus.tenant) return results.answer("segments", coverage);
    if (query.project !== undefined && query.project !== manifest.corpus.project) return results.answer("segments", coverage);
    for (const segment of manifest.segments) {
        if (!segmentMayMatch(segment, query)) continue;
        try {
            const raw = await readSegment(store, manifest, segment);
            coverage.bytes += segment.bytes; coverage.files++;
            searchSegment(raw, manifest, segment, results, coverage);
        } catch (error) { coverage.complete = false; coverage.errors.push(String(error)); }
    }
    return results.answer("segments", coverage);
}
export function parseSegmentManifest(value: unknown): SegmentManifest {
    if (!isJsonObject(value) || value.version !== 1 || !isJsonObject(value.corpus) || !Array.isArray(value.segments)) throw new Error("invalid segment manifest");
    parseEvidenceCorpus(value.corpus);
    if (!isJsonObject(value.coverage) || typeof value.coverage.complete !== "boolean" || !Array.isArray(value.coverage.errors) || !value.coverage.errors.every((error) => typeof error === "string")) throw new Error("invalid segment coverage");
    if (value.segments.length > 100_000) throw new Error("segment manifest count limit exceeded");
    for (const segment of value.segments) validateSegment(segment);
    // SAFETY: ownership, bounded descriptors and every field needed for retrieval are checked.
    return value as unknown as SegmentManifest;
}
function validateSegment(segment: unknown): void {
    if (!isJsonObject(segment) || !isJsonObject(segment.file)) throw new Error("invalid segment");
    const file = segment.file;
    if (!["key", "hash", "storedHash"].every((key) => typeof segment[key] === "string")) throw new Error("invalid segment key/hash");
    if (!["path", "source"].every((key) => typeof file[key] === "string")) throw new Error("invalid segment source");
    if (!["bytes", "expandedBytes", "start", "records"].every((key) => typeof segment[key] === "number" && Number.isSafeInteger(segment[key]) && segment[key] >= 0)) throw new Error("invalid segment bounds");
    if (Number(segment.expandedBytes) > MAX_SEGMENT_BYTES || Number(segment.bytes) > MAX_SEGMENT_BYTES) throw new Error("segment size limit exceeded");
    if (segment.sessions !== null && (!Array.isArray(segment.sessions) || !segment.sessions.every((session) => typeof session === "string"))) throw new Error("invalid session synopsis");
    for (const key of ["minTime", "maxTime"]) if (segment[key] !== null && (typeof segment[key] !== "number" || !Number.isFinite(segment[key]))) throw new Error("invalid segment time");
}
