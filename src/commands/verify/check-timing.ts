import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface VerifyCheckTiming { check: string; duration_ms: number; calls: number; max_call_ms: number; skipped: number; errors: number; unavailable_inputs?: { file: string; reason: string }[]; excluded?: number; excluded_inputs?: { file: string; reason: string }[]; }
export interface VerifyTimingRun { root: string; runId: string; budgetMs: number; rows: Map<string, VerifyCheckTiming>; skipChecks?: ReadonlySet<string>; }
const active = new AsyncLocalStorage<VerifyTimingRun>();
/** Compatibility callers outside public verify still need their unavailable disclosures. */
export function hasVerifyTimingContext(): boolean { return active.getStore() !== undefined; }
/** Foreground census measures every selected input; callers may explicitly bound work. */
export const VERIFY_CHECK_BUDGET_MS = Number.POSITIVE_INFINITY;

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

/** Aggregate one row/check/run, including unsuccessful and budget-deferred work. */
export async function withVerifyTimings<T>(root: string, work: () => T | Promise<T>, options: { budgetMs?: number; skipChecks?: ReadonlySet<string>; onFinish?: (run: VerifyTimingRun) => void } = {}): Promise<T> {
    const run: VerifyTimingRun = { root, runId: randomUUID(), budgetMs: options.budgetMs ?? VERIFY_CHECK_BUDGET_MS, rows: new Map(), ...(options.skipChecks ? { skipChecks: new Set(options.skipChecks) } : {}) };
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
