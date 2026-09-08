import { getOutputMode, output, outputError } from "../lib/output.js";
import { collectMetricsScoreReport, type MetricsScoreReport } from "../lib/metrics/score-report.js";
import { collectCompositeScoreReport } from "../lib/metrics/composite-report.js";
import { renderCompositeScore, renderCompositeShort } from "./metrics-score-render.js";

export { collectMetricsScoreReport as buildMetricsScoreReport } from "../lib/metrics/score-report.js";
export interface MetricsScoreOptions { cwd?: string; json?: boolean; short?: boolean; profile?: string; }

function formatScore(value: number | null): string {
    return value === null ? "unavailable" : `${value.toFixed(1)}/100`;
}

function renderScore(report: MetricsScoreReport): string {
    const lines = [
        `Structural burden: ${formatScore(report.structuralScore)} (${report.status}; lower is better)`,
        "Full repository slop: unavailable; this experimental profile does not establish a quality ranking.",
        `Local AST analysis; no model calls. ${report.scope.measuredFiles} files, ${report.scope.functions} functions.`,
        "",
    ];
    for (const metric of report.metrics) lines.push(`  ${metric.id.padEnd(14)} ${formatScore(metric.aggregate?.score ?? null)}`);
    lines.push("", `Profile: ${report.profile.id}`, `Unmeasured files: ${report.scope.notMeasured.length}`);
    for (const gap of report.scope.notMeasured.slice(0, 5)) lines.push(`  ${gap.file}: ${gap.reason}`);
    for (const issue of report.scope.discoveryIssues) lines.push(`  Discovery incomplete: ${issue}`);
    lines.push("Coverage, mutants, type annotations and warning counts are not inferred from source size.");
    return lines.join("\n");
}

function renderSelectedComposite(options: MetricsScoreOptions): boolean {
    if (options.profile !== undefined && options.profile !== "structure-v1" && options.profile !== "slop-v1") throw new Error("Profile must be slop-v1 or structure-v1");
    if (options.profile === "structure-v1") return false;
    const report = collectCompositeScoreReport(options.cwd ?? process.cwd());
    output(getOutputMode(options), report, { normal: () => renderCompositeScore(report), short: () => renderCompositeShort(report) });
    return true;
}

/** Offline scoring; it does not run target scripts, install dependencies or query a model. */
export function metricsScoreCommand(options: MetricsScoreOptions): void {
    const mode = getOutputMode(options);
    try {
        if (renderSelectedComposite(options)) return;
        const report = collectMetricsScoreReport(options.cwd ?? process.cwd());
        output(mode, report, {
            normal: () => renderScore(report),
            short: () => `structure ${formatScore(report.structuralScore)}; ${report.status}; slop unavailable; ${report.scope.functions} functions; no model calls`,
        });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : "Metrics scoring failed");
    }
}
