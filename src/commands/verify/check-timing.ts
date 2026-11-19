import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createScanLedger, type NotMeasuredRow, type ScanLedger, type SetAsideRow } from "./scan-ledger.js";

export interface VerifyCheckTiming { check: string; duration_ms: number; calls: number; max_call_ms: number; skipped: number; errors: number; unavailable_inputs?: { file: string; reason: string }[]; excluded?: number; excluded_inputs?: { file: string; reason: string }[]; }
export interface VerifyTimingRun { root: string; runId: string; budgetMs: number; rows: Map<string, VerifyCheckTiming>; skipChecks?: ReadonlySet<string>; ledger: ScanLedger; startedAt: number; deadlineAt?: number; allChecks?: boolean; }
const active = new AsyncLocalStorage<VerifyTimingRun>();
/** Compatibility callers outside public verify still need their unavailable disclosures. */
export function hasVerifyTimingContext(): boolean { return active.getStore() !== undefined; }
/** Foreground census measures every selected input; callers may explicitly bound work. */
const VERIFY_CHECK_BUDGET_MS = Number.POSITIVE_INFINITY;

export function timingSnapshot(run: VerifyTimingRun): VerifyCheckTiming[] {
    return [...run.rows.values()].map(row => ({ ...row })).sort((a, b) => b.duration_ms - a.duration_ms);
}

/** Read the current run's measured and deferred scope before emitting its report. */
export function currentVerifyTimings(): VerifyCheckTiming[] {
    const run = active.getStore();
    return run ? timingSnapshot(run) : [];
}

/** Selection is invocation-local; excluded detectors are not budget-deferred work. */
export function isVerifyCheckSelected(check: string): boolean {
    return !active.getStore()?.skipChecks?.has(check);
}

export function appendVerifyTiming(root: string, row: Record<string, unknown>): void {
    try {
        mkdirSync(join(root, ".interlinked"), { recursive: true });
        appendFileSync(join(root, ".interlinked", "verify-runs.jsonl"), JSON.stringify({ schema: "verify-check-timing.v1", ts: new Date().toISOString(), ...row }) + "\n");
    } catch (error) { void error; }
}

export function recordVerifyMeasurement(check: string, durationMs: number): void {
    const run = active.getStore();
    if (!run) return;
    const row = run.rows.get(check) ?? { check, duration_ms: 0, calls: 0, max_call_ms: 0, skipped: 0, errors: 0 };
    row.duration_ms += durationMs; row.calls++; row.max_call_ms = Math.max(row.max_call_ms, durationMs);
    run.rows.set(check, row);
}

export function recordVerifyInputDeferral(check: string, input?: { file: string; reason: string }): void {
    recordVerifyMeasurement(check, 0);
    const row = active.getStore()?.rows.get(check);
    if (row) {
        row.skipped++;
        if (input) {
            row.unavailable_inputs ??= [];
            row.unavailable_inputs.push(input);
        }
    }
}

/** Intentional scope exclusions are neither completed checks nor unavailable inputs. */
export function recordVerifyInputExclusion(check: string, input: { file: string; reason: string }): void {
    recordVerifyMeasurement(check, 0);
    const row = active.getStore()?.rows.get(check);
    if (!row) return;
    row.excluded = (row.excluded ?? 0) + 1;
    row.excluded_inputs ??= [];
    row.excluded_inputs.push(input);
}

/** The current run's ledger of set-aside files, not-measured pairs and early stop; null outside a run. */
export function currentScanLedger(): ScanLedger | null {
    return active.getStore()?.ledger ?? null;
}

/** A file that source roles set aside: content checks never read it. */
export function recordSetAside(row: SetAsideRow): void {
    active.getStore()?.ledger.setAside.push(row);
}

/** One (check, file) pair that did not finish within budget. The run continues and exits 75 (no clean verdict). */
export function recordNotMeasuredPair(row: NotMeasuredRow): void {
    const run = active.getStore();
    if (!run) return;
    run.ledger.notMeasured.push(row);
    recordVerifyInputDeferral(row.check, { file: row.file, reason: `not measured: ${row.reason} (${Math.round(row.elapsed_ms)} ms)` });
}

/** Add elapsed time to a file's running total and return the new total (0 outside a run). */
export function addFileElapsed(file: string, ms: number): number {
    const ledger = active.getStore()?.ledger;
    if (!ledger) return 0;
    const total = (ledger.fileElapsed.get(file) ?? 0) + ms;
    ledger.fileElapsed.set(file, total);
    return total;
}

export function fileElapsedMs(file: string): number {
    return active.getStore()?.ledger.fileElapsed.get(file) ?? 0;
}

/** True once the soft whole-command deadline has passed. Work checks it between files and checks. */
export function verifyDeadlinePassed(): boolean {
    const deadline = active.getStore()?.deadlineAt;
    return deadline !== undefined && Date.now() >= deadline;
}

/** True when this run was started with `--all-checks`: the opt-in sweeps run only then. */
export function isVerifyAllChecks(): boolean {
    return active.getStore()?.allChecks === true;
}

/** Milliseconds until the soft deadline, or null when the run has none. */
export function verifyDeadlineRemainingMs(): number | null {
    const deadline = active.getStore()?.deadlineAt;
    return deadline === undefined ? null : deadline - Date.now();
}

/** Record that the run stops early and will print a partial report. Keeps the first reason. */
export function markVerifyPartial(phase: string, reason: string): void {
    const run = active.getStore();
    if (!run || run.ledger.partial) return;
    run.ledger.partial = { reason, phase, elapsed_ms: Date.now() - run.startedAt };
    recordVerifyInputDeferral("verify_deadline", { file: "<run>", reason: `${reason} (during ${phase})` });
}

/** Aggregate one row/check/run, including unsuccessful and budget-deferred work. */
export async function withVerifyTimings<T>(root: string, work: () => T | Promise<T>, options: { budgetMs?: number; skipChecks?: ReadonlySet<string>; deadlineAt?: number; allChecks?: boolean; onFinish?: (run: VerifyTimingRun) => void } = {}): Promise<T> {
    const run: VerifyTimingRun = { ...(options.allChecks ? { allChecks: true } : {}), root, runId: randomUUID(), budgetMs: options.budgetMs ?? VERIFY_CHECK_BUDGET_MS, rows: new Map(), ledger: createScanLedger(), startedAt: Date.now(), ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }), ...(options.skipChecks ? { skipChecks: new Set(options.skipChecks) } : {}) };
    try { return await active.run(run, work); }
    finally {
        for (const row of timingSnapshot(run)) appendVerifyTiming(root, { run_id: run.runId, ...row, status: row.errors ? "error" : row.skipped ? "partial" : "complete" });
        options.onFinish?.(run);
        const deferred = [...run.rows.values()].filter(row => row.skipped > 0);
        if (deferred.length) {
            process.stderr.write(`[verify] ${deferred.length} checks have unavailable or deferred inputs; partial verification, no clean verdict.\n`);
            process.exitCode = 75;
        }
    }
}

export function measureVerifyCheck<T>(check: string, work: () => T, deferred?: () => T): T {
    const run = active.getStore();
    if (!run) return work();
    let row = run.rows.get(check);
    if (!row) { row = { check, duration_ms: 0, calls: 0, max_call_ms: 0, skipped: 0, errors: 0 }; run.rows.set(check, row); }
    if (deferred && row.duration_ms >= run.budgetMs) { row.skipped++; return deferred(); }
    const started = performance.now(); row.calls++;
    try { return work(); }
    catch (error) { row.errors++; throw error; }
    finally { const ms = performance.now() - started; row.duration_ms += ms; row.max_call_ms = Math.max(row.max_call_ms, ms); }
}

export async function measureVerifyCheckAsync<T>(check: string, work: () => Promise<T>): Promise<T> {
    const run = active.getStore();
    if (!run) return work();
    let row = run.rows.get(check);
    if (!row) { row = { check, duration_ms: 0, calls: 0, max_call_ms: 0, skipped: 0, errors: 0 }; run.rows.set(check, row); }
    const started = performance.now(); row.calls++;
    try { return await work(); }
    catch (error) { row.errors++; throw error; }
    finally { const ms = performance.now() - started; row.duration_ms += ms; row.max_call_ms = Math.max(row.max_call_ms, ms); }
}
