import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateE2e } from "./evaluate.js";
import { readE2eReceipt, type E2eReceipt, type ReceiptCase } from "./receipt.js";
import { runProjectE2e } from "./run.js";
import { readCohort, type CohortAttempt } from "./stability.js";

export interface AttemptReplay {
    schema: "e2e-attempt-replay.v1";
    cohort: string; attempt: number; original: string; replay: string | null;
    outcome: "reproduced" | "not-reproduced" | "diverged" | "inconclusive" | "refused";
    reason: string;
    environment: "runtime-and-declared-inputs-only";
    failing_cases: string[];
}
function observable(row: ReceiptCase): unknown {
    const seen = row.observations;
    return { id: row.id, digest: row.digest, state: row.state, evidence: seen ? {
        stdout: seen.stdoutSha256, stderr: seen.stderrSha256, exit: seen.exitCode,
        status: seen.status, matched: seen.matched, mismatched: seen.mismatched,
    } : null };
}
/** Exact captured outcomes, excluding volatile process IDs and durations. */
export function compareReplay(original: E2eReceipt, replay: E2eReceipt): AttemptReplay["outcome"] {
    if (!replay.completion.complete || replay.inputGaps.length || replay.completion.inputsChangedDuringRun) return "inconclusive";
    const failures = original.cases.filter(row => row.state === "failed");
    if (!failures.length || failures.some(row => !row.observations)) return "inconclusive";
    if (replay.cases.every(row => row.state === "passed")) return "not-reproduced";
    const same = original.cases.every(row => {
        const next = replay.cases.find(candidate => candidate.id === row.id);
        return next && JSON.stringify(observable(next)) === JSON.stringify(observable(row));
    });
    return same && replay.cases.length === original.cases.length ? "reproduced" : "diverged";
}
function validOriginal(receipt: E2eReceipt, attempt: CohortAttempt, cohort: string): boolean {
    const binding = receipt.stability;
    return receipt.runId === attempt.runId && binding?.cohortId === cohort
        && binding.attempt === attempt.index && binding.seed === attempt.seed && binding.clock === attempt.clock;
}
function currentInputs(root: string, original: E2eReceipt): boolean {
    const current = evaluateE2e({ root, projectId: original.project.id, scenarioIds: original.scenarioIds,
        atMs: Date.now(), dryRun: true, reconcile: false });
    const runtime = original.runtime;
    return current.status === "configured" && current.policyDigest === original.policyDigest
        && runtime.node === process.versions.node && runtime.platform === process.platform && runtime.arch === process.arch
        && current.verdicts.length === original.scenarioIds.length
        && current.verdicts.every(row => row.generation === (original.scenarioGenerations?.[row.scenarioId] ?? original.generation));
}
export function storedAttempts(root: string, cohortId: string): unknown {
    const cohort = readCohort(root, cohortId);
    if (!cohort) throw new Error("cohort missing or invalid");
    return { ...cohort, attempts: cohort.attempts.map(attempt => {
        const receipt = readE2eReceipt(root, attempt.receipt);
        return { ...attempt, failing_cases: receipt?.cases.filter(row => row.state === "failed").map(row => row.id) ?? null,
            receipt_valid: receipt !== null && validOriginal(receipt, attempt, cohortId) };
    }) };
}
/** Re-executes matching declared inputs; never rewrites the original cohort or receipt. */
export async function replayStoredAttempt(options: { root: string; cohortId: string; attempt: number; timeoutMs: number }): Promise<AttemptReplay> {
    const cohort = readCohort(options.root, options.cohortId);
    const attempt = cohort?.attempts.find(row => row.index === options.attempt);
    const original = attempt ? readE2eReceipt(options.root, attempt.receipt) : null;
    const result: AttemptReplay = { schema: "e2e-attempt-replay.v1", cohort: options.cohortId, attempt: options.attempt,
        original: attempt?.receipt ?? "", replay: null, outcome: "refused", reason: "missing or incompatible original evidence",
        environment: "runtime-and-declared-inputs-only", failing_cases: [] };
    if (!attempt || !original || !validOriginal(original, attempt, options.cohortId) || !currentInputs(options.root, original)) return result;
    const run = await runProjectE2e({ root: options.root, projectId: original.project.id, scenarioIds: original.scenarioIds,
        timeoutMs: options.timeoutMs, publication: "diagnostic", stability: { cohortId: options.cohortId, attempt: attempt.index, seed: attempt.seed, clock: attempt.clock } });
    const published = run.receipts[0];
    const replay = published ? readE2eReceipt(options.root, published.path) : null;
    result.replay = published?.path ?? null;
    result.outcome = replay ? compareReplay(original, replay) : "inconclusive";
    result.failing_cases = original.cases.filter(row => row.state === "failed").map(row => row.id);
    result.reason = "Observed outcome comparison. Seed/clock, runtime and declared inputs are bound; external environment closure is not certified. Original evidence remains unchanged.";
    if (published) {
        const directory = join(options.root, ".interlinked/test-runs/e2e", published.runId);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "replay.json"), JSON.stringify(result, null, 2), { flag: "wx" });
    }
    return result;
}
