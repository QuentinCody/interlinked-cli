import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { record, textField } from "./evidence-json.js";
import { collectCompositeScoreReport, type CompositeScoreReport } from "./composite-report.js";

export interface CorpusRepository { name: string; path: string; commit: string; stars: number | null; cohort: "calibration" | "held-out"; }
export interface CorpusRow {
    name: string; commit: string; stars: number | null; cohort: string; status: string;
    artifact?: string; structuralScore?: number | null; observedScore?: number | null; slopScore?: number | null;
    evidenceCompleteness?: number; profileHash?: string; sourceHash?: string; files?: number; functions?: number; durationMs?: number; error?: string;
}
export interface CorpusResult { schemaVersion: 2; modelCalls: 0; repositoryCodeExecuted: false; uniformProfile: boolean; repositories: CorpusRow[]; }
export interface CorpusOptions { manifest: string; out: string; signal?: AbortSignal; progress?: (repository: string, index: number, total: number) => void; }

function parseRepository(value: unknown, directory: string): CorpusRepository {
    const row = record(value, "corpus repository"), commit = textField(row.commit, "commit");
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Corpus commit must be a full SHA");
    const stars = row.stars;
    if (stars !== undefined && stars !== null && (typeof stars !== "number" || !Number.isSafeInteger(stars) || stars < 0)) throw new Error("Invalid star count");
    return { name: textField(row.name, "name"), path: resolve(directory, textField(row.path, "path")), commit,
        stars: typeof stars === "number" ? stars : null, cohort: row.cohort === "held-out" ? "held-out" : "calibration" };
}
export function readCorpusManifest(path: string): CorpusRepository[] {
    const json = record(JSON.parse(readFileSync(path, "utf8")), "corpus manifest");
    if (!Array.isArray(json.repositories) || !json.repositories.length) throw new Error("Manifest requires repositories");
    const rows = json.repositories.map(value => parseRepository(value, dirname(path)));
    if (new Set(rows.map(row => row.name)).size !== rows.length) throw new Error("Duplicate repository names");
    return rows;
}
export function verifyCorpusSnapshot(repository: CorpusRepository): void {
    const options = { cwd: repository.path, encoding: "utf8" as const, stdio: "pipe" as const, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 };
    const head = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    if (head !== repository.commit) throw new Error("Repository HEAD differs from pinned commit");
    const status = execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"], options);
    if (status.trim()) throw new Error("Corpus snapshot has tracked or untracked changes");
}
function resultRow(repository: CorpusRepository, report: CompositeScoreReport, artifact: string, durationMs: number): CorpusRow {
    return { name: repository.name, commit: repository.commit, stars: repository.stars, cohort: repository.cohort, artifact,
        status: report.status, structuralScore: report.structuralScore, observedScore: report.observedScore, slopScore: report.slopScore,
        evidenceCompleteness: report.evidenceCompleteness, profileHash: report.profile.hash, sourceHash: report.sourceHash,
        files: report.scope.measuredFiles, functions: report.scope.functions, durationMs };
}
function measureRepository(repository: CorpusRepository, output: string, index: number): CorpusRow {
    const start = performance.now();
    try {
        verifyCorpusSnapshot(repository);
        const report = collectCompositeScoreReport(repository.path);
        verifyCorpusSnapshot(repository);
        const artifact = `${String(index + 1).padStart(3, "0")}.json`;
        writeFileSync(join(output, artifact), `${JSON.stringify(report, null, 2)}\n`);
        return resultRow(repository, report, artifact, performance.now() - start);
    } catch (error) { return { name: repository.name, commit: repository.commit, stars: repository.stars, cohort: repository.cohort,
        status: "failed", error: error instanceof Error ? error.message : String(error) }; }
}
export async function measureCorpus(options: CorpusOptions): Promise<CorpusResult> {
    const repositories = readCorpusManifest(resolve(options.manifest)), output = resolve(options.out);
    mkdirSync(output, { recursive: true });
    const rows: CorpusRow[] = [];
    for (const [index, repository] of repositories.entries()) {
        if (options.signal?.aborted) break;
        options.progress?.(repository.name, index + 1, repositories.length);
        rows.push(measureRepository(repository, output, index));
        writeFileSync(join(output, "progress.json"), JSON.stringify({ completed: rows.length, total: repositories.length, repositories: rows }));
        await new Promise<void>(done => setImmediate(done));
    }
    const profiles = new Set(rows.flatMap(row => row.profileHash ? [row.profileHash] : []));
    const result: CorpusResult = { schemaVersion: 2, modelCalls: 0, repositoryCodeExecuted: false, uniformProfile: profiles.size === 1, repositories: rows };
    writeFileSync(join(output, "corpus.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
}
