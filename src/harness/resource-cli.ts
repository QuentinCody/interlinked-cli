import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { elapsedMs, recordVerificationStage, stageFromEnvironment } from "./verification-stages.js";
import { resolve } from "node:path";

const SUPERVISOR = "INTERLINKED_RESOURCE_SUPERVISOR_PID";

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

/** Keep the monitor outside heavy CLI scans, whose event loop may be busy. */
export async function superviseResourceCli(argv: string[]): Promise<boolean> {
    if (supervisedChild()) return false;
    if (argv[2] !== "verify" && argv[2] !== "tests") return false;
    if (argv[2] === "tests" && argv[3] === "status") return false;
    if (argv.includes("--help") || argv.includes("-h")) return false;
    const resourceBudget = readResourceBudget() ?? readResourceBudget("light");
    if (!resourceBudget) {
        // Nothing ran: this is NOT RUN (EX_TEMPFAIL), never a failed check.
        process.stderr.write("[resources] NOT RUN: host memory capacity unavailable; no verification verdict.\n");
        process.exitCode = 75;
        return true;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
        const heapMb = Math.min(1536, Math.floor(resourceBudget.maxRssBytes / 1024 ** 2 / 2));
        const started = Date.now();
        const result = await runProcessAsync(process.execPath, [...process.execArgv, `--max-old-space-size=${heapMb}`, ...argv.slice(1)], {
            timeout: 3600_000, signal: controller.signal, resourceBudget, inheritOutput: true,
            env: { [SUPERVISOR]: String(process.pid), GOMAXPROCS: "2", UV_THREADPOOL_SIZE: "2" },
        });
        process.exitCode = result.code ?? 75;
        if (result.killed || result.timedOut) {
            process.stderr.write(`[resources] ${result.resourceReason ?? "CLI interrupted"}; no verification verdict.\n`);
            process.stderr.write(`[resources] MEMORY: peak_rss_bytes=${result.peakRssBytes ?? "unavailable"} rss_budget_bytes=${resourceBudget.maxRssBytes} reserve_bytes=${resourceBudget.reserveBytes} heap_limit_mb=${heapMb}.\n`);
            // The inner CLI may be killed before it can finish its own stage row. Preserve the outer tree's facts;
            // this interrupted supervisor row carries no check identity or passing verification verdict.
            recordVerificationStage(ledgerRoot(argv), { stage: stageFromEnvironment("cli"), check: `cli:${argv[2]}`,
                identity: null, status: "deferred", reused: false, reuse_denied_reason: "interrupted", exec_ms: elapsedMs(started),
                rss_budget_bytes: resourceBudget.maxRssBytes, heap_limit_mb: heapMb,
                ...(result.peakRssBytes === undefined ? {} : { peak_rss_bytes: result.peakRssBytes }),
            });
            process.exitCode = 75;
        }
    } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
    }
    return true;
}
