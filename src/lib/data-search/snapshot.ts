import { closeSync, constants, copyFileSync, createReadStream, createWriteStream, lstatSync, mkdirSync, openSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { discoverDataFiles } from "../data/discovery.js";
import { readDataLines } from "../data/stream.js";
import { corpusPath, evidenceHash, hashEvidenceFile, readCorpus } from "./corpus.js";
import type { CorpusFile, EvidenceCorpus } from "./types.js";

export function createPrivateDirectory(path: string): void {
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    mkdirSync(path, { mode: 0o700 });
}
export function writeCorpusManifest(root: string, corpus: EvidenceCorpus): void {
    writeFileSync(join(root, "corpus.json"), `${JSON.stringify(corpus, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
interface SnapshotInput { path: string; source: string; native: boolean; }
export interface SnapshotOptions {
    cwd: string; out: string; nativeDir?: string; maxBytes: number; maxRecords: number;
    maxFiles?: number; tenant?: string; project?: string;
}
function nativeInputs(root: string, maxFiles: number): SnapshotInput[] {
    const pending = [resolve(root)];
    const files: Array<{ path: string; mtime: number }> = [];
    let entries = 0;
    while (pending.length && entries < 50_000) {
        const directory = pending.pop() ?? root;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (++entries > 50_000) break;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) pending.push(path);
            if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push({ path, mtime: lstatSync(path).mtimeMs });
        }
    }
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles).map((file) => ({ path: file.path, source: "native-claude", native: true }));
}
async function snapshotFile(input: SnapshotInput, output: string, budget: { bytes: number; records: number }): Promise<CorpusFile> {
    const fd = openSync(output, "wx", 0o600);
    let bytes = 0;
    let records = 0;
    try {
        for await (const line of readDataLines(input.path, { maxBytes: budget.bytes })) {
            if (!line.complete || line.text === undefined || records >= budget.records) break;
            const raw = Buffer.from(`${line.text}\n`);
            if (bytes + raw.length > budget.bytes) break;
            writeSync(fd, raw); bytes += raw.length; records++;
        }
    } finally { closeSync(fd); }
    return { path: basename(output), source: input.source, native: input.native, records, bytes, sha256: await hashEvidenceFile(output) };
}
export async function snapshotEvidence(options: SnapshotOptions): Promise<EvidenceCorpus> {
    const maxFiles = options.maxFiles ?? 16;
    const files = options.nativeDir ? nativeInputs(options.nativeDir, maxFiles) : discoverDataFiles(options.cwd).files
        .filter((file) => !file.relativePath.startsWith("index/"))
        .sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, maxFiles)
        .map((file) => ({ path: file.path, source: file.source.name, native: false }));
    if (!files.length) throw new Error("no JSONL sources discovered");
    createPrivateDirectory(options.out);
    const corpus: EvidenceCorpus = { version: 1, tenant: options.tenant ?? "local", project: options.project ?? basename(resolve(options.cwd)),
        created: new Date().toISOString(), kind: options.nativeDir ? "claude-snapshot" : "interlinked-snapshot", files: [], complete: false,
        sampling: `Bounded complete-line prefixes of up to ${maxFiles} recently modified files; ${options.maxBytes} bytes / ${options.maxRecords} records total; native overflow assets not copied` };
    const budget = { bytes: Math.floor(options.maxBytes / files.length), records: Math.floor(options.maxRecords / files.length) };
    if (budget.bytes < 1 || budget.records < 1) throw new Error("snapshot budget smaller than file count");
    for (const [i, input] of files.entries()) corpus.files.push(await snapshotFile(input, join(options.out, `${i}.jsonl`), budget));
    writeCorpusManifest(options.out, corpus);
    return corpus;
}
export async function gzipCorpus(root: string, output: string): Promise<EvidenceCorpus> {
    const corpus = readCorpus(root);
    createPrivateDirectory(output);
    const files: CorpusFile[] = [];
    for (const [i, file] of corpus.files.entries()) {
        const target = `${i}.jsonl.gz`;
        if (file.path.endsWith(".gz")) copyFileSync(corpusPath(root, file.path), join(output, target), constants.COPYFILE_EXCL);
        else await pipeline(createReadStream(corpusPath(root, file.path)), createGzip(), createWriteStream(join(output, target), { flags: "wx", mode: 0o600 }));
        files.push({ ...file, path: target, bytes: lstatSync(join(output, target)).size, sha256: await hashEvidenceFile(join(output, target)) });
    }
    const compressed = { ...corpus, files };
    writeCorpusManifest(output, compressed);
    return compressed;
}
function syntheticRow(index: number, payloadBytes: number): string {
    const entropy = evidenceHash(`evidence-benchmark-seed-20260907:${index}`);
    const marker = index % 97 === 0 ? "needle-auth-failure" : "ordinary-tool-event";
    const payload = (index % 4 === 0 ? entropy : "repeated stable tool output ").repeat(Math.ceil(payloadBytes / 25)).slice(0, payloadBytes);
    return JSON.stringify({ ts: new Date(1_750_000_000_000 + index * 1000).toISOString(), session: `session-${index % 40}`,
        agent: `actor-${index % 7}`, provider: index % 2 ? "claude" : "codex", model: `model-${index % 3}`,
        tool_use_id: `call-${index}`, kind: "tool_result", decision: index % 97 ? "pass" : "fail", origin: "test",
        file: `src/module-${index % 20}.ts`, check: index % 2 ? "typescript" : "lint", message: `${marker} café 日本語 ${payload}` });
}
export async function generateCorpus(output: string, records: number, payloadBytes = 1024): Promise<EvidenceCorpus> {
    if (!Number.isSafeInteger(records) || records < 1 || !Number.isSafeInteger(payloadBytes) || payloadBytes < 0) throw new Error("invalid synthetic corpus dimensions");
    createPrivateDirectory(output);
    const path = join(output, "events.jsonl");
    const fd = openSync(path, "wx", 0o600);
    try { for (let i = 0; i < records; i++) writeSync(fd, `${syntheticRow(i, payloadBytes)}\n`); }
    finally { closeSync(fd); }
    const corpus: EvidenceCorpus = { version: 1, tenant: "benchmark", project: "synthetic", created: new Date().toISOString(), kind: "synthetic",
        files: [{ path: "events.jsonl", source: "tests", native: false, records, bytes: lstatSync(path).size, sha256: await hashEvidenceFile(path) }],
        complete: true, sampling: `Deterministic seed evidence-benchmark-seed-20260907; ${records} events; payload ${payloadBytes} bytes` };
    writeCorpusManifest(output, corpus);
    return corpus;
}
