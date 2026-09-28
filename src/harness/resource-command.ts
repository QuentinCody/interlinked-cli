import { acquireTestCapacity } from "./test-capacity.js";
import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync, type RunProcessResult } from "./check-engine/spawn-async.js";
import { elapsedMs, recordVerificationStage, stageFromEnvironment, type ReuseDeniedReason } from "./verification-stages.js";

const CHECK_LABEL_MAX_CHARS = 200;

interface CommandOutcome { check: string; wait_capacity_ms: number; status: string; exec_ms?: number; denied?: ReuseDeniedReason; }

/** Ledger row for one bounded command: how long admission took, how long it ran, and why it produced no verdict. */
function recordCommand(outcome: CommandOutcome): void {
    const { denied, ...fields } = outcome;
    recordVerificationStage(process.cwd(), {
        stage: stageFromEnvironment("cli"), identity: null, reused: false, ...fields,
        ...(denied === undefined ? {} : { reuse_denied_reason: denied }),
    });
}

function commandStatus(result: RunProcessResult): { status: string; denied?: ReuseDeniedReason } {
    if (result.timedOut || result.killed || result.code === null) return { status: "deferred", denied: "interrupted" };
    return { status: result.code === 0 ? "passed" : "failed" };
}

/** Developer checks use the same host lane and bounded child lifecycle as scheduled work. */
export async function runResourceCommand(file: string, args: string[], signal: AbortSignal, profile: "heavy" | "light" = "heavy"): Promise<RunProcessResult | null> {
    // A daemon push check can already own the host lane for five minutes.
    const waitMs = profile === "light" ? 5000 : 600_000;
    const check = [file, ...args].join(" ").slice(0, CHECK_LABEL_MAX_CHARS);
    const waitStarted = Date.now();
    const lane = await acquireTestCapacity("foreground", Date.now() + waitMs, signal);
    const wait_capacity_ms = elapsedMs(waitStarted);
    if (!lane) {
        recordCommand({ check, wait_capacity_ms, status: "deferred", denied: signal.aborted ? "interrupted" : "capacity-timeout" });
        return null;
    }
    try {
        const resourceBudget = readResourceBudget(profile);
        if (!resourceBudget || signal.aborted) {
            recordCommand({ check, wait_capacity_ms, status: "deferred", denied: resourceBudget ? "interrupted" : "memory-budget-unavailable" });
            return null;
        }
        const command = process.platform === "win32" ? [file, ...args] : ["nice", "-n", "10", file, ...args];
        const executable = command.shift();
        if (!executable) return null;
        const heapMb = profile === "light" ? 512 : Math.min(2560, Math.floor(resourceBudget.maxRssBytes / 1024 ** 2 * 0.625));
        const execStarted = Date.now();
        const result = await runProcessAsync(executable, command, {
            cwd: process.cwd(), timeout: 3600_000, signal, resourceBudget, inheritOutput: true,
            env: {
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${heapMb}`.trim(),
                GOMAXPROCS: "2", UV_THREADPOOL_SIZE: "2", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1",
                MKL_NUM_THREADS: "1", VECLIB_MAXIMUM_THREADS: "1",
            },
        });
        recordCommand({ check, wait_capacity_ms, exec_ms: elapsedMs(execStarted), ...commandStatus(result) });
        return result;
    } finally { lane.release(); }
}
