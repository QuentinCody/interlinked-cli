import { object, parseAnswer, adverseProbability } from "./answers.js";
import { validateMetricContract } from "./serialization.js";
import { binaryStatistics } from "./statistics.js";
import type { AuditCase } from "./audit.js";
import type { DecisionRun, Measurement } from "./types.js";

export function measurementKey(row: Measurement): string {
    return JSON.stringify([
        row.record.repository,
        row.record.revision,
        row.unitId,
        row.contract.id,
    ]);
}

export function probabilityFor(row: Measurement): number | null {
    if (!row.raw) return null;
    return adverseProbability(row.contract, row.raw);
}

export interface RunDifference {
    id: string;
    kind: "added" | "removed" | "answer_changed" | "metric_drift";
    before: Measurement | null;
    after: Measurement | null;
}
function metricDrift(left: Measurement, right: Measurement): boolean {
    return (
        left.provenance.modelIdentity !== right.provenance.modelIdentity ||
        left.provenance.adapterIdentity !== right.provenance.adapterIdentity ||
        left.provenance.servedModel !== right.provenance.servedModel ||
        left.provenance.questionHash !== right.provenance.questionHash ||
        left.record.provenance.metricsVersion !== right.record.provenance.metricsVersion
    );
}

export function diffRuns(
    before: DecisionRun,
    after: DecisionRun,
): { changes: RunDifference[]; compared: number; requiresReaudit: boolean } {
    const a = new Map(before.measurements.map((row) => [row.id, row]));
    const b = new Map(after.measurements.map((row) => [row.id, row]));
    const changes: RunDifference[] = [];
    for (const id of new Set([...a.keys(), ...b.keys()])) {
        const left = a.get(id),
            right = b.get(id);
        if (!left || !right) {
            changes.push({
                id,
                kind: left ? "removed" : "added",
                before: left ?? null,
                after: right ?? null,
            });
            continue;
        }
        const drift = metricDrift(left, right);
        if (
            drift ||
            left.status !== right.status ||
            JSON.stringify(left.raw) !== JSON.stringify(right.raw) ||
            JSON.stringify(left.value) !== JSON.stringify(right.value)
        )
            changes.push({
                id,
                kind: drift ? "metric_drift" : "answer_changed",
                before: left,
                after: right,
            });
    }
    return {
        changes,
        compared: Math.min(a.size, b.size),
        requiresReaudit: changes.some((change) => change.kind === "metric_drift"),
    };
}

function auditFeatures(row: Record<string, unknown>): void {
    for (const field of ["size", "structural", "embedding"]) {
        const vector = row[field];
        if (field === "embedding" && vector === undefined) continue;
        if (
            vector !== null &&
            (!Array.isArray(vector) ||
                vector.some((n) => typeof n !== "number" || !Number.isFinite(n)))
        )
            throw new Error(`invalid ${field} baseline features`);
    }
}

function validateProbabilityFields(row: Record<string, unknown>): void {
    if (row.probability !== null && typeof row.probability !== "number")
        throw new Error("probability must be numeric or null");
    if (row.ruleProbability !== undefined && row.ruleProbability !== null) {
        if (typeof row.ruleProbability !== "number")
            throw new Error("rule probability must be numeric");
        binaryStatistics([{ probability: row.ruleProbability, positive: row.positive === true }]);
    }
    if (row.probability !== null && !["answered", "abstained"].includes(String(row.status)))
        throw new Error("unanswered audit case cannot supply a probability");
}

function assertAuditCase(value: unknown): asserts value is AuditCase {
    const row = object(value);
    for (const key of ["id", "timestamp", "group", "repository", "family"])
        if (typeof row[key] !== "string" || !row[key])
            throw new Error(`audit case requires ${key}`);
    if (typeof row.positive !== "boolean" || typeof row.adjudicated !== "boolean")
        throw new Error("audit label must be explicit");
    if (!Array.isArray(row.reviewers) || row.reviewers.some((v) => typeof v !== "string"))
        throw new Error("reviewer identities required");
    validateProbabilityFields(row);
    if (row.probability !== null)
        binaryStatistics([{ probability: Number(row.probability), positive: row.positive }]);
    if (
        !["answered", "insufficient_evidence", "abstained", "failed", "unassessed"].includes(
            String(row.status),
        )
    )
        throw new Error("invalid audit state");
    auditFeatures(row);
    auditDecisionEvidence(row);
}

function auditDecisionEvidence(row: Record<string, unknown>): void {
    if (row.contract === undefined && row.raw === undefined) return;
    const contract = validateMetricContract(row.contract);
    row.contract = contract;
    if (row.raw === undefined && row.probability === null) return;
    const raw = parseAnswer(row.raw, contract);
    const probability = adverseProbability(contract, raw);
    if (
        row.probability !== null &&
        (probability === null || Math.abs(Number(row.probability) - probability) > 1e-10)
    )
        throw new Error("audit probability disagrees with the saved distribution");
    row.raw = raw;
}

export function validateAuditCase(value: unknown): AuditCase {
    assertAuditCase(value);
    return value;
}
