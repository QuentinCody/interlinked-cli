import { getOutputMode, output, outputError } from "../lib/output.js";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { collectGateReachSnapshot, enumerateEligibleFiles } from "../harness/gate-reach-collect.js";
import { coverageExecutionReach } from "../harness/coverage-execution.js";
import { loadRules } from "../harness/rules-loader.js";
import { coverageIndexContext } from "../harness/coverage-index/context.js";
import { coverageIndexStatus } from "../harness/coverage-index/controller.js";
import { warmCoverageIndex } from "../harness/coverage-index/warm.js";
import { readMeasurementExecutions } from "../lib/metrics/execution-journal.js";
import type { MetricsAnalysisOptions } from "./metrics-analysis.js";

export function metricsGatesCommand(options: MetricsAnalysisOptions): void {
    try {
        const root = options.cwd ?? process.cwd(), rules = loadRules(root), eligible = enumerateEligibleFiles(root);
        const configuredEnabled = rules.per_edit_coverage?.enabled === true, mode = rules.per_edit_coverage?.mode ?? "off";
        const enabled = configuredEnabled && mode === "block";
        const result = { schemaVersion: 1, policy: { perEditCoverageEnabled: configuredEnabled, mode, executes: enabled },
            reach: collectGateReachSnapshot({ cwd: root, sessionId: "metrics-cli", now: Date.now(), perEditCoverageEnabled: enabled }),
            execution: coverageExecutionReach(root, eligible), journal: readMeasurementExecutions(root),
            definitions: { reach: "Files with a measurement divided by eligible files; independent of covered lines", freshness: "Exact source, tests, configuration and support inputs still match", baseline: "Historical ratchet entries; not a fresh coverage measurement" } };
        output(getOutputMode(options), result, { normal: () => [`Per-edit coverage: ${enabled ? "enabled" : "disabled"}`,
            `Fresh measurements: ${result.execution.measured}/${eligible.length} files; ${result.execution.stale} stale/unavailable observations`,
            `${result.execution.attempts} recorded executions; p50 ${result.execution.p50Ms ?? "unmeasured"} ms; p95 ${result.execution.p95Ms ?? "unmeasured"} ms`,
            ...result.execution.issues, result.definitions.reach, result.definitions.baseline].join("\n"), short: () => `coverage=${enabled ? "on" : "off"}; fresh=${result.execution.measured}/${eligible.length}; attempts=${result.execution.attempts}` });
    } catch (error) { outputError(getOutputMode(options), error instanceof Error ? error.message : "Gate status unavailable"); }
}
export async function metricsCoverageCommand(kind: "warm" | "status", options: MetricsAnalysisOptions & { timeout?: string }): Promise<void> {
    try {
        const root = options.cwd ?? process.cwd(), timeout = Number(options.timeout ?? 60_000);
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000) throw new Error("Timeout must be 1–3600000 ms");
        if (kind === "status") {
            const result = coverageIndexStatus(coverageIndexContext(collectRepositoryInventory(root)));
            output(getOutputMode(options), result, { normal: () => [`Coverage index: ${result.valid ? "current" : "unavailable or stale"}; ${result.shards} test shards`, ...result.reasons].join("\n"), short: () => `valid=${result.valid}; shards=${result.shards}` });
            return;
        }
        const result = await warmCoverageIndex(root, timeout);
        output(getOutputMode(options), result, { normal: () => `Coverage index ${result.indexed ? "accepted" : "not accepted"}; ${result.status.shards} shards; ${Math.round(result.durationMs)} ms${result.reason ? `\n${result.reason}` : ""}`, short: () => `indexed=${result.indexed}; shards=${result.status.shards}` });
        if (!result.indexed) process.exitCode = 1;
    } catch (error) { outputError(getOutputMode(options), error instanceof Error ? error.message : "Coverage command failed"); }
}
