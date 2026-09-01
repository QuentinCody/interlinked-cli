import type { FunctionDeclarationKind } from "../function-tokens/types.js";

export const SEMANTIC_SCHEMA_VERSION = 1;
const FUNCTION_EMBEDDING_SCHEMA = "function-embedding-v1" as const;
const SEMANTIC_AGGREGATION_VERSION = "weighted-centroid-v1" as const;

export interface EmbeddingArtifactManifest {
    url: string;
    sha256: string;
    bytes: number;
    fileName: string;
}

export interface EmbeddingModelManifest {
    alias: string;
    modelId: string;
    revision: string;
    artifacts: EmbeddingArtifactManifest[];
    tokenizerSha256: string;
    license: string;
    dimension: number;
    maxInputTokens: number;
    pooling: "mean" | "cls" | "model-native";
    quantization: string;
    runtime: string;
    inputSchemaVersion: typeof FUNCTION_EMBEDDING_SCHEMA;
    documentPrefix: string;
    queryPrefix: string;
    experimental: boolean;
}

export interface SemanticTeamConfig {
    version: 1;
    enabled: boolean;
    model: string;
    include_tests: boolean;
    include: string[];
    exclude: string[];
}

export interface SemanticLocalConfig {
    version: 1;
    device: "auto" | "cpu";
    threads: number;
    batch_size: number;
    idle_unload_ms: number;
    incremental_indexing: boolean;
    llama_embedding_command?: string;
    llama_tokenize_command?: string;
}

export interface ResolvedSemanticConfig {
    team: SemanticTeamConfig;
    local: SemanticLocalConfig;
    manifest: EmbeddingModelManifest;
}

export interface LocalEmbeddingRuntime {
    fingerprint: string;
    countTokens(input: string): Promise<number>;
    embed(inputs: string[]): Promise<Float32Array[]>;
}

export interface FunctionEmbeddingInput {
    language: string;
    qualifiedName: string;
    declarationKind: FunctionDeclarationKind;
    signature: string;
    documentation: string;
    code: string;
    text: string;
    inputHash: string;
    contentHash: string;
}

export interface FunctionEmbeddingChunk {
    text: string;
    sourceStart: number;
    sourceEnd: number;
    nonOverlapStart: number;
    nonOverlapEnd: number;
    modelTokens: number;
    weightTokens: number;
}

export interface EmbeddedFunction {
    vector: Float32Array;
    modelTokens: number;
    chunks: FunctionEmbeddingChunk[];
}

export interface IndexedFunctionRow {
    id: string;
    file: string;
    qualifiedName: string;
    declarationKind: string;
    language: string;
    line: number;
    endLine: number;
    canonicalTokens: number;
    modelTokens: number;
    contentHash: string;
    inputHash: string;
    chunkCount: number;
    chunkRanges: Array<[number, number]>;
    vectorOffset: number;
}

export interface SemanticIndexMeta {
    schemaVersion: 1;
    modelFingerprint: string;
    canonicalTokenizer: string;
    repositoryIdentity: string;
    sourceHash: string;
    functionCount: number;
    vectorCount: number;
    dimension: number;
    byteOrder: "little-endian";
    functionsSha256: string;
    functionsBytes: number;
    vectorsSha256: string;
    vectorsBytes: number;
    buildStartedAt: string;
    buildCompletedAt: string;
    direct: number;
    aggregated: number;
    notIndexed: number;
    unsupported: number;
    includeTests: boolean;
    aggregationVersion: typeof SEMANTIC_AGGREGATION_VERSION;
    overlapPercent: number;
    experimental: boolean;
}

export interface LoadedSemanticIndex {
    generation: string;
    meta: SemanticIndexMeta;
    rows: IndexedFunctionRow[];
    vectors: Float32Array;
}

export type SemanticIndexState =
    | "absent"
    | "building"
    | "current"
    | "stale"
    | "corrupt"
    | "model-mismatch"
    | "model-missing"
    | "runtime-missing";

export interface SemanticStatus {
    schemaVersion: 1;
    state: SemanticIndexState;
    generation: string | null;
    modelFingerprint: string;
    reason: string | null;
    meta: SemanticIndexMeta | null;
}

export interface SemanticSearchResult {
    rank: number;
    score: number;
    file: string;
    symbol: string;
    line: number;
    endLine: number;
    language: string;
    canonicalTokens: number;
    modelTokens: number;
    chunkCount: number;
    stale: boolean;
}
