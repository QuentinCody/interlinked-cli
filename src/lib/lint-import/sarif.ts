import { fileURLToPath } from "node:url";
import { lintJson, lintObject } from "./json.js";
import { reportArray, reportLine, reportString } from "./report-values.js";
import type { LintDiagnostic } from "./parsers.js";

function successfulRun(run: Record<string, unknown>): void {
    if (run.invocations === undefined) return;
    for (const value of reportArray(run.invocations)) {
        const invocation = lintObject(value);
        if (invocation.executionSuccessful !== true) throw new Error("SARIF invocation did not complete successfully");
        rejectNotifications(invocation.toolExecutionNotifications);
        rejectNotifications(invocation.toolConfigurationNotifications);
    }
}

function rejectNotifications(value: unknown): void {
    if (reportArray(value ?? []).some((item) => lintObject(item).level === "error")) throw new Error("SARIF contains execution/configuration errors");
}

function artifactUri(location: Record<string, unknown>, run: Record<string, unknown>, seen = new Set<string>()): string {
    let artifact = location;
    if (artifact.uri === undefined && typeof artifact.index === "number") {
        artifact = lintObject(lintObject(reportArray(run.artifacts)[artifact.index]).location);
    }
    const uri = reportString(artifact.uri);
    if (artifact.uriBaseId === undefined) return uri;
    const id = reportString(artifact.uriBaseId);
    if (seen.has(id) || seen.size > 32) throw new Error("Cyclic SARIF URI bases");
    seen.add(id);
    const base = lintObject(lintObject(run.originalUriBaseIds)[id]);
    return new URL(uri, artifactUri(base, run, seen)).href;
}

function sourcePath(uri: string): string {
    if (uri.startsWith("file:")) return fileURLToPath(uri);
    if (/^[a-z][a-z\d+.-]*:/i.test(uri)) throw new Error("SARIF location is not a local source file");
    if (/[?#]/.test(uri)) throw new Error("Unsupported SARIF artifact URI");
    return decodeURIComponent(uri);
}

function activeResult(row: Record<string, unknown>): boolean {
    if (row.baselineState === "absent") return false;
    if (["pass", "notApplicable", "informational"].includes(String(row.kind))) return false;
    const suppressions = row.suppressions ?? [];
    return !reportArray(suppressions).some((raw) => lintObject(raw).status === "accepted");
}

function resultDiagnostic(raw: unknown, run: Record<string, unknown>, driver: Record<string, unknown>): LintDiagnostic[] {
    const row = lintObject(raw);
    if (!activeResult(row)) return [];
    const location = lintObject(lintObject(reportArray(row.locations)[0]).physicalLocation);
    const artifact = lintObject(location.artifactLocation);
    const indexed = typeof row.ruleIndex === "number" ? lintObject(reportArray(driver.rules)[row.ruleIndex]).id : undefined;
    const rule = reportString(row.ruleId ?? indexed);
    const message = lintObject(row.message);
    return [{ file: sourcePath(artifactUri(artifact, run)), line: reportLine(lintObject(location.region).startLine), rule: `${reportString(driver.name)}/${rule}`, message: reportString(message.text ?? message.markdown) }];
}

/** Strict location-bearing SARIF 2.1.0; unsupported/error reports never retire debt. */
export function parseSarif(output: string): LintDiagnostic[] {
    const report = lintObject(lintJson(output));
    if (report.version !== "2.1.0") throw new Error("Unsupported SARIF version");
    const runs = reportArray(report.runs);
    if (runs.length === 0) throw new Error("SARIF contains no analyzer runs");
    return runs.flatMap((raw) => {
        const run = lintObject(raw);
        successfulRun(run);
        const driver = lintObject(lintObject(run.tool).driver);
        reportString(driver.name);
        return reportArray(run.results).flatMap((result) => resultDiagnostic(result, run, driver));
    });
}
