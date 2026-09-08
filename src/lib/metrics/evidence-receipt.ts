import { natural, record, stringList, textField } from "./evidence-json.js";
import { normalizeEvidenceArtifact } from "./evidence-artifact-selector.js";
import type { EvidenceIdentity, EvidenceOutcome, EvidenceReceipt, EvidenceRunner } from "./evidence-types.js";

export const IDENTITY_KEYS = ["sourceHash", "testHash", "configurationHash", "dependencyHash", "inputHash", "scopeHash", "supportHash"] as const;
function digest(value: unknown): string {
    const result = textField(value, "digest");
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("Expected SHA-256 digest");
    return result;
}
function identity(value: unknown): EvidenceIdentity {
    const row = record(value, "identity");
    return { sourceHash: digest(row.sourceHash), testHash: digest(row.testHash), configurationHash: digest(row.configurationHash),
        dependencyHash: digest(row.dependencyHash), inputHash: digest(row.inputHash), scopeHash: digest(row.scopeHash), supportHash: digest(row.supportHash) };
}
function runner(value: unknown): EvidenceRunner {
    const row = record(value, "runner"), argv = stringList(row.argv, "argv");
    if (!argv.length) throw new Error("Runner argv cannot be empty");
    return { argv, version: textField(row.version, "runner version"), operatorPolicy: textField(row.operatorPolicy, "operator policy"), environmentHash: digest(row.environmentHash),
        ...(row.workspaceHash === undefined ? {} : { workspaceHash: digest(row.workspaceHash) }),
        ...(row.artifactSelector === undefined ? {} : { artifactSelector: normalizeEvidenceArtifact(textField(row.artifactSelector, "artifact selector")) }) };
}
function outcome(value: unknown): EvidenceOutcome {
    if (value === "passed" || value === "failed" || value === "timeout" || value === "cancelled" || value === "error") return value;
    throw new Error("Invalid execution outcome");
}
function timestamp(value: unknown): string {
    const result = textField(value, "timestamp");
    if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid timestamp");
    return result;
}
export function parseEvidenceReceipt(value: unknown): EvidenceReceipt {
    const row = record(value, "receipt");
    if (row.schemaVersion !== 1) throw new Error("Unsupported evidence receipt schema");
    if (row.kind !== "coverage" && row.kind !== "mutation") throw new Error("Invalid evidence kind");
    if (row.origin !== "local" && row.origin !== "ci") throw new Error("Invalid evidence origin");
    const startedAt = timestamp(row.startedAt), finishedAt = timestamp(row.finishedAt);
    if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error("Execution finished before it started");
    return { schemaVersion: 1, kind: row.kind, identity: identity(row.identity), runner: runner(row.runner), startedAt, finishedAt,
        durationMs: natural(row.durationMs, "durationMs"), outcome: outcome(row.outcome), artifactHash: digest(row.artifactHash),
        reportRoot: textField(row.reportRoot, "reportRoot"), origin: row.origin, issues: stringList(row.issues, "issues") };
}
