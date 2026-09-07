import { catalogSources, type CatalogSource } from "./catalog-sources.js";
import { METRIC_CATALOG } from "./catalog-metrics.js";
import { SCORED_CHECKS, SUPPORTING_CHECKS } from "./catalog-policy.js";
import { hashBytes } from "./inventory.js";
import type { CheckDisposition, MetricDefinition, QualityDimension } from "./measurement-types.js";

export interface CatalogCheck extends CatalogSource {
    disposition: CheckDisposition;
    dimension: QualityDimension | null;
    reason: string;
}

function classify(source: CatalogSource): CatalogCheck {
    const dimension = source.family === "inline" ? SCORED_CHECKS[source.id] : undefined;
    if (dimension) return { ...source, disposition: "scored", dimension, reason: "Reviewed standalone content adapter; findings remain evidence-classed" };
    if (["guard", "sequence", "behavioral"].includes(source.family)) {
        return { ...source, disposition: "enforcement", dimension: null, reason: "Describes an execution or agent session, not repository quality" };
    }
    if (SUPPORTING_CHECKS.has(source.id) || source.family === "tool_quality") {
        return { ...source, disposition: "supporting", dimension: null, reason: "Requires contextual or source-bound runner evidence; never count a silent skip as passing" };
    }
    return { ...source, disposition: "advisory", dimension: null, reason: "Not qualified for the fixed scoring profile; retained for review" };
}

export interface MetricCatalog {
    schemaVersion: 1;
    modelCalls: 0;
    registryHash: string;
    metrics: readonly MetricDefinition[];
    checks: CatalogCheck[];
}

export function buildMetricCatalog(): MetricCatalog {
    const checks = catalogSources().map(classify);
    const registryHash = hashBytes(JSON.stringify(checks.map(check => [check.key, check.determinism, check.disposition, check.dimension])));
    return { schemaVersion: 1 as const, modelCalls: 0 as const, registryHash, metrics: METRIC_CATALOG, checks };
}
