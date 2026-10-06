import { realpathSync } from "node:fs";
import { type Command, type OptionValues } from "commander";

/** Inspection joins immutable receipts; replay is an explicit bounded execution. */
export function registerE2eReplay(e2e: Command): void {
    e2e.command("attempts <cohort>").description("Inspect captured seeds, clocks, duration and failing cases")
        .option("--cwd <path>", "Repository root").option("--json", "Machine-readable evidence")
        .action(async (cohort: string, options: OptionValues) => {
            const { storedAttempts } = await import("../harness/project-e2e/replay.js");
            console.log(JSON.stringify(storedAttempts(realpathSync(options.cwd ?? process.cwd()), cohort), null, 2));
        });
    e2e.command("replay <cohort> <attempt>").description("Replay a stored attempt against matching declared inputs; retain original failure")
        .option("--cwd <path>", "Repository root").option("--timeout <ms>", "Bounded execution budget (1–600000)", "120000")
        .option("--json", "Machine-readable evidence")
        .action(async (cohort: string, attempt: string, options: OptionValues) => {
            const { replayStoredAttempt } = await import("../harness/project-e2e/replay.js");
            const timeoutMs = Number(options.timeout), index = Number(attempt);
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error("timeout must be 1–600000 ms");
            if (!Number.isSafeInteger(index) || index < 1) throw new Error("attempt must be a positive integer");
            const result = await replayStoredAttempt({ root: realpathSync(options.cwd ?? process.cwd()), cohortId: cohort, attempt: index, timeoutMs });
            console.log(JSON.stringify(result, null, 2));
            process.exitCode = result.outcome === "refused" || result.outcome === "inconclusive" ? 2 : 0;
        });
}
