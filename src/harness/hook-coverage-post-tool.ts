import { resolve } from "node:path";
import type { HookCheckReceipt } from "./hook-coverage-evidence.js";
import type { startHookFilesystemWatch } from "./hook-filesystem-watch.js";
import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import type { QualityCheckResult } from "./quality-checks/result-types.js";
import { runQualityChecks, resolveQualityCheckTarget, type QualityCheckOptions } from "./quality-checks.js";
import type { HarnessEvent, QualityCheckConfig } from "./types.js";

type Watcher = ReturnType<typeof startHookFilesystemWatch>;
type CheckInput = Pick<HookCheckReceipt, "id" | "path" | "identity" | "policyDigest" | "policyGeneration">;

function captureInput(watcher: Watcher, path: string): CheckInput | undefined {
    watcher.reconcile();
    if (watcher.status().readiness !== "ready") return undefined;
    const snapshot = watcher.ledger.snapshot();
    const entry = snapshot.pending.find(candidate => candidate.path === path);
    if (!entry || entry.identity === "missing") return undefined;
    return { id: entry.id, path, identity: entry.identity, policyDigest: watcher.ledger.policyDigest(), policyGeneration: snapshot.policyGeneration };
}

function recordOutcome(watcher: Watcher, input: CheckInput | undefined, result: { checks: string[]; findings: QualityCheckResult[] }): void {
    if (!input || !result.checks.length) return;
    if (result.findings.some(finding => isOperationalCheckDeferral(finding.name))) return;
    watcher.reconcile();
    if (watcher.status().readiness !== "ready") return;
    watcher.ledger.recordCheck({ ...input, checks: [...new Set(result.checks)],
        findings: result.findings.map(finding => `${finding.severity}: ${finding.name}: ${finding.message}${finding.detail ? `\n${finding.detail}` : ""}`),
        checkedAt: new Date().toISOString(), kind: "automated_check" });
}

interface CoverageQualityOptions {
    watcher: Watcher | undefined;
    event: HarnessEvent;
    checks: Record<string, QualityCheckConfig>;
    cwd: string;
    options: QualityCheckOptions;
}

/** Consume actual per-file execution evidence before session suppression.
 * Aggregate external checks cannot be attributed to one file here. */
export async function runQualityChecksWithCoverage(input: CoverageQualityOptions): Promise<QualityCheckResult[]> {
    const { watcher, event, checks, cwd, options } = input;
    if (!watcher || options.skipMultiFileExternalChecks) return runQualityChecks(event, checks, cwd, options);
    const target = resolveQualityCheckTarget(event, cwd);
    const captured = target ? captureInput(watcher, resolve(cwd, target.filePath)) : undefined;
    const completed: string[] = [];
    const results = await runQualityChecks(event, checks, cwd, { ...options, outChecksRan: completed });
    options.outChecksRan?.push(...completed);
    recordOutcome(watcher, captured, { checks: completed, findings: results });
    return results;
}
