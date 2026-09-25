// ===========================================
// Hook surfaces — PostToolUse reconciliation and the Stop summary
// ===========================================
// Plan 31 §12.1. PostToolUse reconciles observed changes into obligations
// and emits bounded actionable lines; Stop summarizes unresolved required
// scenarios with the exact command. Neither runs a suite, and neither costs
// anything in a repository without `.interlinked/e2e-policy.json`. Both are
// warn-only: the explicit CLI and configured gates are the verdict surfaces.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { HarnessEvent } from "../types.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, loadE2ePolicy } from "./policy.js";
import { editedTexts, formatQualityFindings, qualityFindings } from "./quality-feedback.js";
import { formatReconcileMessages, reconcileChanges, type ReconcileResult } from "./reconcile.js";
import { openRequest } from "./requests.js";
import { recoverOrphanedRuns } from "./attempts.js";
import { AutoRunner, type AutoRunnerDeps, DEFAULT_SCHEDULING, spawnDetachedE2eRun } from "./scheduler.js";
import { StopReminderMemory, stopSummary } from "./stop-summary.js";

const stopReminders = new StopReminderMemory();
let autoRunner: AutoRunner | null = null;
/** Tests inject a fake spawn; production lazily builds the detached-CLI runner. */
export function configureAutoRunner(deps: AutoRunnerDeps | null): void { autoRunner = deps ? new AutoRunner(deps) : null; }
/**
 * C5: adopted automatic execution — only when the CURRENT policy turns it on, only for real (non-dry-run) unresolved work.
 * A policy that is now off, absent or invalid DISARMS the project's lane (review C4): a queued start never outlives the
 * authorization that queued it.
 */
function notifyAutoRunner(root: string, result: ReconcileResult, event: HarnessEvent): void {
    if (event.dry_run) return;
    if (!result.scheduling?.autoRun) { autoRunner?.disarm(root); return; }
    if (!result.affected.length) return;
    autoRunner ??= new AutoRunner({ spawn: spawnDetachedE2eRun });
    autoRunner.notify(root, { ...DEFAULT_SCHEDULING, ...result.scheduling });
}
/** SessionStart / daemon start (C3): attempts whose process is gone become explicit `unavailable` attempts; one line per recovered run. */
export function recoverProjectE2eOrphans(root: string): string[] {
    if (!hasProjectE2ePolicy(root)) return [];
    try {
        return recoverOrphanedRuns(root, Date.now()).recovered.map(runId => `[interlinked:e2e] run ${runId} exited before its evidence was reconciled; its scenarios are unavailable until a new supervised run completes`);
    } catch (error) {
        return [`[interlinked:e2e] orphan recovery unavailable: ${error instanceof Error ? error.message : String(error)}`];
    }
}
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoRead", "NotebookRead", "ListFiles"]);

function toRepoRelative(root: string, path: string): string | null {
    const rel = isAbsolute(path) ? relative(root, path) : path;
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.replaceAll("\\", "/");
}
/** Cheap presence probe so unconfigured repositories pay nothing on any hook. */
export function hasProjectE2ePolicy(root: string): boolean {
    return existsSync(join(root, E2E_POLICY_PATH));
}
/** Durable request per UNRESOLVED affected obligation (C4; review C6: a second session observing a generation another session opened gets its own request): survives the daemon; served only by a run certifying that exact key + generation. */
function openPendingRequests(root: string, result: ReconcileResult, event: HarnessEvent): void {
    const extra = { ...(event.session_id ? { sessionId: event.session_id } : {}), ...(event.dry_run ? { dryRun: true } : {}) };
    for (const row of result.affected) openRequest(root, { key: row.key, generation: row.generation, atMs: Date.now(), ...extra });
}
/** Unit E3 (§12.3): the test-quality signals this edit introduced, attached to the scenarios the edit affects; advice only, never a verdict. */
function qualityAdvice(root: string, event: HarnessEvent, result: ReconcileResult): string[] {
    const keys = [...new Set(result.affected.map(row => row.key))];
    return editedTexts(event.tool_name || "", event.tool_input).flatMap(edit => {
        const path = toRepoRelative(root, edit.path);
        if (path === null) return [];
        return formatQualityFindings(path, qualityFindings({ ...edit, path }), keys);
    });
}
/** PostToolUse: observed changed paths → pending obligations → at most five actionable lines. */
export function collectProjectE2eWarnings(event: HarnessEvent): string[] {
    const root = event.cwd || process.cwd();
    if (!hasProjectE2ePolicy(root) || READ_ONLY_TOOLS.has(event.tool_name || "")) return [];
    const changedPaths = extractAllEditedFilePaths(event).map(path => toRepoRelative(root, path)).filter((path): path is string => path !== null);
    if (!changedPaths.length) return [];
    try {
        const result = reconcileChanges({ root, changedPaths, atMs: Date.now(), ...(event.session_id ? { sessionId: event.session_id } : {}), ...(event.dry_run ? { dryRun: true } : {}) });
        openPendingRequests(root, result, event);
        notifyAutoRunner(root, result, event);
        return [...formatReconcileMessages(result), ...qualityAdvice(root, event, result)];
    } catch (error) {
        return [`[interlinked:e2e] reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}; obligations may be missing — run interlinked tests e2e status`];
    }
}
/** Stop: one bounded summary of unresolved REQUIRED scenarios (projects with gates.stop "off" are skipped). */
export function formatProjectE2eStopWarning(input: { cwd: string; sessionId: string; dryRun?: boolean }): string | null {
    const loaded = loadE2ePolicy(input.cwd);
    if (loaded.status === "unconfigured") return null;
    if (loaded.status === "invalid") return `[interlinked:e2e] policy invalid: ${loaded.reason}; no scenario is verified until .interlinked/e2e-policy.json parses`;
    const silenced = new Set(loaded.policy.projects.filter(project => project.gates?.stop === "off").map(project => project.id));
    const evaluation = evaluateE2e({ root: input.cwd, atMs: Date.now(), sessionId: input.sessionId, ...(input.dryRun ? { dryRun: true } : {}) });
    const open = evaluation.verdicts.filter(row => row.required && !row.satisfied && !silenced.has(row.projectId));
    return stopSummary(open, stopReminders, input.sessionId); // F6: bounded per session (PE-39), handoff when unavailable, quarantine visible
}
