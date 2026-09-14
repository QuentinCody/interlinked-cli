import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";

const SUPERVISOR = "INTERLINKED_RESOURCE_SUPERVISOR_PID";

/** The direct child consumes its marker before command dispatch or evidence capture. */
function supervisedChild(): boolean {
    const parent = Number(process.env[SUPERVISOR]);
    delete process.env[SUPERVISOR];
    return Number.isSafeInteger(parent) && parent > 0 && parent === process.ppid;
}

/** Keep the monitor outside heavy CLI scans, whose event loop may be busy. */
export async function superviseResourceCli(argv: string[]): Promise<boolean> {
    if (supervisedChild()) return false;
    if (argv[2] !== "verify" && argv[2] !== "tests") return false;
    if (argv[2] === "tests" && argv[3] === "status") return false;
    if (argv.includes("--help") || argv.includes("-h")) return false;
    const resourceBudget = readResourceBudget() ?? readResourceBudget("light");
    if (!resourceBudget) {
        process.stderr.write("[resources] Host memory capacity unavailable; no verification verdict.\n");
        process.exitCode = 75;
        return true;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
        const heapMb = Math.min(1536, Math.floor(resourceBudget.maxRssBytes / 1024 ** 2 / 2));
        const result = await runProcessAsync(process.execPath, [...process.execArgv, `--max-old-space-size=${heapMb}`, ...argv.slice(1)], {
            timeout: 3600_000, signal: controller.signal, resourceBudget, inheritOutput: true,
            env: { [SUPERVISOR]: String(process.pid), GOMAXPROCS: "2", UV_THREADPOOL_SIZE: "2" },
        });
        process.exitCode = result.code ?? 75;
        if (result.killed || result.timedOut) {
            process.stderr.write(`[resources] ${result.resourceReason ?? "CLI interrupted"}; no verification verdict.\n`);
            process.exitCode = 75;
        }
    } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
    }
    return true;
}
