import type { HarnessDecision } from "../types.js";
import { startHookFilesystemWatch } from "../hook-filesystem-watch.js";
import type { ServerRuntime } from "./runtime-context.js";
import { createHookCoverageChecker } from "../hook-coverage-checks.js";

const COVERAGE_BOUNDARIES = new Set(["SessionStart", "Stop", "PostToolBatch", "FileChanged", "CwdChanged", "ConfigChange"]);
const WATCH_PATH_BOUNDARIES = new Set(["SessionStart", "FileChanged", "CwdChanged"]);
type CoverageRuntime = Pick<ServerRuntime, "hookCoverage" | "hookCoverageUnavailable">;

/** Lifecycle delivery never acknowledges the underlying check obligation. */
export function appendHookCoverageDecision(runtime: CoverageRuntime, nativeEvent: string, decision: HarnessDecision): HarnessDecision {
    if (!COVERAGE_BOUNDARIES.has(nativeEvent)) return decision;
    const watcher = runtime.hookCoverage;
    if (!watcher) {
        if (!runtime.hookCoverageUnavailable) return decision;
        return { ...decision, warnings: [...(decision.warnings ?? []), `[interlinked:hook-coverage] NOT MEASURED: ${runtime.hookCoverageUnavailable}`] };
    }
    watcher.reconcile();
    const snapshot = watcher.ledger.snapshot();
    const warnings = [...(decision.warnings ?? [])];
    if (snapshot.pending.length) warnings.push(`[interlinked:hook-coverage] NOT CHECKED: ${snapshot.pending.length} protected/reserved file version(s) await verification. Writer identity is unknown. Run interlinked harness coverage verify --json; inspect interlinked harness capabilities --json for identities.`);
    for (const reason of watcher.status().unmeasured) warnings.push(`[interlinked:hook-coverage] NOT MEASURED: ${reason}`);
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
