import { resolve } from "node:path";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { buildMetricCatalog } from "../lib/metrics/catalog.js";
import { collectCompositeScoreReport } from "../lib/metrics/composite-report.js";
import { explainCompositeMetric } from "../lib/metrics/composite-explain.js";
import { compareScoreSnapshots } from "../lib/metrics/score-compare.js";
import { parseScoreSnapshot } from "../lib/metrics/score-snapshot.js";
import { readEvidenceArtifact } from "../lib/metrics/evidence-store.js";

export interface MetricsAnalysisOptions { cwd?: string; json?: boolean; short?: boolean; checks?: boolean; }
function failure(options: MetricsAnalysisOptions, error: unknown): void { outputError(getOutputMode(options), error instanceof Error ? error.message : "Metrics command failed"); }

export function metricsCatalogCommand(options: MetricsAnalysisOptions): void {
    const catalog = buildMetricCatalog();
    const lines = [`${catalog.metrics.length} metric contracts; ${catalog.checks.length} check/guard entries; no model calls`];
    for (const metric of catalog.metrics) lines.push(`${metric.id.padEnd(28)} ${metric.unit}; denominator: ${metric.denominator}`);
    if (options.checks) for (const check of catalog.checks) lines.push(`${check.key}: ${check.disposition} — ${check.reason}`);
    output(getOutputMode(options), catalog, { normal: () => lines.join("\n"), short: () => lines[0] ?? "" });
}
export function metricsExplainCommand(id: string, options: MetricsAnalysisOptions): void {
    try {
        const result = explainCompositeMetric(collectCompositeScoreReport(options.cwd ?? process.cwd()), id);
        output(getOutputMode(options), result, { normal: () => [result.definition.name, `Unit: ${result.definition.unit}`, `Denominator: ${result.definition.denominator}`,
            `Measurement: ${result.reading?.state ?? "missing"}; score ${result.reading?.score ?? "unavailable"}/100`,
            ...result.groups.map(group => `${group.weight}-point group: ${group.rationale}`),
            ...result.reading?.limitations ?? [], `Observed score improvement if resolved: ${result.observedImprovementIfResolved ?? "unavailable"}`].join("\n"),
            short: () => `${id}: ${result.reading?.state ?? "missing"}; ${result.reading?.score ?? "unavailable"}/100` });
    } catch (error) { failure(options, error); }
}
export function metricsCompareCommand(before: string, after: string, options: MetricsAnalysisOptions): void {
    try {
        const root = options.cwd ?? process.cwd();
        const result = compareScoreSnapshots(parseScoreSnapshot(JSON.parse(readEvidenceArtifact(resolve(root, before)))), parseScoreSnapshot(JSON.parse(readEvidenceArtifact(resolve(root, after)))));
        output(getOutputMode(options), result, { normal: () => [`Composite delta: ${result.compositeDelta ?? "not comparable"}`, ...result.reasons,
            ...result.metrics.map(row => `${row.id.padEnd(28)} ${row.scoreDelta ?? "unmeasured"} points; ${row.state}`)].join("\n"),
            short: () => `comparable=${result.comparable}; delta=${result.compositeDelta ?? "unavailable"}` });
    } catch (error) { failure(options, error); }
}
export function metricsDeletionsCommand(options: MetricsAnalysisOptions): void {
    try {
        const report = collectCompositeScoreReport(options.cwd ?? process.cwd()), candidates = report.deletionCandidates;
        output(getOutputMode(options), { candidates, reviewRequired: true }, {
            normal: () => [`${candidates.length} deletion-review candidates; every removal requires validation`, ...candidates.map(row => `${row.file}:${row.line} [${row.priority}] ${row.signals.join("; ")}${row.blockers.length ? `; blockers: ${row.blockers.join("; ")}` : ""}`)].join("\n"),
            short: () => `${candidates.length} deletion-review candidates` });
    } catch (error) { failure(options, error); }
}
