import { METRIC_CATALOG } from "./catalog-metrics.js";
import type { RepositoryAnalysis } from "./analysis.js";
import { emptyReading, qualityFinding, valueReading } from "./adapter-values.js";
import type { AdapterResult, MetricReading } from "./measurement-types.js";
import { aggregateBurden, interpolateBurden, STRUCTURE_PROFILE, type StructuralMetric } from "./score-profile.js";

function structureReading(id: StructuralMetric, analysis: RepositoryAnalysis): MetricReading {
    const functions = analysis.files.flatMap(file => file.structure?.functions ?? []);
    if (!functions.length) return emptyReading(id, "not-applicable", 0, "No measured function implementations");
    const definition = STRUCTURE_PROFILE.metrics[id];
    const aggregate = aggregateBurden(functions.map(fn => ({ exposure: fn.exposure,
        burden: id === "difficulty" && fn.volume < STRUCTURE_PROFILE.halsteadVolumeFloor ? 0 : interpolateBurden(fn[id], definition.knots) })));
    const max = functions.reduce((value, fn) => Math.max(value, fn[id]), 0);
    return { ...valueReading(id, max, functions.length), score: aggregate?.score ?? null };
}

function fileReading(id: "file.lines" | "file.top_level", analysis: RepositoryAnalysis): MetricReading {
    const files = analysis.files.filter(file => file.structure !== null);
    const definition = METRIC_CATALOG.find(metric => metric.id === id);
    if (!files.length || !definition) return emptyReading(id, "not-applicable", 0, "No measured product files");
    const values = files.map(file => ({ value: id === "file.lines" ? file.structure?.physicalLines ?? 0 : file.syntax.topLevelTokens,
        exposure: Math.max(1, file.structure?.astTokens ?? 0) }));
    const aggregate = aggregateBurden(values.map(item => ({ exposure: item.exposure, burden: interpolateBurden(item.value, definition.knots) })));
    return { ...valueReading(id, values.reduce((value, item) => Math.max(value, item.value), 0), files.length), score: aggregate?.score ?? null };
}

export function measureStructureDimensions(analysis: RepositoryAnalysis): AdapterResult {
    const metrics = (["cyclomatic", "cognitive", "tokens", "difficulty"] as const).map(id => structureReading(id, analysis));
    metrics.push(fileReading("file.lines", analysis), fileReading("file.top_level", analysis));
    const findings = analysis.files.flatMap(file => (file.structure?.functions ?? []).filter(fn => fn.tokens > 500).map(fn =>
        qualityFinding({ metric: "tokens", file: file.input, line: fn.line, endLine: fn.endLine,
            evidence: "proven", message: `${fn.name} contains ${fn.tokens} syntax tokens; the shipped cap is 500` })));
    for (const file of analysis.files) {
        if ((file.structure?.physicalLines ?? 0) > 500) findings.push(qualityFinding({ metric: "file.lines", file: file.input,
            line: 1, evidence: "proven", message: `${file.structure?.physicalLines} physical lines exceeds the shipped file cap` }));
    }
    return { metrics, findings };
}
