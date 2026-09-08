import { evidenceIdentity } from "../../lib/metrics/evidence-identity.js";
import { appendMeasurementExecution } from "../../lib/metrics/execution-journal.js";
import { saveEvidence } from "../../lib/metrics/evidence-store.js";
import { hashBytes } from "../../lib/metrics/inventory.js";
import type { CoverageIndexContext } from "./context.js";

export function recordWarmEvidence(context: CoverageIndexContext, artifact: { content: string; root: string; argv: string[] }, durationMs: number): void {
    const now = Date.now(), identity = evidenceIdentity(context.inventory), runner = { argv: artifact.argv,
        version: context.validity.runnerVersion, operatorPolicy: "vitest-full-v8-location-v1", environmentHash: context.validity.environmentHash };
    const stored = saveEvidence(context.inventory, { schemaVersion: 1, kind: "coverage", identity, runner, startedAt: new Date(now - durationMs).toISOString(), finishedAt: new Date(now).toISOString(),
        durationMs, outcome: "passed", artifactHash: hashBytes(artifact.content), reportRoot: artifact.root, origin: "local", issues: [] }, artifact.content);
    appendMeasurementExecution(context.inventory.root, { schemaVersion: 1, gate: "metrics.coverage", at: new Date(now).toISOString(), sessionId: "metrics-warm",
        inputFingerprint: context.fingerprint, file: "*", sourceHash: identity.sourceHash, scope: [], elapsedMs: Math.round(durationMs), outcome: stored.observations.state === "measured" ? "measured" : "unavailable", testsPassed: true,
        reason: stored.observations.issues.join("; ") || "Full Vitest contribution capture validated against full report" });
}
export function recordWarmFailure(context: CoverageIndexContext, result: { durationMs: number; reason: string; testsPassed: boolean | null }): void {
    appendMeasurementExecution(context.inventory.root, { schemaVersion: 1, gate: "metrics.coverage", at: new Date().toISOString(), sessionId: "metrics-warm",
        inputFingerprint: context.fingerprint, file: "*", sourceHash: context.inventory.sourceHash, scope: [], elapsedMs: Math.round(result.durationMs),
        outcome: "unavailable", testsPassed: result.testsPassed, reason: result.reason });
}
