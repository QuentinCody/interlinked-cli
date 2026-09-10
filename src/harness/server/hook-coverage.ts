import type { HarnessDecision } from "../types.js";
import { startHookFilesystemWatch } from "../hook-filesystem-watch.js";
import type { ServerRuntime } from "./runtime-context.js";
import { createHookCoverageChecker } from "../hook-coverage-checks.js";
import { suppressRepeatedNudges, type NudgeScope } from "./stop-nudge-throttle.js";

const COVERAGE_BOUNDARIES = new Set(["SessionStart", "Stop", "PostToolBatch", "FileChanged", "CwdChanged", "ConfigChange"]);
const WATCH_PATH_BOUNDARIES = new Set(["SessionStart", "FileChanged", "CwdChanged"]);
type CoverageRuntime = Pick<ServerRuntime, "cwd" | "hookCoverage" | "hookCoverageUnavailable">;
/** The native lifecycle event name plus the session it belongs to (empty when the runner sent none). */
export interface CoverageBoundary { hook_event: string; session_id: string }

/** Stop is the one boundary that recurs every turn; the pending count cannot be
 *  discharged by anything the agent may do, so it is throttled like every other
 *  Stop nudge. Only the coverage lines pass through here — the rest of the Stop
 *  wall was already throttled by handleStop against the same told-set. */
function deliverable(runtime: CoverageRuntime, event: CoverageBoundary, lines: string[]): string[] {
    if (event.hook_event !== "Stop" || !event.session_id) return lines;
    const scope: NudgeScope = { projectRoot: runtime.cwd, sessionId: event.session_id };
    return suppressRepeatedNudges(scope, lines);
}

/** Lifecycle delivery never acknowledges the underlying check obligation. */
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
    const snapshot = watcher.ledger.snapshot();
    const coverage: string[] = [];
    if (snapshot.pending.length) coverage.push(`[interlinked:hook-coverage] NOT CHECKED: ${snapshot.pending.length} protected/reserved file version(s) await verification. Writer identity is unknown. Run interlinked harness coverage verify --json; inspect interlinked harness capabilities --json for identities.`);
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
            reservations: () => runtime.reservations.getAll().map(entry => entry.file_pattern),
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
