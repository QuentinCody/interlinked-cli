import { resolve } from "node:path";
import type { HookCheckReceipt } from "./hook-coverage-evidence.js";
import type { startHookFilesystemWatch } from "./hook-filesystem-watch.js";
import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import type { QualityCheckResult } from "./quality-checks/result-types.js";
import { runQualityChecks, resolveQualityCheckTarget, type QualityCheckOptions } from "./quality-checks.js";
import type { HarnessEvent, QualityCheckConfig } from "./types.js";
import type { ChangeSetExternalBatch } from "./quality-checks/change-set-external.js";

type Watcher = ReturnType<typeof startHookFilesystemWatch>;
type CheckInput = Pick<HookCheckReceipt, "id" | "path" | "identity" | "policyDigest" | "policyGeneration">;
const batchPolicies = new WeakMap<ChangeSetExternalBatch, { digest: string; generation: number }>();

function captureInput(watcher: Watcher, path: string): CheckInput | undefined {
    watcher.reconcile();
    if (watcher.status().readiness !== "ready") return undefined;
    const snapshot = watcher.ledger.observation();
    const entry = snapshot.pending.find(candidate => candidate.path === path);
    if (!entry || entry.identity === "missing") return undefined;
    return { id: entry.id, path, identity: entry.identity, policyDigest: watcher.ledger.policyDigest(), policyGeneration: watcher.ledger.summary().policyGeneration };
}

function recordOutcome(watcher: Watcher, input: CheckInput | undefined, result: { checks: string[]; findings: QualityCheckResult[]; unavailable: string[]; scopes?: HookCheckReceipt["scopes"] }): void {
    if (!input || !result.checks.length) return;
    watcher.reconcile();
    if (watcher.status().readiness !== "ready") return;
    if (result.scopes?.some(scope => !scope.inputs.some(file => file.path === input.path && file.identity === input.identity))) {
        result.unavailable.push("Shared evidence describes a different file version");
    }
    watcher.ledger.recordCheck({ ...input, checks: [...new Set(result.checks)],
        unavailable: result.unavailable,
        ...(result.scopes ? { scopes: result.scopes } : {}),
        findings: result.findings.map(finding => `${finding.severity}: ${finding.name}: ${finding.message}${finding.detail ? `\n${finding.detail}` : ""}`),
        checkedAt: new Date().toISOString(), kind: "automated_check" });
}

interface CoverageQualityOptions {
    watcher: Watcher | undefined;
    event: HarnessEvent;
    checks: Record<string, QualityCheckConfig>;
    cwd: string;
    options: QualityCheckOptions;
    externalBatch?: ChangeSetExternalBatch | undefined;
}

/** Consume actual per-file execution evidence before session suppression.
 * Aggregate external checks cannot be attributed to one file here. */
export async function runQualityChecksWithCoverage(input: CoverageQualityOptions): Promise<QualityCheckResult[]> {
    const { watcher, event, checks, cwd, options } = input;
    if (!watcher) return runQualityChecks(event, checks, cwd, options);
    rememberBatchPolicy(input);
    const target = resolveQualityCheckTarget(event, cwd);
    const captured = target ? captureInput(watcher, resolve(cwd, target.filePath)) : undefined;
    const completed: string[] = [];
    const results = await runQualityChecks(event, checks, cwd, { ...options, outChecksRan: completed });
    options.outChecksRan?.push(...completed);
    const unavailable = results.filter(finding => isOperationalCheckDeferral(finding.name)).map(finding => `${finding.name}: ${finding.message}`);
    recordOutcome(watcher, captured, await receiptOutcome(input, completed, results, unavailable));
    return results;
}

async function receiptOutcome(input: CoverageQualityOptions, checks: string[], results: QualityCheckResult[], unavailable: string[]): Promise<Parameters<typeof recordOutcome>[2]> {
    const path = resolveQualityCheckTarget(input.event, input.cwd)?.filePath;
    if (!input.externalBatch || !path) {
        if (input.options.skipMultiFileExternalChecks) unavailable.push("Shared external batch scope evidence is not attached to this per-file receipt");
        return { checks, findings: results.filter(row => !isOperationalCheckDeferral(row.name)), unavailable };
    }
    const external = await input.externalBatch.evidenceForFile(path);
    if (!batchPolicyMatches(input)) unavailable.push("Policy changed during shared batch execution");
    const findings = [...results, ...await input.externalBatch.resultsForFile(path)].filter(row => !isOperationalCheckDeferral(row.name));
    return { checks: [...checks, ...external.checks], findings, unavailable: [...unavailable, ...external.unavailable], scopes: external.scopes };
}

function rememberBatchPolicy(input: CoverageQualityOptions): void {
    if (!input.externalBatch || !input.watcher || batchPolicies.has(input.externalBatch)) return;
    batchPolicies.set(input.externalBatch, { digest: input.watcher.ledger.policyDigest(), generation: input.watcher.ledger.summary().policyGeneration });
}

function batchPolicyMatches(input: CoverageQualityOptions): boolean {
    if (!input.externalBatch || !input.watcher) return false;
    const policy = batchPolicies.get(input.externalBatch);
    return policy?.digest === input.watcher.ledger.policyDigest() && policy.generation === input.watcher.ledger.summary().policyGeneration;
}
