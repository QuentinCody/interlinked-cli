import { collectAutoDiagnosticReport, isMixedDiagnosticReport, type AutoDiagnosticReport } from "../lib/metrics/diagnostic-auto.js";
import { collectDiagnosticReport, type DiagnosticReport } from "../lib/metrics/diagnostic-report.js";
import { collectPythonDiagnosticReportAsync } from "../lib/metrics/diagnostic-python.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

interface Options { cwd?: string; json?: boolean; short?: boolean; profile?: string; }

async function collectProfile(options: Options): Promise<DiagnosticReport | AutoDiagnosticReport> {
    const root = options.cwd ?? process.cwd();
    if (options.profile === "python") return collectPythonDiagnosticReportAsync(root, { resourcePolicy: "foreground-survey" });
    if (options.profile === "js-ts") return collectDiagnosticReport(root);
    if (!options.profile || options.profile === "auto") return collectAutoDiagnosticReport(root);
    throw new Error("Diagnostic profile must be auto, js-ts or python");
}
function percent(fraction: number | null): string { return fraction === null ? "not applicable" : `${(fraction * 100).toFixed(2)}%`; }

function renderSummary(report: DiagnosticReport): string {
    return `Diagnostic subset: verbosity ${percent(report.verbosity.fraction)} (${report.verbosity.numerator}/${report.verbosity.denominator} SLOC); `
        + `erosion ${percent(report.erosion.fraction)} (${report.erosion.numerator.toFixed(2)}/${report.erosion.denominator.toFixed(2)} mass); `
        + `${report.scope.status} scope ${report.scope.measuredFiles}/${report.scope.eligibleFiles} files; no quality verdict`;
}

function renderReport(report: DiagnosticReport): string {
    const lines = [renderSummary(report), `Profile: ${report.profile.id}`, "",
        `Pattern lines: ${report.verbosity.patternLines}; all clone lines: ${report.verbosity.cloneLines}; overlap: ${report.verbosity.overlapLines}.`,
        `Redundant clone lines after one representative per group: ${report.verbosity.redundantCloneLines}.`,
        `High-complexity functions: ${report.erosion.highComplexityFunctions}/${report.erosion.functions}.`, "Largest high-complexity contributions:"];
    for (const fn of [...report.functions].filter(fn => fn.highComplexityMass > 0).sort((a, b) => b.mass - a.mass).slice(0, 10)) {
        lines.push(`  ${fn.file}:${fn.line} ${fn.name}: CC ${fn.cyclomatic}, SLOC ${fn.sloc}, mass ${fn.mass.toFixed(2)}`);
    }
    for (const gap of report.scope.notMeasured.slice(0, 10)) lines.push(`Not measured: ${gap.path}: ${gap.reason}`);
    for (const issue of report.scope.discoveryIssues) lines.push(`Discovery issue: ${issue}`);
    return [...lines, "", ...report.limitations].join("\n");
}

function renderMixed(profiles: DiagnosticReport[], render: (report: DiagnosticReport) => string): string {
    return profiles.map(report => `[${report.profile.languages.join("/")}]\n${render(report)}`).join("\n\n");
}

export async function metricsDiagnosticsCommand(options: Options): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const report = await collectProfile(options);
        const selection = "profileSelection" in report ? `Profile selection: ${report.profileSelection.rule} (product files ${JSON.stringify(report.profileSelection.languages)})\n` : "";
        if (isMixedDiagnosticReport(report)) {
            output(mode, report, { normal: () => selection + renderMixed(report.profiles, renderReport), short: () => selection + renderMixed(report.profiles, renderSummary) });
            return;
        }
        output(mode, report, { normal: () => selection + renderReport(report), short: () => selection + renderSummary(report) });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : "Diagnostic measurement failed");
    }
}
