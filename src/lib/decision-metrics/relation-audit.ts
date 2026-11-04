import { hash, record, strings, text, unique } from "../../harness/semantic-graph/relation-core.js";
import { parseRelationRun } from "../../harness/semantic-graph/relation-codec.js";
import type { RelationKind, RelationPlan, RelationRun } from "../../harness/semantic-graph/relation-types.js";
import { RELATION_CONTRACTS } from "./relation-contracts.js";

export interface RelationLabel { packetId: string; caseId: string; split: "development" | "holdout"; source: "fixture_execution" | "astra_model_review"; reviewer: string; choice: string | null; rationale: string; evidence: string[]; }
export interface RelationLabels { schema: "interlinked.relation-labels/1"; planId: string; blinded: boolean; labels: RelationLabel[]; }
export function blindRelationPackets(plan: RelationPlan): unknown {
    const packets = [...new Map(plan.jobs.flatMap(j => j.packets).map(p => [p.id, p])).values()];
    return { schema: "interlinked.relation-review/1", planId: plan.id, labelSource: "astra_model_review", instructions: "Review supplied code against the frozen question. Do not inspect judge outputs. Use insufficient_evidence or null when not decidable. Cite exact supplied text; do not claim execution unless separately reproduced. Record your model name and rationale. Model reference agreement is not established correctness.", cases: packets.map(p => ({ packetId: p.id, caseId: p.logicalKey, contract: RELATION_CONTRACTS[p.kind], evidence: p.evidence, complete: p.complete, missing: p.missing, label: { packetId: p.id, caseId: p.logicalKey, split: "development", source: "astra_model_review", reviewer: "", choice: null, rationale: "", evidence: [] } })) };
}
export function parseRelationLabels(value: unknown, plan: RelationPlan): RelationLabels {
    const r = record(value);
    if (r.schema !== "interlinked.relation-labels/1" || r.planId !== plan.id || typeof r.blinded !== "boolean" || !Array.isArray(r.labels)) throw new Error("label schema or plan identity mismatch");
    const packets = new Map(plan.jobs.flatMap(j => j.packets).map(p => [p.id, p]));
    const labels = r.labels.map(value => {
        const row = record(value), packetId = text(row.packetId), packet = packets.get(packetId);
        if (!packet || !["fixture_execution", "astra_model_review"].includes(String(row.source)) || !["development", "holdout"].includes(String(row.split))) throw new Error("invalid label identity/provenance/split");
        if (row.choice !== null && !Object.hasOwn(RELATION_CONTRACTS[packet.kind].options!, text(row.choice))) throw new Error("label outside contract");
        return { packetId, caseId: text(row.caseId), split: row.split as RelationLabel["split"], source: row.source as RelationLabel["source"], reviewer: text(row.reviewer), choice: row.choice as string | null, rationale: text(row.rationale), evidence: strings(row.evidence) };
    });
    unique(labels.map(l => l.packetId), "reference label");
    return { schema: "interlinked.relation-labels/1", planId: plan.id, blinded: r.blinded, labels };
}
function binomialCdf(x: number, n: number, p: number): number {
    if (x < 0) return 0; if (x >= n || p === 0) return 1; if (p === 1) return 0;
    let log = n * Math.log1p(-p), maximum = -Infinity;
    const terms: number[] = [];
    for (let i = 0; i <= x; i++) { terms.push(log); maximum = Math.max(maximum, log); log += Math.log(n - i) - Math.log(i + 1) + Math.log(p) - Math.log1p(-p); }
    return Math.min(1, Math.exp(maximum) * terms.reduce((sum, t) => sum + Math.exp(t - maximum), 0));
}
export function clopperPearsonOneSided(x: number, n: number): { lower: number; upper: number } | null {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(n) || x < 0 || n < x) throw new Error("invalid binomial counts");
    if (!n) return null;
    const solve = (k: number, target: number) => { let low = 0, high = 1; for (let i = 0; i < 65; i++) { const mid = (low + high) / 2; if (binomialCdf(k, n, mid) > target) low = mid; else high = mid; } return (low + high) / 2; };
    return { lower: x === 0 ? 0 : solve(x - 1, 0.95), upper: x === n ? 1 : solve(x, 0.05) };
}
const POSITIVE: Record<RelationKind, string[]> = { invariant_membership: ["related"], invariant_role: ["present"], invariant_compatibility: ["contradictory"], invariant_group: ["contradictory"], semantic_coupling: ["update"] };
export function auditRelations(runInput: RelationRun, labelInput: unknown): unknown {
    const run = parseRelationRun(runInput), labels = parseRelationLabels(labelInput, run.plan);
    const labelMap = new Map(labels.labels.map(l => [l.packetId, l]));
    const groups = new Map<string, typeof run.measurements>();
    for (const measurement of run.measurements) {
        const label = labelMap.get(measurement.packetId);
        const key = `${measurement.armId}/${measurement.populationId}/${label?.source ?? "unlabeled"}/${label?.split ?? "unassigned"}`;
        groups.set(key, [...(groups.get(key) ?? []), measurement]);
    }
    const results = [...groups].map(([population, measurements]) => {
        return auditRelationPopulation(population, measurements, labels, labelMap);
    });
    return { schema: "interlinked.relation-audit/1", runId: run.id, labelsDigest: hash(labels), candidateCoverage: run.plan.coverage.map(c => ({ invariantId: c.invariantId, mode: c.mode, method: c.method, k: c.limit, recovered: c.recovered.length, reference: c.reference.length, recall: c.reference.length ? c.recovered.length / c.reference.length : null, missed: c.reference.filter(id => !c.recovered.includes(id)), missingSelectors: c.missingSelectors, historyAvailable: c.historyAvailable, referenceSource: "authored registry; not inferred truth" })), results, referencePolicy: "Astra model reviews replace human review by user instruction. Keep model-reference agreement separate from executable fixture evidence. No automatic advisory promotion.", blinded: labels.blinded, incomplete: !run.complete || labels.labels.length < new Set(run.plan.jobs.flatMap(j => j.packets.map(p => p.id))).size };
}

function relationConfusion(measurements: RelationRun["measurements"], labelMap: Map<string, RelationLabel>) {
    let tp = 0, fp = 0, tn = 0, fn = 0, compared = 0, correct = 0, brier = 0, scored = 0, undecidableReferences = 0;
    const confusion: Record<string, Record<string, number>> = {}, caseIds: string[] = [];
    for (const m of measurements) {
        const label = labelMap.get(m.packetId); if (!label?.choice) continue;
        compared++; caseIds.push(label.caseId);
        const predicted = m.status === "answered" || m.status === "insufficient_evidence" ? m.choice ?? "unresolved" : "unresolved";
        const row = confusion[label.choice] ?? {}; row[predicted] = (row[predicted] ?? 0) + 1; confusion[label.choice] = row;
        if (predicted === label.choice) correct++;
        const positive = POSITIVE[m.recordKind], truth = positive.includes(label.choice), alert = m.status === "answered" && positive.includes(predicted);
        if (label.choice === "insufficient_evidence") undecidableReferences++;
        else if (truth && alert) tp++; else if (truth) fn++; else if (alert) fp++; else tn++;
        if (!["failed", "unassessed"].includes(m.status) && m.raw && m.raw.kind !== "yes_no") { brier += Object.entries(m.raw.probabilities).reduce((sum, [option, p]) => sum + (p - Number(option === label.choice)) ** 2, 0); scored++; }
    }
    return { tp, fp, tn, fn, compared, correct, brier, scored, undecidableReferences, confusion, caseIds };
}

function relationExecutionStats(measurements: RelationRun["measurements"]) {
    const elapsed = measurements.filter(m => !m.cached && m.calls > 0).map(m => m.durationMs).sort((a, b) => a - b);
    return { probabilitySource: [...new Set(measurements.map(m => m.probabilitySource))], calls: measurements.reduce((sum, m) => sum + m.calls, 0), knownCostUsd: measurements.reduce((sum, m) => sum + (m.costUsd ?? 0), 0), unknownCostObservations: measurements.filter(m => m.calls > 0 && m.costUsd === null).length, latencyMs: { p50: elapsed[Math.max(0, Math.ceil(elapsed.length*.5)-1)] ?? null, p95: elapsed[Math.max(0, Math.ceil(elapsed.length*.95)-1)] ?? null }, cached: measurements.filter(m => m.cached).length };
}

function auditRelationPopulation(population: string, measurements: RelationRun["measurements"], labels: RelationLabels, labelMap: Map<string, RelationLabel>) {
    const statuses = Object.fromEntries(["answered", "insufficient_evidence", "abstained", "failed", "unassessed"].map(s => [s, measurements.filter(m => m.status === s).length]));
    const { tp, fp, tn, fn, compared, correct, brier, scored, undecidableReferences, confusion, caseIds } = relationConfusion(measurements, labelMap);
    const uniqueReferenceCases = new Set(caseIds).size === caseIds.length;
    // Distinct author-assigned IDs are necessary, not proof of statistical independence.
    const independent = uniqueReferenceCases && labels.labels.every(l => l.source === "fixture_execution");
    const precision = tp + fp ? tp / (tp + fp) : null;
    const precisionInterval = independent ? clopperPearsonOneSided(tp, tp + fp) : null;
    const falseAlertInterval = independent ? clopperPearsonOneSided(fp, fp + tn) : null;
    const perClass = relationClassScores(measurements[0]!.recordKind, confusion);
    const f1 = Object.values(perClass).map(c => c.f1).filter((n): n is number => n !== null);
    return { population, opportunities: measurements.length, labeled: compared, undecidableReferences, referenceAgreement: compared ? correct / compared : null, statuses, confusion, perClass, macroF1: f1.length ? f1.reduce((a,b) => a+b, 0) / f1.length : null, positiveOptions: POSITIVE[measurements[0]!.recordKind], tp, fp, fn, tn, precision, recall: tp + fn ? tp / (tp + fn) : null, precisionBounds: precisionInterval, falseAlertBounds: falseAlertInterval, intervalMethod: "one-sided 95% exact Clopper-Pearson; descriptive fixture examples only; natural-case independence not established", independentCaseIds: uniqueReferenceCases, binomialAssumptionEstablished: independent, brier: scored ? brier / scored : null, brierN: scored, ...relationExecutionStats(measurements), qualification: "exploratory; model reference agreement or fixture accuracy does not qualify deployment" };
}

function relationClassScores(kind: RelationKind, confusion: Record<string, Record<string, number>>) {
    const classes = Object.keys(RELATION_CONTRACTS[kind].options!);
    const perClass = Object.fromEntries(classes.map(choice => {
        const truePositive = confusion[choice]?.[choice] ?? 0, actual = Object.values(confusion[choice] ?? {}).reduce((a, b) => a + b, 0), predicted = Object.values(confusion).reduce((sum, row) => sum + (row[choice] ?? 0), 0);
        return [choice, { precision: predicted ? truePositive / predicted : null, recall: actual ? truePositive / actual : null, f1: actual + predicted ? 2 * truePositive / (actual + predicted) : null }];
    }));
    return perClass;
}
