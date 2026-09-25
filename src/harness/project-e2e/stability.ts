// ===========================================
// Stability cohorts and quarantine — plan §9.5 (Unit E1)
// ===========================================
// Independent qualification repetitions are not "retry until green": every
// attempt is its own supervised run (own snapshot, data, ports, seed) and
// every attempt is published. A cohort qualifies only when EVERY required
// attempt passed; mixed results are a flake finding that opens a quarantine
// record (a diagnosis schedule, never a waiver, keyed by generation so an
// unchanged rerun cannot erase it); a budget that ends early defers the
// cohort with its remaining count. Three passes are a sample — the record
// never claims flake-freedom.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AttemptStatus, CohortVerdict } from "./ledger.js";

export const E2E_COHORTS_DIRECTORY = ".interlinked/test-runs/e2e/cohorts";
export const E2E_QUARANTINE_PATH = ".interlinked/e2e-quarantine.jsonl";
export type { CohortVerdict } from "./ledger.js";
export interface CohortAttempt { index: number; runId: string; receipt: string; status: AttemptStatus; seed: string; clock: string; durationMs: number; }
/** The durable cohort record: profile, every attempt with its seed/clock, and the classified verdict. */
export interface CohortRecord {
    version: 1; cohortId: string; key: string; generation: string; required: number; baselineSeed: string; clock: string;
    startedAt: string; updatedAt: string; verdict: CohortVerdict; reasons: string[]; attempts: CohortAttempt[];
}
export interface CohortClassification { verdict: CohortVerdict; reasons: string[]; remaining: number; }
export interface QuarantineRecord { key: string; generation: string; cohortId: string; attempts: Array<{ runId: string; status: AttemptStatus }>; reason: string; atMs: number; reviewAtMs: number; sessionId?: string; }
export type CohortDecision = { action: "start" } | { action: "resume"; remaining: number } | { action: "diagnose" };

const GENERATION = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "unavailable", "stale"]);
const VERDICTS: ReadonlySet<string> = new Set(["in-progress", "qualified", "mixed", "failed", "unavailable", "deferred"]);

/** Attempt 1 reproduces the baseline seed exactly; later attempts get bounded varied seeds derived from it (§9.5). */
export function attemptSeed(baselineSeed: string, index: number): string {
    if (index <= 1) return baselineSeed;
    return createHash("sha256").update(`${baselineSeed}\0${index}`).digest("hex").slice(0, 16);
}
/** The §9.5 verdict over the attempts published so far. Pure. */
export function classifyCohort(record: Pick<CohortRecord, "attempts" | "required">): CohortClassification {
    const statuses = record.attempts.map(attempt => attempt.status);
    const remaining = Math.max(0, record.required - statuses.length);
    const failed = statuses.filter(status => status === "failed").length, passed = statuses.filter(status => status === "passed").length;
    const gaps = statuses.filter(status => status === "unavailable" || status === "stale").length;
    if (failed && passed) return { verdict: "mixed", remaining, reasons: [`${passed} attempt(s) passed and ${failed} failed: an inconsistent result is a flake finding, not a pass; the scenario stays unresolved`] };
    if (failed) return { verdict: "failed", remaining, reasons: [`${failed}/${statuses.length} attempt(s) failed`] };
    if (gaps) return { verdict: "unavailable", remaining, reasons: [`${gaps} attempt(s) could not certify (infrastructure gap, not an application failure); the cohort is incomplete`] };
    if (remaining) return { verdict: "deferred", remaining, reasons: [`${passed}/${record.required} attempt(s) passed; ${remaining} remaining — partial success cannot qualify`] };
    return { verdict: "qualified", remaining: 0, reasons: [`${passed}/${record.required} independent attempts passed: this sample qualifies the profile; it is not a flake-free guarantee`] };
}
/** What `qualify` does for this generation: resume an interrupted cohort, diagnose a quarantined failure, or start a fresh one for a changed profile. */
export function cohortDecision(input: { generation: string; cohort: CohortRecord | null; quarantined: boolean }): CohortDecision {
    if (input.quarantined) return { action: "diagnose" };
    const resumable = input.cohort !== null && input.cohort.generation === input.generation && (input.cohort.verdict === "deferred" || input.cohort.verdict === "in-progress");
    if (resumable) return { action: "resume", remaining: classifyCohort(input.cohort!).remaining };
    return { action: "start" };
}
function cohortPath(cohortId: string): string { return `${E2E_COHORTS_DIRECTORY}/${cohortId}.json`; }
export function writeCohort(root: string, record: CohortRecord): string {
    const path = cohortPath(record.cohortId), absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, JSON.stringify(record, null, 2));
    return path;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function parseAttempt(value: unknown): CohortAttempt | null {
    if (!isRecord(value) || !Number.isInteger(value.index) || typeof value.runId !== "string" || typeof value.receipt !== "string" || !STATUSES.has(String(value.status))) return null;
    if (typeof value.seed !== "string" || typeof value.clock !== "string" || typeof value.durationMs !== "number") return null;
    // SAFETY: membership in STATUSES was just checked.
    return { index: Number(value.index), runId: value.runId, receipt: value.receipt, status: value.status as AttemptStatus, seed: value.seed, clock: value.clock, durationMs: value.durationMs };
}
type CohortHead = Omit<CohortRecord, "attempts" | "reasons">;
function parseCohortHead(value: Record<string, unknown>): CohortHead | null {
    if (value.version !== 1 || typeof value.cohortId !== "string" || !ID.test(value.cohortId) || typeof value.key !== "string") return null;
    if (typeof value.generation !== "string" || !GENERATION.test(value.generation) || !Number.isInteger(value.required) || !VERDICTS.has(String(value.verdict))) return null;
    if (typeof value.baselineSeed !== "string" || typeof value.clock !== "string" || typeof value.startedAt !== "string" || typeof value.updatedAt !== "string") return null;
    // SAFETY: VERDICTS membership was just checked.
    return { version: 1, cohortId: value.cohortId, key: value.key, generation: value.generation, required: Number(value.required), baselineSeed: value.baselineSeed, clock: value.clock, startedAt: value.startedAt, updatedAt: value.updatedAt, verdict: value.verdict as CohortVerdict };
}
/** Constructing parser: anything malformed reads as null (unverified), never a guessed cohort. */
export function parseCohort(value: unknown): CohortRecord | null {
    if (!isRecord(value) || !Array.isArray(value.attempts) || !Array.isArray(value.reasons)) return null;
    const head = parseCohortHead(value);
    const attempts = value.attempts.map(parseAttempt);
    if (!head || attempts.some(attempt => attempt === null) || !value.reasons.every(reason => typeof reason === "string")) return null;
    // SAFETY: every attempt parsed non-null and every reason is a string (checked above).
    return { ...head, reasons: value.reasons as string[], attempts: attempts as CohortAttempt[] };
}
export function readCohort(root: string, cohortId: string): CohortRecord | null {
    if (!ID.test(cohortId)) return null;
    const absolute = join(root, cohortPath(cohortId));
    if (!existsSync(absolute)) return null;
    try { return parseCohort(JSON.parse(readFileSync(absolute, "utf8"))); } catch { return null; }
}
export function appendQuarantine(root: string, row: QuarantineRecord): QuarantineRecord {
    const absolute = join(root, E2E_QUARANTINE_PATH);
    mkdirSync(dirname(absolute), { recursive: true });
    appendFileSync(absolute, `${JSON.stringify(row)}\n`);
    return row;
}
function parseQuarantine(value: unknown): QuarantineRecord | null {
    if (!isRecord(value) || typeof value.key !== "string" || typeof value.generation !== "string" || !GENERATION.test(value.generation) || typeof value.cohortId !== "string") return null;
    if (typeof value.reason !== "string" || typeof value.atMs !== "number" || typeof value.reviewAtMs !== "number" || !Array.isArray(value.attempts)) return null;
    const attempts = value.attempts.filter((item): item is { runId: string; status: AttemptStatus } => isRecord(item) && typeof item.runId === "string" && STATUSES.has(String(item.status)));
    const row: QuarantineRecord = { key: value.key, generation: value.generation, cohortId: value.cohortId, attempts, reason: value.reason, atMs: value.atMs, reviewAtMs: value.reviewAtMs };
    if (typeof value.sessionId === "string") row.sessionId = value.sessionId;
    return row;
}
/** The quarantine row for exactly this key AND generation, or null: a repair (new generation) starts clean, an unchanged rerun does not. */
export function quarantineFor(root: string, key: string, generation: string): QuarantineRecord | null {
    const absolute = join(root, E2E_QUARANTINE_PATH);
    if (!existsSync(absolute)) return null;
    let found: QuarantineRecord | null = null;
    for (const line of readFileSync(absolute, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const row = parseQuarantine(parsed);
        if (row && row.key === key && row.generation === generation) found = row;
    }
    return found;
}
