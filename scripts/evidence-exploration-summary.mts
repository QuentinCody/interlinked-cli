import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "../src/lib/json-types.js";

export function explorationOutcome(file: string) {
    const base = { schema: "exploration-outcome.v1", owner: "QuentinCody", seed_policy: "varying; replay seeds retained in failing Vitest output" };
    try {
        if (statSync(file).size > 4 * 1024 * 1024) throw new Error("report exceeds 4 MiB read budget");
        const report: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (!isJsonObject(report) || typeof report.success !== "boolean" || typeof report.numTotalTests !== "number"
            || typeof report.numPassedTests !== "number" || typeof report.numFailedTests !== "number") throw new Error("invalid Vitest report");
        const status = report.success && report.numPassedTests > 0 && report.numFailedTests === 0 ? "passed" : "failed";
        return { ...base, status, tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests };
    } catch (error) {
        return { ...base, status: "unavailable", reason: String(error) };
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const directory = resolve(process.argv[2] ?? ".interlinked/agent-output/deep-audit");
    const result = explorationOutcome(join(directory, "exploration.json"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "exploration-outcome.json"), JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Exploration: **${result.status}**. Owner: QuentinCody. See retained exploration artifacts for failures and replay seeds.\n`);
    if (result.status !== "passed") process.exitCode = 1;
}
