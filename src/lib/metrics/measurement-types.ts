/** Versioned, model-independent contracts shared by every scoring adapter. */
export type MeasurementState = "measured" | "not-applicable" | "missing" | "stale" | "unsupported" | "inconclusive";
export type SourceRole = "product" | "test" | "configuration" | "generated" | "fixture" | "vendor" | "documentation" | "asset";
export type QualityDimension = "structure" | "file_size" | "coverage" | "mutation" | "test_integrity" | "redundancy" | "types" | "architecture" | "correctness" | "contracts";
export type CheckDisposition = "scored" | "supporting" | "advisory" | "enforcement";

export interface MetricDefinition {
    id: string;
    name: string;
    dimension: QualityDimension;
    unit: string;
    denominator: string;
    roles: readonly SourceRole[];
    languages: readonly string[];
    direction: "lower" | "higher";
    knots: readonly (readonly [number, number])[];
    evidence: "syntax" | "graph" | "typed" | "coverage" | "mutation" | "checks";
    limitations: readonly string[];
}

export interface MetricReading {
    id: string;
    state: MeasurementState;
    value: number | null;
    numerator: number | null;
    denominator: number | null;
    score: number | null;
    measuredEntities: number;
    eligibleEntities: number;
    evidenceIds: string[];
    limitations: string[];
    details?: Record<string, number>;
}

export interface QualityFinding {
    id: string;
    metric: string;
    file: string;
    line: number;
    endLine: number;
    severity: "error" | "warning";
    evidence: "proven" | "heuristic";
    message: string;
    sourceSha256: string;
    related: string[];
}

export interface AdapterResult {
    metrics: MetricReading[];
    findings: QualityFinding[];
}

export interface InventoryFile {
    path: string;
    role: SourceRole;
    language: string | null;
    sha256: string;
    content: string;
}

export interface InventoryGap { path: string; role: SourceRole; reason: string; }
export interface RepositoryInventory {
    version: "interlinked-source-roles-v2";
    root: string;
    discovery: "git" | "filesystem";
    files: InventoryFile[];
    gaps: InventoryGap[];
    excluded: { path: string; role: SourceRole; reason: string }[];
    inputHash: string;
    sourceHash: string;
    issues: string[];
}
