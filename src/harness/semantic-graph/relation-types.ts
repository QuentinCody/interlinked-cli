import type { Json, MeasurementStatus, RawAnswer } from "../../lib/decision-metrics/types.js";
import type { Unit } from "./types.js";

export type RelationKind = "invariant_membership" | "invariant_role" | "invariant_compatibility" | "invariant_group" | "semantic_coupling";
export type InvariantRole = "enforces" | "assumes" | "propagates" | "reports" | "tests";
export interface InvariantDefinition {
    id: string; version: string; statement: string; applicability: string;
    clauses: string[]; exceptions: string[]; participants: string[]; groups: string[][]; contextFiles: string[];
}
export interface ScenarioDefinition { id: string; version: string; statement: string; applicability: string; invariantId: string; }
export interface RelationPolicy { version: 1; invariants: InvariantDefinition[]; scenarios: ScenarioDefinition[]; }
export interface PolicyReference { revision: string | null; blobs: Record<string, string>; digest: string; exploratory: boolean; policy: RelationPolicy; }
export interface HistoryBoundary { tip: string; since: string; until: string; maxCommits: number; }
export interface HistoryEvidence {
    status: "available" | "unavailable"; boundary: HistoryBoundary; commits: string[];
    map: Record<string, string[]>; digest: string; reason: string | null; complete: boolean;
}
export interface RelationSnapshot {
    schema: "interlinked.relation-snapshot/1"; repository: string; revision: string; tree: string;
    files: Record<string, { text: string; hash: string }>;
    units: Unit[]; history: HistoryEvidence; omitted: string[]; digest: string;
}
export interface RelationPacket {
    schema: "interlinked.relation-packet/1"; id: string; logicalKey: string;
    kind: RelationKind; populationId: string; unit: "pair" | "group";
    participants: string[]; invariantId: string; scenarioId: string | null; queriedRole: InvariantRole | null;
    expectedParticipants: string[];
    evidence: Record<string, Json>; dependencies: Record<string, string>;
    complete: boolean; missing: string[]; evidenceHash: string;
}
export interface EngineSpec {
    id: string; backend: "ollama" | "typesafe" | "haiku"; model: string; identity: string;
    command: string | null; endpoint: string | null; effort: "low" | null;
    maxCalls: number; maxUsd: number; timeoutMs: number; band: readonly [number, number];
}
export interface RelationJob {
    id: string; side: "single" | "before" | "after"; snapshot: RelationSnapshot;
    packets: RelationPacket[]; engine: EngineSpec;
}
export interface CandidateCoverage {
    invariantId: string; method: "shared_rules" | "lexical" | "embedding" | "curated";
    mode: "curated" | "retrieved"; limit: number; universe: number; selected: string[];
    reference: string[]; recovered: string[]; missingSelectors: string[];
    historyAvailable: boolean; omissions: string[];
}
export interface RelationPlan {
    schema: "interlinked.relation-plan/1"; kind: "single_snapshot" | "paired_snapshots";
    id: string; createdAt: string; policy: PolicyReference; jobs: RelationJob[];
    coverage: CandidateCoverage[]; sourcePlans: string[]; experimental: boolean;
    unmatched: string[];
    contractDigest: string;
}
export interface RelationMeasurement {
    schemaVersion: 2; id: string; jobId: string; packetId: string; logicalKey: string;
    armId: string; recordKind: RelationKind; populationId: string; unit: "pair" | "group";
    status: MeasurementStatus; choice: string | null; raw: RawAnswer | null; reason: string | null;
    evidenceHash: string; fingerprint: string; contractHash: string;
    requestedModel: string; servedModel: string | null; engineIdentity: string;
    startedAt: string; durationMs: number; cached: boolean; calls: number;
    costUsd: number | null; inputTokens: number | null; response: Json | null;
    probabilitySource: "backend_distribution" | "self_report" | "unavailable";
    /** Present on current observations; absent only on earlier relation-run/2 artifacts. */
    snapshotDigest?: string;
}
export interface RelationRun {
    schema: "interlinked.relation-run/2"; id: string; plan: RelationPlan;
    measurements: RelationMeasurement[]; completedAt: string; complete: boolean;
}
