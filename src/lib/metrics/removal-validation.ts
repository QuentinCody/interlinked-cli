import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceIdentity, identityDifferences } from "./evidence-identity.js";
import { runEvidenceProcess, type EvidenceProcessResult } from "./evidence-process.js";
import { copyEvidenceWorkspace, removeEvidenceWorkspace } from "./evidence-workspace.js";
import { collectRepositoryInventory, containedFile, hashBytes } from "./inventory.js";
import type { RepositoryInventory } from "./measurement-types.js";
import { parseRemovalPlan, type RemovalCheck, type RemovalEdit, type RemovalPlan } from "./removal-plan.js";

export interface RemovalTrialOptions { root: string; plan: RemovalPlan; timeoutMs: number; signal?: AbortSignal; }
export interface RemovalCheckResult extends EvidenceProcessResult { kind: RemovalCheck["kind"]; argv: string[]; }
export interface RemovalTrialResult {
    schemaVersion: 1; planHash: string; verdict: "checks-passed" | "baseline-failed" | "candidate-failed" | "inconclusive";
    before: RemovalCheckResult[]; after: RemovalCheckResult[]; issues: string[]; reviewRequired: true;
}

function applyFileRemoval(workspace: string, inventory: RepositoryInventory, edits: RemovalEdit[]): void {
    const first = edits[0];
    if (!first) return;
    const input = inventory.files.find(file => file.path === first.path);
    if (!input || input.role !== "product") throw new Error("Removal trials may only change product source");
    const path = containedFile(workspace, first.path);
    let content = readFileSync(path, "utf8"), upper = content.length;
    if (hashBytes(content) !== input.sha256) throw new Error("Baseline checks changed the proposed removal input");
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        if (edit.sourceSha256 !== input.sha256 || edit.end > upper) throw new Error("Removal hash mismatch or overlapping/out-of-bounds spans");
        content = content.slice(0, edit.start) + content.slice(edit.end); upper = edit.start;
    }
    if (!content) rmSync(path);
    else writeFileSync(path, content);
}

async function checks(options: RemovalTrialOptions, workspace: string, deadline: number): Promise<RemovalCheckResult[]> {
    const results: RemovalCheckResult[] = [];
    for (const check of options.plan.checks) {
        const result = await runEvidenceProcess({ cwd: workspace, argv: check.argv, timeoutMs: Math.max(1, deadline - Date.now()), ...(options.signal ? { signal: options.signal } : {}) });
        results.push({ ...result, kind: check.kind, argv: check.argv });
        if (result.outcome !== "passed") break;
    }
    return results;
}

async function trial(options: RemovalTrialOptions, workspace: string, inventory: RepositoryInventory, deadline: number): Promise<RemovalTrialResult> {
    const result: RemovalTrialResult = { schemaVersion: 1, planHash: hashBytes(JSON.stringify(options.plan)), verdict: "inconclusive", before: [], after: [], issues: [], reviewRequired: true };
    await copyEvidenceWorkspace({ source: inventory.root, destination: workspace, deadline, ...(options.signal ? { signal: options.signal } : {}) });
    result.before = await checks(options, workspace, deadline);
    if (result.before.some(row => row.outcome !== "passed")) { result.verdict = "baseline-failed"; return result; }
    for (const path of new Set(options.plan.edits.map(edit => edit.path))) applyFileRemoval(workspace, inventory, options.plan.edits.filter(edit => edit.path === path));
    result.after = await checks(options, workspace, deadline);
    result.verdict = result.after.every(row => row.outcome === "passed") ? "checks-passed" : "candidate-failed";
    result.issues.push("Passing selected checks supports this removal only within their scope; external consumers and unasserted side effects still require review.");
    return result;
}

export async function validateRemoval(options: RemovalTrialOptions): Promise<RemovalTrialResult> {
    const plan = parseRemovalPlan(options.plan);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Positive trial timeout required");
    const inventory = collectRepositoryInventory(options.root), identity = evidenceIdentity(inventory);
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-removal-trial-")));
    try {
        const result = await trial({ ...options, plan }, workspace, inventory, Date.now() + options.timeoutMs);
        const changed = identityDifferences(identity, evidenceIdentity(collectRepositoryInventory(options.root)));
        if (changed.length) { result.verdict = "inconclusive"; result.issues.push(...changed); }
        return result;
    } finally { await removeEvidenceWorkspace(workspace); }
}
