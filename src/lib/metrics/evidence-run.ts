import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { evidenceCacheKey, evidenceIdentity, identityDifferences } from "./evidence-identity.js";
import { captureEvidenceEnvironment } from "./evidence-environment.js";
import { runEvidenceProcess } from "./evidence-process.js";
import { evidenceDirectory, loadEvidence, readEvidenceArtifact, saveEvidence } from "./evidence-store.js";
import type { EvidenceIdentity, EvidenceOutcome, EvidenceReceipt, EvidenceRunner, StoredEvidence } from "./evidence-types.js";
import { copyEvidenceWorkspace } from "./evidence-workspace.js";
import { collectRepositoryInventory, containedFile, hashBytes } from "./inventory.js";
import type { RepositoryInventory } from "./measurement-types.js";
import { appendMeasurementExecution } from "./execution-journal.js";
import { executionEvidenceBlockers } from "./execution-evidence.js";

export interface EvidenceRunOptions {
    root: string; kind: "coverage" | "mutation"; artifact: string; runner: Omit<EvidenceRunner, "environmentHash">;
    timeoutMs: number; signal?: AbortSignal; resume?: boolean;
}
export interface EvidenceRunResult { outcome: EvidenceOutcome; cached: boolean; evidence: StoredEvidence | null; durationMs: number; issues: string[]; }
interface PreparedEvidenceRunOptions extends EvidenceRunOptions { runner: EvidenceRunner; environment: NodeJS.ProcessEnv; }

function cachedRun(inventory: RepositoryInventory, options: PreparedEvidenceRunOptions): StoredEvidence | undefined {
    if (!options.resume || executionEvidenceBlockers(inventory).length) return undefined;
    const key = evidenceCacheKey(evidenceIdentity(inventory), options.runner, options.kind);
    const latest = loadEvidence(inventory).entries.filter(entry => evidenceCacheKey(entry.receipt.identity, entry.receipt.runner, entry.receipt.kind) === key)
        .sort((a, b) => Date.parse(b.receipt.finishedAt) - Date.parse(a.receipt.finishedAt))[0];
    return latest?.observations.state === "measured" ? latest : undefined;
}

function executionRecord(options: PreparedEvidenceRunOptions, result: EvidenceRunResult, identity: EvidenceIdentity): void {
    const directory = evidenceDirectory(options.root);
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "executions.jsonl"), `${JSON.stringify({ schemaVersion: 1, kind: options.kind, at: new Date().toISOString(),
        outcome: result.outcome, cached: result.cached, durationMs: result.durationMs, evidenceId: result.evidence?.id ?? null, issues: result.issues })}\n`, { mode: 0o600 });
    appendMeasurementExecution(options.root, { schemaVersion: 1, gate: `metrics.${options.kind}`, at: new Date().toISOString(), sessionId: "metrics-cli",
        inputFingerprint: hashBytes(JSON.stringify(identity)), file: "*", sourceHash: identity.sourceHash,
        scope: [evidenceCacheKey(identity, options.runner, options.kind)], elapsedMs: Math.round(result.durationMs),
        outcome: result.evidence?.observations.state === "measured" ? "measured" : "unavailable", testsPassed: result.outcome === "passed" ? true : result.outcome === "failed" ? false : null, reason: result.issues.join("; ") });
}

function changedWorkspaceInputs(inventory: RepositoryInventory, workspace: string): string[] {
    return inventory.files.flatMap(file => {
        try { return hashBytes(readFileSync(containedFile(workspace, file.path))) === file.sha256 ? [] : [`Runner changed input: ${file.path}`]; }
        catch { return [`Runner removed input: ${file.path}`]; }
    });
}

interface RunContext { inventory: RepositoryInventory; identity: EvidenceIdentity; started: number; }
async function executeWorkspace(options: PreparedEvidenceRunOptions, context: RunContext, workspace: string): Promise<EvidenceRunResult> {
    const { inventory, identity, started } = context;
    const signal = options.signal ? { signal: options.signal } : {};
    await copyEvidenceWorkspace({ source: inventory.root, destination: workspace, deadline: started + options.timeoutMs, ...signal });
    const artifact = join(workspace, options.artifact);
    const rel = relative(workspace, artifact);
    if (rel.startsWith("..") || !rel) throw new Error("Artifact must be a relative file inside the workspace");
    rmSync(artifact, { force: true });
    const run = await runEvidenceProcess({ cwd: workspace, argv: options.runner.argv, environment: options.environment, timeoutMs: Math.max(1, started + options.timeoutMs - Date.now()), ...signal });
    if (run.outcome !== "passed") return { ...run, durationMs: Date.now() - started, cached: false, evidence: null, issues: [`Runner ${run.outcome}`] };
    const issues = [...changedWorkspaceInputs(inventory, workspace), ...identityDifferences(identity, evidenceIdentity(collectRepositoryInventory(options.root))),
        ...identityDifferences(identity, evidenceIdentity({ ...inventory, root: workspace })).map(issue => `Workspace ${issue}`)];
    const content = readEvidenceArtifact(containedFile(workspace, options.artifact));
    const receipt: EvidenceReceipt = { schemaVersion: 1, kind: options.kind, identity, runner: options.runner,
        startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
        outcome: run.outcome, artifactHash: hashBytes(content), reportRoot: workspace, origin: "local", issues };
    return { outcome: "passed", cached: false, evidence: saveEvidence(inventory, receipt, content), durationMs: receipt.durationMs, issues };
}

export async function runBehavioralEvidence(request: EvidenceRunOptions): Promise<EvidenceRunResult> {
    const { environment, environmentHash } = captureEvidenceEnvironment();
    const options: PreparedEvidenceRunOptions = { ...request, environment, runner: { argv: [...request.runner.argv], version: request.runner.version, operatorPolicy: request.runner.operatorPolicy, environmentHash } };
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Positive timeout required");
    const inventory = collectRepositoryInventory(options.root), cached = cachedRun(inventory, options), started = Date.now();
    if (cached) { const result: EvidenceRunResult = { outcome: "passed", cached: true, evidence: cached, durationMs: 0, issues: [] }; executionRecord(options, result, cached.receipt.identity); return result; }
    const context: RunContext = { inventory, identity: evidenceIdentity(inventory), started };
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-metrics-run-")));
    let result: EvidenceRunResult;
    try { result = await executeWorkspace(options, context, workspace); }
    catch (error) { result = { outcome: options.signal?.aborted ? "cancelled" : "error", cached: false, evidence: null, durationMs: Date.now() - started,
        issues: [error instanceof Error ? error.message : "Evidence execution failed"] }; }
    finally { rmSync(workspace, { recursive: true, force: true }); }
    executionRecord(options, result, context.identity);
    return result;
}
