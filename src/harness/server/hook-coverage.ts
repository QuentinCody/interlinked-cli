import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HarnessDecision } from "../types.js";
import { startHookFilesystemWatch } from "../hook-filesystem-watch.js";
import type { ServerRuntime } from "./runtime-context.js";
import { createHookCoverageChecker } from "../hook-coverage-checks.js";
import { novelCoverageLines } from "./advisory-delivery.js";
import { recordHookObservations } from "../hook-observations.js";

const COVERAGE_BOUNDARIES = new Set(["SessionStart", "Stop", "PostToolBatch", "FileChanged", "CwdChanged", "ConfigChange"]);
const WATCH_PATH_BOUNDARIES = new Set(["SessionStart", "FileChanged", "CwdChanged"]);
type CoverageRuntime = Pick<ServerRuntime, "cwd" | "hookCoverage" | "hookCoverageUnavailable">;
/** The native lifecycle event name plus the session it belongs to (empty when the runner sent none). */
export interface CoverageBoundary { hook_event: string; session_id: string }

/** Retain every observation; present a coverage gap once until it changes or clears. */
function deliverable(runtime: CoverageRuntime, event: CoverageBoundary, lines: string[]): string[] {
    const visible = novelCoverageLines(runtime, event, lines);
    recordHookObservations({ ...event, cwd: runtime.cwd, agent_source: "unknown", timestamp: new Date().toISOString() },
        lines.map(message => ({ kind: "advisory", check: "hook-coverage", message, delivered: visible.includes(message) })));
    return visible;
}

/** Lifecycle delivery never acknowledges the underlying check obligation. */
/**
 * The backlog line names its drain. Versions written outside hook events stay pending until a check of that exact
 * version runs; the daemon starts that check itself after an idle period, and `harness coverage verify` runs it now.
 */
export function pendingEvidenceLine(pendingCount: number, draining: boolean): string {
    const drain = draining
        ? "A verification job is draining them now."
        : "Run `interlinked harness coverage verify` to check them now; the daemon also drains them after 10 idle minutes.";
    return `[interlinked:hook-coverage] NOT CHECKED: ${pendingCount} protected/reserved file version(s) lack complete check evidence. Writer identity is unknown. ${drain} Pending scopes and recovery results: interlinked harness coverage status --json.`;
}

export function appendHookCoverageDecision(runtime: CoverageRuntime, event: CoverageBoundary, decision: HarnessDecision): HarnessDecision {
    const nativeEvent = event.hook_event;
    if (!COVERAGE_BOUNDARIES.has(nativeEvent)) return decision;
    const watcher = runtime.hookCoverage;
    if (!watcher) {
        if (!runtime.hookCoverageUnavailable) return decision;
        const lines = deliverable(runtime, event, [`[interlinked:hook-coverage] NOT MEASURED: ${runtime.hookCoverageUnavailable}`]);
        return { ...decision, warnings: [...(decision.warnings ?? []), ...lines] };
    }
    watcher.reconcile();
    const snapshot = watcher.ledger.summary();
    const coverage: string[] = [];
    if (snapshot.pendingCount) coverage.push(pendingEvidenceLine(snapshot.pendingCount, watcher.verification?.isRunning() ?? false));
    for (const reason of watcher.status().unmeasured) coverage.push(`[interlinked:hook-coverage] NOT MEASURED: ${reason}`);
    const warnings = [...(decision.warnings ?? []), ...deliverable(runtime, event, coverage)];
    const result: HarnessDecision = { ...decision, warnings };
    if (WATCH_PATH_BOUNDARIES.has(nativeEvent)) result.watch_paths = watcher.watchPaths();
    if (nativeEvent === "ConfigChange" && snapshot.acceptedPolicy && snapshot.acceptedPolicy !== watcher.ledger.policyDigest()) {
        result.decision = "block";
        result.reason = "Protected policy differs from its accepted identity; runtime application is refused pending explicit review. The filesystem write has already happened.";
    }
    return result;
}

export function activateHookCoverage(runtime: ServerRuntime): () => void {
    let stop = (): void => {};
    try {
        const watcher = startHookFilesystemWatch({
            root: runtime.cwd,
            // Reservations also cover external memory and other repositories. They
            // are not part of this repository's recovery scope. Keep lexical paths
            // so an in-repository symlink still reaches the observer's strict check.
            reservations: () => runtime.reservations.getAll().map(entry => entry.file_pattern).filter(path => {
                const rel = relative(runtime.cwd, resolve(runtime.cwd, path));
                return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
            }),
            onError: message => runtime.logAlways(`[interlinked:hook-coverage] ${message}`),
            checker: createHookCoverageChecker(runtime.cwd, () => runtime.rules.quality_checks),
        });
        runtime.hookCoverage = watcher;
        stop = watcher.stop;
        const unsubscribe = runtime.reservations.onChange(() => watcher.reconcile());
        return () => { unsubscribe(); watcher.stop(); };
    } catch (error) {
        stop();
        delete runtime.hookCoverage;
        runtime.hookCoverageUnavailable = String(error);
        runtime.logAlways(`[interlinked:hook-coverage] NOT MEASURED: ${String(error)}`);
        return () => {};
    }
}
