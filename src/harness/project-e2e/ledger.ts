// ===========================================
// Scenario obligation ledger — append-only txns, deterministic reducer
// ===========================================
// Plan 31 §8. Obligation identity is project + scenario (the key) at a
// generation; a run attempt is separate evidence with its own id. The reducer
// is pure and order-sensitive: a pass published for an older generation after
// a newer edit is historical evidence only, never a satisfied newer
// obligation (PE-04/05/30). Duplicate rows fold by exact identity. Sibling of
// `obligations.ts` (file-keyed debts); deliberately not the same identity.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "./policy.js";

export const E2E_LEDGER_PATH = ".interlinked/e2e-obligations.jsonl";
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const GENERATION = /^[a-f0-9]{64}$/;

export type AttemptStatus = "passed" | "failed" | "unavailable" | "stale";
export type ObligationStatus = "pending" | "satisfied" | "failed" | "unavailable" | "stale" | "review-required";
export type E2eTxn =
    | { op: "pending"; key: string; generation: string; reason: string; atMs: number; sessionId?: string }
    | { op: "attempt"; key: string; generation: string; runId: string; status: AttemptStatus; atMs: number; receipt: string; reason: string }
    | { op: "invalidate"; key: string; generation: string; reason: string; atMs: number }
    | { op: "review-required"; key: string; generation: string; reason: string; atMs: number }
    /** Unit E1 (§9.5): a stability cohort's classified verdict for this generation; the record path holds every attempt. */
    | { op: "cohort"; key: string; generation: string; cohortId: string; verdict: CohortVerdict; record: string; reason: string; atMs: number };
export type CohortVerdict = "in-progress" | "qualified" | "mixed" | "failed" | "unavailable" | "deferred";
export interface E2eObligationState {
    key: string; generation: string; status: ObligationStatus; reason: string; updatedAtMs: number; attempts: number;
    lastRunId?: string; lastReceipt?: string; lastSatisfiedGeneration?: string;
    /** The latest cohort verdict recorded for THIS generation (a cohort for another generation is historical only). */ cohort?: { cohortId: string; verdict: CohortVerdict; record: string };
}
export type E2eLedgerState = Map<string, E2eObligationState>;

export function scenarioKey(projectId: string, scenarioId: string): string { return `${projectId}/${scenarioId}`; }

const ATTEMPT_TO_STATUS: Record<AttemptStatus, ObligationStatus> = { passed: "satisfied", failed: "failed", unavailable: "unavailable", stale: "stale" };

function fresh(txn: E2eTxn): E2eObligationState {
    return { key: txn.key, generation: txn.generation, status: "pending", reason: "", updatedAtMs: txn.atMs, attempts: 0 };
}
/** A new generation opens a fresh pending obligation; the previous run stays attached as HISTORICAL evidence
 *  (so the verdict can say "stale" rather than "never run") but can never satisfy the new generation. */
function applyPending(state: E2eLedgerState, txn: Extract<E2eTxn, { op: "pending" }>): void {
    const row = state.get(txn.key);
    if (row && row.generation === txn.generation) return;
    const next: E2eObligationState = { ...fresh(txn), reason: txn.reason };
    if (row?.lastSatisfiedGeneration) next.lastSatisfiedGeneration = row.lastSatisfiedGeneration;
    if (row?.lastRunId) next.lastRunId = row.lastRunId;
    if (row?.lastReceipt) next.lastReceipt = row.lastReceipt;
    state.set(txn.key, next);
}
function applyAttempt(state: E2eLedgerState, txn: Extract<E2eTxn, { op: "attempt" }>): void {
    const row = state.get(txn.key) ?? fresh(txn);
    if (row.generation !== txn.generation) return; // historical evidence for an older/newer generation: recorded, not applied
    const next: E2eObligationState = { ...row, status: ATTEMPT_TO_STATUS[txn.status], reason: txn.reason, updatedAtMs: txn.atMs, attempts: row.attempts + 1, lastRunId: txn.runId, lastReceipt: txn.receipt };
    if (txn.status === "passed") next.lastSatisfiedGeneration = txn.generation;
    state.set(txn.key, next);
}
function applyMark(state: E2eLedgerState, txn: Extract<E2eTxn, { op: "invalidate" | "review-required" }>): void {
    const row = state.get(txn.key);
    if (!row || row.generation !== txn.generation) return;
    state.set(txn.key, { ...row, status: txn.op === "invalidate" ? "pending" : "review-required", reason: txn.reason, updatedAtMs: txn.atMs });
}
/** A cohort verdict attaches to the obligation of its own generation only; it never changes the attempt-derived status (qualification reads both). */
function applyCohort(state: E2eLedgerState, txn: Extract<E2eTxn, { op: "cohort" }>): void {
    const row = state.get(txn.key) ?? fresh(txn);
    if (row.generation !== txn.generation) return;
    state.set(txn.key, { ...row, updatedAtMs: txn.atMs, cohort: { cohortId: txn.cohortId, verdict: txn.verdict, record: txn.record } });
}
const COHORT_VERDICTS: ReadonlySet<string> = new Set(["in-progress", "qualified", "mixed", "failed", "unavailable", "deferred"]);
/** Pure, deterministic. Replaying the same rows always yields the same state. */
export function reduceE2eLedger(txns: Iterable<E2eTxn>): E2eLedgerState {
    const state: E2eLedgerState = new Map();
    const seen = new Set<string>();
    for (const txn of txns) {
        const identity = canonicalJson(txn);
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (txn.op === "pending") applyPending(state, txn);
        else if (txn.op === "attempt") applyAttempt(state, txn);
        else if (txn.op === "cohort") applyCohort(state, txn);
        else applyMark(state, txn);
    }
    return state;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function hasBase(row: Record<string, unknown>): boolean {
    return typeof row.key === "string" && typeof row.generation === "string" && GENERATION.test(row.generation) && typeof row.atMs === "number" && Number.isInteger(row.atMs);
}
function isAttemptStatus(value: unknown): value is AttemptStatus {
    return typeof value === "string" && Object.hasOwn(ATTEMPT_TO_STATUS, value);
}
function parseCohortTxn(value: Record<string, unknown>, base: { key: string; generation: string; reason: string; atMs: number }): E2eTxn | null {
    if (typeof value.cohortId !== "string" || typeof value.record !== "string" || !COHORT_VERDICTS.has(String(value.verdict))) return null;
    // SAFETY: membership in COHORT_VERDICTS was just checked.
    return { op: "cohort", ...base, cohortId: value.cohortId, record: value.record, verdict: value.verdict as CohortVerdict };
}
/** Strict row parser; a malformed row is skipped, never guessed at. Rebuilds a typed row field by field. */
export function parseE2eTxn(value: unknown): E2eTxn | null {
    if (!isRecord(value) || !hasBase(value) || typeof value.reason !== "string") return null;
    const base = { key: String(value.key), generation: String(value.generation), reason: value.reason, atMs: Number(value.atMs) };
    if (value.op === "pending") {
        if (value.sessionId !== undefined && typeof value.sessionId !== "string") return null;
        return { op: "pending", ...base, ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }) };
    }
    if (value.op === "invalidate" || value.op === "review-required") return { op: value.op, ...base };
    if (value.op === "cohort") return parseCohortTxn(value, base);
    if (value.op !== "attempt" || typeof value.runId !== "string" || typeof value.receipt !== "string" || !isAttemptStatus(value.status)) return null;
    return { op: "attempt", ...base, runId: value.runId, receipt: value.receipt, status: value.status };
}
export function appendE2eTxn(root: string, txn: E2eTxn): void {
    const path = join(root, E2E_LEDGER_PATH);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(txn)}\n`);
}
/** Reads the tail of the ledger (bounded). A torn last line is dropped, never partially applied. */
export function readE2eTxns(root: string): E2eTxn[] {
    const path = join(root, E2E_LEDGER_PATH);
    if (!existsSync(path)) return [];
    let content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content) > MAX_LEDGER_BYTES) content = content.slice(content.indexOf("\n", content.length - MAX_LEDGER_BYTES) + 1);
    const rows: E2eTxn[] = [];
    for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const txn = parseE2eTxn(parsed);
        if (txn) rows.push(txn);
    }
    return rows;
}
