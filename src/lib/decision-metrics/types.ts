// interlinked-tdd: exempt -- type declarations only; runtime contracts are tested in answers/contracts.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Band = readonly [number, number];
export type MeasurementStatus =
    | "answered"
    | "insufficient_evidence"
    | "abstained"
    | "failed"
    | "unassessed";

export interface MetricContract {
    id: string;
    version: string;
    construct: string;
    unit: "function" | "hunk" | "commit" | "pair" | "claim";
    population: string;
    question: string;
    kind: "decide" | "choose" | "score" | "tag";
    on: string[];
    options?: Record<string, string>;
    levels?: string[];
    labels?: string[];
    aggregation: string;
    validation: string;
    adverse?: boolean | string | number;
    phase: "pilot" | "research" | "phase2";
}

export interface EvidenceRecord {
    id: string;
    repository: string;
    revision: string;
    timestamp: string;
    unit: MetricContract["unit"];
    file: string;
    line: number;
    evidence: Record<string, Json>;
    provenance: { extractor: string; sourceHash: string; metricsVersion: string };
    eligible?: boolean;
    reason?: string;
}

export type RawAnswer =
    | { kind: "yes_no"; probability: number }
    | {
          kind: "choice" | "score" | "tag";
          probabilities: Record<string, number>;
          confidence?: number;
      };

export interface Interpretation {
    status: MeasurementStatus;
    value: boolean | string | number | string[] | null;
    reason?: string;
}

export interface Measurement extends Interpretation {
    schemaVersion: 1;
    id: string;
    unitId: string;
    contract: MetricContract;
    record: EvidenceRecord;
    raw: RawAnswer | null;
    band: Band;
    provenance: {
        evidenceVersion: string;
        questionHash: string;
        requestedModel: string;
        servedModel: string | null;
        modelIdentity: string;
        calibrationVersion: "unvalidated";
        aggregationVersion: "semantic-metrics-v1";
        requestHash: string | null;
        requestHashes?: string[];
        questionKey?: string;
        adapterIdentity?: string;
        batch: string[];
        adapterVersion: string;
        cached: boolean;
        durationMs: number;
    };
}

export interface DecisionConfig {
    version: 1;
    enabled: boolean;
    command: string;
    backend: "ollama" | "typesafe" | "liquid" | "openrouter" | "perplexity";
    url: string;
    model: string;
    allowRemote: boolean;
    band: Band;
    metrics: string[];
    deadlineMs: number;
    maxRecords: number;
    maxEvidenceBytes: number;
    maxRequestBytes: number;
    embeddingModel: string;
    ollamaUrl: string;
    hook: { enabled: boolean; deadlineMs: number; maxRecords: number; metrics: string[] };
}

export interface DecisionRun {
    schemaVersion: 1;
    runId: string;
    startedAt: string;
    completedAt: string;
    mode: "plan" | "measure";
    measurements: Measurement[];
    summary: Record<MeasurementStatus, number>;
    population: number;
    measured: number;
    completion: number;
    runtimeFailure?: string;
}
