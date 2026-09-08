import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { tryAcquireProjectHeavyProcessLease } from "../harness/project-heavy-process-lock.js";
import { loadLintBaseline, newLintFindings, retireLintDebt, tightenLintBaseline } from "../lib/lint-import/baseline.js";
import { lintEntryLabel } from "../lib/lint-import/identity.js";
import { importedLintGuardUpdate, LINT_POLICY_PATH, loadLintPolicy, planLintImport, writeLintJson } from "../lib/lint-import/policy.js";
import { measureImportedLint } from "../lib/lint-import/runner.js";
import { type LintSelection, prepareLintImport } from "../lib/lint-import/selection.js";
import type { LintInventory, LintMeasurement } from "../lib/lint-import/types.js";

interface LintOptions extends LintSelection {
    json?: boolean;
    write?: boolean;
    details?: boolean;
    baseline?: boolean;
    updateBaseline?: boolean;
    timeout?: string;
}

function renderInvocationReview(inventory: LintInventory): void {
    for (const candidate of inventory.invocations ?? []) {
        if (candidate.reason) console.log(`  Review: ${candidate.origin.file}:${candidate.origin.line} (${candidate.origin.label}): ${candidate.reason}`);
    }
}

function renderInventory(inventory: LintInventory, details: boolean, plan = planLintImport(inventory)): void {
    console.log(`Lint discovery: ${inventory.root}`);
    for (const source of inventory.sources) {
        console.log(`  ${source.tool.padEnd(16)} ${source.file} (${source.kind})`);
        if (details) for (const declaration of source.declarations) console.log(`    ${declaration}`);
    }
    console.log(`${inventory.sources.length} sources; ${plan.policy.entries.length} importable scopes/profiles; ${plan.review.length} sources need review.`);
    for (const entry of plan.policy.entries) console.log(`  Adopt: ${lintEntryLabel(entry)}`);
    renderInvocationReview(inventory);
    console.log("Discovery inventories declarations; original analyzers resolve inherited and executable configuration.");
    for (const warning of inventory.warnings) console.log(`NOT INSPECTED: ${warning}`);
}

export function lintScanCommand(target: string, options: LintOptions): void {
    const { inventory, ...plan } = prepareLintImport(target, options, null);
    if (options.json) console.log(JSON.stringify({ ...inventory, ...plan }, null, 2));
    else renderInventory(inventory, options.details === true, plan);
    if (!inventory.complete) process.exitCode = 2;
}

export async function lintImportCommand(target: string, options: LintOptions): Promise<void> {
    timeoutFor(options);
    if (options.baseline && !options.write) throw new Error("--baseline requires --write");
    const { inventory, ...plan } = prepareLintImport(target, options);
    if (!options.write) {
        if (options.json) console.log(JSON.stringify({ ...inventory, ...plan, written: false }, null, 2));
        else {
            renderInventory(inventory, options.details === true, plan);
            console.log("Preview only. Repeat this command with --write; add --baseline to measure existing debt.");
        }
        if (!inventory.complete) process.exitCode = 2;
        return;
    }
    if (!inventory.complete) throw new Error("Discovery is incomplete; resolve the reported gaps before importing");
    if (plan.policy.entries.length === 0) throw new Error("No supported lint scopes to import; inspect the review list");
    const policy = plan.policy;
    const guardUpdate = importedLintGuardUpdate(inventory.root);
    writeLintJson(inventory.root, LINT_POLICY_PATH, policy);
    writeLintJson(inventory.root, ".interlinked/guard-rules.json", guardUpdate);
    if (options.baseline) {
        // interlinked: defer flag_argument -- This named Commander option requests explicit adoption through the shared CLI path.
        await lintCheckCommand(inventory.root, { ...options, updateBaseline: true });
        return;
    }
    if (options.json) console.log(JSON.stringify({ ...plan, policy, written: true }, null, 2));
    else {
        console.log(`Imported ${policy.entries.length} lint scopes/profiles into ${LINT_POLICY_PATH}; PostToolUse check enabled.`);
        console.log(`${plan.review.length} sources need review. Run interlinked lint check --update-baseline to adopt existing debt.`);
    }
}

function timeoutFor(options: LintOptions): number {
    const timeout = options.timeout === undefined ? 30_000 : Number(options.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) throw new Error("--timeout must be 1–300000 milliseconds");
    return timeout;
}

function renderMeasurements(measurements: LintMeasurement[], root: string): void {
    const baseline = loadLintBaseline(root);
    for (const measurement of measurements) {
        const label = lintEntryLabel(measurement.entry);
        if (measurement.status !== "measured") {
            console.log(`NOT CHECKED: ${label}: ${measurement.reason}`);
            continue;
        }
        const introduced = newLintFindings(measurement, baseline);
        console.log(`${label}: ${introduced.length} new findings; ${measurement.findings.length - introduced.length} baseline findings`);
        for (const finding of introduced) console.log(`  ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
    }
}

/** Unlike verify's inventory, this command has gate exit semantics: 0 clean, 1 new debt, 2 unmeasured. */
export async function lintCheckCommand(target: string, options: LintOptions): Promise<void> {
    const root = realpathSync(resolve(target));
    const timeout = timeoutFor(options);
    const policy = loadLintPolicy(root);
    if (!policy) throw new Error("No imported lint policy; run interlinked lint import --write first");
    const release = tryAcquireProjectHeavyProcessLease(root);
    if (!release) throw new Error("Lint check deferred: project check capacity is busy; no verdict");
    try {
        const measurements = await measureImportedLint(root, policy, { timeoutMs: timeout });
        const complete = measurements.every((measurement) => measurement.status === "measured");
        if (complete && options.updateBaseline) tightenLintBaseline(root, measurements);
        else if (complete) retireLintDebt(root, measurements);
        const baseline = loadLintBaseline(root);
        const introduced = measurements.flatMap((measurement) => newLintFindings(measurement, baseline));
        if (options.json) console.log(JSON.stringify({ root, complete, measurements, introduced, baseline_updated: complete && options.updateBaseline === true }, null, 2));
        else renderMeasurements(measurements, root);
        if (!complete) process.exitCode = 2;
        else if (introduced.length > 0) process.exitCode = 1;
    } finally { release(); }
}
