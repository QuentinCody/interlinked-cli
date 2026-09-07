import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus, platform, release } from "node:os";
import { isJsonObject } from "../json-types.js";
import { evidenceHash, readCorpus } from "./corpus.js";
import { createPrivateDirectory } from "./snapshot.js";
import { defaultBenchmarkQueries, type BenchmarkJob, type EvidenceEngine, type EngineMeasurement } from "./benchmark-worker.js";
import { benchmarkRawGrep } from "./raw-grep.js";

export interface BenchmarkOptions {
    corpus: string; out: string; engines: EvidenceEngine[]; repetitions: number; diskBudget: number;
    launcher: string[]; endpoint?: string;
}
function launchBenchmark(jobPath: string, launcher: string[]): Promise<EngineMeasurement> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...launcher, "data", "lab", "worker", "--job", jobPath], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("benchmark worker exceeded 30 minutes")); }, 30 * 60 * 1000);
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-32_768); });
        child.on("error", (error) => { clearTimeout(timeout); reject(error); });
        child.on("close", (code) => {
            clearTimeout(timeout);
            if (code !== 0) { reject(new Error(`benchmark worker exit ${code}: ${stderr || stdout}`)); return; }
            try {
                const value: unknown = JSON.parse(stdout);
                if (!isJsonObject(value) || !Array.isArray(value.queries)) throw new Error("invalid benchmark response");
                // SAFETY: the child invokes the same version's private benchmark worker.
                resolve(value as unknown as EngineMeasurement);
            } catch (error) { reject(error); }
        });
    });
}
async function runEngines(options: BenchmarkOptions): Promise<{ results: EngineMeasurement[]; failures: Array<{ engine: string; error: string }> }> {
    const results: EngineMeasurement[] = [];
    const failures: Array<{ engine: string; error: string }> = [];
    const queries = await defaultBenchmarkQueries(options.corpus);
    for (const engine of options.engines) {
        const job: BenchmarkJob = { corpus: options.corpus, out: join(options.out, engine), engine,
            queries, repetitions: options.repetitions, diskBudget: options.diskBudget,
            ...(options.endpoint ? { endpoint: options.endpoint } : {}) };
        const path = join(options.out, `${engine}.job.json`);
        writeFileSync(path, JSON.stringify(job), { flag: "wx", mode: 0o600 });
        try {
            const measurement = await launchBenchmark(path, options.launcher);
            results.push(measurement);
            writeFileSync(join(options.out, `${engine}.result.json`), JSON.stringify(measurement, null, 2), { flag: "wx", mode: 0o600 });
        } catch (error) { failures.push({ engine, error: String(error) }); }
    }
    return { results, failures };
}
function compareQueries(results: EngineMeasurement[]) {
    const baseline = results.find((result) => result.engine === "scan");
    return results.flatMap((result) => result.queries.flatMap((query, index) => {
        const expected = baseline?.queries[index];
        return expected && query.idsHash === expected.idsHash && query.orderedIdsHash === expected.orderedIdsHash && query.total === expected.total && query.complete === expected.complete
            ? [] : [{ engine: result.engine, query: index, reason: expected ? "result or coverage differs" : "scan baseline unavailable" }];
    }));
}
function compareFts(results: EngineMeasurement[]) {
    const baseline = results.find((result) => result.engine === "legacy");
    return results.filter((result) => result.engine === "compact").flatMap((result) => result.fts.filter((query, index) => {
        const expected = baseline?.fts[index];
        return expected && (query.idsHash !== expected.idsHash || query.complete !== expected.complete);
    }).map((query) => ({ engine: result.engine, expression: query.expression })));
}
export async function benchmarkEvidence(options: BenchmarkOptions): Promise<Record<string, unknown>> {
    createPrivateDirectory(options.out);
    const corpus = readCorpus(options.corpus);
    const { results, failures } = await runEngines(options);
    const mismatches = compareQueries(results);
    const ftsMismatches = compareFts(results);
    const rawGrep = await benchmarkRawGrep(options.corpus, options.repetitions);
    const report = { version: 1, created: new Date().toISOString(), environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model },
        corpusHash: evidenceHash(readFileSync(join(options.corpus, "corpus.json"))), corpus,
        sourceBytes: corpus.files.reduce((sum, file) => sum + file.bytes, 0), results, failures, mismatches, rawGrep,
        ftsMismatches, correct: failures.length === 0 && mismatches.length === 0 && ftsMismatches.length === 0,
        methodology: "Fresh process per engine. Source verification and build precede query timing; first query is not OS-cold. Warm p50/p95 exclude first repetition. ASCII-folded literal AND terms plus exact dimensions; full matching-ID and ordered page hashes compared. RSS includes runtime/imports. Raw sources and existing production index untouched.",
        unmeasured: ["deployed network latency and billing", "R2 SQL/Iceberg without configured catalog", "Windows/Linux performance", "Claude interactive UI latency"] };
    writeFileSync(join(options.out, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    return report;
}
