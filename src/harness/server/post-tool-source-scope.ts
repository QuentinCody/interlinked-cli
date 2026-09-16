import { resolve } from "node:path";
import { lstatSync } from "node:fs";
import { appendCapturedData } from "../../lib/data/capture.js";
import { isDirectFileEditTool } from "../../lib/write-tool-registry.js";
import { detectBashCodeFileWrite } from "../pre-checks-bash-write-detect.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import { sourceScanScope } from "../source-scan-scope.js";
import { createChangeSetExternalBatch } from "../quality-checks/change-set-external.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { applyQualityDecision, collectQualityResultEntries, formatQualityDecisionWarnings } from "./post-tool-file-checks-phases-quality.js";
import type { ServerRuntime } from "./runtime-context.js";
import type { EditedPathResolution } from "./post-tool-pipeline-paths.js";
import type { QualityCheckResult } from "../quality-checks/result-types.js";
import { isInsideRoot } from "../large-file-policy.js";

async function checkExcludedSecurity(ctx: ServerRuntime, event: HarnessEvent, paths: string[]): Promise<QualityCheckResult[]> {
    paths = paths.filter(path => isInsideRoot(ctx.cwd, path));
    if (!paths.length) return [];
    const checks = Object.fromEntries(Object.entries(ctx.rules.quality_checks).filter(([name]) => name === "gitleaks" || name === "dependency_audit"));
    const batch = createChangeSetExternalBatch({ paths: paths.map(path => resolve(ctx.cwd, path)), checks, cwd: ctx.cwd });
    const findings: QualityCheckResult[] = [];
    for (const path of paths) {
        const absolute = resolve(ctx.cwd, path), results = await batch.resultsForFile(absolute);
        findings.push(...results);
    }
    const evidence = await batch.evidenceForFile(resolve(ctx.cwd, paths[0]!));
    if (!event.dry_run) appendCapturedData({ cwd: ctx.cwd, producer: "harness/source-scan-scope", session: event.session_id }, "check-executions", [{
        schema: "source-scan-security.v1", ts: event.timestamp, tool_use_id: event.tool_use_id ?? null,
        paths, results: findings, evidence, scope: "security-only", reusable: false,
    }]);
    return findings;
}

export function hasSourceChecks(resolved: EditedPathResolution, paths: string[]): boolean {
    return paths.length > 0 || (resolved.shouldRunChecks && resolved.editedFilePaths.length === 0);
}

/** Keep unknown/generated populations bounded without labelling them dependencies. */
async function boundedSourcePaths(ctx: ServerRuntime, event: HarnessEvent, paths: string[], decision: HarnessDecision): Promise<string[]> {
    const eligible: string[] = [], deferred: string[] = [];
    for (const path of paths) {
        try {
            if (eligible.length >= 64 || lstatSync(resolve(ctx.cwd, path)).size > 256 * 1024) deferred.push(path);
            else eligible.push(path);
        } catch { eligible.push(path); }
    }
    if (deferred.length) {
        const result = { source: "quality" as const, name: "external_check_deferred", severity: "warning" as const, determinism: "fully_deterministic" as const,
            message: `Source-quality budget exhausted for ${deferred.length} input(s) (source_quality)`, detail: `${deferred.length} input(s) omitted; 64 files / 256 KiB per file; review scope and run applicable tools explicitly. No source-quality verdict.`, file: deferred[0]! };
        if (!event.dry_run) appendCapturedData({ cwd: ctx.cwd, producer: "harness/source-scan-scope", session: event.session_id }, "check-executions", [{ schema: "source-scan-budget.v1", paths: deferred, status: "unavailable", reason: result.detail }]);
        decision.check_results = [...(decision.check_results ?? []), result];
        decision.warnings = [...(decision.warnings ?? []), ...formatQualityDecisionWarnings([result])];
        const security = await checkExcludedSecurity(ctx, event, deferred);
        collectQualityResultEntries(security, decision.check_results ??= []);
        applyQualityDecision(ctx, security, decision);
    }
    return eligible;
}

function declaredWrites(event: HarnessEvent): string[] {
    if (isDirectFileEditTool(event.tool_name)) return extractAllEditedFilePaths(event);
    const command = event.tool_input?.command;
    const write = typeof command === "string" ? detectBashCodeFileWrite(command) : null;
    return write ? [write.target] : [];
}

/** Source-quality scope only; runtime validation and security remain separate. */
export async function prepareSourceChecks(ctx: ServerRuntime, event: HarnessEvent, paths: string[], decision: HarnessDecision): Promise<string[]> {
    if (!paths.length) return paths;
    const scope = sourceScanScope(ctx.cwd, declaredWrites(event));
    paths = [...paths].sort((a, b) => scope.priority(a) - scope.priority(b));
    const excluded = paths.flatMap(path => {
        const reason = scope.reason(path);
        return reason ? [{ path, reason }] : [];
    });
    if (!excluded.length) return boundedSourcePaths(ctx, event, paths, decision);
    const excludedPaths = new Set(excluded.map(row => row.path));
    if (!event.dry_run) appendCapturedData({ cwd: ctx.cwd, producer: "harness/source-scan-scope", session: event.session_id }, "check-executions", [{
        schema: "source-scan-scope.v1", ts: event.timestamp, tool_use_id: event.tool_use_id ?? null,
        excluded, status: "excluded_not_checked", scope: "authored-source-quality-only",
    }]);
    const findings = await checkExcludedSecurity(ctx, event, excluded.map(row => row.path));
    collectQualityResultEntries(findings, decision.check_results ??= []);
    applyQualityDecision(ctx, findings, decision);
    ctx.log(`Source checks excluded ${excluded.length} installed/runtime artifact(s); security scope retained; exclusions are not passes.`);
    return boundedSourcePaths(ctx, event, paths.filter(path => !excludedPaths.has(path)), decision);
}
