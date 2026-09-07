import { COMPOSITE_GROUPS, type CompositeGroup } from "./composite-profile.js";
import type { MetricReading } from "./measurement-types.js";

export interface CompositeGroupReading { id: string; weight: number; applicable: boolean; score: number | null; lower: number; upper: number; reach: number; missing: string[]; }
export interface CompositeResult {
    observedScore: number | null; slopScore: number | null; range: { lower: number; upper: number };
    evidenceCompleteness: number; status: "complete" | "provisional" | "unavailable";
    rankingEligible: boolean; rankingBlockers: string[]; groups: CompositeGroupReading[];
}
const round = (value: number): number => Math.round(value * 100) / 100;

function groupReading(group: CompositeGroup, readings: readonly MetricReading[]): CompositeGroupReading {
    const rows = Object.entries(group.metrics).map(([id, weight]) => ({ id, weight, row: readings.find(row => row.id === id) }))
        .filter(item => item.row?.state !== "not-applicable");
    const total = rows.reduce((sum, item) => sum + item.weight, 0);
    const measured = rows.filter(item => item.row?.state === "measured" && item.row.score !== null);
    const known = measured.reduce((sum, item) => sum + item.weight, 0);
    const sum = measured.reduce((sum, item) => sum + item.weight * (item.row?.score ?? 0), 0);
    const missing = rows.filter(item => !measured.includes(item)).map(item => item.id);
    const maximum = Math.max(0, ...measured.map(item => item.row?.score ?? 0));
    const mean = group.method === "mean";
    return { id: group.id, weight: group.weight, applicable: total > 0,
        score: known > 0 ? (mean ? sum / known : maximum) : null,
        lower: total > 0 && mean ? sum / total : maximum,
        upper: mean && total > 0 ? (sum + (total - known) * 100) / total : (missing.length ? 100 : maximum),
        reach: total > 0 ? known / total : 0, missing };
}

function validateReadings(readings: readonly MetricReading[]): void {
    for (const row of readings) if (row.score !== null && (!Number.isFinite(row.score) || row.score < 0 || row.score > 100)) throw new Error(`Invalid metric score: ${row.id}`);
    if (new Set(readings.map(row => row.id)).size !== readings.length) throw new Error("Duplicate metric reading");
}

export function composeScore(readings: readonly MetricReading[], blockers: readonly string[] = []): CompositeResult {
    validateReadings(readings);
    const groups = COMPOSITE_GROUPS.map(group => groupReading(group, readings));
    const applicable = groups.filter(group => group.applicable), weight = applicable.reduce((sum, group) => sum + group.weight, 0);
    const known = applicable.reduce((sum, group) => sum + group.weight * group.reach, 0);
    const observed = applicable.reduce((sum, group) => sum + group.weight * group.reach * (group.score ?? 0), 0);
    const missing = [...new Set(groups.flatMap(group => group.missing))].map(id => `${id}: ${readings.find(row => row.id === id)?.state ?? "missing"}`);
    const rankingBlockers = [...blockers, ...missing];
    if (!weight || !known) rankingBlockers.push("No applicable measured opportunities");
    const rankingEligible = rankingBlockers.length === 0;
    const observedScore = known ? round(observed / known) : null;
    return { observedScore, slopScore: rankingEligible ? observedScore : null,
        range: { lower: weight ? round(applicable.reduce((sum, group) => sum + group.weight * group.lower, 0) / weight) : 0,
            upper: weight ? round(applicable.reduce((sum, group) => sum + group.weight * group.upper, 0) / weight) : 100 },
        evidenceCompleteness: weight ? round(100 * known / weight) : 0,
        status: known ? (rankingEligible ? "complete" : "provisional") : "unavailable", rankingEligible, rankingBlockers, groups };
}
