import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { HookPendingCheck } from "./hook-coverage-ledger.js";
import type { HookCheckEvidence, HookCoverageChecker } from "./hook-coverage-verification.js";
import { isInsideRoot } from "./large-file-policy.js";
import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import { createChangeSetExternalBatch } from "./quality-checks/change-set-external.js";
import { pathMatchesCheck } from "./quality-checks/change-set-external-candidates.js";
import { findProjectRoot } from "./quality-checks/project-root.js";
import { isLikelyTestFile } from "./quality-checks/test-classifier.js";
import type { QualityCheckResult } from "./quality-checks/result-types.js";
import { resolveQualityCheckTarget, runQualityChecks } from "./quality-checks.js";
import type { HarnessEvent, QualityCheckConfig } from "./types.js";

// Recovery is an explicit background job. Group up to the external batch cap
// so overlapping related suites run once; bound worker count in the runner.
const RECOVERY_BATCH_SIZE = 32;
const RECOVERY_TEST_TIMEOUT_MS = 900_000;

function recoveryChecks(configured: Record<string, QualityCheckConfig>): Record<string, QualityCheckConfig> {
    const checks = structuredClone(configured);
    const tests = checks.affected_tests;
    if (tests) {
        tests.timeout_ms = Math.max(tests.timeout_ms, RECOVERY_TEST_TIMEOUT_MS);
        tests.max_dependent_tests = Math.max(tests.max_dependent_tests ?? 8, RECOVERY_BATCH_SIZE);
    }
    return checks;
}

function recoveryBatches(root: string, entries: readonly HookPendingCheck[], checks: Record<string, QualityCheckConfig>): HookPendingCheck[][] {
    const groups = new Map<string, HookPendingCheck[]>();
    for (const entry of entries) {
        const project = resolve(findProjectRoot(entry.path, root) ?? root);
        const test = isLikelyTestFile(basename(entry.path, extname(entry.path)), entry.path);
        const applicable = Object.entries(checks).filter(([name, check]) => check.enabled &&
            (name !== "affected_tests" || !test) && pathMatchesCheck(entry.path, check)).map(([name]) => name).sort();
        const key = JSON.stringify([project, applicable]);
        const group = groups.get(key) ?? [];
        group.push(entry);
        groups.set(key, group);
    }
    return [...groups.values()].flatMap(group => Array.from(
        { length: Math.ceil(group.length / RECOVERY_BATCH_SIZE) },
        (_, index) => group.slice(index * RECOVERY_BATCH_SIZE, (index + 1) * RECOVERY_BATCH_SIZE),
    ));
}

function capturedContent(root: string, entry: HookPendingCheck): string {
    if (entry.identity === "missing") throw new Error("File is absent; review deletion or optional absence explicitly");
    if (!isInsideRoot(root, entry.path)) throw new Error("File is outside the workspace");
    const stat = lstatSync(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("File is not a regular file");
    const bytes = readFileSync(entry.path);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.identity) throw new Error("File changed before checking");
    return bytes.toString("utf8");
}

function checkEvent(root: string, entry: HookPendingCheck, content: string): HarnessEvent {
    // The legacy checker requires an adapter tag. This dry-run envelope is
    // never emitted as a provider observation; receipt writer identity stays unknown.
    return { hook_event: "PostToolUse", session_id: "hook-coverage-verification", agent_source: "claude",
        tool_name: "Write", tool_input: { file_path: entry.path, content }, cwd: root,
        timestamp: new Date().toISOString(), dry_run: true };
}

function findingText(result: QualityCheckResult): string {
    return `${result.severity}: ${result.name}: ${result.message}${result.detail ? `\n${result.detail}` : ""}`;
}

function collectInputs(root: string, entries: readonly HookPendingCheck[], evidence: Map<string, HookCheckEvidence>): Map<HookPendingCheck, HarnessEvent> {
    const inputs = new Map<HookPendingCheck, HarnessEvent>();
    for (const entry of entries) {
        try {
            const event = checkEvent(root, entry, capturedContent(root, entry));
            if (!resolveQualityCheckTarget(event, root)) throw new Error("Path is excluded from quality checks");
            inputs.set(entry, event);
        } catch (error) { evidence.set(entry.id, { checks: [], findings: [], unavailable: [String(error)] }); }
    }
    return inputs;
}

/** Reuses configured PostToolUse checks with one bounded external batch.
 * Receipts enumerate completed checks; they do not certify unrun hook phases. */
export function createHookCoverageChecker(root: string, getChecks: () => Record<string, QualityCheckConfig>): HookCoverageChecker {
    const checker: HookCoverageChecker = async entries => {
        const evidence = new Map<string, HookCheckEvidence>();
        const configured = structuredClone(getChecks());
        const checks = recoveryChecks(configured);
        for (const batch of recoveryBatches(root, entries, configured)) {
            await checkRecoveryBatch(root, batch, checks, evidence);
        }
        if (JSON.stringify(configured) !== JSON.stringify(getChecks())) {
            for (const result of evidence.values()) result.unavailable.push("Configured checks changed during verification");
        }
        return evidence;
    };
    checker.batches = entries => recoveryBatches(root, entries, getChecks());
    return checker;
}

async function checkRecoveryBatch(root: string, entries: readonly HookPendingCheck[], checks: Record<string, QualityCheckConfig>, evidence: Map<string, HookCheckEvidence>): Promise<void> {
    const inputs = collectInputs(root, entries, evidence);
    if (!inputs.size) return;
    const externalRan: string[] = [];
    const external = createChangeSetExternalBatch({ cwd: root, paths: [...inputs.keys()].map(entry => entry.path), checks, outChecksRan: externalRan, recovery: true });
    const externalRows = new Map<string, QualityCheckResult[]>();
    for (const [entry] of inputs) externalRows.set(entry.id, await external.resultsForFile(entry.path));
    // Shared deferrals invalidate their compatible group, never unrelated
    // documentation or another project's completed checks.
    const deferred = [...externalRows.values()].flat().filter(row => isOperationalCheckDeferral(row.name)).map(findingText);
    for (const [entry, event] of inputs) {
        evidence.set(entry.id, await checkInput({ root, entry, event, checks, externalRan, externalRows: externalRows.get(entry.id) ?? [], deferred }));
    }
}

interface CheckInputOptions {
    root: string;
    entry: HookPendingCheck;
    event: HarnessEvent;
    checks: Record<string, QualityCheckConfig>;
    externalRan: string[];
    externalRows: QualityCheckResult[];
    deferred: string[];
}

async function checkInput(options: CheckInputOptions): Promise<HookCheckEvidence> {
    const { root, entry, event, checks, externalRan, externalRows, deferred } = options;
    const completed = externalRan.filter(name => checks[name] && pathMatchesCheck(entry.path, checks[name]));
    try {
        const results = await runQualityChecks(event, checks, root, { skipMultiFileExternalChecks: true, outChecksRan: completed, editedFileInRepo: true });
        const unavailable = results.filter(row => isOperationalCheckDeferral(row.name)).map(findingText);
        const findings = [...externalRows, ...results].filter(row => !isOperationalCheckDeferral(row.name)).map(findingText);
        return { checks: [...new Set(completed)], findings, unavailable: [...deferred, ...unavailable] };
    } catch (error) { return { checks: completed, findings: [], unavailable: [String(error)] }; }
}
