import type { VerificationStageInput } from "./verification-stages.js";

/**
 * Explain one verification request from its ledger rows (`verification-stages.jsonl`, joined on `trace`).
 *
 * Pure: the command (`interlinked tests trace`) reads the ledger; this module only folds rows. Durations are
 * summed per phase as the writers recorded them; a row's start is its `ts` minus the phases it recorded, so the
 * user-visible span runs from the earliest start to the latest end. Capacity waits are additionally merged on the
 * clock (`wall_wait_ms`), because two checks waiting for the same slot at the same time is one wait, not two.
 */
export type TraceRow = Pick<VerificationStageInput, "stage" | "check" | "status" | "reused" | "identity" | "owner" | "trace" | "run_id" | "session"
    | "reuse_denied_reason" | "queue_ms" | "wait_capacity_ms" | "validate_ms" | "lookup_ms" | "exec_ms" | "post_ms" | "tests_executed" | "tests_reused"> & { ts: string };

const PHASES = ["queue_ms", "wait_capacity_ms", "validate_ms", "lookup_ms", "exec_ms", "post_ms"] as const;
type Phase = (typeof PHASES)[number];
export type PhaseTotals = Record<Phase, number>;

export interface OwnerSummary { owner: string; rows: number; exec_ms: number; wait_capacity_ms: number; }
export interface TraceSummary {
    trace: string | null;
    rows: number;
    /** ISO start of the earliest row (its `ts` minus its recorded phases) and ISO end of the latest row. */
    started: string | null;
    ended: string | null;
    /** User-visible span from `started` to `ended`; never a sum of rows. */
    span_ms: number;
    phases: PhaseTotals;
    /** Capacity waits merged on the clock: overlapping waits count once. */
    wall_wait_ms: number;
    owners: OwnerSummary[];
    statuses: Record<string, number>;
    /** Observed file counts; missing reports remain visible instead of contributing a claimed zero. */
    tests: { executed: number; reused: number; unmeasured_runs: number };
    /** The handoff fallback this trace recorded, if any (its cause is the suffix of `handoff-fallback:<cause>`). */
    fallback: { cause: string; check: string } | null;
    /** Checks that produced no verdict, with the ledger's reason. */
    deferred: { check: string; reason: string }[];
    /** Checks that ran fresh although a result might have been reused, with the ledger's reason. */
    fresh: { check: string; reason: string }[];
}

const FALLBACK_PREFIX = "handoff-fallback:";

function phaseTotal(row: TraceRow): number {
    return PHASES.reduce((sum, phase) => sum + (row[phase] ?? 0), 0);
}

function startOf(row: TraceRow): number {
    return Date.parse(row.ts) - phaseTotal(row);
}

/** Total length of the union of `[start, end]` intervals. */
function mergedLength(intervals: [number, number][]): number {
    const sorted = [...intervals].filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    let total = 0, cursor = Number.NEGATIVE_INFINITY;
    for (const [start, end] of sorted) {
        const from = Math.max(start, cursor);
        if (end > from) total += end - from;
        cursor = Math.max(cursor, end);
    }
    return total;
}

function count(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
}

function ownerSummaries(rows: TraceRow[]): OwnerSummary[] {
    const owners = new Map<string, OwnerSummary>();
    for (const row of rows) {
        const key = row.owner ?? "unknown";
        const owner = owners.get(key) ?? { owner: key, rows: 0, exec_ms: 0, wait_capacity_ms: 0 };
        owner.rows += 1; owner.exec_ms += row.exec_ms ?? 0; owner.wait_capacity_ms += row.wait_capacity_ms ?? 0;
        owners.set(key, owner);
    }
    return [...owners.values()].sort((a, b) => a.owner.localeCompare(b.owner));
}

/** File counts are observations from reports, independent of timing or the number of tests planned. */
function summarizeTests(rows: TraceRow[]): TraceSummary["tests"] {
    const tests = { executed: 0, reused: 0, unmeasured_runs: 0 };
    for (const row of rows) {
        tests.executed += row.tests_executed ?? 0;
        tests.reused += row.tests_reused ?? 0;
        if ((row.check.startsWith("vitest:") || row.check === "pre-tool:project-tests")
            && (row.tests_executed === undefined || row.tests_reused === undefined)) tests.unmeasured_runs += 1;
    }
    return tests;
}

/** Fold the rows of one trace (or of all rows when `trace` is omitted and the rows already share one) into a summary. */
export function explainVerificationTrace(rows: readonly TraceRow[], trace?: string): TraceSummary {
    const selected = rows.filter(row => trace === undefined || row.trace === trace).filter(row => Number.isFinite(Date.parse(row.ts)));
    const phases: PhaseTotals = { queue_ms: 0, wait_capacity_ms: 0, validate_ms: 0, lookup_ms: 0, exec_ms: 0, post_ms: 0 };
    const statuses: Record<string, number> = {};
    const deferred: TraceSummary["deferred"] = [], fresh: TraceSummary["fresh"] = [];
    const waits: [number, number][] = [];
    let fallback: TraceSummary["fallback"] = null;
    let started = Number.POSITIVE_INFINITY, ended = Number.NEGATIVE_INFINITY;
    for (const row of selected) {
        for (const phase of PHASES) phases[phase] += row[phase] ?? 0;
        count(statuses, row.status);
        const start = startOf(row), end = Date.parse(row.ts);
        started = Math.min(started, start); ended = Math.max(ended, end);
        if (row.wait_capacity_ms) waits.push([start + (row.queue_ms ?? 0), start + (row.queue_ms ?? 0) + row.wait_capacity_ms]);
        const reason = row.reuse_denied_reason;
        if (reason?.startsWith(FALLBACK_PREFIX)) fallback ??= { cause: reason.slice(FALLBACK_PREFIX.length), check: row.check };
        else if (row.status === "deferred") deferred.push({ check: row.check, reason: reason ?? "unknown" });
        else if (reason && !row.reused && row.status !== "fallback") fresh.push({ check: row.check, reason });
    }
    const resolvedTrace = trace ?? selected.find(row => row.trace)?.trace ?? null;
    return {
        trace: resolvedTrace, rows: selected.length,
        started: selected.length ? new Date(started).toISOString() : null, ended: selected.length ? new Date(ended).toISOString() : null,
        span_ms: selected.length ? ended - started : 0,
        phases, wall_wait_ms: mergedLength(waits), owners: ownerSummaries(selected), statuses, tests: summarizeTests(selected), fallback, deferred, fresh,
    };
}

/** The trace of the newest row that belongs to a push (stage `push`), or null when no push left a traced row. */
export function latestPushTrace(rows: readonly TraceRow[]): string | null {
    let best: { ts: number; trace: string } | undefined;
    for (const row of rows) {
        if (row.stage !== "push" || !row.trace) continue;
        const ts = Date.parse(row.ts);
        if (Number.isFinite(ts) && (!best || ts > best.ts)) best = { ts, trace: row.trace };
    }
    return best?.trace ?? null;
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
}

/** Human rendering: span, phases, owners, fallback, deferred and fresh checks; bounded to the rows' own content. */
export function renderVerificationTrace(summary: TraceSummary): string {
    const lines = [`trace ${summary.trace ?? "(none)"}: ${summary.rows} row(s), ${summary.started ?? "?"} → ${summary.ended ?? "?"} (span ${seconds(summary.span_ms)})`];
    const { phases } = summary;
    lines.push(`  phases: wait ${seconds(phases.wait_capacity_ms)} (on the clock ${seconds(summary.wall_wait_ms)}), validate ${seconds(phases.validate_ms)}, lookup ${seconds(phases.lookup_ms)}, exec ${seconds(phases.exec_ms)}, post ${seconds(phases.post_ms)}, queue ${seconds(phases.queue_ms)}`);
    lines.push(`  test files: ${summary.tests.executed} observed executed, ${summary.tests.reused} reused; counts unavailable for ${summary.tests.unmeasured_runs} run(s); statuses: ${Object.entries(summary.statuses).map(([status, n]) => `${status} ${n}`).join(", ") || "none"}`);
    for (const owner of summary.owners) lines.push(`  owner ${owner.owner}: ${owner.rows} row(s), exec ${seconds(owner.exec_ms)}, wait ${seconds(owner.wait_capacity_ms)}`);
    lines.push(summary.fallback ? `  handoff: FALLBACK (${summary.fallback.cause}) recorded by ${summary.fallback.check}` : "  handoff: no fallback recorded");
    for (const item of summary.deferred) lines.push(`  no verdict: ${item.check} — ${item.reason}`);
    for (const item of summary.fresh) lines.push(`  ran fresh: ${item.check} — ${item.reason}`);
    return lines.join("\n");
}
