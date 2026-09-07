import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpusRecords, evidenceHash, readCorpus, scanCorpus, verifyCorpus } from "./corpus.js";
import { createPrivateDirectory, gzipCorpus } from "./snapshot.js";
import { buildLegacyIndex, searchLegacyIndex } from "./legacy.js";
import { buildCompactIndex, searchBoundedIndex, searchCompactIndex, directoryBytes } from "./sqlite.js";
import { buildSegments, searchSegments } from "./segments.js";
import { DirectoryEvidenceStore } from "./object-store.js";
import { publishCloudEvidence, queryCloudEvidence } from "./cloud-client.js";
import type { EvidenceAnswer, EvidenceQuery } from "./types.js";
import { searchEvidenceFts } from "./fts.js";

export const EVIDENCE_ENGINES = ["scan", "gzip", "legacy", "compact", "bounded", "segments", "cloud"] as const;
export type EvidenceEngine = typeof EVIDENCE_ENGINES[number];
export interface BenchmarkJob { corpus: string; out: string; engine: EvidenceEngine; queries: EvidenceQuery[]; repetitions: number; diskBudget: number; endpoint?: string; }
export interface QueryMeasurement { query: EvidenceQuery; total: number; idsHash: string; orderedIdsHash: string; milliseconds: number[]; firstMs: number; p50Ms: number; p95Ms: number; complete: boolean; bytesRead: number; partitionsRead: number; }
export interface EngineMeasurement {
    engine: EvidenceEngine; buildMs: number; storageBytes: number; buildReceipt: unknown;
    queries: QueryMeasurement[]; cpuMicros: number; maxRssKiB: number;
    fts: Array<{ expression: string; idsHash: string; total: number; milliseconds: number[]; complete: boolean }>;
}
interface PreparedEngine { query: (query: EvidenceQuery) => Promise<EvidenceAnswer>; storageBytes: number; receipt: unknown; }
async function prepareEngine(job: BenchmarkJob): Promise<PreparedEngine> {
    if (job.engine === "scan") return { query: (query) => scanCorpus(job.corpus, query), storageBytes: 0, receipt: null };
    if (job.engine === "gzip") {
        const corpus = await gzipCorpus(job.corpus, job.out);
        return { query: (query) => scanCorpus(job.out, query), storageBytes: directoryBytes(job.out), receipt: corpus };
    }
    if (job.engine === "legacy") {
        const receipt = await buildLegacyIndex(job.corpus, job.out);
        return { query: async (query) => searchLegacyIndex(job.out, query), storageBytes: receipt.bytes, receipt };
    }
    if (job.engine === "compact" || job.engine === "bounded") {
        const diskBudget = job.engine === "compact" ? 2 * 1024 ** 3 : job.diskBudget;
        const receipt = await buildCompactIndex(job.corpus, job.out, { diskBudget });
        const query = job.engine === "compact" ? async (value: EvidenceQuery) => searchCompactIndex(job.out, value) : (value: EvidenceQuery) => searchBoundedIndex(job.out, job.corpus, value);
        return { query, storageBytes: receipt.bytes, receipt };
    }
    return prepareSegments(job);
}
async function prepareSegments(job: BenchmarkJob): Promise<PreparedEngine> {
    createPrivateDirectory(job.out);
    const store = new DirectoryEvidenceStore(join(job.out, "objects"));
    const manifest = await buildSegments(job.corpus, store);
    writeFileSync(join(job.out, "segments.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    if (job.engine !== "cloud") return { query: (query) => searchSegments(manifest, store, query), storageBytes: directoryBytes(job.out), receipt: { segments: manifest.segments.length } };
    if (!job.endpoint) throw new Error("cloud benchmark requires --endpoint");
    const token = process.env.INTERLINKED_EVIDENCE_BENCHMARK_TOKEN;
    if (!token) throw new Error("cloud benchmark requires INTERLINKED_EVIDENCE_BENCHMARK_TOKEN");
    const target = { endpoint: job.endpoint, token, project: manifest.corpus.project };
    const id = await publishCloudEvidence(manifest, store, target);
    return { query: (query) => queryCloudEvidence(target, id, query), storageBytes: directoryBytes(job.out), receipt: { id, segments: manifest.segments.length, storage_scope: "local upload artifacts; remote billing/storage unmeasured" } };
}
function percentile(values: number[], fraction: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}
async function measureQuery(run: PreparedEngine, query: EvidenceQuery, repetitions: number): Promise<QueryMeasurement> {
    const times: number[] = [];
    let first: EvidenceAnswer | undefined;
    for (let i = 0; i < repetitions; i++) {
        const start = performance.now();
        const result = await run.query(query);
        times.push(performance.now() - start);
        if (first && evidenceHash(first.ids.join("\n")) !== evidenceHash(result.ids.join("\n"))) throw new Error("query results changed between repetitions");
        first ??= result;
    }
    if (!first) throw new Error("benchmark repetitions must be positive");
    return { query, total: first.total, idsHash: evidenceHash(first.ids.join("\n")), orderedIdsHash: evidenceHash(first.rows.map((row) => row.id).join("\n")),
        milliseconds: times, firstMs: times[0] ?? 0, p50Ms: percentile(times.slice(1), 0.5), p95Ms: percentile(times.slice(1), 0.95),
        complete: first.coverage.complete, bytesRead: first.coverage.bytes, partitionsRead: first.coverage.files };
}
export async function runEvidenceBenchmarkJob(job: BenchmarkJob): Promise<EngineMeasurement> {
    if (!Number.isSafeInteger(job.repetitions) || job.repetitions < 2 || job.repetitions > 30) throw new Error("benchmark repetitions must be 2..30");
    await verifyCorpus(job.corpus);
    const cpu = process.cpuUsage();
    const start = performance.now();
    const engine = await prepareEngine(job);
    const buildMs = performance.now() - start;
    const queries: QueryMeasurement[] = [];
    for (const query of job.queries) queries.push(await measureQuery(engine, query, job.repetitions));
    const fts = measureFts(job);
    const usage = process.cpuUsage(cpu);
    return { engine: job.engine, buildMs, storageBytes: engine.storageBytes, buildReceipt: engine.receipt,
        queries, fts, cpuMicros: usage.user + usage.system, maxRssKiB: process.resourceUsage().maxRSS };
}
function measureFts(job: BenchmarkJob): EngineMeasurement["fts"] {
    if (job.engine !== "legacy" && job.engine !== "compact") return [];
    const engine = job.engine;
    return ['"needle-auth-failure"', "typescript", "error", "café"].map((expression) => {
        const milliseconds: number[] = [];
        let result;
        for (let i = 0; i < job.repetitions; i++) {
            const start = performance.now();
            result = searchEvidenceFts(job.out, engine, expression);
            milliseconds.push(performance.now() - start);
        }
        if (!result) throw new Error("missing FTS measurement");
        return { expression, milliseconds, idsHash: evidenceHash(result.ids.join("\n")), total: result.total, complete: result.complete };
    });
}
async function sampledQueries(corpusRoot: string): Promise<EvidenceQuery[]> {
    const queries: EvidenceQuery[] = [];
    let seen = 0;
    const chosen = new Set<string>();
    for await (const row of corpusRecords(corpusRoot)) {
        if (row.files[0] && !chosen.has("file")) { queries.push({ file: row.files[0], limit: 20 }); chosen.add("file"); }
        for (const key of ["session", "provider", "model", "source", "call"] as const) {
            if (chosen.has(key) || !row[key]) continue;
            queries.push({ [key]: row[key], limit: 20 }); chosen.add(key);
        }
        if (++seen >= 1000 || chosen.size === 6) break;
    }
    return queries;
}
export async function defaultBenchmarkQueries(corpusRoot: string): Promise<EvidenceQuery[]> {
    const corpus = readCorpus(corpusRoot);
    return [{ text: "needle-auth-failure", limit: 20 }, { text: "typescript", limit: 20 },
        { text: "error", limit: 20 }, { provider: "claude", limit: 20 },
        { session: "session-17", limit: 20 }, { file: "src/module-3.ts", limit: 20 },
        { tenant: corpus.tenant, project: corpus.project, limit: 10, offset: 3 },
        { text: "evidence-deliberately-absent-948217", limit: 20 }, ...await sampledQueries(corpusRoot)];
}
