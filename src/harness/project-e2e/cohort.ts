// ===========================================
// `tests e2e qualify` — run a stability cohort (plan §9.5, §14; Unit E1)
// ===========================================
// N independent supervised attempts of ONE scenario, each its own run (own
// snapshot, data, ports) with its recorded seed and clock. The cohort record
// is written before the first attempt and after every attempt, so a crash or
// an exhausted budget leaves a visible, resumable record; the ledger's
// `cohort` row and the quarantine log carry the verdict to qualification.
// Never a retry loop: an attempt's failure is published, not hidden.

import { randomUUID } from "node:crypto";
import { evaluateE2e, selectScenarios, type E2eEvaluation, type Selected } from "./evaluate.js";
import { scenarioGeneration } from "./generation.js";
import { appendE2eTxn, readE2eTxns, reduceE2eLedger, scenarioKey, type AttemptStatus, type ObligationStatus } from "./ledger.js";
import { loadE2ePolicy, type E2ePolicy, type E2eStability } from "./policy.js";
import { statusFor } from "./qualify.js";
import { runProjectE2e } from "./run.js";
import { appendQuarantine, attemptSeed, classifyCohort, cohortDecision, quarantineFor, readCohort, writeCohort, type CohortDecision, type CohortRecord, type QuarantineRecord } from "./stability.js";

export interface QualifyStabilityOptions {
    root: string; /** Where git refs resolve when `root` is an exported candidate tree (CI, F-R3/F-R7). */ gitRoot?: string; scenarioId: string; projectId?: string; timeoutMs: number; sessionId?: string;
    /** Explicit profile when the scenario declares none (`--runs`). */ runs?: number;
    /** Injectable clock for the budget check (tests); the attempts themselves run on the real clock. */ now?: () => number;
}
export interface QualifyStabilityResult { cohort: CohortRecord; decision: CohortDecision; messages: string[]; exitCode: 0 | 1 | 2; evaluation: E2eEvaluation; }
interface Prepared { selected: Selected; profile: E2eStability; key: string; generation: string; existing: CohortRecord | null; quarantine: QuarantineRecord | null; decision: CohortDecision; }

const QUARANTINE_REVIEW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPT_MS = 600_000;
const STATUS_TO_ATTEMPT: Record<ObligationStatus, AttemptStatus> = { satisfied: "passed", failed: "failed", unavailable: "unavailable", stale: "stale", pending: "unavailable", "review-required": "unavailable" };
const EXIT: Record<CohortRecord["verdict"], 0 | 1 | 2> = { qualified: 0, mixed: 1, failed: 1, deferred: 2, unavailable: 2, "in-progress": 2 };

function selectOne(options: QualifyStabilityOptions): { selected: Selected; digest: string; policy: E2ePolicy } {
    const loaded = loadE2ePolicy(options.root);
    if (loaded.status !== "configured") throw new Error(loaded.status === "invalid" ? `e2e: policy invalid: ${loaded.reason}` : "e2e: UNCONFIGURED — no .interlinked/e2e-policy.json");
    const rows = selectScenarios(loaded.policy, { scenarioIds: [options.scenarioId], ...(options.projectId ? { projectId: options.projectId } : {}) });
    if (rows.length !== 1) throw new Error(`e2e: scenario ${options.scenarioId} matches ${rows.length} project(s); pass --project`);
    return { selected: rows[0]!, digest: loaded.digest, policy: loaded.policy };
}
function profileOf(selected: Selected, options: QualifyStabilityOptions): E2eStability {
    if (selected.scenario.stability) return selected.scenario.stability;
    if (options.runs !== undefined) return { qualificationRuns: options.runs };
    throw new Error(`e2e: scenario ${selected.scenario.id} declares no stability profile; declare stability {} in the policy or pass --runs <n>`);
}
/** Resolve the scenario, its profile, the current generation and what this call must do (start / resume / diagnose). */
function prepare(options: QualifyStabilityOptions): Prepared {
    const { selected, digest, policy } = selectOne(options);
    const profile = profileOf(selected, options);
    const key = scenarioKey(selected.project.id, selected.scenario.id);
    const { generation } = scenarioGeneration(options.root, policy, digest, selected.project, selected.scenario, options.gitRoot ?? options.root);
    const state = reduceE2eLedger(readE2eTxns(options.root)).get(key);
    const existing = state?.cohort ? readCohort(options.root, state.cohort.cohortId) : null;
    const quarantine = quarantineFor(options.root, key, generation);
    return { selected, profile, key, generation, existing, quarantine, decision: cohortDecision({ generation, cohort: existing, quarantined: quarantine !== null }) };
}
function freshCohort(prepared: Prepared): CohortRecord {
    const startedAt = new Date().toISOString();
    return { version: 1, cohortId: randomUUID(), key: prepared.key, generation: prepared.generation, required: prepared.profile.qualificationRuns, baselineSeed: prepared.profile.seed ?? "0", clock: prepared.profile.clock ?? "real", startedAt, updatedAt: startedAt, verdict: "in-progress", reasons: [], attempts: [] };
}
/** The attempt status the ledger recorded for this key after a run; `stale` when the run certified another generation. */
/**
 * One attempt's status is the SHARED predicate over that run's receipt (authority, boundary, scope, observations, …)
 * minus the stability dimension itself — never the ledger's execution status alone (review E2: two green runs with
 * unaccepted contracts are not a qualified cohort).
 */
function attemptStatusFor(options: QualifyStabilityOptions, cohort: CohortRecord, selected: Selected): AttemptStatus {
    const row = reduceE2eLedger(readE2eTxns(options.root)).get(cohort.key);
    if (!row || row.generation !== cohort.generation) return "stale";
    const verdict = evaluateAfter(options, selected).verdicts[0];
    if (!verdict) return "unavailable";
    return STATUS_TO_ATTEMPT[statusFor(verdict.reasons.filter(reason => !reason.code.startsWith("STABILITY_")))];
}
async function runAttempt(options: QualifyStabilityOptions, cohort: CohortRecord, index: number, remainingMs: number, selected: Selected): Promise<void> {
    const seed = attemptSeed(cohort.baselineSeed, index), started = Date.now();
    const result = await runProjectE2e({ root: options.root, ...gitRootOf(options), projectId: selected.project.id, scenarioIds: [selected.scenario.id], timeoutMs: Math.max(1, Math.min(remainingMs, MAX_ATTEMPT_MS)), ...(options.sessionId ? { sessionId: options.sessionId } : {}), stability: { cohortId: cohort.cohortId, attempt: index, seed, clock: cohort.clock } });
    const receipt = result.receipts[0];
    cohort.attempts.push({ index, runId: receipt?.runId ?? "none", receipt: receipt?.path ?? "none", status: receipt ? attemptStatusFor(options, cohort, selected) : "unavailable", seed, clock: cohort.clock, durationMs: Date.now() - started });
    cohort.updatedAt = new Date().toISOString();
}
/**
 * Runs the remaining attempts within the budget. An application failure is published and the cohort CONTINUES (a
 * consistent failure and a mixed outcome are different findings); an infrastructure gap ends it (repeating on broken
 * infrastructure proves nothing). Returns why it deferred, if it did.
 */
async function executeAttempts(options: QualifyStabilityOptions, cohort: CohortRecord, selected: Selected, now: () => number): Promise<string | null> {
    const deadline = now() + options.timeoutMs;
    for (let index = cohort.attempts.length + 1; index <= cohort.required; index += 1) {
        const remaining = deadline - now();
        if (remaining <= 0) return `budget exhausted before attempt ${index}`;
        await runAttempt(options, cohort, index, remaining, selected);
        writeCohort(options.root, cohort);
        const status = cohort.attempts[cohort.attempts.length - 1]!.status;
        if (status === "unavailable" || status === "stale") return null;
    }
    return null;
}
function finish(options: QualifyStabilityOptions, cohort: CohortRecord, deferredBy: string | null): string {
    const classified = classifyCohort(cohort);
    cohort.verdict = classified.verdict;
    cohort.reasons = deferredBy ? [deferredBy, ...classified.reasons] : classified.reasons;
    cohort.updatedAt = new Date().toISOString();
    const record = writeCohort(options.root, cohort);
    const atMs = Date.now();
    if (cohort.verdict === "mixed") appendQuarantine(options.root, { key: cohort.key, generation: cohort.generation, cohortId: cohort.cohortId, attempts: cohort.attempts.map(attempt => ({ runId: attempt.runId, status: attempt.status })), reason: cohort.reasons.join("; "), atMs, reviewAtMs: atMs + QUARANTINE_REVIEW_MS, ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
    appendE2eTxn(options.root, { op: "cohort", key: cohort.key, generation: cohort.generation, cohortId: cohort.cohortId, verdict: cohort.verdict, record, reason: cohort.reasons.join("; "), atMs });
    return record;
}
function gitRootOf(options: QualifyStabilityOptions): { gitRoot: string } | Record<string, never> {
    return options.gitRoot ? { gitRoot: options.gitRoot } : {};
}
function evaluateAfter(options: QualifyStabilityOptions, selected: Selected): E2eEvaluation {
    return evaluateE2e({ root: options.root, ...gitRootOf(options), atMs: Date.now(), projectId: selected.project.id, scenarioIds: [selected.scenario.id], ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
}
/** Runs (or resumes) the stability cohort for one scenario at its CURRENT generation and returns the post-cohort evaluation. */
export async function qualifyStability(options: QualifyStabilityOptions): Promise<QualifyStabilityResult> {
    const prepared = prepare(options);
    const { selected, decision } = prepared;
    if (decision.action === "diagnose") {
        const quarantine = prepared.quarantine!; // SAFETY: `diagnose` is only decided when a quarantine row exists
        const messages = [`${prepared.key}: quarantined at this generation since cohort ${quarantine.cohortId} (${quarantine.reason}). Rerunning the unchanged profile cannot erase the failure: repair the flake (a new generation) and qualify again; the record stays visible.`];
        return { cohort: prepared.existing ?? freshCohort(prepared), decision, messages, exitCode: 1, evaluation: evaluateAfter(options, selected) };
    }
    const cohort = decision.action === "resume" && prepared.existing ? prepared.existing : freshCohort(prepared);
    cohort.verdict = "in-progress";
    writeCohort(options.root, cohort);
    const deferredBy = await executeAttempts(options, cohort, selected, options.now ?? Date.now);
    const record = finish(options, cohort, deferredBy);
    const evaluation = evaluateAfter(options, selected);
    return { cohort, decision, messages: [headline(cohort, decision.action === "resume", record), ...cohort.reasons, ...predicateGap(cohort, evaluation)], exitCode: commandExit(cohort, evaluation), evaluation };
}
/** E2: a qualified cohort is one dimension; command success is the SHARED predicate's exit, and a measured failure or an unmet requirement dominates a deferral. */
function commandExit(cohort: CohortRecord, evaluation: E2eEvaluation): 0 | 1 | 2 {
    return cohort.verdict === "qualified" || evaluation.exitCode === 1 ? evaluation.exitCode : EXIT[cohort.verdict];
}
function predicateGap(cohort: CohortRecord, evaluation: E2eEvaluation): string[] {
    if (cohort.verdict !== "qualified" || evaluation.exitCode === 0) return [];
    const verdict = evaluation.verdicts[0];
    return [`${cohort.key}: cohort qualified, but the scenario is ${verdict?.status ?? "unresolved"} (${verdict?.reasons.map(reason => reason.code).join(", ") ?? "no verdict"}); repeated green runs do not clear the other conditions`];
}
function headline(cohort: CohortRecord, resumed: boolean, record: string): string {
    const remaining = cohort.verdict === "deferred" ? `: ${classifyCohort(cohort).remaining} attempt(s) remaining` : "";
    return `${cohort.key}: cohort ${cohort.cohortId} ${resumed ? "resumed" : "started"} — ${cohort.verdict}${remaining} (${cohort.attempts.length}/${cohort.required} attempts; record ${record})`;
}
