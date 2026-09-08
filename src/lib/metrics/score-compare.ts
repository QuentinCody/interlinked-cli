import type { ScoreSnapshot } from "./score-snapshot.js";

export interface ScoreComparison {
    comparable: boolean; reasons: string[]; compositeDelta: number | null; sourceChanged: boolean;
    metrics: { id: string; before: number | null; after: number | null; scoreDelta: number | null; state: string }[];
}
export function compareScoreSnapshots(before: ScoreSnapshot, after: ScoreSnapshot): ScoreComparison {
    const reasons: string[] = [];
    if (before.profile.hash !== after.profile.hash) reasons.push("Scoring profiles differ");
    if (before.registryHash !== after.registryHash) reasons.push("Reviewed check registries differ");
    if (before.languages.join() !== after.languages.join()) reasons.push("Language cohorts differ");
    if (before.evidencePolicies.join() !== after.evidencePolicies.join()) reasons.push("Behavioral measurement policies differ");
    if (!before.rankingEligible || !after.rankingEligible) reasons.push("At least one snapshot lacks complete ranking evidence");
    const metrics = [...new Set([...before.metrics, ...after.metrics].map(row => row.id))].sort().map(id => {
        const a = before.metrics.find(row => row.id === id), b = after.metrics.find(row => row.id === id);
        const known = a?.state === "measured" && b?.state === "measured" && before.profile.hash === after.profile.hash;
        const scoreDelta = known && a.score !== null && b.score !== null ? Math.round((b.score - a.score) * 100) / 100 : null;
        return { id, before: a?.value ?? null, after: b?.value ?? null, scoreDelta, state: `${a?.state ?? "missing"} → ${b?.state ?? "missing"}` };
    });
    const comparable = reasons.length === 0 && before.slopScore !== null && after.slopScore !== null;
    return { comparable, reasons, sourceChanged: before.sourceHash !== after.sourceHash,
        compositeDelta: comparable ? Math.round(((after.slopScore ?? 0) - (before.slopScore ?? 0)) * 100) / 100 : null, metrics };
}
