import { realpathSync } from "node:fs";
import { output, outputError, getOutputMode } from "../lib/output.js";
import { changedTestInputs, loadTestPlan } from "../harness/test-plan-inputs.js";
import { pendingTests } from "../harness/test-requests.js";
import { scheduleTests } from "../harness/test-scheduler.js";
import type { TestPlan } from "../harness/test-plan.js";
import { readTestRunObservation } from "../harness/test-run-observation.js";

interface TestsOptions { cwd?: string; base?: string; all?: boolean; json?: boolean; timeout?: string; workers?: string; }

export function formatTestPlan(plan: TestPlan): string {
    const summary = `${plan.mode}: ${plan.tests.length} test files; ${plan.omitted.length} omitted; estimated serial time ${plan.estimatedSerialMs === null ? "unmeasured" : `${plan.estimatedSerialMs} ms`}`;
    return [summary, `Snapshot: ${plan.snapshot}`, `Result reuse: ${plan.reusable ? "eligible after runtime validation" : "disabled for uncertain inputs"}`,
        ...plan.reasons, ...plan.tests.map(test => `${test.path}: ${test.reasons.join("; ")}`)].join("\n");
}

function positive(value: string | undefined, fallback: number, maximum: number): number {
    const number = Number(value ?? fallback);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`Expected an integer from 1 to ${maximum}`);
    return number;
}

export async function testsCommand(kind: "plan" | "run" | "status", paths: string[], options: TestsOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd());
        const pending = pendingTests(root);
        if (kind === "status") {
            const latest = readTestRunObservation(root);
            output(mode, { ...pending, latest }, { normal: () => `${pending.ids.length} pending requests\n${pending.paths.join("\n")}\nLast observation: ${latest ? `${latest.status} ${latest.runId} at ${latest.observedAt} (owner PID ${latest.pid})` : "none"}` });
            return;
        }
        const timeoutMs = positive(options.timeout, 60_000, 3_600_000);
        const changed = paths.length || options.all ? paths : changedTestInputs(root, options.base);
        if (kind === "plan") {
            const plan = await loadTestPlan(root, [...new Set([...changed, ...pending.paths])], timeoutMs, options.all === true || pending.full);
            output(mode, plan, { normal: () => formatTestPlan(plan) });
            return;
        }
        const result = await scheduleTests({ root, paths: changed, timeoutMs, full: options.all === true, maxWorkers: positive(options.workers, 2, 64) });
        output(mode, result, { normal: () => `${result.status}${result.reused ? " (reused)" : ""}: ${result.durationMs} ms; run ${result.runId}\n${formatTestPlan(result.plan)}\n${result.reason}\n${result.output}` });
        if (result.status !== "passed" && result.status !== "empty") process.exitCode = 1;
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "Test planning unavailable"); }
}
