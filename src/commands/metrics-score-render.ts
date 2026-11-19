import { evidenceAxes, renderAxes } from "../lib/metrics/axes.js";
import type { CompositeScoreReport } from "../lib/metrics/composite-report.js";
import type { MetricReading } from "../lib/metrics/measurement-types.js";
import type { ProvenanceSummary } from "../lib/metrics/provenance.js";

function formatMetricScore(value: number | null): string { return value === null ? "unavailable" : `${value.toFixed(1)}/100`; }
export function renderCompositeShort(report: CompositeScoreReport): string {
    return `slop ${formatMetricScore(report.slopScore)}; observed ${formatMetricScore(report.observedScore)}; ${report.status}; evidence ${report.evidenceCompleteness.toFixed(1)}%; no model calls`;
}
export function renderCompositeScore(report: CompositeScoreReport): string {
    const lines = [
        `Slop score: ${formatMetricScore(report.slopScore)} (${report.status}; lower is better)`,
        `Observed burden: ${formatMetricScore(report.observedScore)}; evidence completeness ${report.evidenceCompleteness.toFixed(1)}%`,
        `Missing-evidence range: ${report.range.lower.toFixed(1)}–${report.range.upper.toFixed(1)}/100; ranking ${report.rankingEligible ? "eligible" : "ineligible"}`,
        `${report.scope.measuredFiles}/${report.scope.eligibleFiles} product files; ${report.scope.functions} functions; no model calls`,
        report.provenance.line, "",
    ];
    for (const metric of report.metrics) lines.push(`  ${metric.id.padEnd(28)} ${formatMetricScore(metric.score).padStart(12)}  ${metric.state}${topOf(metric)}`);
    lines.push("", renderAxes(evidenceAxes(report.groups)));
    lines.push("", `Profile: ${report.profile.id}`, "Diagnostic-only metrics: coverage.crap, mutation.uncovered");
    for (const reason of report.rankingBlockers.slice(0, 10)) lines.push(`  Evidence gap: ${reason}`);
    if (report.rankingBlockers.length > 10) lines.push(`  ${report.rankingBlockers.length - 10} more gaps in --json output`);
    lines.push(`Deletion review candidates: ${report.deletionCandidates.length}; inspect with metrics deletions`);
    lines.push(...declaredLines(report.provenance));
    return lines.join("\n");
}

/** "  max 202 at path:line name" for a metric whose value is a maximum. */
function topOf(metric: MetricReading): string {
    const top = metric.top;
    if (top === undefined) return "";
    const where = `${top.file}${top.line === undefined ? "" : `:${top.line}`}${top.name === undefined ? "" : ` ${top.name}`}`;
    return `  max ${Number.isInteger(top.value) ? top.value : top.value.toFixed(1)} at ${where}${top.declaredGenerated === true ? " [file declares itself generated]" : ""}`;
}

/** Files that only declare themselves generated stay measured; they are listed here (capped; the total is exact). */
function declaredLines(provenance: ProvenanceSummary): string[] {
    const declared = provenance.declared;
    if (declared.total === 0) return [];
    const lines = [`Declare generated, still measured (the file says so; the agent can write that header): ${declared.total}`];
    for (const file of declared.files.slice(0, 5)) lines.push(`  ${file.path} (${file.lines} lines): ${file.detail}`);
    if (declared.total > 5) lines.push(`  ${declared.total - 5} more in --json provenance.declared`);
    return lines;
}
