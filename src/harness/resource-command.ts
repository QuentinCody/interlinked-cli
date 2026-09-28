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

/**
 * What happened to a bounded command. Only `ran` carries a verdict; the other three mean the command
 * never started, which the caller must report as NOT RUN and never as a failed check.
 */
export type ResourceCommandOutcome =
    | { kind: "ran"; result: RunProcessResult; wait_capacity_ms: number }
    | { kind: "capacity-timeout"; wait_capacity_ms: number }
    | { kind: "memory-budget-unavailable"; wait_capacity_ms: number }
    | { kind: "interrupted"; wait_capacity_ms: number };

/** Exit status for a bounded command that produced no verdict (EX_TEMPFAIL): the caller may retry, nothing failed. */
export const NO_VERDICT_EXIT_CODE = 75;

/**
 * What a supervising script may conclude. The exit code alone cannot carry this: a child's own
 * exit 75 and a killed child both surface as 75, so the verdict travels beside it.
 * - `not-run`: admission never happened (nothing failed, nothing verified)
 * - `interrupted`: the command started and was killed or timed out (no verdict)
 * - `exit`: the command ran to completion; `exitCode` is its own
 */
export type ResourceCommandVerdict = "not-run" | "interrupted" | "exit";
export interface ResourceCommandReport { verdict: ResourceCommandVerdict; kind: ResourceCommandOutcome["kind"]; wait_capacity_ms: number; exitCode: number; message: string | null; }

/** One line for stderr, the exit code a supervising script should adopt, and the verdict it may draw. */
export function describeResourceCommandOutcome(outcome: ResourceCommandOutcome): ResourceCommandReport {
    const waited = `${Math.round(outcome.wait_capacity_ms / 1000)}s`;
    const base = { kind: outcome.kind, wait_capacity_ms: outcome.wait_capacity_ms };
    switch (outcome.kind) {
        case "capacity-timeout":
            return { ...base, verdict: "not-run", exitCode: NO_VERDICT_EXIT_CODE, message: `[resources] NOT RUN: waited ${waited} for host capacity and none opened; no verification verdict.` };
        case "memory-budget-unavailable":
            return { ...base, verdict: "not-run", exitCode: NO_VERDICT_EXIT_CODE, message: `[resources] NOT RUN: host memory budget unavailable after admission (waited ${waited}); no verification verdict.` };
        case "interrupted":
            return { ...base, verdict: "not-run", exitCode: NO_VERDICT_EXIT_CODE, message: "[resources] NOT RUN: interrupted before the command started; no verification verdict." };
        case "ran": {
            const { result } = outcome;
            if (result.killed || result.timedOut || result.code === null) {
                return { ...base, verdict: "interrupted", exitCode: NO_VERDICT_EXIT_CODE, message: `[resources] INTERRUPTED: ${result.resourceReason ?? "command killed or timed out"}; no verification verdict.` };
            }
            return { ...base, verdict: "exit", exitCode: result.code, message: null };
        }
    }
}

/** Developer checks use the same host lane and bounded child lifecycle as scheduled work. */
export async function runResourceCommand(file: string, args: string[], signal: AbortSignal, profile: "heavy" | "light" = "heavy"): Promise<ResourceCommandOutcome> {
    // A daemon push check can already own the host lane for five minutes.
    const waitMs = profile === "light" ? 5000 : 600_000;
    const check = [file, ...args].join(" ").slice(0, CHECK_LABEL_MAX_CHARS);
    const waitStarted = Date.now();
    let lane: Awaited<ReturnType<typeof acquireTestCapacity>>;
    try {
        lane = await acquireTestCapacity("foreground", Date.now() + waitMs, signal);
    } catch (error) {
        // The blocking lease wait throws when its signal aborts; that is a cancelled admission, not a crash.
        if (!signal.aborted) throw error;
        lane = null;
    }
    const wait_capacity_ms = elapsedMs(waitStarted);
    if (!lane) {
        const denied = signal.aborted ? "interrupted" : "capacity-timeout";
        recordCommand({ check, wait_capacity_ms, status: "deferred", denied });
        return { kind: denied, wait_capacity_ms };
    }
    try {
        const resourceBudget = readResourceBudget(profile);
        if (!resourceBudget || signal.aborted) {
            const denied = resourceBudget ? "interrupted" : "memory-budget-unavailable";
            recordCommand({ check, wait_capacity_ms, status: "deferred", denied });
            return { kind: denied, wait_capacity_ms };
        }
        const command = process.platform === "win32" ? [file, ...args] : ["nice", "-n", "10", file, ...args];
        const executable = command.shift();
        if (!executable) return { kind: "interrupted", wait_capacity_ms };
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
        return { kind: "ran", result, wait_capacity_ms };
    } finally { lane.release(); }
}
