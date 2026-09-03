import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { computeFunctionTokens, CANONICAL_TOKENIZER_ID } from "../function-tokens/index.js";
import { chunkFunctionInput } from "./chunker.js";
import { loadSemanticConfig } from "./config.js";
import { aggregateFunctionVectors } from "./embed-function.js";
import { buildFunctionEmbeddingInput } from "./function-input.js";
import { discoverSemanticSources, semanticSourceHash } from "./index-discovery.js";
import { semanticModelInstalled } from "./model-install.js";
import { createLlamaRuntime } from "./runtime.js";
import type {
    FunctionEmbeddingChunk,
    IndexedFunctionRow,
    LoadedSemanticIndex,
    LocalEmbeddingRuntime,
} from "./types.js";
import { loadSemanticIndex, publishSemanticGeneration } from "./vector-store.js";

interface PreparedRow {
    row: Omit<IndexedFunctionRow, "modelTokens" | "chunkCount" | "chunkRanges" | "vectorOffset">;
    chunks: FunctionEmbeddingChunk[];
    modelTokens: number;
    code: string;
}

interface CompletedRow {
    row: IndexedFunctionRow;
    vector: Float32Array;
}

export interface SemanticBuildOptions {
    rebuild?: boolean;
    includeTests?: boolean;
    runtime?: LocalEmbeddingRuntime;
}

export interface SemanticBuildResult {
    schemaVersion: 1;
    generation: string;
    fingerprint: string;
    functions: number;
    direct: number;
    aggregated: number;
    reused: number;
    notIndexed: number;
    notIndexedReasons: Array<{ file: string; symbol: string; reason: string }>;
    unsupported: number;
    durationMs: number;
}

function stableId(file: string, symbol: string, kind: string, ordinal: number): string {
    return createHash("sha256").update(`${file}\0${symbol}\0${kind}\0${ordinal}`).digest("hex");
}

function repositoryIdentity(root: string): string {
    let identity = basename(root);
    try {
        identity = execFileSync("git", ["config", "--get", "remote.origin.url"], {
            cwd: root,
            encoding: "utf8",
            timeout: 2_000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim() || identity;
        // interlinked-ignore: empty_catch — no remote configured (local-only
        // repo) is an expected state; the pre-set fallback identity is used.
    } catch {
        // A local-only repository still gets a stable, non-absolute identity.
    }
    return createHash("sha256").update(identity).digest("hex");
}

function priorVectors(root: string, fingerprint: string, rebuild: boolean): Map<string, CompletedRow> {
    if (rebuild) return new Map();
    try {
        const prior = loadSemanticIndex(root, fingerprint);
        return new Map(prior.rows.map((row) => {
            const start = row.vectorOffset * prior.meta.dimension;
            const vector = prior.vectors.slice(start, start + prior.meta.dimension);
            return [row.inputHash, { row, vector }];
        }));
    } catch {
        // No prior index (first build) or an unreadable one — start fresh.
        return new Map();
    }
}

function completedFromPrior(
    base: PreparedRow["row"],
    prior: CompletedRow,
): CompletedRow {
    return {
        row: {
            ...base,
            modelTokens: prior.row.modelTokens,
            chunkCount: prior.row.chunkCount,
            chunkRanges: prior.row.chunkRanges,
            vectorOffset: 0,
        },
        vector: prior.vector,
    };
}

type SemanticSource = ReturnType<typeof discoverSemanticSources>[number];
type SemanticConfig = ReturnType<typeof loadSemanticConfig>;

interface SourceRows {
    /** Rows whose vector was reused from the prior generation. */
    reused: CompletedRow[];
    /** Rows still needing an embedding pass. */
    pending: PreparedRow[];
    /** One entry per function whose chunking threw. */
    notIndexedReasons: Array<{ file: string; symbol: string; reason: string }>;
}

/**
 * Prepares every function row for one source file, or returns null when the
 * file is unsupported (inexact source, or no extractable function tokens).
 */
async function prepareSourceRows(
    source: SemanticSource,
    config: SemanticConfig,
    runtime: LocalEmbeddingRuntime,
    reusable: Map<string, CompletedRow>,
): Promise<SourceRows | null> {
    if (!source.exact) return null;
    const entries = computeFunctionTokens(source.content, source.relativePath);
    if (entries === null) return null;
    const result: SourceRows = { reused: [], pending: [], notIndexedReasons: [] };
    const ordinals = new Map<string, number>();
    for (const entry of entries) {
        const ordinalKey = `${entry.qualifiedName}\0${entry.declarationKind}`;
        const ordinal = ordinals.get(ordinalKey) ?? 0;
        ordinals.set(ordinalKey, ordinal + 1);
        const input = buildFunctionEmbeddingInput(source.content, entry, config.manifest);
        const base = {
            id: stableId(source.relativePath, entry.qualifiedName, entry.declarationKind, ordinal),
            file: source.relativePath,
            qualifiedName: entry.qualifiedName,
            declarationKind: entry.declarationKind,
            language: entry.language,
            line: entry.line,
            endLine: entry.endLine,
            canonicalTokens: entry.canonicalTokens,
            contentHash: input.contentHash,
            inputHash: input.inputHash,
        };
        const cached = reusable.get(input.inputHash);
        if (cached !== undefined) {
            result.reused.push(completedFromPrior(base, cached));
            continue;
        }
        try {
            const prepared = await chunkFunctionInput(input, config.manifest, runtime);
            result.pending.push({
                row: base,
                chunks: prepared.chunks,
                modelTokens: prepared.modelTokens,
                code: input.code,
            });
        } catch (error) {
            result.notIndexedReasons.push({
                file: source.relativePath,
                symbol: entry.qualifiedName,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return result;
}

async function prepareRows(
    root: string,
    runtime: LocalEmbeddingRuntime,
    options: SemanticBuildOptions,
): Promise<{
    completed: CompletedRow[];
    pending: PreparedRow[];
    sourceHash: string;
    unsupported: number;
    notIndexed: number;
    notIndexedReasons: Array<{ file: string; symbol: string; reason: string }>;
    reused: number;
}> {
    const config = loadSemanticConfig(root);
    const sources = discoverSemanticSources(root, config.team, options.includeTests ?? config.team.include_tests);
    const reusable = priorVectors(root, runtime.fingerprint, options.rebuild === true);
    const completed: CompletedRow[] = [];
    const pending: PreparedRow[] = [];
    let unsupported = 0;
    let notIndexed = 0;
    const notIndexedReasons: Array<{ file: string; symbol: string; reason: string }> = [];
    let reused = 0;
    for (const source of sources) {
        const sourceRows = await prepareSourceRows(source, config, runtime, reusable);
        if (sourceRows === null) {
            unsupported++;
            continue;
        }
        completed.push(...sourceRows.reused);
        reused += sourceRows.reused.length;
        pending.push(...sourceRows.pending);
        notIndexed += sourceRows.notIndexedReasons.length;
        notIndexedReasons.push(...sourceRows.notIndexedReasons);
    }
    return {
        completed,
        pending,
        sourceHash: semanticSourceHash(sources),
        unsupported,
        notIndexed,
        notIndexedReasons,
        reused,
    };
}

async function embedPending(
    pending: PreparedRow[],
    dimension: number,
    runtime: LocalEmbeddingRuntime,
): Promise<CompletedRow[]> {
    if (pending.length === 0) return [];
    const allChunks = pending.flatMap((item) => item.chunks.map((chunk) => chunk.text));
    const vectors = await runtime.embed(allChunks);
    const completed: CompletedRow[] = [];
    let cursor = 0;
    for (const item of pending) {
        const chunkVectors = vectors.slice(cursor, cursor + item.chunks.length);
        cursor += item.chunks.length;
        completed.push({
            row: {
                ...item.row,
                modelTokens: item.modelTokens,
                chunkCount: item.chunks.length,
                chunkRanges: item.chunks.map((chunk) => [
                    Buffer.byteLength(item.code.slice(0, chunk.sourceStart), "utf8"),
                    Buffer.byteLength(item.code.slice(0, chunk.sourceEnd), "utf8"),
                ]),
                vectorOffset: 0,
            },
            vector: aggregateFunctionVectors(chunkVectors, item.chunks, dimension),
        });
    }
    if (cursor !== vectors.length) throw new Error("embedding runtime returned extra chunk vectors");
    return completed;
}

function orderedRows(completed: CompletedRow[]): CompletedRow[] {
    return completed.sort((a, b) => a.row.file.localeCompare(b.row.file)
        || a.row.line - b.row.line
        || a.row.qualifiedName.localeCompare(b.row.qualifiedName));
}

export async function buildSemanticIndex(root: string, options: SemanticBuildOptions = {}): Promise<SemanticBuildResult> {
    const started = Date.now();
    const buildStartedAt = new Date(started).toISOString();
    const config = loadSemanticConfig(root);
    const includeTests = options.includeTests ?? config.team.include_tests;
    if (options.runtime === undefined && !semanticModelInstalled(config.manifest)) {
        throw new Error(`semantic model is not installed; run interlinked semantic install --model ${config.manifest.alias}`);
    }
    const runtime = options.runtime ?? await createLlamaRuntime(config.manifest, config.local);
    const prepared = await prepareRows(root, runtime, options);
    const embedded = await embedPending(prepared.pending, config.manifest.dimension, runtime);
    const completed = orderedRows([...prepared.completed, ...embedded]);
    const rows = completed.map((item, vectorOffset) => ({ ...item.row, vectorOffset }));
    const direct = rows.filter((row) => row.chunkCount === 1).length;
    const aggregated = rows.filter((row) => row.chunkCount > 1).length;
    const index: LoadedSemanticIndex = publishSemanticGeneration(
        root,
        rows,
        completed.map((item) => item.vector),
        {
            modelFingerprint: runtime.fingerprint,
            canonicalTokenizer: CANONICAL_TOKENIZER_ID,
            repositoryIdentity: repositoryIdentity(root),
            sourceHash: prepared.sourceHash,
            dimension: config.manifest.dimension,
            buildStartedAt,
            direct,
            aggregated,
            notIndexed: prepared.notIndexed,
            unsupported: prepared.unsupported,
            includeTests,
            experimental: config.manifest.experimental,
        },
    );
    return {
        schemaVersion: 1,
        generation: index.generation,
        fingerprint: runtime.fingerprint,
        functions: rows.length,
        direct,
        aggregated,
        reused: prepared.reused,
        notIndexed: prepared.notIndexed,
        notIndexedReasons: prepared.notIndexedReasons,
        unsupported: prepared.unsupported,
        durationMs: Date.now() - started,
    };
}
