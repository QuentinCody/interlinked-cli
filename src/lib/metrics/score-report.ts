import { createHash } from "node:crypto";
import { collectScoringSources, type SourceGap } from "./source-census.js";
import { aggregateBurden, interpolateBurden, scoreProfileHash, STRUCTURE_PROFILE, type BurdenAggregate, type StructuralMetric } from "./score-profile.js";
import { measureStructure, type MeasuredStructure, type StructureFunction } from "./structure.js";

export interface ScoredFile extends MeasuredStructure { file: string; sha256: string; }
export interface ScoredFunction extends StructureFunction { file: string; }
export interface MetricScore {
    id: StructuralMetric;
    weight: number;
    aggregate: BurdenAggregate | null;
    rawMax: number | null;
}
export interface MetricsScoreReport {
    schemaVersion: 1;
    profile: typeof STRUCTURE_PROFILE;
    profileHash: string;
    sourceHash: string;
    status: "measured" | "partial" | "unavailable";
    measurement: { modelCalls: 0; repositoryCodeExecuted: false; typescriptVersion: string | null; };
    structuralScore: number | null;
    slopScore: null;
    rankEligible: false;
    unavailable: string[];
    scope: {
        discovery: "git" | "filesystem";
        measuredFiles: number;
        functions: number;
        moduleTokensOutsideFunctions: number;
        notMeasured: SourceGap[];
        discoveryIssues: string[];
        excluded: string[];
    };
    metrics: MetricScore[];
    files: ScoredFile[];
}

const SUPPORTED_SOURCE = /\.[cm]?[jt]sx?$/i;
const METRICS: StructuralMetric[] = ["cyclomatic", "cognitive", "tokens", "difficulty"];
function metricScore(id: StructuralMetric, functions: ScoredFunction[]): MetricScore {
    const { weight, knots } = STRUCTURE_PROFILE.metrics[id];
    const values = functions.map(fn => ({
        exposure: fn.exposure,
        burden: id === "difficulty" && fn.volume < STRUCTURE_PROFILE.halsteadVolumeFloor ? 0 : interpolateBurden(fn[id], knots),
    }));
    const rawMax = functions.reduce<number | null>((max, fn) => max === null ? fn[id] : Math.max(max, fn[id]), null);
    return { id, weight, aggregate: aggregateBurden(values), rawMax };
}

function reportStatus(functions: ScoredFunction[], gaps: SourceGap[], issues: string[]): MetricsScoreReport["status"] {
    if (!functions.length) return "unavailable";
    return gaps.length || issues.length ? "partial" : "measured";
}

/** Full repository slop stays unavailable until all dimension contracts have adapters. */
export function collectMetricsScoreReport(root: string): MetricsScoreReport {
    const census = collectScoringSources(root);
    const files: ScoredFile[] = [];
    for (const source of census.sources) {
        if (!SUPPORTED_SOURCE.test(source.file)) {
            census.notMeasured.push({ file: source.file, reason: "This structural profile supports JavaScript and TypeScript" });
            continue;
        }
        const result = measureStructure(source.content, source.file);
        if (result.state === "unavailable") census.notMeasured.push({ file: source.file, reason: result.reason });
        else files.push({ ...result, file: source.file, sha256: source.sha256 });
    }
    const functions = files.flatMap(file => file.functions.map(fn => ({ ...fn, file: file.file })));
    const metrics = METRICS.map(id => metricScore(id, functions));
    const typescriptVersion = files[0]?.typescriptVersion ?? null;
    const sourceHash = createHash("sha256").update(JSON.stringify(census.sources.map(source => [source.file, source.sha256]))).digest("hex");
    return {
        schemaVersion: 1, profile: STRUCTURE_PROFILE, profileHash: scoreProfileHash(typescriptVersion), sourceHash,
        status: reportStatus(functions, census.notMeasured, census.discoveryIssues),
        measurement: { modelCalls: 0, repositoryCodeExecuted: false, typescriptVersion },
        structuralScore: functions.length ? metrics.reduce((sum, metric) => sum + metric.weight * (metric.aggregate?.score ?? 0), 0) : null,
        slopScore: null, rankEligible: false,
        unavailable: ["behavioral coverage and mutation evidence", "qualified test integrity", "architecture burden", "correctness and security burden", "type soundness", "qualified redundancy", "contract consistency", "normalized file size", "top-level module execution burden"],
        scope: {
            discovery: census.discovery, measuredFiles: files.length, functions: functions.length,
            moduleTokensOutsideFunctions: files.reduce((sum, file) => sum + file.astTokens, 0) - functions.reduce((sum, fn) => sum + fn.exposure, 0),
            notMeasured: census.notMeasured.sort((a, b) => a.file.localeCompare(b.file)), discoveryIssues: census.discoveryIssues, excluded: census.excluded,
        },
        metrics, files,
    };
}
