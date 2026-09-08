import { resolve } from "node:path";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { evidenceIdentity } from "../lib/metrics/evidence-identity.js";
import { stringList } from "../lib/metrics/evidence-json.js";
import { parseEvidenceReceipt } from "../lib/metrics/evidence-receipt.js";
import { runBehavioralEvidence, type EvidenceRunOptions } from "../lib/metrics/evidence-run.js";
import { loadEvidence, readEvidenceArtifact, saveEvidence } from "../lib/metrics/evidence-store.js";
import { collectRepositoryInventory, hashBytes } from "../lib/metrics/inventory.js";
import { parseRemovalPlan } from "../lib/metrics/removal-plan.js";
import { validateRemoval } from "../lib/metrics/removal-validation.js";
import type { MetricsAnalysisOptions } from "./metrics-analysis.js";

export interface MetricsEvidenceOptions extends MetricsAnalysisOptions {
    kind?: string; command?: string; artifact?: string; runnerVersion?: string; policy?: string; timeout?: string; resume?: boolean;
}
function fail(options: MetricsAnalysisOptions, error: unknown): void { outputError(getOutputMode(options), error instanceof Error ? error.message : "Evidence command failed"); }
function timeout(value: string | undefined): number {
    const result = Number(value ?? "60000");
    if (!Number.isSafeInteger(result) || result < 1 || result > 3_600_000) throw new Error("Timeout must be 1–3600000 milliseconds");
    return result;
}
async function cancellable<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(), abort = () => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try { return await run(controller.signal); }
    finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}

export function metricsEvidenceStatusCommand(options: MetricsAnalysisOptions): void {
    try {
        const inventory = collectRepositoryInventory(options.cwd ?? process.cwd()), store = loadEvidence(inventory);
        const entries = store.entries.map(entry => ({ id: entry.id, kind: entry.receipt.kind, state: entry.observations.state, outcome: entry.receipt.outcome,
            origin: entry.receipt.origin, finishedAt: entry.receipt.finishedAt, durationMs: entry.receipt.durationMs, issues: entry.observations.issues }));
        output(getOutputMode(options), { entries, issues: store.issues }, { normal: () => ["Behavioral evidence receipts", ...entries.map(row => `${row.kind} ${row.state} ${row.id} (${row.durationMs} ms)`), ...store.issues].join("\n"), short: () => `${entries.length} receipts; ${store.issues.length} store issues` });
    } catch (error) { fail(options, error); }
}
export function metricsEvidenceIdentityCommand(options: MetricsAnalysisOptions): void {
    try {
        const identity = evidenceIdentity(collectRepositoryInventory(options.cwd ?? process.cwd()));
        output(getOutputMode(options), { schemaVersion: 1, identity }, { normal: () => JSON.stringify({ schemaVersion: 1, identity }, null, 2), short: () => identity.inputHash });
    } catch (error) { fail(options, error); }
}
export function metricsEvidenceImportCommand(receiptPath: string, artifactPath: string, options: MetricsAnalysisOptions): void {
    try {
        const root = options.cwd ?? process.cwd(), inventory = collectRepositoryInventory(root);
        const receipt = parseEvidenceReceipt(JSON.parse(readEvidenceArtifact(resolve(root, receiptPath))));
        const entry = saveEvidence(inventory, { ...receipt, origin: "ci" }, readEvidenceArtifact(resolve(root, artifactPath)));
        output(getOutputMode(options), entry, { normal: () => `Imported ${entry.receipt.kind}: ${entry.observations.state}; ${entry.id}`, short: () => `${entry.observations.state} ${entry.id}` });
        if (entry.observations.state !== "measured") process.exitCode = 1;
    } catch (error) { fail(options, error); }
}

export async function metricsEvidenceRunCommand(options: MetricsEvidenceOptions): Promise<void> {
    try {
        if (options.kind !== "coverage" && options.kind !== "mutation") throw new Error("Evidence kind must be coverage or mutation");
        if (!options.command || !options.artifact || !options.runnerVersion || !options.policy) throw new Error("Runner command, artifact, version and policy are required");
        const argv = stringList(JSON.parse(options.command), "command");
        const request: EvidenceRunOptions = { root: options.cwd ?? process.cwd(), kind: options.kind, artifact: options.artifact, timeoutMs: timeout(options.timeout), resume: options.resume === true,
            runner: { argv, version: options.runnerVersion, operatorPolicy: options.policy, environmentHash: hashBytes(JSON.stringify([process.version, process.platform, process.arch, process.env.NODE_OPTIONS ?? "", process.env.NODE_ENV ?? "test"])) } };
        const result = await cancellable(signal => runBehavioralEvidence({ ...request, signal }));
        output(getOutputMode(options), result, { normal: () => `${result.outcome}; ${result.durationMs} ms; cached=${result.cached}\n${result.issues.join("\n")}`, short: () => `${result.outcome}; cached=${result.cached}; ${result.durationMs} ms` });
        if (result.outcome !== "passed" || result.evidence?.observations.state !== "measured") process.exitCode = 1;
    } catch (error) { fail(options, error); }
}
export async function metricsRemovalValidateCommand(path: string, options: MetricsEvidenceOptions): Promise<void> {
    try {
        const root = options.cwd ?? process.cwd(), plan = parseRemovalPlan(JSON.parse(readEvidenceArtifact(resolve(root, path))));
        const result = await cancellable(signal => validateRemoval({ root, plan, timeoutMs: timeout(options.timeout), signal }));
        output(getOutputMode(options), result, { normal: () => `${result.verdict}; review remains required\n${result.issues.join("\n")}`, short: () => result.verdict });
        if (result.verdict !== "checks-passed") process.exitCode = 1;
    } catch (error) { fail(options, error); }
}
