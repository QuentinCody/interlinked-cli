import { writeFileSync } from "node:fs";
import { describeResourceCommandOutcome, runResourceCommand } from "../src/harness/resource-command.js";

/** When set, the outcome report is written here as JSON so the caller can read the VERDICT, which the exit code alone cannot carry. */
const OUTCOME_FILE_ENV = "INTERLINKED_BOUNDED_OUTCOME";
const LIGHT_PROFILE_FLAG = "--light";

const controller = new AbortController();
const abort = (): void => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
    const argv = process.argv.slice(2);
    const profile = argv[0] === LIGHT_PROFILE_FLAG ? "light" : "heavy";
    if (profile === "light") argv.shift();
    const [file, ...args] = argv;
    if (!file) throw new Error("Usage: node --import tsx scripts/run-resource-bounded.ts <command> [args...]");
    // A command that never started is NOT RUN (exit 75, EX_TEMPFAIL) and a killed one is INTERRUPTED (also 75);
    // a child's own exit 75 is preserved as its verdict. The report file keeps the three apart for the caller.
    const report = describeResourceCommandOutcome(await runResourceCommand(file, args, controller.signal, profile));
    const outcomePath = process.env[OUTCOME_FILE_ENV];
    if (outcomePath) writeFileSync(outcomePath, `${JSON.stringify({ verdict: report.verdict, kind: report.kind, wait_capacity_ms: report.wait_capacity_ms, exit_code: report.exitCode })}\n`);
    if (report.message) console.error(report.message);
    process.exitCode = report.exitCode;
} finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
}
