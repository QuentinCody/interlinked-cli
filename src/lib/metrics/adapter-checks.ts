import { join } from "node:path";
import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import { withCheckRoot } from "../../harness/checks/check-root.js";
import { checkMatchLimit } from "../../harness/checks/check-scan-policy.js";
import type { AnalyzedFile, RepositoryAnalysis } from "./analysis.js";
import { emptyReading, qualityFinding, ratioReading } from "./adapter-values.js";
import { FOREGROUND_UNCAPPED_SCORED_CHECKS, SCORED_CHECK_RUNTIME_RESULT_LIMITS, SCORED_CHECKS } from "./catalog-policy.js";
import type { AdapterResult, QualityFinding } from "./measurement-types.js";

function checkFile(file: AnalyzedFile, dimension: "test_integrity" | "correctness", root: string): { findings: QualityFinding[]; failures: string[] } {
    const findings: QualityFinding[] = [], failures: string[] = [];
    const metric = dimension === "test_integrity" ? "tests.integrity" : "correctness.findings";
    for (const check of CHECK_REGISTRY) {
        if (SCORED_CHECKS[check.id] !== dimension) continue;
        try {
            const run = withCheckRoot(root, () => check.fn(file.input.content, join(root, file.input.path)));
            const matches = run.result;
            for (const reason of run.notMeasured) failures.push(reason);
            const runtimeLimit = SCORED_CHECK_RUNTIME_RESULT_LIMITS.get(check.id);
            if (runtimeLimit === undefined) {
                failures.push(`${check.id}: result-collection capability is unknown in ${file.input.path}; findings are a lower bound`);
            } else {
                const saturationThreshold = FOREGROUND_UNCAPPED_SCORED_CHECKS.has(check.id) ? checkMatchLimit(runtimeLimit) : runtimeLimit;
                if (matches.length >= saturationThreshold) failures.push(`${check.id}: reporting cap may be saturated in ${file.input.path}; findings are a lower bound`);
            }
            for (const match of matches) findings.push(qualityFinding({
                metric, file: file.input, line: match.line, message: `${check.id}: ${match.text}`,
                severity: check.severity, evidence: check.determinism === "fully_deterministic" ? "proven" : "heuristic",
            }));
        } catch (error) { failures.push(`${check.id}: ${String(error)}`); }
    }
    return { findings, failures };
}

function affectedOpportunities(file: AnalyzedFile, findings: QualityFinding[], tests: boolean): number {
    const spans = tests ? file.syntax.tests : file.syntax.statements;
    const affected = new Set<number>();
    for (const finding of findings) {
        const matches = spans.map((span, index) => ({ span, index })).filter(item => item.span.line <= finding.line && finding.line <= item.span.endLine);
        matches.sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start));
        if (matches[0]) affected.add(matches[0].index);
    }
    return affected.size;
}

export function measureContentChecks(analysis: RepositoryAnalysis, dimension: "test_integrity" | "correctness"): AdapterResult {
    const tests = dimension === "test_integrity";
    const id = tests ? "tests.integrity" : "correctness.findings";
    const inRole = analysis.files.filter(file => file.input.role === (tests ? "test" : "product"));
    const files = inRole.filter(file => !file.python);
    const findings: QualityFinding[] = [], failures: string[] = [];
    let numerator = 0, denominator = 0;
    for (const file of files) {
        const result = checkFile(file, dimension, analysis.inventory.root);
        for (const finding of result.findings) findings.push(finding);
        for (const reason of result.failures) failures.push(reason);
        numerator += affectedOpportunities(file, result.findings, tests);
        denominator += tests ? file.syntax.tests.length : file.syntax.statements.length;
    }
    const reading = tests && !files.length ? emptyReading(id, "missing", 0, inRole.length ? "No JavaScript or TypeScript test files found" : "No supported test files found") : ratioReading(id, numerator, denominator);
    if (failures.length) {
        reading.state = "inconclusive";
        for (const reason of failures) reading.limitations.push(reason);
    }
    reading.evidenceIds = findings.map(finding => finding.id);
    reading.limitations.push("Only explicitly catalogued checks contribute; absence of findings is not proof of complete correctness.");
    if (inRole.length > files.length) reading.limitations.push(`${inRole.length - files.length} Python files are outside this metric: the reviewed checks are JavaScript/TypeScript detectors, so Python has no ${id} measurement.`);
    return { metrics: [reading], findings };
}
