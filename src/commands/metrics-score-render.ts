import type { CompositeScoreReport } from "../lib/metrics/composite-report.js";

export function formatMetricScore(value: number | null): string { return value === null ? "unavailable" : `${value.toFixed(1)}/100`; }
export function renderCompositeShort(report: CompositeScoreReport): string {
    return `slop ${formatMetricScore(report.slopScore)}; observed ${formatMetricScore(report.observedScore)}; ${report.status}; evidence ${report.evidenceCompleteness.toFixed(1)}%; no model calls`;
}
export function renderCompositeScore(report: CompositeScoreReport): string {
    const lines = [
        `Slop score: ${formatMetricScore(report.slopScore)} (${report.status}; lower is better)`,
        `Observed burden: ${formatMetricScore(report.observedScore)}; evidence completeness ${report.evidenceCompleteness.toFixed(1)}%`,
        `Missing-evidence range: ${report.range.lower.toFixed(1)}–${report.range.upper.toFixed(1)}/100; ranking ${report.rankingEligible ? "eligible" : "ineligible"}`,
        `${report.scope.measuredFiles}/${report.scope.eligibleFiles} product files; ${report.scope.functions} functions; no model calls`, "",
    ];
    for (const metric of report.metrics) lines.push(`  ${metric.id.padEnd(28)} ${formatMetricScore(metric.score).padStart(12)}  ${metric.state}`);
    lines.push("", `Profile: ${report.profile.id}`, "Diagnostic-only metrics: coverage.crap, mutation.uncovered");
    for (const reason of report.rankingBlockers.slice(0, 10)) lines.push(`  Evidence gap: ${reason}`);
    if (report.rankingBlockers.length > 10) lines.push(`  ${report.rankingBlockers.length - 10} more gaps in --json output`);
    lines.push(`Deletion review candidates: ${report.deletionCandidates.length}; inspect with metrics deletions`);
    return lines.join("\n");
}
