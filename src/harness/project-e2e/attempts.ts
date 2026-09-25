// ===========================================
// Durable run attempts — written before execution, recovered after a crash
// ===========================================
// Plan 31 §8 / §9.1 step 12 (Unit C3). A supervised run writes
// `<run-dir>/attempt.json` (pid, host, keys, generations) BEFORE it executes
// anything. If the process dies before the receipt and the ledger row are
// published, the next reader (daemon start, the next run, doctor) finds an
// attempt with no ledger row from a dead process and appends one explicit
// `unavailable` attempt per obligation — concurrency or a restart can turn
// incomplete evidence into an open obligation, never into satisfaction
// (PE-28/29). A receipt that exists without its ledger row is likewise
// recorded as unavailable: it was never reconciled under the publication
// order, so it is rerun rather than trusted after the fact.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { FileMutationLockTimeoutError, withFileMutationLock } from "../../lib/file-mutation-lock.js";
import { appendE2eTxn, readE2eTxns } from "./ledger.js";
import { E2E_RUNS_DIRECTORY } from "./receipt.js";

export const ATTEMPT_FILE = "attempt.json";
export const ORPHANED_FILE = "orphaned.json";
const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const GENERATION = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 256 * 1024;
export interface AttemptRecord {
    version: 1; runId: string; pid: number; hostname: string; startedAt: string; projectId: string;
    scenarioIds: string[]; keys: string[]; /** Generation per key that this attempt set out to certify. */ generations: Record<string, string>;
}
export interface RecoveryDeps { isAlive?: (pid: number) => boolean; host?: string; }

function runDirectory(root: string, runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error(`e2e attempt: runId ${JSON.stringify(runId)} is not a confined run directory name`);
    return join(root, E2E_RUNS_DIRECTORY, runId);
}
/** Written once (`wx`) before any execution; a second write for the same run is a bug, not a retry. */
export function writeAttemptRecord(root: string, record: AttemptRecord): string {
    const directory = runDirectory(root, record.runId);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, ATTEMPT_FILE);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return path;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isStringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function readJsonBounded(path: string): unknown {
    try { const text = readFileSync(path, "utf8"); return Buffer.byteLength(text) > MAX_RECORD_BYTES ? undefined : JSON.parse(text); } catch { return undefined; }
}
function generationsOf(value: unknown): Record<string, string> | null {
    if (!isRecord(value)) return null;
    const generations: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) { if (typeof item !== "string" || !GENERATION.test(item)) return null; generations[key] = item; }
    return generations;
}
function hasIdentity(row: Record<string, unknown>): row is Record<string, unknown> & { runId: string; pid: number; hostname: string; startedAt: string; projectId: string } {
    return typeof row.runId === "string" && RUN_ID.test(row.runId) && typeof row.pid === "number" && Number.isInteger(row.pid) && row.pid >= 1
        && typeof row.hostname === "string" && typeof row.startedAt === "string" && typeof row.projectId === "string";
}
/** Constructing parser: a record this build does not understand is null (unverified), never a guess. */
export function readAttemptRecord(path: string): AttemptRecord | null {
    const parsed = readJsonBounded(path);
    if (!isRecord(parsed) || parsed.version !== 1 || !hasIdentity(parsed)) return null;
    const generations = generationsOf(parsed.generations);
    if (!generations || !isStringList(parsed.scenarioIds) || !isStringList(parsed.keys)) return null;
    return { version: 1, runId: parsed.runId, pid: parsed.pid, hostname: parsed.hostname, startedAt: parsed.startedAt, projectId: parsed.projectId, scenarioIds: parsed.scenarioIds, keys: parsed.keys, generations };
}
function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    // SAFETY: process.kill throws an ErrnoException; EPERM means the process exists but belongs to another user.
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function runIds(root: string): string[] {
    const directory = join(root, E2E_RUNS_DIRECTORY);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && RUN_ID.test(entry.name)).map(entry => entry.name).sort();
}
export interface OrphanedRun extends AttemptRecord { /** Keys this attempt set out to certify that still have no attempt row for this run (review C5: publication is one row PER scenario). */ missingKeys: string[]; }
/** Attempts whose process is gone (or ran on another host) with at least one key whose evidence was never reconciled into the ledger. */
export function listOrphanedRuns(root: string, deps: RecoveryDeps = {}): OrphanedRun[] {
    const alive = deps.isAlive ?? processAlive, host = deps.host ?? hostname();
    const reconciled = new Set(readE2eTxns(root).filter(txn => txn.op === "attempt").map(txn => `${txn.runId}\0${txn.key}`));
    const orphans: OrphanedRun[] = [];
    for (const runId of runIds(root)) {
        const directory = join(root, E2E_RUNS_DIRECTORY, runId);
        if (existsSync(join(directory, ORPHANED_FILE))) continue; // recovery COMPLETED for this run (the marker is written last)
        const record = readAttemptRecord(join(directory, ATTEMPT_FILE));
        if (!record || (record.hostname === host && alive(record.pid))) continue;
        const missingKeys = record.keys.filter(key => !reconciled.has(`${runId}\0${key}`));
        if (missingKeys.length) orphans.push({ ...record, missingKeys });
    }
    return orphans;
}
function orphanReason(root: string, record: OrphanedRun): string {
    const published = existsSync(join(root, E2E_RUNS_DIRECTORY, record.runId, "receipt.json"));
    return published
        ? `orphaned: process ${record.pid} on ${record.hostname} published a receipt that was never reconciled into the ledger for ${record.missingKeys.join(", ")}; rerun rather than trust it`
        : `orphaned: process ${record.pid} on ${record.hostname} exited before publication; no evidence was produced`;
}
/** The path whose mutation lock serializes one run's recovery: the completion marker itself (`<run-dir>/orphaned.json`). */
export function recoveryLockTarget(root: string, runId: string): string {
    return join(root, E2E_RUNS_DIRECTORY, runId, ORPHANED_FILE);
}
/**
 * Cross-process serialization of one run's recovery (review rounds 2–3, D2/E1) through the repository's
 * `withFileMutationLock`: ownership is published atomically (an incomplete owner record is never read as
 * abandonment), a dead owner's lock is recovered, release is ownership-checked so a successor's lock is never
 * removed, and contention (`waitMs: 0`) DEFERS this orphan to the next reader. Returns null when deferred.
 */
function recoverSerialized(root: string, record: OrphanedRun, atMs: number): boolean | null {
    try { return withFileMutationLock(recoveryLockTarget(root, record.runId), () => recoverUnderLock(root, record, atMs), { waitMs: 0 }); }
    catch (error) { if (error instanceof FileMutationLockTimeoutError) return null; throw error; }
}
/** Under the lock: re-derive the keys STILL missing (another recoverer may have finished between listing and locking), append their rows, then the completion marker. */
function recoverUnderLock(root: string, record: OrphanedRun, atMs: number): boolean {
    const reconciled = new Set(readE2eTxns(root).filter(txn => txn.op === "attempt" && txn.runId === record.runId).map(txn => txn.key));
    const missingKeys = record.missingKeys.filter(key => !reconciled.has(key));
    const marker = join(root, E2E_RUNS_DIRECTORY, record.runId, ORPHANED_FILE);
    if (!missingKeys.length && existsSync(marker)) return false;
    const reason = orphanReason(root, { ...record, missingKeys });
    for (const key of missingKeys) {
        const generation = record.generations[key];
        if (generation) appendE2eTxn(root, { op: "attempt", key, generation, runId: record.runId, status: "unavailable", atMs, receipt: `${E2E_RUNS_DIRECTORY}/${record.runId}/receipt.json`, reason });
    }
    if (!existsSync(marker)) writeFileSync(marker, `${JSON.stringify({ version: 1, recoveredAtMs: atMs, reason, keys: missingKeys }, null, 2)}\n`, { mode: 0o600 });
    return true;
}
/**
 * Per (run, key), serialized across processes: every key still missing its row gets exactly one `unavailable` attempt
 * row, THEN the `orphaned.json` marker is written (a crash between rows leaves no marker, so the next reader resumes
 * with exactly the keys still missing — review C5), all under the run's mutation lock so two recoverers never both
 * append (D2/E1). A run whose lock another live recoverer holds is left for the next reader.
 */
export function recoverOrphanedRuns(root: string, atMs: number, deps: RecoveryDeps = {}): { recovered: string[] } {
    const recovered: string[] = [];
    for (const record of listOrphanedRuns(root, deps)) {
        if (recoverSerialized(root, record, atMs)) recovered.push(record.runId);
    }
    return { recovered };
}
