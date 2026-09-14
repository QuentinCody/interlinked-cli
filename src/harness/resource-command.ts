import { acquireTestCapacity } from "./test-capacity.js";
import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync, type RunProcessResult } from "./check-engine/spawn-async.js";

/** Developer checks use the same host lane and bounded child lifecycle as scheduled work. */
export async function runResourceCommand(file: string, args: string[], signal: AbortSignal, profile: "heavy" | "light" = "heavy"): Promise<RunProcessResult | null> {
    const lane = await acquireTestCapacity("foreground", Date.now() + 5000, signal);
    if (!lane) return null;
    try {
        const resourceBudget = readResourceBudget(profile);
        if (!resourceBudget || signal.aborted) return null;
        const command = process.platform === "win32" ? [file, ...args] : ["nice", "-n", "10", file, ...args];
        const executable = command.shift();
        if (!executable) return null;
        const heapMb = profile === "light" ? 512 : Math.min(2560, Math.floor(resourceBudget.maxRssBytes / 1024 ** 2 * 0.625));
        return await runProcessAsync(executable, command, {
            cwd: process.cwd(), timeout: 3600_000, signal, resourceBudget, inheritOutput: true,
            env: {
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${heapMb}`.trim(),
                GOMAXPROCS: "2", UV_THREADPOOL_SIZE: "2", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1",
                MKL_NUM_THREADS: "1", VECLIB_MAXIMUM_THREADS: "1",
            },
        });
    } finally { lane.release(); }
}
