import { findDeadCodeCandidates } from "../../harness/mutation/dead-code-signal.js";
import type { BehavioralObservations } from "./behavioral-types.js";
import type { StaticMeasurements } from "./static-measurements.js";
import { hashBytes } from "./inventory.js";

export interface DeletionCandidate {
    id: string; file: string; line: number; endLine: number; sourceSha256: string;
    signals: string[]; evidenceIds: string[]; blockers: string[]; priority: "inspect" | "validate-removal";
    verdict: "candidate"; reviewRequired: true;
}

function candidateKey(file: string, line: number): string { return `${file}:${line}`; }

function mutationCandidates(measurements: StaticMeasurements, evidence?: BehavioralObservations): DeletionCandidate[] {
    if (evidence?.state !== "measured") return [];
    return measurements.analysis.files.flatMap(file => {
        const survivors = evidence.mutants.filter(row => row.path === file.input.path && row.outcome === "survived");
        return findDeadCodeCandidates(survivors.map(row => ({ ...row, mutatorName: row.operator }))).map(row => ({
            id: hashBytes(candidateKey(file.input.path, row.line) + file.input.sha256), file: file.input.path, line: row.line, endLine: row.line,
            sourceSha256: file.input.sha256, signals: [row.reason], evidenceIds: [evidence.evidenceId], blockers: [],
            priority: "inspect" as const, verdict: "candidate" as const, reviewRequired: true as const,
        }));
    });
}

export function joinDeletionEvidence(measurements: StaticMeasurements, coverage?: BehavioralObservations, mutation?: BehavioralObservations): DeletionCandidate[] {
    const candidates = new Map<string, DeletionCandidate>();
    for (const finding of measurements.findings.filter(row => row.metric.startsWith("redundancy."))) {
        const key = candidateKey(finding.file, finding.line), previous = candidates.get(key);
        if (previous) { previous.signals.push(finding.message); previous.evidenceIds.push(finding.id); continue; }
        candidates.set(key, { id: hashBytes(key + finding.sourceSha256), file: finding.file, line: finding.line, endLine: finding.endLine,
            sourceSha256: finding.sourceSha256, signals: [finding.message], evidenceIds: [finding.id], blockers: [], priority: "inspect", verdict: "candidate", reviewRequired: true });
    }
    for (const row of mutationCandidates(measurements, mutation)) {
        const key = candidateKey(row.file, row.line), previous = candidates.get(key);
        if (previous) { previous.signals.push(...row.signals); previous.evidenceIds.push(...row.evidenceIds); }
        else candidates.set(key, row);
    }
    for (const candidate of candidates.values()) qualifyCandidate(candidate, measurements, coverage);
    return [...candidates.values()].sort((a, b) => b.signals.length - a.signals.length || a.file.localeCompare(b.file) || a.line - b.line);
}

function qualifyCandidate(candidate: DeletionCandidate, measurements: StaticMeasurements, coverage?: BehavioralObservations): void {
    const graph = measurements.graph;
    if (graph.dynamic || graph.unresolved.length || !graph.entries.length) candidate.blockers.push("Entry/import graph is incomplete");
    if (graph.publicEntries.includes(candidate.file)) candidate.blockers.push("Public entry point may have external consumers");
    const row = coverage?.state === "measured" ? coverage.coverage.find(row => row.path === candidate.file) : undefined;
    if (!row) candidate.blockers.push("No current runtime coverage for this file");
    else if (row.uncoveredLines.some(line => line >= candidate.line && line <= candidate.endLine)) {
        candidate.signals.push("Current test execution leaves candidate lines uncovered; this is not proof of unreachability");
        if (coverage) candidate.evidenceIds.push(coverage.evidenceId);
    }
    if (measurements.analysis.gaps.length) candidate.blockers.push("Source analysis has unmeasured files");
    if (!candidate.blockers.length && candidate.signals.length > 1) candidate.priority = "validate-removal";
}
