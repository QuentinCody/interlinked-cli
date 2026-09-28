import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { analyzeExpressions, EXPRESSION_COUNTER, expressionLimitsFor, expressionReadabilityChecks } from "../harness/checks/expression-readability.js";
import type { ExpressionAnalysis, ExpressionFinding, ExpressionLimits } from "../harness/checks/expression-readability.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { discoverFunctionTokenFiles } from "./verify/file-discovery.js";

interface ExpressionFileReport extends ExpressionAnalysis {
    file: string;
    sourceHash?: string;
    limits?: ExpressionLimits;
    findings: ExpressionFinding[];
}
export interface ExpressionReport {
    version: 1;
    counter: typeof EXPRESSION_COUNTER;
    root: string;
    target: string;
    complete: boolean;
    scope: "discovered-js-ts-files" | "explicit-file";
    disposition: "advisory";
    files: ExpressionFileReport[];
    limitations: string[];
}

function measureFile(file: string, root: string): ExpressionFileReport {
    const path = relative(root, file);
    try {
        if (statSync(file).size > 2_000_000) throw new Error("File exceeds the 2 MB expression analysis budget");
        const content = readFileSync(file, "utf8");
        const sourceHash = createHash("sha256").update(content).digest("hex");
        const limits = expressionLimitsFor(file);
        const analysis = analyzeExpressions(content, file, limits);
        return { ...analysis, file: path, sourceHash, limits, findings: expressionReadabilityChecks(content, file, limits) };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { counter: EXPRESSION_COUNTER, file: path, status: "unavailable", reason, expressions: [], structural: [], findings: [] };
    }
}

/** Advisory inventory over explicit files or the repository's discovered source scope. */
export function collectExpressionReport(target = ".", cwd = process.cwd()): ExpressionReport {
    const root = resolve(cwd);
    const path = resolve(root, target);
    const directory = statSync(path).isDirectory();
    const selected = directory
        ? discoverFunctionTokenFiles(path).filter(file => /\.[cm]?[jt]sx?$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file))
        : [path];
    const files = selected.sort().map(file => measureFile(file, root));
    const complete = files.length > 0 && files.every(file => file.status === "measured");
    return {
        version: 1, counter: EXPRESSION_COUNTER, root, target, complete,
        scope: directory ? "discovered-js-ts-files" : "explicit-file",
        disposition: "advisory", files,
        limitations: [
            "Directory discovery excludes ignored/build paths; completeness applies only to the listed files, not every repository path or language.",
            "Syntax budgets are review signals. They do not establish behavioral correctness or justify trivial helper extraction.",
            "Review prerequisite failures, command provenance and success claims separately; validate domain rules with regression tests.",
        ],
    };
}

function renderReport(report: ReturnType<typeof collectExpressionReport>): string {
    const lines: string[] = [];
    for (const file of report.files) {
        if (file.status !== "measured") {
            lines.push(`NOT CHECKED: ${file.file}: ${file.reason}`);
            continue;
        }
        for (const finding of file.findings) lines.push(`${file.file}:${finding.line} [${finding.check}] ${finding.text}`);
    }
    lines.push(`${report.files.length} listed file(s); ${report.complete ? "measured" : "NOT CHECKED: incomplete"}; advisory findings, no quality verdict.`);
    return lines.join("\n");
}

export function metricsExpressionsCommand(target: string | undefined, options: { cwd?: string; json?: boolean; short?: boolean }): void {
    const mode = getOutputMode(options);
    try {
        const report = collectExpressionReport(target, options.cwd);
        output(mode, report, { normal: () => renderReport(report), short: () => renderReport(report) });
        if (!report.complete) process.exitCode = 2;
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : "Expression analysis unavailable");
        process.exitCode = 2;
    }
}
