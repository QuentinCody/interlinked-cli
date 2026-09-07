import type { MeasurementState } from "./measurement-types.js";

export interface CoverageCount { covered: number; total: number; }
export interface CoveredFunction { line: number; endLine: number; count: CoverageCount; }
export interface CoverageObservation {
    path: string; lines: CoverageCount; branches: CoverageCount; functions: CoverageCount;
    spans: CoveredFunction[]; uncoveredLines: number[];
}
export type MutantOutcome = "killed" | "survived" | "no-coverage" | "timeout" | "error" | "ignored";
export interface MutantObservation { id: string; path: string; line: number; column: number; endLine: number; endColumn: number; operator: string; replacement: string; outcome: MutantOutcome; }
export interface BehavioralObservations {
    kind: "coverage" | "mutation"; state: MeasurementState; evidenceId: string; issues: string[];
    coveredFiles: string[]; coverage: CoverageObservation[]; mutants: MutantObservation[];
}
