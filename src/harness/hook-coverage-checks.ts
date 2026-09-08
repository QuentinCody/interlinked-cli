import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { HookPendingCheck } from "./hook-coverage-ledger.js";
import type { HookCheckEvidence, HookCoverageChecker } from "./hook-coverage-verification.js";
import { isInsideRoot } from "./large-file-policy.js";
import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import { createChangeSetExternalBatch } from "./quality-checks/change-set-external.js";
import { pathMatchesCheck } from "./quality-checks/change-set-external-candidates.js";
import type { QualityCheckResult } from "./quality-checks/result-types.js";
import { resolveQualityCheckTarget, runQualityChecks } from "./quality-checks.js";
import type { HarnessEvent, QualityCheckConfig } from "./types.js";

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
    return async entries => {
        const evidence = new Map<string, HookCheckEvidence>();
        const inputs = collectInputs(root, entries, evidence);
        const checks = structuredClone(getChecks());
        const externalRan: string[] = [];
        const external = createChangeSetExternalBatch({ cwd: root, paths: [...inputs.keys()].map(entry => entry.path), checks, outChecksRan: externalRan });
        const externalRows = new Map<string, QualityCheckResult[]>();
        for (const [entry] of inputs) externalRows.set(entry.id, await external.resultsForFile(entry.path));
        // The batch attributes a shared deferral to its primary path. It must
        // invalidate coverage for every consumer, not only that first file.
        const deferred = [...externalRows.values()].flat().filter(row => isOperationalCheckDeferral(row.name)).map(findingText);
        for (const [entry, event] of inputs) {
            evidence.set(entry.id, await checkInput({ root, entry, event, checks, externalRan, externalRows: externalRows.get(entry.id) ?? [], deferred }));
        }
        if (JSON.stringify(checks) !== JSON.stringify(getChecks())) {
            for (const result of evidence.values()) result.unavailable.push("Configured checks changed during verification");
        }
        return evidence;
    };
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
