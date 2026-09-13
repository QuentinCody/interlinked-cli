import { canonicalProjectRoot, acquireCrossProcessCompilerLease, tryAcquireCrossProcessCompilerLease } from "./project-compiler-lock.js";
import { runProcessAsync, type RunProcessResult } from "./check-engine/spawn-async.js";
import { readResourceMemory } from "./resource-memory.js";

export interface BackgroundJob {
    name: string;
    file: string;
    args: string[];
}

const GIB = 1024 ** 3;
const HOST_LANE = "interlinked-background-host-v1";
const MEMORY_POLL_MS = 500;

/** The supervisor owns both leases, so daemon exit cannot release a live job's slot. */
export async function runBackgroundJob(
    job: BackgroundJob,
    cwd: string,
    signal: AbortSignal,
): Promise<RunProcessResult | null> {
    const key = `interlinked-background-job-v1\0${canonicalProjectRoot(cwd)}\0${job.name}`;
    const owner = tryAcquireCrossProcessCompilerLease(key);
    if (!owner) return null;
    try {
        const lane = await acquireCrossProcessCompilerLease(HOST_LANE, Date.now() + 120_000, signal);
        if (!lane) return null;
        try {
            return await runWithMemoryWatch(job, cwd, signal);
        } finally {
            lane.release();
        }
    } finally {
        owner.release();
    }
}

/** Recheck after waiting; abort the entire child group if host headroom disappears. */
async function runWithMemoryWatch(job: BackgroundJob, cwd: string, signal: AbortSignal): Promise<RunProcessResult | null> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const memory = readResourceMemory();
    const reserve = Math.max(GIB, memory.totalBytes / 8);
    const budget = Math.min(memory.totalBytes / 4, memory.availableBytes - reserve);
    const workers = Math.floor((budget - GIB) / GIB);
    if (!Number.isFinite(workers) || workers < 1) return null;
    // Admission may have waited behind another job: shrink stale worker plans.
    const args = job.args.map(arg => {
        if (!arg.startsWith("--maxWorkers=")) return arg;
        const requested = Number(arg.slice("--maxWorkers=".length));
        const bounded = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
        return `--maxWorkers=${Math.min(workers, bounded)}`;
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setInterval(() => {
        try {
            const current = readResourceMemory().availableBytes;
            if (!Number.isFinite(current) || current < reserve) abort();
        } catch {
            abort();
        }
    }, MEMORY_POLL_MS);
    try {
        return await runProcessAsync(job.file, args, {
            cwd, timeout: 600_000, signal: controller.signal,
            env: { NODE_OPTIONS: "--max-old-space-size=768" },
        });
    } finally {
        clearInterval(timer);
        signal.removeEventListener("abort", abort);
    }
}
