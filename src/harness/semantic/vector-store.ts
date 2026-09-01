import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { interlinkedPath } from "../../lib/interlinked-path.js";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { IndexedFunctionRow, LoadedSemanticIndex, SemanticIndexMeta } from "./types.js";

const GENERATION_PATTERN = /^[A-Za-z0-9._-]+$/;

export function semanticIndexRoot(root: string): string {
    return interlinkedPath(root, "index", "functions");
}

function sha256(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

function vectorsBuffer(vectors: Float32Array[], dimension: number): Buffer {
    const buffer = Buffer.alloc(vectors.length * dimension * Float32Array.BYTES_PER_ELEMENT);
    let offset = 0;
    for (const vector of vectors) {
        if (vector.length !== dimension) throw new Error("vector dimension does not match generation metadata");
        for (const value of vector) {
            if (!Number.isFinite(value)) throw new Error("cannot store a non-finite semantic vector");
            buffer.writeFloatLE(value, offset);
            offset += Float32Array.BYTES_PER_ELEMENT;
        }
    }
    return buffer;
}

function generationId(): string {
    return `${Date.now()}-${randomUUID()}`;
}

export interface GenerationMetadataInput {
    modelFingerprint: string;
    canonicalTokenizer: string;
    repositoryIdentity: string;
    sourceHash: string;
    dimension: number;
    buildStartedAt: string;
    direct: number;
    aggregated: number;
    notIndexed: number;
    unsupported: number;
    includeTests: boolean;
    experimental: boolean;
}

function buildMeta(
    input: GenerationMetadataInput,
    rows: IndexedFunctionRow[],
    functionsData: string,
    vectorsData: Buffer,
): SemanticIndexMeta {
    return {
        schemaVersion: 1,
        modelFingerprint: input.modelFingerprint,
        canonicalTokenizer: input.canonicalTokenizer,
        repositoryIdentity: input.repositoryIdentity,
        sourceHash: input.sourceHash,
        functionCount: rows.length,
        vectorCount: rows.length,
        dimension: input.dimension,
        byteOrder: "little-endian",
        functionsSha256: sha256(functionsData),
        functionsBytes: Buffer.byteLength(functionsData),
        vectorsSha256: sha256(vectorsData),
        vectorsBytes: vectorsData.byteLength,
        buildStartedAt: input.buildStartedAt,
        buildCompletedAt: new Date().toISOString(),
        direct: input.direct,
        aggregated: input.aggregated,
        notIndexed: input.notIndexed,
        unsupported: input.unsupported,
        includeTests: input.includeTests,
        aggregationVersion: "weighted-centroid-v1",
        overlapPercent: 10,
        experimental: input.experimental,
    };
}

export function publishSemanticGeneration(
    root: string,
    rows: IndexedFunctionRow[],
    vectors: Float32Array[],
    metadata: GenerationMetadataInput,
): LoadedSemanticIndex {
    const indexRoot = semanticIndexRoot(root);
    const generations = join(indexRoot, "generations");
    mkdirSync(generations, { recursive: true, mode: 0o700 });
    const generation = generationId();
    const temporary = join(generations, `.building-${generation}`);
    const committed = join(generations, generation);
    mkdirSync(temporary, { mode: 0o700 });
    const functionsData = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
    const vectorData = vectorsBuffer(vectors, metadata.dimension);
    const meta = buildMeta(metadata, rows, functionsData, vectorData);
    const flattened = Float32Array.from(vectors.flatMap((vector) => [...vector]));
    validateIndex({ generation, meta, rows, vectors: flattened }, functionsData, vectorData);
    writeFileSync(join(temporary, "functions.jsonl"), functionsData, { mode: 0o600 });
    writeFileSync(join(temporary, "vectors.f32"), vectorData, { mode: 0o600 });
    writeFileSync(join(temporary, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, committed);
    const currentTemporary = join(indexRoot, `.CURRENT-${randomUUID()}`);
    writeFileSync(currentTemporary, `${generation}\n`, { mode: 0o600 });
    renameSync(currentTemporary, join(indexRoot, "CURRENT"));
    return { generation, meta, rows, vectors: flattened };
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
    return Number.isInteger(value) && typeof value === "number" && value >= minimum;
}

function isChunkRanges(value: unknown): value is Array<[number, number]> {
    return Array.isArray(value) && value.every((range) => Array.isArray(range)
        && range.length === 2
        && isIntegerAtLeast(range[0], 0)
        && isIntegerAtLeast(range[1], range[0]));
}

function validRowIdentity(row: JsonObject): boolean {
    return typeof row.id === "string"
        && typeof row.file === "string"
        && typeof row.qualifiedName === "string"
        && typeof row.declarationKind === "string"
        && typeof row.language === "string";
}

function validRowMeasurements(row: JsonObject): boolean {
    return isIntegerAtLeast(row.line, 1)
        && isIntegerAtLeast(row.endLine, row.line)
        && isIntegerAtLeast(row.canonicalTokens, 0)
        && isIntegerAtLeast(row.modelTokens, 0)
        && isIntegerAtLeast(row.chunkCount, 1)
        && isIntegerAtLeast(row.vectorOffset, 0);
}

function isIndexedFunctionRow(value: unknown): value is IndexedFunctionRow {
    return isJsonObject(value)
        && validRowIdentity(value)
        && validRowMeasurements(value)
        && typeof value.contentHash === "string"
        && typeof value.inputHash === "string"
        && isChunkRanges(value.chunkRanges);
}

function validMetaIdentity(meta: JsonObject): boolean {
    return meta.schemaVersion === 1
        && typeof meta.modelFingerprint === "string"
        && typeof meta.canonicalTokenizer === "string"
        && typeof meta.repositoryIdentity === "string"
        && typeof meta.sourceHash === "string"
        && meta.byteOrder === "little-endian";
}

function validMetaFiles(meta: JsonObject): boolean {
    return typeof meta.functionsSha256 === "string"
        && isIntegerAtLeast(meta.functionsBytes, 0)
        && typeof meta.vectorsSha256 === "string"
        && isIntegerAtLeast(meta.vectorsBytes, 0);
}

function validMetaCounts(meta: JsonObject): boolean {
    return isIntegerAtLeast(meta.functionCount, 0)
        && isIntegerAtLeast(meta.vectorCount, 0)
        && isIntegerAtLeast(meta.dimension, 1)
        && isIntegerAtLeast(meta.direct, 0)
        && isIntegerAtLeast(meta.aggregated, 0)
        && isIntegerAtLeast(meta.notIndexed, 0)
        && isIntegerAtLeast(meta.unsupported, 0);
}

function validMetaBuild(meta: JsonObject): boolean {
    return typeof meta.buildStartedAt === "string"
        && typeof meta.buildCompletedAt === "string"
        && typeof meta.includeTests === "boolean"
        && meta.aggregationVersion === "weighted-centroid-v1"
        && typeof meta.overlapPercent === "number"
        && typeof meta.experimental === "boolean";
}

function isSemanticIndexMeta(value: unknown): value is SemanticIndexMeta {
    return isJsonObject(value)
        && validMetaIdentity(value)
        && validMetaFiles(value)
        && validMetaCounts(value)
        && validMetaBuild(value);
}

function parseRows(data: string): IndexedFunctionRow[] {
    if (data.length === 0) return [];
    return data.trimEnd().split("\n").map((line, index) => {
        const parsed: unknown = JSON.parse(line);
        if (!isIndexedFunctionRow(parsed)) throw new Error(`semantic function row ${index + 1} is malformed`);
        return parsed;
    });
}

function validateIndex(index: LoadedSemanticIndex, functionData: string, vectorData: Buffer): void {
    const { meta, rows } = index;
    // `schemaVersion`/`byteOrder` are literal-typed on `SemanticIndexMeta`
    // (1 / "little-endian") — both callers of `validateIndex` already went
    // through `buildMeta` or the `isSemanticIndexMeta` load-time guard, so a
    // mismatch here is unreachable rather than a runtime possibility.
    if (Buffer.byteLength(functionData) !== meta.functionsBytes || sha256(functionData) !== meta.functionsSha256) {
        throw new Error("semantic function metadata failed integrity validation");
    }
    if (vectorData.byteLength !== meta.vectorsBytes || sha256(vectorData) !== meta.vectorsSha256) {
        throw new Error("semantic vectors failed integrity validation");
    }
    const rowBytes = meta.dimension * Float32Array.BYTES_PER_ELEMENT;
    if (rowBytes <= 0 || vectorData.byteLength % rowBytes !== 0) throw new Error("semantic vector file has an invalid length");
    if (rows.length !== meta.functionCount || rows.length !== meta.vectorCount || rows.length !== vectorData.byteLength / rowBytes) {
        throw new Error("semantic row and vector counts disagree");
    }
    const ids = new Set<string>();
    for (const [indexNumber, row] of rows.entries()) {
        if (ids.has(row.id)) throw new Error(`duplicate semantic function id: ${row.id}`);
        ids.add(row.id);
        if (row.vectorOffset !== indexNumber) throw new Error("semantic vector offset is out of order");
    }
    for (const value of index.vectors) {
        if (!Number.isFinite(value)) throw new Error("semantic vector file contains a non-finite value");
    }
}

export function loadSemanticIndex(root: string, expectedFingerprint?: string): LoadedSemanticIndex {
    const indexRoot = semanticIndexRoot(root);
    const currentPath = join(indexRoot, "CURRENT");
    if (!existsSync(currentPath)) throw new Error("semantic index is absent");
    const generation = readFileSync(currentPath, "utf8").trim();
    if (!GENERATION_PATTERN.test(generation)) throw new Error("semantic CURRENT contains an invalid generation id");
    const directory = join(indexRoot, "generations", generation);
    const parsedMeta: unknown = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
    if (!isSemanticIndexMeta(parsedMeta)) throw new Error("semantic index metadata is malformed");
    const meta = parsedMeta;
    if (expectedFingerprint !== undefined && meta.modelFingerprint !== expectedFingerprint) {
        throw new Error("semantic index model fingerprint does not match the active runtime");
    }
    const functionData = readFileSync(join(directory, "functions.jsonl"), "utf8");
    const vectorData = readFileSync(join(directory, "vectors.f32"));
    const rows = parseRows(functionData);
    if (vectorData.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error("semantic vector file is not aligned to float32 values");
    }
    const vectorCount = vectorData.byteLength / Float32Array.BYTES_PER_ELEMENT;
    const vectors = new Float32Array(vectorCount);
    for (let offset = 0; offset < vectorData.byteLength; offset += Float32Array.BYTES_PER_ELEMENT) {
        vectors[offset / Float32Array.BYTES_PER_ELEMENT] = vectorData.readFloatLE(offset);
    }
    const loaded = { generation, meta, rows, vectors };
    validateIndex(loaded, functionData, vectorData);
    return loaded;
}

export function semanticBuildInProgress(root: string): boolean {
    const generations = join(semanticIndexRoot(root), "generations");
    if (!existsSync(generations)) return false;
    return statSync(generations).isDirectory()
        && readdirSync(generations).some((entry) => entry.startsWith(".building-"));
}
