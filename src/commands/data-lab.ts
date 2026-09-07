import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { OptionValues } from "commander";
import { isJsonObject } from "../lib/json-types.js";
import { generateCorpus, snapshotEvidence } from "../lib/data-search/snapshot.js";
import { benchmarkEvidence } from "../lib/data-search/benchmark.js";
import { EVIDENCE_ENGINES, runEvidenceBenchmarkJob, type BenchmarkJob, type EvidenceEngine } from "../lib/data-search/benchmark-worker.js";
import { executeLabQuery, showLabEvidence } from "../lib/data-search/operations.js";
import { validateEvidenceQuery } from "../lib/data-search/query.js";
import type { EvidenceQuery } from "../lib/data-search/types.js";
import { searchEvidenceFts } from "../lib/data-search/fts.js";
import { exportEvidenceAnalytics, queryR2Sql } from "../lib/data-search/analytics.js";

export type DataLabOperation = "generate" | "snapshot" | "build" | "search" | "show" | "fts" | "analytics-export" | "analytics-query" | "benchmark" | "worker";
function required(options: OptionValues, name: string): string {
    const value: unknown = options[name];
    if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
    return value;
}
function numberOption(options: OptionValues, name: string, min: number, max: number): number {
    const value = Number(options[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
    return value;
}
function engineName(value: string): EvidenceEngine {
    const engine = EVIDENCE_ENGINES.find((name) => name === value);
    if (!engine) throw new Error(`unknown evidence engine: ${value}`);
    return engine;
}
function parseQuery(text: string): EvidenceQuery {
    const value: unknown = JSON.parse(text);
    if (!isJsonObject(value)) throw new Error("query must be an object");
    // SAFETY: every consumed query field is checked by validateEvidenceQuery.
    const query: EvidenceQuery = value;
    validateEvidenceQuery(query);
    return query;
}
function readJob(path: string): BenchmarkJob {
    if (statSync(path).size > 1024 * 1024) throw new Error("oversized benchmark job");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || typeof value.corpus !== "string" || typeof value.out !== "string" || typeof value.engine !== "string" || !Array.isArray(value.queries)) throw new Error("invalid benchmark job");
    const engine = engineName(value.engine);
    return { corpus: value.corpus, out: value.out, engine, queries: value.queries.map((query) => parseQuery(JSON.stringify(query))),
        repetitions: Number(value.repetitions), diskBudget: Number(value.diskBudget), ...(typeof value.endpoint === "string" ? { endpoint: value.endpoint } : {}) };
}
async function executeLab(operation: DataLabOperation, options: OptionValues): Promise<unknown> {
    if (operation === "fts" || operation === "analytics-query") return executeLabExternalQuery(operation, options);
    if (operation === "worker") return runEvidenceBenchmarkJob(readJob(required(options, "job")));
    if (operation === "generate") return generateCorpus(resolve(required(options, "out")), numberOption(options, "records", 1, 1_000_000), numberOption(options, "payloadBytes", 0, 65_536));
    if (operation === "snapshot") return snapshotEvidence({ cwd: resolve(options.cwd ?? process.cwd()), out: resolve(required(options, "out")), nativeDir: options.nativeDir,
        maxBytes: numberOption(options, "maxMb", 1, 1024) * 1024 ** 2, maxRecords: numberOption(options, "records", 1, 1_000_000), maxFiles: numberOption(options, "maxFiles", 1, 1000) });
    const corpus = resolve(required(options, "corpus"));
    if (operation === "show") return showLabEvidence(corpus, required(options, "id"));
    if (operation === "search") return executeLabQuery(corpus, engineName(required(options, "engine")), options.index, parseQuery(required(options, "query")));
    return executeLabBuild(operation, options, corpus);
}
async function executeLabExternalQuery(operation: "fts" | "analytics-query", options: OptionValues): Promise<unknown> {
    const query = parseQuery(required(options, "query"));
    if (operation === "fts") {
        const engine = required(options, "engine");
        if (engine !== "legacy" && engine !== "compact") throw new Error("FTS requires legacy or compact engine");
        if (Object.keys(query).some((key) => key !== "text")) throw new Error("FTS lane accepts only a text expression");
        return searchEvidenceFts(required(options, "index"), engine, query.text ?? "");
    }
    return queryR2Sql({ account: required(options, "account"), bucket: required(options, "bucket"), table: required(options, "table"),
        tenant: required(options, "tenant"), project: required(options, "project"), token: process.env.WRANGLER_R2_SQL_AUTH_TOKEN ?? "" }, query);
}
async function executeLabBuild(operation: "build" | "benchmark" | "analytics-export", options: OptionValues, corpus: string): Promise<unknown> {
    const out = resolve(required(options, "out"));
    if (operation === "analytics-export") return exportEvidenceAnalytics(corpus, out);
    const diskBudget = numberOption(options, "diskMb", 1, 2048) * 1024 ** 2;
    if (operation === "build") return runEvidenceBenchmarkJob({ corpus, out, diskBudget, engine: engineName(required(options, "engine")), queries: [], repetitions: 2, endpoint: options.endpoint });
    const engines = [...new Set(required(options, "engines").split(",").map(engineName))];
    if (!engines.includes("scan")) throw new Error("benchmark requires the scan correctness baseline");
    const report = await benchmarkEvidence({ corpus, out, diskBudget, engines, endpoint: options.endpoint,
        repetitions: numberOption(options, "repetitions", 2, 30), launcher: [...process.execArgv, process.argv[1] ?? ""] });
    if (!report.correct) process.exitCode = 1;
    return report;
}
export async function dataLabCommand(operation: DataLabOperation, options: OptionValues): Promise<void> {
    try { console.log(JSON.stringify(await executeLab(operation, options), null, 2)); }
    catch (error) { console.error(JSON.stringify({ error: String(error) })); process.exitCode = 1; }
}
