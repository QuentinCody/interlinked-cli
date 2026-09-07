import type { BehavioralObservations } from "./behavioral-types.js";

export interface EvidenceIdentity {
    sourceHash: string; testHash: string; configurationHash: string; dependencyHash: string;
    inputHash: string; scopeHash: string; supportHash: string;
}
export interface EvidenceRunner { argv: string[]; version: string; operatorPolicy: string; environmentHash: string; }
export type EvidenceOutcome = "passed" | "failed" | "timeout" | "cancelled" | "error";
export interface EvidenceReceipt {
    schemaVersion: 1; kind: "coverage" | "mutation"; identity: EvidenceIdentity; runner: EvidenceRunner;
    startedAt: string; finishedAt: string; durationMs: number; outcome: EvidenceOutcome;
    artifactHash: string; reportRoot: string; origin: "local" | "ci"; issues: string[];
}
export interface StoredEvidence { id: string; receipt: EvidenceReceipt; observations: BehavioralObservations; }
