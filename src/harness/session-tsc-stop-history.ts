// F72/F75 R, conservatively bounded by unit7 amendment A1. Advisory only.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const TSC_HISTORY_WINDOW_MS = 60 * 60 * 1000;
export const TSC_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export type TscOutcome = "finding" | "no_reported_findings" | "skipped" | "timeout" | "resource_failure" | "process_failure" | "unknown";
export interface TscHistoryRow { session: string; time: number; call: string; outcome: TscOutcome; }
export interface TscHistorySummary { runs: number; fires: number; rate: number; latest: TscOutcome | null; }
function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** A status is a diff-aware reported outcome, never proof of full compilation. */
export function classifyTscOutcome(raw: unknown): TscOutcome {
    const row = record(raw);
    if (!row || row.schema !== "check-results.v2" || row.dry_run === true || !Array.isArray(row.execution)) return "unknown";
    const entries = row.execution.map(record).filter((e) => e?.id === "typescript");
    if (entries.length !== 1) return "unknown";
    const entry = entries[0];
    if (!entry) return "unknown";
    const details = Array.isArray(row.finding_details) ? row.finding_details.map(record).filter((d) => d?.name === "typescript") : [];
    const text = [entry.reason, ...details.flatMap((d) => [d?.message, d?.detail])].filter((s) => typeof s === "string").join(" ");
    if (/timed?\s*out|timeout/i.test(text) || entry.status === "timeout") return "timeout";
    if (/resource.busy|out of memory|heap limit|ENOMEM|EAGAIN|SIGKILL/i.test(text) || entry.status === "resource_busy") return "resource_failure";
    if (/spawn.*(?:fail|error|ENOENT)|compiler.*(?:unavailable|not found)|process.*(?:fail|error)|unsupported.configuration/i.test(text) || ["error", "unsupported_configuration"].includes(String(entry.status))) return "process_failure";
    if (["skipped", "deferred"].includes(String(entry.status))) return "skipped";
    if (entry.status === "finding") return "finding";
    if (entry.status === "completed_no_reported_findings") return "no_reported_findings";
    return "unknown";
}
export function parseTscHistoryRow(raw: unknown): TscHistoryRow | null {
    const row = record(raw);
    if (!row || row.schema !== "check-results.v2" || row.dry_run === true || typeof row.session !== "string" || !row.session.trim() || typeof row.ts !== "string") return null;
    const time = Date.parse(row.ts);
    if (!Number.isFinite(time)) return null;
    return { session: row.session, time, call: typeof row.tool_use_id === "string" ? row.tool_use_id : "", outcome: classifyTscOutcome(row) };
}
/** Preserve first observed identity, including unknown outcomes; unidentified runs are unusable. */
export function firstTscInvocations<T extends TscHistoryRow>(rows: readonly T[]): T[] {
    const seen = new Set<string>();
    return rows.filter((r) => {
        if (!r.call.trim()) return false;
        const key = JSON.stringify([r.session, r.call]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
export function summarizeTscHistory(rows: readonly TscHistoryRow[], session: string, now: number, ownCall = ""): TscHistorySummary {
    const selected = rows.filter((r) => r.session === session && r.time < now && r.time >= now - TSC_HISTORY_WINDOW_MS && (!ownCall || r.call !== ownCall));
    const valid = firstTscInvocations(selected).filter((r) => r.outcome === "finding" || r.outcome === "no_reported_findings").sort((a, b) => a.time - b.time);
    const fires = valid.filter((r) => r.outcome === "finding").length;
    // A clean at a tied latest timestamp wins conservatively, independent of line order.
    const latestTime = valid.at(-1)?.time;
    const latest = valid.some((r) => r.time === latestTime && r.outcome === "no_reported_findings") ? "no_reported_findings" : valid.at(-1)?.outcome ?? null;
    return { runs: valid.length, fires, rate: (fires + 1) / (valid.length + 2), latest };
}
export function tscStopHistoryAddendum(h: TscHistorySummary): string | null {
    if (h.runs < 3 || h.rate < 0.5 || h.latest !== "finding") return null;
    return ` Recent same-session TypeScript checks reported findings in ${h.fires} of ${h.runs} runs; rerun the project's typecheck before concluding. This history does not establish the current compile outcome.`;
}
/** Bounded tail avoids scanning the whole potentially gigabyte-sized check log at Stop. */
export function readTscStopHistory(cwd: string, session: string, now: number, ownCall = ""): TscHistorySummary {
    const rows: TscHistoryRow[] = [];
    let fd: number | undefined;
    try {
        fd = openSync(join(cwd, ".interlinked", "check-results.jsonl"), "r");
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - TSC_HISTORY_MAX_BYTES);
        const buffer = Buffer.alloc(size - start);
        let read = 0;
        while (read < buffer.length) { const n = readSync(fd, buffer, read, buffer.length - read, start + read); if (!n) break; read += n; }
        const text = buffer.subarray(0, read).toString("utf8");
        const lines = text.split("\n");
        if (start > 0) lines.shift();
        lines.pop(); // Uncommitted tail is unknown even if it happens to parse.
        const seen = new Set<string>();
        for (const line of lines) {
            if (!line || seen.has(line)) continue;
            seen.add(line);
            try { const row = parseTscHistoryRow(JSON.parse(line)); if (row) rows.push(row); } catch (error) { void error; /* malformed row stays unknown */ }
        }
    } catch (error) { void error; /* Missing/unreadable evidence produces no advisory. */ }
    finally { if (fd !== undefined) closeSync(fd); }
    return summarizeTscHistory(rows, session, now, ownCall);
}
/** Extends an existing Stop warning; never creates a warning or block itself. */
export function appendTscStopHistory(base: string | null, opts: { enabled?: boolean; cwd: string; session: string; now: number; ownCall?: string }): string | null {
    if (base === null || opts.enabled !== true || !opts.session || !Number.isFinite(opts.now)) return base;
    const addendum = tscStopHistoryAddendum(readTscStopHistory(opts.cwd, opts.session, opts.now, opts.ownCall));
    return addendum ? base + addendum : base;
}
