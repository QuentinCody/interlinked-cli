/** Versioned, model-independent contracts shared by every scoring adapter. */
export type MeasurementState = "measured" | "not-applicable" | "missing" | "stale" | "unsupported" | "inconclusive";
/**
 * `unlinted` is a file that the repository's own linter configuration excludes (evidence kind `tool-config`). It says "the owners do not lint
 * this path", which holds for generated output, vendored code, examples and scripts alike, so it is NOT the role `generated`.
 */
export type SourceRole = "product" | "test" | "configuration" | "generated" | "fixture" | "vendor" | "documentation" | "asset" | "unlinted";
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
    /** The entity behind a maximum `value`, so a reader can see what the number points at. */
    top?: { file: string; value: number; line?: number; name?: string; declaredGenerated?: true };
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
    /** Set when evidence beyond the path-only role moved this file to `role` but kept it a score input (for example `mocks/` to test). */
    moved?: { from: SourceRole; evidence: RoleEvidence };
    /** The file's own header says it is generated. Self-declared, so the file stays measured; the report labels it. */
    declaredGenerated?: { detail: string };
    /** The file sits in a directory whose files are uniform (`uniform-structure` alone). Not proof: the file stays measured and the report lists the directory. */
    candidateGenerated?: { dir: string; detail: string };
}

export interface InventoryGap { path: string; role: SourceRole; reason: string; }
/**
 * How a file's role was established. Evidence that a GENERATOR wrote it: `path` / `tool-path` (a name only tools write), `marker` (a
 * self-declared header), `attributes` (`.gitattributes` linguist-generated), `generator-config` (a generator's own config or manifest names
 * the output), `generator-command` (a repository script runs a generator with an output path). `shape` is minified text.
 * `uniform-structure` is a directory of near-identical files: alone it only makes a candidate, with a second kind it sets files aside.
 * `tool-config` (a linter exclude) says "not linted by the owner" and gives the role `unlinted`, never `generated`.
 * Every detail names the tool, the file and the line.
 */
export const ROLE_EVIDENCE_KINDS = ["path", "tool-path", "marker", "shape", "tool-config", "attributes", "generator-config", "generator-command", "uniform-structure"] as const;
export type RoleEvidenceKind = typeof ROLE_EVIDENCE_KINDS[number];
export const emptyEvidenceCounts = (): Record<RoleEvidenceKind, number> => Object.fromEntries(ROLE_EVIDENCE_KINDS.map((kind) => [kind, 0])) as Record<RoleEvidenceKind, number>;
export interface RoleEvidence { kind: RoleEvidenceKind; detail: string; }
/** A file kept out of the authored set. `from` is set when the role differs from the path-only role; `lines` only when the content was read. */
export interface ExcludedFile { path: string; role: SourceRole; reason: string; evidence?: RoleEvidence; from?: SourceRole; lines?: number; }
export interface RepositoryInventory {
    version: "interlinked-source-roles-v3" | "interlinked-source-roles-v4" | "interlinked-source-roles-v5";
    root: string;
    discovery: "git" | "filesystem";
    files: InventoryFile[];
    gaps: InventoryGap[];
    excluded: ExcludedFile[];
    inputHash: string;
    sourceHash: string;
    issues: string[];
}
