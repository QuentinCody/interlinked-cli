import { appendCapturedData } from "../../lib/data/capture.js";
import type { QualityCheckConfig } from "../types.js";
import type { QualityCheckResult } from "./result-types.js";
import { runOneCheck, skipAfterYield, skipBeforeYield, yieldEventLoop, type ToolCheckLoopContext } from "./tool-check-loop.js";

interface ExecutionRecord { id: string; status: string; elapsed_ms: number; finding_count: number; findings?: QualityCheckResult[]; }
function skippedBefore(check: QualityCheckConfig): string { return check.enabled ? "skipped_file_type_or_batched_external" : "disabled"; }
async function runConfiguredCheck(ctx: ToolCheckLoopContext, name: string, check: QualityCheckConfig): Promise<ExecutionRecord> {
    if (skipBeforeYield(ctx, name, check)) return { id: name, status: skippedBefore(check), elapsed_ms: 0, finding_count: 0 };
    await yieldEventLoop();
    ctx.onCheckBoundary?.(`yield_${name}`);
    if (skipAfterYield(ctx, check)) return { id: name, status: "skipped_test_file_or_foreign_project", elapsed_ms: 0, finding_count: 0 };
    const start = performance.now();
    const outcome = await runOneCheck(ctx, name, check);
    if (outcome.boundary !== null) ctx.onCheckBoundary?.(outcome.boundary);
    return { id: name, status: outcome.status, elapsed_ms: performance.now() - start,
        finding_count: outcome.findings.length, findings: outcome.findings };
}
function persistExecutions(ctx: ToolCheckLoopContext, execution: ExecutionRecord[]): void {
    if (ctx.event.dry_run) return;
    appendCapturedData({ cwd: ctx.cwd, producer: "harness/quality-checks/tool-check-loop", session: ctx.event.session_id }, "check-executions", [{
        schema: "check-executions.v1", ts: ctx.event.timestamp, session_id: ctx.event.session_id,
        tool_use_id: ctx.event.tool_use_id ?? null, provider: ctx.event.agent_source, file: ctx.filePath,
        execution, coverage: "all entries in this config-driven quality-check loop; other pipelines have separate coverage",
    }]);
}

/** Every configured check gets an execution state, including disabled and deferred checks. */
export async function runToolCheckLoop(ctx: ToolCheckLoopContext): Promise<QualityCheckResult[]> {
    const results: QualityCheckResult[] = [];
    const execution: ExecutionRecord[] = [];
    for (const [name, check] of Object.entries(ctx.checks)) {
        const record = await runConfiguredCheck(ctx, name, check);
        execution.push(record);
        if (record.findings) results.push(...record.findings);
    }
    persistExecutions(ctx, execution);
    return results;
}
