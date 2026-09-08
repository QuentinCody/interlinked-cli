import { natural, record, stringList, textField } from "./evidence-json.js";
import type { MeasurementState } from "./measurement-types.js";

export interface SnapshotMetric { id: string; state: MeasurementState; value: number | null; score: number | null; }
export interface ScoreSnapshot {
    schemaVersion: 2; profile: { id: string; hash: string }; registryHash: string; languages: string[];
    rankingEligible: boolean; slopScore: number | null; observedScore: number | null; sourceHash: string;
    metrics: SnapshotMetric[]; evidencePolicies: string[];
}
function nullableNumber(value: unknown): number | null {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected finite score/value or null");
    return value;
}
function state(value: unknown): MeasurementState {
    if (value === "measured" || value === "not-applicable" || value === "missing" || value === "stale" || value === "unsupported" || value === "inconclusive") return value;
    throw new Error("Invalid measurement state");
}
function metric(value: unknown): SnapshotMetric {
    const row = record(value, "metric");
    const score = nullableNumber(row.score);
    if (score !== null && (score < 0 || score > 100)) throw new Error("Metric score outside 0–100");
    return { id: textField(row.id, "metric id"), state: state(row.state), value: nullableNumber(row.value), score };
}
function selectedPolicies(metrics: unknown[], evidence: unknown[]): string[] {
    const ids = new Set(metrics.flatMap(value => {
        const row = record(value, "metric");
        return row.evidenceIds === undefined ? [] : stringList(row.evidenceIds, "evidenceIds");
    }));
    const entries = evidence.map(value => record(value, "evidence"));
    return [...new Set(entries.filter(entry => typeof entry.id === "string" && ids.has(entry.id)).map(entry =>
        `${textField(entry.kind, "kind")}:${textField(entry.operatorPolicy, "operatorPolicy")}`))].sort();
}
export function parseScoreSnapshot(value: unknown): ScoreSnapshot {
    const row = record(value, "score report"), profile = record(row.profile, "profile");
    if (natural(row.schemaVersion, "schemaVersion") !== 2) throw new Error("Regenerate comparison snapshots with metrics score schema v2");
    if (!Array.isArray(row.metrics) || !Array.isArray(row.evidence) || typeof row.rankingEligible !== "boolean") throw new Error("Incomplete score snapshot");
    const metrics = row.metrics.map(metric);
    if (new Set(metrics.map(row => row.id)).size !== metrics.length) throw new Error("Duplicate snapshot metric");
    const evidencePolicies = selectedPolicies(row.metrics, row.evidence);
    return { schemaVersion: 2, profile: { id: textField(profile.id, "profile id"), hash: textField(profile.hash, "profile hash") },
        registryHash: textField(row.registryHash, "registry hash"), languages: stringList(row.languages, "languages").sort(), rankingEligible: row.rankingEligible,
        slopScore: nullableNumber(row.slopScore), observedScore: nullableNumber(row.observedScore), sourceHash: textField(row.sourceHash, "source hash"), metrics, evidencePolicies };
}
