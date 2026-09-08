import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { newLintFindings, retireLintDebt } from "../../../lib/lint-import/baseline.js";
import { lintEntryLabel } from "../../../lib/lint-import/identity.js";
import { LINT_POLICY_PATH, loadLintPolicy } from "../../../lib/lint-import/policy.js";
import { measureImportedLint } from "../../../lib/lint-import/runner.js";
import { tryAcquireProjectHeavyProcessLease } from "../../project-heavy-process-lock.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

function policyRoot(start: string): string {
    let root = resolve(start);
    for (;;) {
        if (existsSync(join(root, LINT_POLICY_PATH))) return root;
        const parent = dirname(root);
        if (parent === root) throw new Error("No imported lint policy found");
        root = parent;
    }
}

/** Synchronous callers must not run package analyzers on the daemon event loop. */
export function runImportedLint(): CheckResult[] {
    throw new Error("Imported lint requires asynchronous execution; use interlinked lint check");
}

export async function runImportedLintAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
    const root = policyRoot(input.scope.projectRoot);
    if (root === resolve(input.scope.projectRoot)) return runImportedLintAtRoot(root, input);
    const release = tryAcquireProjectHeavyProcessLease(root);
    if (!release) throw new Error("Imported lint project capacity is busy; no verdict");
    try { return await runImportedLintAtRoot(root, input); }
    finally { release(); }
}

async function runImportedLintAtRoot(root: string, input: ToolRunnerInput): Promise<CheckResult[]> {
    const policy = loadLintPolicy(root);
    if (!policy) throw new Error("No imported lint policy found");
    const measurements = await measureImportedLint(root, policy, { timeoutMs: input.timeoutMs, cadence: input.scope.lintCadence ?? "hook" });
    const unavailable = measurements.filter((measurement) => measurement.status === "unavailable");
    if (unavailable.length > 0) {
        throw new Error(unavailable.map((measurement) => `${lintEntryLabel(measurement.entry)}: ${measurement.reason}`).join("; "));
    }
    const baseline = retireLintDebt(root, measurements);
    const findings = measurements.flatMap((measurement) => newLintFindings(measurement, baseline));
    const target = input.scope.targetFile ? resolve(input.scope.projectRoot, input.scope.targetFile) : undefined;
    return findings.filter((finding) => !input.scope.filterToFile || !target || resolve(root, finding.file) === target)
        .map((finding) => ({
            tool: "lint-import",
            file: relative(input.scope.projectRoot, resolve(root, finding.file)),
            line: finding.line,
            severity: "warning",
            ruleId: `${finding.tool}/${finding.rule}`,
            message: `[${finding.tool}/${finding.rule}${finding.config === undefined ? "" : `; config: ${finding.config}`}] ${finding.message}`,
        }));
}
