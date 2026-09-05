/** Re-run a pinned, local repository corpus without model calls or target execution. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { isJsonObject } from "../src/lib/json-types.js";
import { collectMetricsScoreReport } from "../src/lib/metrics/score-report.js";

interface CorpusRepository { name: string; path: string; commit: string; stars: number | null; }
interface CorpusOptions { manifest: string; out: string; }

function parseRepository(value: unknown, manifestDirectory: string): CorpusRepository {
    if (!isJsonObject(value)) throw new Error("A corpus entry must be an object");
    if (typeof value.name !== "string" || typeof value.path !== "string") throw new Error("A corpus entry requires name and path");
    if (typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit)) throw new Error("A corpus entry requires a full commit SHA");
    const stars = typeof value.stars === "number" && Number.isFinite(value.stars) ? value.stars : null;
    return { name: value.name, path: resolve(manifestDirectory, value.path), commit: value.commit, stars };
}

function readManifest(path: string): CorpusRepository[] {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || !Array.isArray(value.repositories)) throw new Error("Manifest requires a repositories array");
    if (value.repositories.length === 0) throw new Error("Manifest has no repositories");
    return value.repositories.map(row => parseRepository(row, dirname(path)));
}

function checkSnapshot(repository: CorpusRepository): void {
    const options = { cwd: repository.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 } as const;
    const commit = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    if (commit !== repository.commit) throw new Error("Repository HEAD differs from the manifest commit");
    const changes = execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"], options);
    if (changes.trim()) throw new Error("Corpus snapshots require clean tracked and untracked files");
}

function measureRepository(repository: CorpusRepository, output: string, index: number) {
    try {
        checkSnapshot(repository);
        const report = collectMetricsScoreReport(repository.path);
        checkSnapshot(repository);
        const artifact = `${String(index + 1).padStart(3, "0")}.json`;
        writeFileSync(join(output, artifact), `${JSON.stringify(report, null, 2)}\n`);
        return {
            name: repository.name, commit: repository.commit, stars: repository.stars, artifact,
            status: report.status, structuralScore: report.structuralScore, slopScore: report.slopScore,
            profileHash: report.profileHash, sourceHash: report.sourceHash,
            files: report.scope.measuredFiles, functions: report.scope.functions,
            unmeasuredFiles: report.scope.notMeasured.length, metrics: report.metrics,
        };
    } catch (error) {
        return { name: repository.name, commit: repository.commit, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
}

async function main(): Promise<void> {
    const program = new Command().requiredOption("--manifest <path>").requiredOption("--out <directory>").parse();
    const options = program.opts<CorpusOptions>();
    const manifest = readManifest(resolve(options.manifest));
    const output = resolve(options.out);
    mkdirSync(output, { recursive: true });
    const rows: ReturnType<typeof measureRepository>[] = [];
    for (const [index, repository] of manifest.entries()) {
        process.stderr.write(`[${index + 1}/${manifest.length}] ${repository.name}\n`);
        rows.push(measureRepository(repository, output, index));
        await new Promise<void>(done => setImmediate(done));
    }
    const profileHashes = [...new Set(rows.flatMap(row => row.profileHash ? [row.profileHash] : []))];
    const report = { schemaVersion: 1, modelCalls: 0, repositoryCodeExecuted: false, uniformProfile: profileHashes.length === 1, repositories: rows };
    writeFileSync(join(output, "corpus.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (rows.some(row => row.status === "failed")) process.exitCode = 1;
}

await main();
