// ===========================================
// `interlinked harness latency` — read latency.jsonl, surface percentiles
// ===========================================
// Reads the daemon-emitted `.interlinked/logs/latency.jsonl` (see
// `src/harness/latency-log.ts`), aggregates hook-decision records, and
// prints per-event-class p50/p90/p99 plus the top-N slowest sessions.
//
// Companion to Task #10. Output mirrors the shape proposed in
// docs/plans/free-cli-adoption/_phase1-phase-matrix.md §"Telemetry hook".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";

interface ToolBreakdownRecord {
	tool: string;
	ms: number;
	finding_count: number;
}

// Only the fields the report reads. Wire rows carry more (schema/kind/ts/
// tool_name/agent_source/decision); parsing them was validate-and-ignore
// dead weight — twice-confirmed unobserved by mutation re-measure 2026-08-22.
interface LatencyRecord {
	hook_event?: string | null;
	session_id?: string | null;
	checks_ran?: string[] | null;
	checks_timing_ms?: number | null;
	// Unvalidated JSON array — entries are checked one-by-one in
	// addBreakdownTimings, not here (see the field's usage comment below).
	tool_breakdown?: unknown[] | null;
}

/**
 * Parse one already-`JSON.parse`d latency.jsonl line into a `LatencyRecord`,
 * or null when the line isn't a JSON object at all (a bare array/string/
 * number/null — the daemon writer never emits these, but a truncated or
 * hand-edited log line could parse to one). Unlike a full field-by-field
 * reconstruction, a wrong-TYPED field degrades to that field's safe empty
 * value here rather than rejecting the whole record — every consumer below
 * already re-validates each field defensively (`typeof`/`Array.isArray` in
 * `addBreakdownTimings`/`addChecksRanTimings`/the aggregation loop), so this
 * only needs to guarantee the SHAPE the rest of the file assumes.
 *
 * Before this gate, a line that parsed to `null` (`JSON.parse("null")`) was
 * pushed into `records` unchecked and crashed the aggregation loop the
 * moment it read `.hook_event` off it — not caught by the per-line try/catch,
 * which only wraps the parse+push, not later use.
 */
function parseLatencyRecord(value: unknown): LatencyRecord | null {
	if (!isJsonObject(value)) return null;
	// Wire rows carry more fields (schema/kind/ts/tool_name/agent_source/
	// decision); parsing them here was validate-and-ignore dead weight —
	// twice-confirmed unobserved by mutation re-measure 2026-08-22. The
	// parser now keeps only what the report reads.
	const { hook_event, session_id, checks_ran, checks_timing_ms, tool_breakdown } = value;
	return {
		hook_event: typeof hook_event === "string" || hook_event === null ? hook_event : null,
		session_id: typeof session_id === "string" || session_id === null ? session_id : null,
		// Element-level validation is deliberately NOT done here (see
		// addBreakdownTimings/addChecksRanTimings) — they already skip
		// malformed entries one-by-one, and duplicating that here would risk
		// the two checks drifting apart.
		checks_ran: Array.isArray(checks_ran) ? checks_ran : null,
		checks_timing_ms: typeof checks_timing_ms === "number" ? checks_timing_ms : null,
		tool_breakdown: Array.isArray(tool_breakdown) ? tool_breakdown : null,
	};
}

export interface LatencyPercentiles {
	timing_count: number;
	p50: number | null;
	p90: number | null;
	p99: number | null;
	max: number | null;
}

export interface SlowestSession {
	session_id: string;
	max_timing_ms: number;
	event_count: number;
}

/** Per-tool stats (when --by-tool is requested). The `when_present` numbers
 *  are the percentiles of `checks_timing_ms` across events where this tool
 *  appeared in `checks_ran` — an approximation of per-tool contribution
 *  until Phase A.7 lands real per-tool elapsed times. The `events` count is
 *  exact. */
export interface ByToolStats {
	tool: string;
	events: number;
	when_present: LatencyPercentiles;
}

export interface LatencyReport {
	total_events: number;
	by_hook_event: Record<string, number>;
	post_tool_use: LatencyPercentiles;
	slowest_sessions: SlowestSession[];
	/** Populated only when `compute_by_tool: true`. */
	by_tool?: ByToolStats[];
}

interface ComputeLatencyOptions {
	log_path?: string;
	top_sessions?: number;
	/** Compute per-tool occurrence + when-present percentiles. Default false
	 *  to keep the basic report cheap — `--by-tool` flips it on. */
	compute_by_tool?: boolean;
}

const DEFAULT_TOP_SESSIONS = 10;

export function computeLatencyReport(
	cwd: string,
	opts: ComputeLatencyOptions = {},
): LatencyReport {
	const path = opts.log_path ?? join(cwd, ".interlinked", "logs", "latency.jsonl");
	const topN = opts.top_sessions ?? DEFAULT_TOP_SESSIONS;
	const empty: LatencyReport = {
		total_events: 0,
		by_hook_event: {},
		post_tool_use: { timing_count: 0, p50: null, p90: null, p99: null, max: null },
		slowest_sessions: [],
	};
	const raw = readLatencyLog(path);
	if (raw === null) return empty;

	const records = parseLatencyRecords(raw);
	const { byHookEvent, postTimings, sessionMax } = aggregateLatencyRecords(records);

	postTimings.sort((a, b) => a - b);
	const slowestSessions = topSlowestSessions(sessionMax, topN);

	const byTool = opts.compute_by_tool ? computeByToolStats(records) : undefined;

	return {
		total_events: records.length,
		by_hook_event: byHookEvent,
		post_tool_use: {
			timing_count: postTimings.length,
			p50: percentile(postTimings, 0.5),
			p90: percentile(postTimings, 0.9),
			p99: percentile(postTimings, 0.99),
			max: postTimings.length > 0 ? (postTimings[postTimings.length - 1] ?? null) : null,
		},
		slowest_sessions: slowestSessions,
		...(byTool ? { by_tool: byTool } : {}),
	};
}

/**
 * Read the latency log, or null when it is missing or unreadable. A null
 * makes the caller return the empty report rather than crashing
 * `interlinked harness latency` — `Total events: 0` is correct for a
 * missing/unreadable log.
 */
function readLatencyLog(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch (e) {
		void e;
		return null;
	}
}

/**
 * Parse every non-blank line of the raw log into records. A malformed line is
 * skipped silently — the latency log is append-only and occasionally contains
 * a partial trailing line if the daemon was killed mid-write; we should not
 * crash the report on it.
 */
function parseLatencyRecords(raw: string): LatencyRecord[] {
	const records: LatencyRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const record = parseLatencyRecord(JSON.parse(trimmed));
			if (record) records.push(record);
		} catch (e) {
			void e;
		}
	}
	return records;
}

interface LatencyAggregates {
	byHookEvent: Record<string, number>;
	/** Unsorted — the caller sorts ascending before taking percentiles. */
	postTimings: number[];
	sessionMax: Map<string, { max: number; count: number }>;
}

/** Fold the records into hook-event counts, PostToolUse timings, and the
 *  per-session max/count used by the slowest-sessions table. */
function aggregateLatencyRecords(records: LatencyRecord[]): LatencyAggregates {
	const byHookEvent: Record<string, number> = {};
	const postTimings: number[] = [];
	const sessionMax = new Map<string, { max: number; count: number }>();

	for (const r of records) {
		const evt = r.hook_event ?? "unknown";
		byHookEvent[evt] = (byHookEvent[evt] ?? 0) + 1;
		if (r.hook_event === "PostToolUse" && typeof r.checks_timing_ms === "number") {
			postTimings.push(r.checks_timing_ms);
		}
		if (r.session_id && typeof r.checks_timing_ms === "number") {
			const entry = sessionMax.get(r.session_id) ?? { max: 0, count: 0 };
			if (r.checks_timing_ms > entry.max) entry.max = r.checks_timing_ms;
			entry.count += 1;
			sessionMax.set(r.session_id, entry);
		}
	}
	return { byHookEvent, postTimings, sessionMax };
}

/** The `topN` sessions with the highest single-event timing, descending. */
function topSlowestSessions(
	sessionMax: Map<string, { max: number; count: number }>,
	topN: number,
): SlowestSession[] {
	return Array.from(sessionMax.entries())
		.map(([session_id, e]) => ({
			session_id,
			max_timing_ms: e.max,
			event_count: e.count,
		}))
		.sort((a, b) => b.max_timing_ms - a.max_timing_ms)
		.slice(0, topN);
}

/**
 * Bucket one record's REAL per-tool timings from Phase A.7's `tool_breakdown`
 * field — each subprocess (tsc, biome, eslint, etc.) reports its own
 * elapsedMs. No-op when the record predates A.7 (no `tool_breakdown`).
 */
function addBreakdownTimings(buckets: Map<string, number[]>, r: LatencyRecord): void {
	if (!Array.isArray(r.tool_breakdown)) return;
	for (const entry of r.tool_breakdown) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof (entry as ToolBreakdownRecord).tool !== "string" ||
			typeof (entry as ToolBreakdownRecord).ms !== "number"
		)
			continue;
		const validated = entry as ToolBreakdownRecord;
		const arr = buckets.get(validated.tool) ?? [];
		arr.push(validated.ms);
		buckets.set(validated.tool, arr);
	}
}

/**
 * Fallback for legacy log lines without `tool_breakdown`: bucket the
 * record's total `checks_timing_ms` against every tool present in
 * `checks_ran`. Overstates individual cost but preserves the ordering
 * signal for archived (pre-A.7) logs.
 */
function addChecksRanTimings(buckets: Map<string, number[]>, r: LatencyRecord): void {
	if (!Array.isArray(r.checks_ran)) return;
	const t = r.checks_timing_ms;
	for (const tool of r.checks_ran) {
		if (typeof tool !== "string") continue;
		const arr = buckets.get(tool) ?? [];
		if (typeof t === "number") arr.push(t);
		buckets.set(tool, arr);
	}
}

/**
 * Compute per-tool stats. Two data sources — see `addBreakdownTimings` (real
 * per-tool elapsed times) and `addChecksRanTimings` (when-present
 * approximation for legacy logs).
 *
 * When at least one record carries `tool_breakdown`, we prefer the real
 * timings exclusively — mixing apples and oranges across the two would skew
 * the percentiles. When no record carries it (pre-A.7 log), we fall through
 * to the approximation so the command still works on archived logs.
 */
function computeByToolStats(records: LatencyRecord[]): ByToolStats[] {
	const hasBreakdown = records.some((r) => Array.isArray(r.tool_breakdown) && r.tool_breakdown.length > 0);
	const buckets = new Map<string, number[]>();
	if (hasBreakdown) {
		for (const r of records) addBreakdownTimings(buckets, r);
	} else {
		for (const r of records) addChecksRanTimings(buckets, r);
	}
	const stats: ByToolStats[] = [];
	for (const [tool, timings] of buckets.entries()) {
		timings.sort((a, b) => a - b);
		stats.push({
			tool,
			events: timings.length,
			when_present: {
				timing_count: timings.length,
				p50: percentile(timings, 0.5),
				p90: percentile(timings, 0.9),
				p99: percentile(timings, 0.99),
				max: timings.length > 0 ? (timings[timings.length - 1] ?? null) : null,
			},
		});
	}
	stats.sort((a, b) => b.events - a.events); // most-frequent first
	return stats;
}

function percentile(sortedAsc: number[], q: number): number | null {
	if (sortedAsc.length === 0) return null;
	const idx = Math.min(
		sortedAsc.length - 1,
		Math.max(0, Math.ceil(q * sortedAsc.length) - 1),
	);
	return sortedAsc[idx] ?? null;
}

export interface HarnessLatencyCommandOptions {
	json?: boolean;
	byTool?: boolean;
}

export async function harnessLatencyCommand(
	opts: HarnessLatencyCommandOptions = {},
): Promise<void> {
	const report = computeLatencyReport(process.cwd(), {
		compute_by_tool: opts.byTool === true,
	});
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}
	const lines: string[] = [];
	lines.push("Harness latency report");
	lines.push("──────────────────────");
	lines.push(`  Total events:        ${report.total_events}`);
	lines.push("");
	lines.push("  By hook_event:");
	for (const [evt, count] of Object.entries(report.by_hook_event).sort(
		(a, b) => b[1] - a[1],
	)) {
		lines.push(`    ${evt.padEnd(20)} ${count}`);
	}
	lines.push("");
	const p = report.post_tool_use;
	lines.push("  PostToolUse check timing:");
	lines.push(`    samples              ${p.timing_count}`);
	lines.push(`    p50                  ${formatMs(p.p50)}`);
	lines.push(`    p90                  ${formatMs(p.p90)}`);
	lines.push(`    p99                  ${formatMs(p.p99)}`);
	lines.push(`    max                  ${formatMs(p.max)}`);
	lines.push("");
	lines.push("  Top slowest sessions (by max event timing):");
	if (report.slowest_sessions.length === 0) {
		lines.push("    (none)");
	} else {
		for (const s of report.slowest_sessions) {
			lines.push(
				`    ${s.session_id.slice(0, 36).padEnd(38)} ${formatMs(s.max_timing_ms)}  (${s.event_count} events)`,
			);
		}
	}
	if (report.by_tool && report.by_tool.length > 0) {
		lines.push("");
		lines.push("  Per-tool stats:");
		lines.push(
			`    ${"tool".padEnd(24)} ${"events".padEnd(8)} ${"p50".padEnd(10)} ${"p99".padEnd(10)} ${"max"}`,
		);
		for (const t of report.by_tool) {
			lines.push(
				`    ${t.tool.padEnd(24)} ${String(t.events).padEnd(8)} ${formatMs(t.when_present.p50).padEnd(10)} ${formatMs(t.when_present.p99).padEnd(10)} ${formatMs(t.when_present.max)}`,
			);
		}
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function formatMs(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}
