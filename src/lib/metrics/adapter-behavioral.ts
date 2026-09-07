import type { RepositoryAnalysis } from "./analysis.js";
import { emptyReading, ratioReading, valueReading } from "./adapter-values.js";
import type { BehavioralObservations, CoverageObservation } from "./behavioral-types.js";
import type { MetricReading } from "./measurement-types.js";

function qualify(reading: MetricReading, evidence: BehavioralObservations, missingFiles: number): MetricReading {
    reading.evidenceIds = [evidence.evidenceId];
    reading.limitations.push(...evidence.issues);
    if (evidence.state !== "measured") reading.state = evidence.state;
    else if (missingFiles) { reading.state = "inconclusive"; reading.limitations.push(`${missingFiles} eligible product files absent from evidence`); }
    return reading;
}

function crapReading(analysis: RepositoryAnalysis, rows: CoverageObservation[]): MetricReading {
    const values: number[] = [];
    let eligible = 0;
    for (const file of analysis.files) for (const fn of file.structure?.functions ?? []) {
        eligible++;
        const span = rows.find(row => row.path === file.input.path)?.spans.find(item => item.line === fn.line && item.endLine === fn.endLine);
        if (!span || !span.count.total) continue;
        const uncovered = 1 - span.count.covered / span.count.total;
        values.push(fn.cyclomatic ** 2 * uncovered ** 3 + fn.cyclomatic);
    }
    if (!values.length) return emptyReading("coverage.crap", "missing", eligible, "No exact function-span coverage joins");
    const reading = valueReading("coverage.crap", Math.max(...values), values.length);
    reading.eligibleEntities = eligible;
    if (eligible !== values.length) reading.state = "inconclusive";
    reading.limitations.push("Diagnostic maximum only; composite excludes CRAP to avoid counting complexity and coverage twice.");
    return reading;
}

export function measureCoverageEvidence(analysis: RepositoryAnalysis, evidence?: BehavioralObservations): MetricReading[] {
    const files = analysis.files.filter(file => file.input.role === "product").map(file => file.input.path);
    if (!evidence) return ["lines", "branches", "functions", "crap"].map(id => emptyReading(`coverage.${id}`, "missing", files.length, "No current coverage receipt"));
    const rows = evidence.coverage.filter(row => files.includes(row.path));
    const absent = files.filter(path => !rows.some(row => row.path === path)).length;
    const readings = (["lines", "branches", "functions"] as const).map(kind => {
        const total = rows.reduce((sum, row) => sum + row[kind].total, 0);
        const covered = rows.reduce((sum, row) => sum + row[kind].covered, 0);
        return ratioReading(`coverage.${kind}`, total - covered, total);
    });
    return [...readings, crapReading(analysis, rows)].map(reading => qualify(reading, evidence, absent));
}

export function measureMutationEvidence(analysis: RepositoryAnalysis, evidence?: BehavioralObservations): MetricReading[] {
    const files = analysis.files.filter(file => file.input.role === "product").map(file => file.input.path);
    if (!evidence) return ["survivors", "uncovered"].map(id => emptyReading(`mutation.${id}`, "missing", files.length, "No current mutation receipt"));
    const mutants = evidence.mutants.filter(row => files.includes(row.path));
    const count = (outcome: string) => mutants.filter(row => row.outcome === outcome).length;
    const evaluated = count("killed") + count("survived");
    const readings = [ratioReading("mutation.survivors", count("survived"), evaluated), ratioReading("mutation.uncovered", count("no-coverage"), evaluated + count("no-coverage"))];
    const absent = files.filter(path => !evidence.coveredFiles.includes(path)).length;
    for (const reading of readings) {
        qualify(reading, evidence, absent);
        if (reading.id === "mutation.survivors" && count("no-coverage")) { reading.state = "inconclusive"; reading.limitations.push("Uncovered mutants leave assertion discrimination unmeasured at those sites"); }
        if (count("timeout") + count("error") + count("ignored")) { reading.state = "inconclusive"; reading.limitations.push("Timeout, error and ignored mutants are not counted as kills"); }
    }
    return readings;
}
