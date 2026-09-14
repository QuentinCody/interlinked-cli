import { runResourceCommand } from "../src/harness/resource-command.js";

const controller = new AbortController();
const abort = (): void => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
    const argv = process.argv.slice(2);
    const profile = argv[0] === "--light" ? "light" : "heavy";
    if (profile === "light") argv.shift();
    const [file, ...args] = argv;
    if (!file) throw new Error("Usage: node --import tsx scripts/run-resource-bounded.ts <command> [args...]");
    const result = await runResourceCommand(file, args, controller.signal, profile);
    if (!result || result.killed || result.timedOut || result.code === null) {
        console.error(`[resources] ${result?.resourceReason ?? "Host capacity unavailable or command interrupted"}; no verification verdict.`);
        process.exitCode = 75;
    } else process.exitCode = result.code;
} finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
}
