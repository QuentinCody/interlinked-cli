import { METRIC_CATALOG } from "./catalog-metrics.js";
import type { RepositoryAnalysis } from "./analysis.js";
import { emptyReading, qualityFinding, valueReading } from "./adapter-values.js";
import type { AdapterResult, MetricReading } from "./measurement-types.js";
import { aggregateBurden, interpolateBurden, STRUCTURE_PROFILE, type StructuralMetric } from "./score-profile.js";

function structureReading(id: StructuralMetric, analysis: RepositoryAnalysis): MetricReading {
    const located = analysis.files.flatMap(file => (file.structure?.functions ?? []).map(fn => ({ fn, file: file.input.path, declared: file.input.declaredGenerated !== undefined })));
    const functions = located.map(item => item.fn);
    if (!functions.length) return emptyReading(id, "not-applicable", 0, "No measured function implementations");
    const definition = STRUCTURE_PROFILE.metrics[id];
    const aggregate = aggregateBurden(functions.map(fn => ({ exposure: fn.exposure,
        burden: id === "difficulty" && fn.volume < STRUCTURE_PROFILE.halsteadVolumeFloor ? 0 : interpolateBurden(fn[id], definition.knots) })));
    const max = functions.reduce((value, fn) => Math.max(value, fn[id]), 0);
    const peak = located.reduce((best, item) => item.fn[id] > best.fn[id] ? item : best);
    return { ...valueReading(id, max, functions.length), score: aggregate?.score ?? null,
        top: { file: peak.file, value: peak.fn[id], line: peak.fn.line, name: peak.fn.name, ...(peak.declared ? { declaredGenerated: true as const } : {}) } };
}

function fileReading(id: "file.lines" | "file.top_level", analysis: RepositoryAnalysis): MetricReading {
    const files = analysis.files.filter(file => file.structure !== null);
    const definition = METRIC_CATALOG.find(metric => metric.id === id);
    if (!files.length || !definition) return emptyReading(id, "not-applicable", 0, "No measured product files");
    const values = files.map(file => ({ file: file.input.path, declared: file.input.declaredGenerated !== undefined, value: id === "file.lines" ? file.structure?.physicalLines ?? 0 : file.syntax.topLevelTokens,
        exposure: Math.max(1, file.structure?.astTokens ?? 0) }));
    const aggregate = aggregateBurden(values.map(item => ({ exposure: item.exposure, burden: interpolateBurden(item.value, definition.knots) })));
    const peak = values.reduce((best, item) => item.value > best.value ? item : best);
    return { ...valueReading(id, peak.value, files.length), score: aggregate?.score ?? null, top: { file: peak.file, value: peak.value, ...(peak.declared ? { declaredGenerated: true as const } : {}) } };
}

export function measureStructureDimensions(analysis: RepositoryAnalysis): AdapterResult {
    const metrics = (["cyclomatic", "cognitive", "tokens", "difficulty"] as const).map(id => structureReading(id, analysis));
    metrics.push(fileReading("file.lines", analysis), fileReading("file.top_level", analysis));
    const findings = analysis.files.flatMap(file => (file.structure?.functions ?? []).filter(fn => fn.tokens > 500).map(fn =>
        qualityFinding({ metric: "tokens", file: file.input, line: fn.line, endLine: fn.endLine,
            evidence: "proven", message: `${fn.name} contains ${fn.tokens} AST syntax tokens; the profile review reference is 500` })));
    for (const file of analysis.files) {
        if ((file.structure?.physicalLines ?? 0) > 500) findings.push(qualityFinding({ metric: "file.lines", file: file.input,
            line: 1, evidence: "proven", message: `${file.structure?.physicalLines} physical lines exceeds the 500-line profile review reference` }));
    }
    return { metrics, findings };
}
