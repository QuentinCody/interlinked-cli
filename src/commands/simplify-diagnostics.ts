import { collectDiagnosticReport, type DiagnosticReport } from "../lib/metrics/diagnostic-report.js";
import { collectPythonDiagnosticReport } from "../lib/metrics/diagnostic-python.js";
import type { SimplificationCandidateDraft, SimplificationDetectorResult } from "./simplify-detectors.js";

function candidate(report: DiagnosticReport, input: { path: string; start: number; end: number; key: string; metric: string; summary: string; hash: string; related: string[] }): SimplificationCandidateDraft {
    return { source: `diagnostics.iterative.${input.metric}`, remedy: "shrink", evidenceState: "heuristic", confidence: 0.35,
        path: input.path, startLine: input.start, endLine: input.end, key: `${report.profile.id}:${input.key}`,
        summary: input.summary, replacement: "Review intent, public boundaries and independent behavior before consolidating or inlining; validate any change with relevant tests.",
        evidence: [{ kind: "diagnostic-source-identity", state: "proven", path: input.path,
            detail: `Source SHA-256 ${input.hash}; measurement identity ${report.measurementIdentity}; profile ${report.profile.id}.` },
        { kind: "diagnostic-candidate", state: "heuristic", path: input.path, detail: input.summary }],
        estimatedLoc: null, relatedPaths: input.related };
}

export function diagnosticSimplificationEvidence(report: DiagnosticReport): SimplificationDetectorResult {
    const drafts = report.findings.map(finding => candidate(report, { path: finding.file, start: finding.line, end: finding.endLine,
        key: finding.id, metric: finding.metric, summary: finding.message, hash: finding.sourceSha256, related: finding.related }));
    for (const group of report.clones) for (const member of group.members) {
        if (member.representative || member.lines.length === 0) continue;
        drafts.push(candidate(report, { path: member.file, start: member.lines[0]!, end: member.lines.at(-1)!,
            key: `${group.hash}:${member.startOffset}`, metric: "exact_clone", hash: member.sourceSha256,
            summary: "Function body repeats an exact token sequence; independent contracts may still justify separate implementations.",
            related: [...new Set(group.members.map(peer => peer.file))] }));
    }
    return { drafts, sources: [{ source: "diagnostics.iterative", status: report.scope.status === "complete" ? "checked" : "partial",
        files_considered: report.scope.eligibleFiles, analyzed_paths: report.files.map(file => file.path), findings_emitted: drafts.length,
        notes: [`Profile ${report.profile.id}; measurement ${report.measurementIdentity}.`,
            ...report.scope.notMeasured.map(gap => `${gap.path}: ${gap.reason}`), ...report.scope.discoveryIssues, ...report.limitations] }] };
}

export function collectDiagnosticSimplificationEvidence(root: string, profile?: string): SimplificationDetectorResult {
    if (profile === undefined) return { drafts: [], sources: [] };
    if (profile === "js-ts") return diagnosticSimplificationEvidence(collectDiagnosticReport(root));
    if (profile === "python") return diagnosticSimplificationEvidence(collectPythonDiagnosticReport(root));
    throw new Error("Simplification diagnostics must be js-ts or python");
}
