import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import type { AnalyzedFile, RepositoryAnalysis } from "./analysis.js";
import { emptyReading, qualityFinding, ratioReading } from "./adapter-values.js";
import { SCORED_CHECKS } from "./catalog-policy.js";
import type { AdapterResult, QualityFinding } from "./measurement-types.js";

function checkFile(file: AnalyzedFile, dimension: "test_integrity" | "correctness"): { findings: QualityFinding[]; failures: string[] } {
    const findings: QualityFinding[] = [], failures: string[] = [];
    const metric = dimension === "test_integrity" ? "tests.integrity" : "correctness.findings";
    for (const check of CHECK_REGISTRY) {
        if (SCORED_CHECKS[check.id] !== dimension) continue;
        try {
            for (const match of check.fn(file.input.content, file.input.path)) findings.push(qualityFinding({
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
    const files = analysis.files.filter(file => file.input.role === (tests ? "test" : "product"));
    const findings: QualityFinding[] = [], failures: string[] = [];
    let numerator = 0, denominator = 0;
    for (const file of files) {
        const result = checkFile(file, dimension);
        findings.push(...result.findings); failures.push(...result.failures);
        numerator += affectedOpportunities(file, result.findings, tests);
        denominator += tests ? file.syntax.tests.length : file.syntax.statements.length;
    }
    const reading = tests && !files.length ? emptyReading(id, "missing", 0, "No supported test files found") : ratioReading(id, numerator, denominator);
    if (failures.length) { reading.state = "inconclusive"; reading.limitations.push(...failures); }
    reading.evidenceIds = findings.map(finding => finding.id);
    reading.limitations.push("Only explicitly catalogued checks contribute; absence of findings is not proof of complete correctness.");
    return { metrics: [reading], findings };
}
