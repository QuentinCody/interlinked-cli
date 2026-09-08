import { evidenceIdentity } from "../lib/metrics/evidence-identity.js";
import { appendMeasurementExecution, readMeasurementExecutions } from "../lib/metrics/execution-journal.js";
import { collectRepositoryInventory, hashBytes } from "../lib/metrics/inventory.js";
import { inventoryWithOverrides } from "../lib/metrics/inventory-overrides.js";
import type { CoverageRunResult } from "./coverage-runner.js";
import type { GateContext } from "./evaluator/coverage-write-guard.js";
import type { HarnessEvent } from "./types.js";

export function recordCoverageExecution(ctx: GateContext, event: HarnessEvent, result: CoverageRunResult, now: number): void {
    if (event.dry_run) return;
    try {
        const changes = new Map((ctx.overlayFiles ?? []).map(file => [file.relPath, file.delete ? null : file.content]));
        changes.set(ctx.relPath, ctx.proposed);
        const inventory = inventoryWithOverrides(collectRepositoryInventory(ctx.projectRoot), changes);
        const measured = result.ok && result.perFile.has(ctx.relPath);
        appendMeasurementExecution(ctx.projectRoot, { schemaVersion: 1, gate: "per_edit_coverage", at: new Date(now).toISOString(), sessionId: event.session_id || "unattributed",
            inputFingerprint: hashBytes(JSON.stringify(evidenceIdentity(inventory, changes))), file: ctx.relPath, sourceHash: hashBytes(ctx.proposed), scope: ctx.selectedTests ?? [],
            elapsedMs: Math.max(0, Math.round(result.suiteMs)), outcome: measured ? "measured" : "unavailable",
            testsPassed: result.testsPassed, reason: result.testsPassed === false ? "Test suite failed" : result.error ?? "" });
    } catch (error) { console.warn(`[interlinked:coverage-execution] Unable to record measurement: ${error instanceof Error ? error.message : "unknown error"}`); }
}

export interface CoverageExecutionReach { measured: number; stale: number; attempts: number; present: boolean; issues: string[]; p50Ms: number | null; p95Ms: number | null; }
export function recordCoverageNotRun(root: string, event: HarnessEvent, file: string, reason: string, outcome: "deferred" | "unavailable"): void {
    if (event.dry_run) return;
    try {
        appendMeasurementExecution(root, { schemaVersion: 1, gate: "per_edit_coverage", at: new Date().toISOString(), sessionId: event.session_id,
            inputFingerprint: hashBytes("not-measured"), file, sourceHash: hashBytes("not-measured"), scope: [], elapsedMs: 0, outcome, reason, testsPassed: null });
    } catch (error) { console.warn(`[interlinked:coverage-execution] ${error instanceof Error ? error.message : "Cannot record deferred coverage"}`); }
}
export function coverageExecutionReach(root: string, eligible: readonly string[]): CoverageExecutionReach {
    const journal = readMeasurementExecutions(root), entries = journal.entries.filter(row => row.gate === "per_edit_coverage");
    const result: CoverageExecutionReach = { measured: 0, stale: 0, attempts: entries.length, present: journal.present, issues: journal.issues, p50Ms: null, p95Ms: null };
    if (!entries.length) return result;
    try {
        const inventory = collectRepositoryInventory(root), fingerprint = hashBytes(JSON.stringify(evidenceIdentity(inventory)));
        const latest = new Map(entries.map(row => [row.file, row]));
        for (const [path, entry] of latest) {
            if (!eligible.includes(path)) continue;
            if (entry.inputFingerprint === fingerprint && entry.outcome === "measured") result.measured++;
            else result.stale++;
        }
        const times = entries.filter(row => row.elapsedMs > 0).map(row => row.elapsedMs).sort((a, b) => a - b);
        result.p50Ms = times[Math.ceil(times.length * .5) - 1] ?? null;
        result.p95Ms = times[Math.ceil(times.length * .95) - 1] ?? null;
    } catch (error) { result.issues.push(error instanceof Error ? error.message : "Cannot validate execution freshness"); }
    return result;
}
