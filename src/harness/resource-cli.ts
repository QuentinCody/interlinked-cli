import { readResourceBudget, resourceBudgetSnapshot, type ResourceBudget } from "./resource-budget.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { elapsedMs, recordVerificationStage, stageFromEnvironment } from "./verification-stages.js";
import { resolve } from "node:path";
import { withProcessCancellation } from "./check-engine/process-cancellation.js";
import { waitForResource } from "./resource-wait.js";
import { boundedNodeHeap } from "./node-heap-limit.js";
import { appendVerifyTiming } from "../commands/verify/check-timing.js";
import { randomUUID } from "node:crypto";

const SUPERVISOR = "INTERLINKED_RESOURCE_SUPERVISOR_PID";

/** Indexed runs already own admission; dispatch supplies cancellation ownership without another supervisor. */
export async function withResourceCliCancellation(argv: string[], work: () => Promise<void>): Promise<void> {
    const args = argv.slice(2, argv.indexOf("--") < 0 ? undefined : argv.indexOf("--"));
    const indexed = (args[0] === "coverage" && args.includes("--from-index") && (args[1] === "check" || args[1]?.startsWith("-")))
        || (args[0] === "metrics" && args[1] === "coverage" && args[2] === "warm");
    if (!indexed || args.includes("--help") || args.includes("-h")) return work();
    const controller = new AbortController();
    const interrupt = (): void => controller.abort(new Error("Coverage index cancelled by SIGINT"));
    const terminate = (): void => controller.abort(new Error("Coverage index cancelled by SIGTERM"));
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
        await withProcessCancellation(controller.signal, work);
    } catch (error) {
        if (!controller.signal.aborted) throw error;
    } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
        if (controller.signal.aborted) {
            process.exitCode = 75;
            process.stderr.write("[resources] Coverage index interrupted; no verification verdict.\n");
        }
    }
}

/** The direct child consumes its marker before command dispatch or evidence capture. */
function supervisedChild(): boolean {
    const parent = Number(process.env[SUPERVISOR]);
    delete process.env[SUPERVISOR];
    return Number.isSafeInteger(parent) && parent > 0 && parent === process.ppid;
}

/** Match the tests command's project override when the child cannot finish its own telemetry. */
function ledgerRoot(argv: string[]): string {
    let root = process.cwd();
    if (argv[2] !== "tests") return root;
    for (let index = 3; index < argv.length && argv[index] !== "--"; index++) {
        const arg = argv[index] ?? "";
        if (arg === "--cwd" && argv[index + 1]) root = resolve(argv[++index] ?? root);
        else if (arg.startsWith("--cwd=")) root = resolve(arg.slice("--cwd=".length));
    }
    return root;
}

function commandDeadline(argv: string[], started: number): number {
    let timeout = 3600_000;
    for (let index = 3; index < argv.length && argv[index] !== "--"; index++) {
        const arg = argv[index] ?? "";
        const value = arg === "--timeout" ? argv[++index] : arg.startsWith("--timeout=") ? arg.slice(10) : undefined;
        if (value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0)
            timeout = Math.min(3600_000, Number(value));
    }
    return started + timeout;
}

async function runSupervisedCli(argv: string[], signal: AbortSignal, resourceBudget: ResourceBudget, timeout: number, wait_capacity_ms: number): Promise<void> {
    const ceiling = Math.min(1536, Math.floor(resourceBudget.maxRssBytes / 1024 ** 2 / 2));
    const heapMb = boundedNodeHeap([process.env.NODE_OPTIONS ?? "", ...process.execArgv].join(" "), ceiling);
    if (heapMb === null) {
        process.stderr.write("[resources] NOT RUN: ambiguous or percentage heap override; no verification verdict.\n");
        process.exitCode = 75;
        return;
    }
    const started = Date.now();
    const result = await runProcessAsync(process.execPath, [...process.execArgv, `--max-old-space-size=${heapMb}`, ...argv.slice(1)], {
        timeout, signal, resourceBudget, inheritOutput: true,
        env: { [SUPERVISOR]: String(process.pid), GOMAXPROCS: "2", UV_THREADPOOL_SIZE: "2" },
    });
    process.exitCode = result.code ?? 75;
    if (argv[2] === "verify") appendVerifyTiming(ledgerRoot(argv), { run_id: `process:${randomUUID()}`,
        check: "managed_process_tree", duration_ms: elapsedMs(started), calls: 1,
        status: result.killed || result.timedOut || result.code === null ? "interrupted" : "complete",
        peak_rss_bytes: result.peakRssBytes ?? null, rss_budget_bytes: resourceBudget.maxRssBytes,
        reserve_bytes: resourceBudget.reserveBytes, heap_limit_mb: heapMb, exit_code: result.code });
    // An external signal can leave code null without setting a local cancellation flag.
    if (result.code !== null && !result.killed && !result.timedOut && !signal.aborted) return;
    process.stderr.write(`[resources] ${result.resourceReason ?? "CLI interrupted"}; no verification verdict.\n`);
    process.stderr.write(`[resources] MEMORY: peak_rss_bytes=${result.peakRssBytes ?? "unavailable"} rss_budget_bytes=${resourceBudget.maxRssBytes} reserve_bytes=${resourceBudget.reserveBytes} heap_limit_mb=${heapMb}.\n`);
    // The child may be killed before finishing telemetry; this outer row carries no passing check identity.
    recordVerificationStage(ledgerRoot(argv), { stage: stageFromEnvironment("cli"), check: `cli:${argv[2]}`,
        identity: null, status: "deferred", reused: false, reuse_denied_reason: "interrupted", wait_capacity_ms, exec_ms: elapsedMs(started),
        rss_budget_bytes: resourceBudget.maxRssBytes, heap_limit_mb: heapMb,
        ...(result.peakRssBytes === undefined ? {} : { peak_rss_bytes: result.peakRssBytes }),
    });
    process.exitCode = 75;
}

async function admitCli(argv: string[], signal: AbortSignal): Promise<void> {
    const started = Date.now(), deadline = commandDeadline(argv, started);
    // An interactive verify must distinguish admission from slow checks promptly.
    // Keep the heavy-memory requirement; never turn an admission refusal into a pass.
    const admissionLimit = argv[2] === "verify" ? 30_000 : 600_000;
    const budget = await waitForResource(() => readResourceBudget(), Math.min(deadline, started + admissionLimit), signal,
        () => process.stderr.write(`[resources] Waiting for host memory capacity within the command deadline; no verification has started. ${JSON.stringify(resourceBudgetSnapshot())}\n`));
    const waited = elapsedMs(started), remaining = deadline - Date.now();
    if (argv[2] === "verify") appendVerifyTiming(ledgerRoot(argv), { run_id: `admission:${randomUUID()}`,
        check: "host_memory_admission", duration_ms: waited, calls: 1, max_call_ms: waited,
        status: budget ? "admitted" : "deferred", execution_started: false, admission: resourceBudgetSnapshot() });
    if (budget && !signal.aborted && remaining > 0) return runSupervisedCli(argv, signal, budget, remaining, waited);
    process.stderr.write("[resources] NOT RUN: host memory capacity unavailable or admission interrupted; no verification verdict.\n");
    recordVerificationStage(ledgerRoot(argv), { stage: stageFromEnvironment("cli"), check: `cli:${argv[2]}`,
        identity: null, status: "deferred", reused: false, wait_capacity_ms: waited, exec_ms: 0,
        reuse_denied_reason: signal.aborted ? "interrupted" : "memory-budget-unavailable" });
    process.exitCode = 75;
}

/** Keep the monitor outside heavy CLI scans, whose event loop may be busy. */
export async function superviseResourceCli(argv: string[]): Promise<boolean> {
    if (supervisedChild()) return false;
    if (argv[2] !== "verify" && argv[2] !== "tests") return false;
    if (argv[2] === "tests" && argv[3] === "status") return false;
    if (argv.includes("--help") || argv.includes("-h")) return false;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try { await admitCli(argv, controller.signal); }
    finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
    }
    return true;
}
