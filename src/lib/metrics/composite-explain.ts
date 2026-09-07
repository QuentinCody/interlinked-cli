import { METRIC_CATALOG } from "./catalog-metrics.js";
import { COMPOSITE_GROUPS } from "./composite-profile.js";
import { composeScore } from "./composite.js";
import type { CompositeScoreReport } from "./composite-report.js";
import type { MetricDefinition, MetricReading, QualityFinding } from "./measurement-types.js";

export interface MetricExplanation {
    definition: MetricDefinition; reading: MetricReading | null; groups: { id: string; weight: number; method: string; rationale: string }[];
    observedImprovementIfResolved: number | null; findings: QualityFinding[];
}
export function explainCompositeMetric(report: CompositeScoreReport, id: string): MetricExplanation {
    const definition = METRIC_CATALOG.find(metric => metric.id === id);
    if (!definition) throw new Error(`Unknown metric: ${id}`);
    const reading = report.metrics.find(row => row.id === id) ?? null;
    const groups = COMPOSITE_GROUPS.filter(group => id in group.metrics).map(({ id, weight, method, rationale }) => ({ id, weight, method, rationale }));
    const counterfactual = composeScore(report.metrics.map(row => row.id === id && row.state === "measured" ? { ...row, score: 0 } : row));
    const baseline = report.observedScore, improved = counterfactual.observedScore;
    const delta = baseline !== null && improved !== null ? Math.round((baseline - improved) * 100) / 100 : null;
    return { definition, reading, groups, observedImprovementIfResolved: delta, findings: report.findings.filter(row => row.metric === id) };
}
