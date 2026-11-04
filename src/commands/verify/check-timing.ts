import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface VerifyCheckTiming { check: string; duration_ms: number; calls: number; max_call_ms: number; skipped: number; errors: number; unavailable_inputs?: { file: string; reason: string }[]; }
export interface VerifyTimingRun { root: string; runId: string; budgetMs: number; rows: Map<string, VerifyCheckTiming>; }
const active = new AsyncLocalStorage<VerifyTimingRun>();
export const VERIFY_CHECK_BUDGET_MS = 30_000;

export function timingSnapshot(run: VerifyTimingRun): VerifyCheckTiming[] {
    return [...run.rows.values()].map(row => ({ ...row })).sort((a, b) => b.duration_ms - a.duration_ms);
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
            if (row.unavailable_inputs.length < 100) row.unavailable_inputs.push(input);
        }
    }
}

/** Aggregate one row/check/run, including unsuccessful and budget-deferred work. */
export async function withVerifyTimings<T>(root: string, work: () => T | Promise<T>, options: { budgetMs?: number; onFinish?: (run: VerifyTimingRun) => void } = {}): Promise<T> {
    const run: VerifyTimingRun = { root, runId: randomUUID(), budgetMs: options.budgetMs ?? VERIFY_CHECK_BUDGET_MS, rows: new Map() };
    try { return await active.run(run, work); }
    finally {
        for (const row of timingSnapshot(run)) appendVerifyTiming(root, { run_id: run.runId, ...row, status: row.errors ? "error" : row.skipped ? "partial" : "complete" });
        options.onFinish?.(run);
        const deferred = [...run.rows.values()].filter(row => row.skipped > 0);
        if (deferred.length) {
            process.stderr.write(`[verify] ${deferred.length} checks have deferred inputs under size/time budgets; partial verification, no clean verdict.\n`);
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
