import { measureCoverageEvidence, measureMutationEvidence } from "./adapter-behavioral.js";
import { buildMetricCatalog } from "./catalog.js";
import { REVIEWED_REGISTRY_HASH } from "./catalog-review.js";
import { COMPOSITE_PROFILE } from "./composite-profile.js";
import { composeScore, type CompositeResult } from "./composite.js";
import { joinDeletionEvidence, type DeletionCandidate } from "./deletion-evidence.js";
import { loadEvidence } from "./evidence-store.js";
import type { StoredEvidence } from "./evidence-types.js";
import type { InventoryGap, MetricReading, QualityFinding, RepositoryInventory } from "./measurement-types.js";
import { collectStaticMeasurements } from "./static-measurements.js";

export interface CompositeScoreReport extends CompositeResult {
    schemaVersion: 2; profile: typeof COMPOSITE_PROFILE; modelCalls: 0; registryHash: string;
    sourceHash: string; inputHash: string; languages: string[]; structuralScore: number | null;
    scope: { eligibleFiles: number; measuredFiles: number; functions: number; notMeasured: InventoryGap[]; exclusions: RepositoryInventory["excluded"]; discoveryIssues: string[]; };
    metrics: MetricReading[]; findings: QualityFinding[]; deletionCandidates: DeletionCandidate[];
    evidence: { id: string; kind: string; state: string; origin: string; durationMs: number; finishedAt: string; operatorPolicy: string; }[];
    evidenceIssues: string[];
}

function selectedEvidence(entries: StoredEvidence[], kind: string): StoredEvidence | undefined {
    const matching = entries.filter(entry => entry.receipt.kind === kind);
    matching.sort((a, b) => Date.parse(b.receipt.finishedAt) - Date.parse(a.receipt.finishedAt));
    return matching.find(entry => entry.observations.state !== "stale") ?? matching[0];
}

export function collectCompositeScoreReport(root: string): CompositeScoreReport {
    const measured = collectStaticMeasurements(root), { analysis } = measured, { inventory } = analysis;
    const catalog = buildMetricCatalog(), evidence = loadEvidence(inventory);
    const coverage = selectedEvidence(evidence.entries, "coverage")?.observations;
    const mutation = selectedEvidence(evidence.entries, "mutation")?.observations;
    const metrics = [...measured.metrics, ...measureCoverageEvidence(analysis, coverage), ...measureMutationEvidence(analysis, mutation)];
    const blockers = [...inventory.issues, ...measured.config.issues, ...evidence.issues];
    if (analysis.gaps.length) blockers.push(`${analysis.gaps.length} source files could not be measured`);
    if (catalog.registryHash !== REVIEWED_REGISTRY_HASH) blockers.push("Check registry changed; scoring disposition review required");
    const composite = composeScore(metrics, blockers);
    return { schemaVersion: 2, ...composite, profile: COMPOSITE_PROFILE, modelCalls: 0, registryHash: catalog.registryHash,
        sourceHash: inventory.sourceHash, inputHash: inventory.inputHash,
        languages: [...new Set(inventory.files.filter(file => file.role === "product").map(file => file.language ?? "unknown"))].sort(),
        structuralScore: composite.groups.find(group => group.id === "structure")?.score ?? null,
        scope: { eligibleFiles: inventory.files.filter(file => file.role === "product").length, measuredFiles: analysis.files.filter(file => file.input.role === "product").length,
            functions: analysis.files.reduce((sum, file) => sum + (file.structure?.functions.length ?? 0), 0), notMeasured: analysis.gaps,
            exclusions: inventory.excluded, discoveryIssues: inventory.issues },
        metrics, findings: measured.findings, deletionCandidates: joinDeletionEvidence(measured, coverage, mutation),
        evidence: evidence.entries.map(entry => ({ id: entry.id, kind: entry.receipt.kind, state: entry.observations.state, origin: entry.receipt.origin,
            durationMs: entry.receipt.durationMs, finishedAt: entry.receipt.finishedAt, operatorPolicy: entry.receipt.runner.operatorPolicy })), evidenceIssues: evidence.issues };
}
