// ===========================================
// Check Health — Tricorder-style demotion signal (v1, log-derived)
// ===========================================
// The recurrence log already powers the UP direction (recurrence propose →
// ratchet a noisy pattern into a harder gate). This module adds the DOWN
// direction: per-check-id health stats over `harness_caught` rows, flagging
// checks whose findings re-fire over and over without changing — the classic
// signature of a false-positive-prone or ignored advisory (Google Tricorder's
// "if devs ignore it, demote it" governance loop).
//
// Everything here is pure fold/finalize over recurrence rows: NO LLM, NO
// network, NO clock reads — first/last seen come solely from row timestamps.
// Callers stream the JSONL line-by-line through `foldRecurrenceLine` so the
// 40k+-row production log is never materialized as one array.

import type { RecurrenceEvent } from "./recurrence.js";

export type CheckDeterminismTag = "proven" | "heuristic" | null;

type CheckHealthStatus = "probation-candidate" | "healthy" | "low-data";

// ===========================================
// Thresholds (named + rationale — tune here, tests derive from these)
// ===========================================

/** Repeat-rate (events per unique finding) at or above which a check looks
 *  ignored/noisy. A healthy finding gets fixed after 1–3 fires (edit → warn →
 *  fix → gone); ≥5 average re-fires of the SAME (file,message) means agents
 *  are editing past the warning without the finding changing. */
export const PROBATION_REPEAT_RATE_THRESHOLD = 5;

/** Minimum distinct (file,message) findings before repeat-rate is trusted.
 *  One stuck finding re-firing forever is a stuck FILE, not a bad check;
 *  demotion evidence requires the pattern across ≥5 independent findings. */
export const PROBATION_UNIQUE_FINDINGS_FLOOR = 5;

/** Below this many total events a check has too little signal to grade at
 *  all — new or rarely-firing checks report `low-data`, never probation. */
export const LOW_DATA_EVENT_FLOOR = 10;

// ===========================================
// Shapes
// ===========================================

export interface CheckHealthRow {
	check_id: string;
	/** Total harness_caught events for this check id. */
	events: number;
	/** Distinct (file, message) pairs — "unique findings". */
	unique_findings: number;
	/** Distinct session ids that saw a fire. */
	sessions: number;
	first_seen: string;
	last_seen: string;
	/** events / unique_findings — high = same finding re-fired unchanged. */
	repeat_rate: number;
	determinism: CheckDeterminismTag;
	status: CheckHealthStatus;
	/** Actionable one-liner: "693 events / 10 unique / 12 sessions …". */
	why: string;
}

interface HealthBucket {
	events: number;
	findings: Set<string>;
	sessions: Set<string>;
	first_seen: string;
	last_seen: string;
}

interface CheckHealthAccumulator {
	buckets: Map<string, HealthBucket>;
}

// ===========================================
// Fold (streaming-friendly)
// ===========================================

export function createCheckHealthAccumulator(): CheckHealthAccumulator {
	return { buckets: new Map() };
}

/** Fold one raw JSONL line. Torn/garbage lines (process died mid-append) and
 *  non-harness_caught rows are skipped silently — same tolerance as
 *  `loadRecurrenceEvents`. Returns true when the line contributed. */
export function foldRecurrenceLine(acc: CheckHealthAccumulator, line: string): boolean {
	if (!line.trim()) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return false;
	}
	if (!isCaughtRow(parsed)) return false;
	foldCaughtRow(acc, parsed);
	return true;
}

/** Fold one already-parsed recurrence event (ignores anything that is not a
 *  harness_caught row with a check_id — health is about check FIRES only). */
export function foldCheckHealthEvent(acc: CheckHealthAccumulator, event: RecurrenceEvent): void {
	if (!isCaughtRow(event)) return;
	foldCaughtRow(acc, event);
}

function foldCaughtRow(
	acc: CheckHealthAccumulator,
	event: RecurrenceEvent & { check_id: string },
): void {
	const bucket = acc.buckets.get(event.check_id) ?? {
		events: 0,
		findings: new Set<string>(),
		sessions: new Set<string>(),
		first_seen: event.ts,
		last_seen: event.ts,
	};
	bucket.events++;
	// Finding identity = (file, message). Missing fields collapse to "" so a
	// field-less row still counts as one finding rather than vanishing.
	bucket.findings.add(`${event.file ?? ""}\x00${event.message ?? ""}`);
	if (event.session_id) bucket.sessions.add(event.session_id);
	if (tsMillis(event.ts) < tsMillis(bucket.first_seen)) bucket.first_seen = event.ts;
	if (tsMillis(event.ts) > tsMillis(bucket.last_seen)) bucket.last_seen = event.ts;
	acc.buckets.set(event.check_id, bucket);
}

// ===========================================
// Finalize
// ===========================================

/** Materialize health rows, sorted by repeat-rate (worst first). Determinism
 *  is injected so this module stays registry-free and directly testable; the
 *  CLI passes `classifyDeterminism` from quality-checks. */
export function finalizeCheckHealth(
	acc: CheckHealthAccumulator,
	classify: (checkId: string) => CheckDeterminismTag,
): CheckHealthRow[] {
	const rows: CheckHealthRow[] = [];
	for (const [checkId, bucket] of acc.buckets) {
		const unique = bucket.findings.size;
		// unique ≥ 1 whenever events ≥ 1 (every fold adds a finding key), but
		// guard the division anyway — a 0/0 check id must read as 0, not NaN.
		const repeatRate = unique > 0 ? bucket.events / unique : 0;
		const stats = {
			events: bucket.events,
			unique_findings: unique,
			sessions: bucket.sessions.size,
			repeat_rate: repeatRate,
			determinism: classify(checkId),
		};
		rows.push({
			check_id: checkId,
			...stats,
			first_seen: bucket.first_seen,
			last_seen: bucket.last_seen,
			status: classifyCheckHealth(stats),
			why: describeCheckHealth(stats),
		});
	}
	return rows.sort(
		(a, b) =>
			b.repeat_rate - a.repeat_rate ||
			b.events - a.events ||
			a.check_id.localeCompare(b.check_id),
	);
}

/** The probation heuristic. Only HEURISTIC checks are demotion-eligible: a
 *  proven check (tsc, gitleaks…) re-firing means the agent ignored a real
 *  error — evidence about the agent, not the check. Unknown determinism
 *  (retired/foreign ids) is likewise never demoted on log evidence alone. */
export function classifyCheckHealth(stats: {
	events: number;
	unique_findings: number;
	repeat_rate: number;
	determinism: CheckDeterminismTag;
}): CheckHealthStatus {
	if (stats.events < LOW_DATA_EVENT_FLOOR) return "low-data";
	const noisy =
		stats.repeat_rate >= PROBATION_REPEAT_RATE_THRESHOLD &&
		stats.unique_findings >= PROBATION_UNIQUE_FINDINGS_FLOOR &&
		stats.determinism === "heuristic";
	return noisy ? "probation-candidate" : "healthy";
}

/** "693 events / 10 unique / 12 sessions — repeat-rate 69.3 (heuristic)". */
export function describeCheckHealth(stats: {
	events: number;
	unique_findings: number;
	sessions: number;
	repeat_rate: number;
	determinism: CheckDeterminismTag;
}): string {
	const det = stats.determinism ?? "unknown-determinism";
	return (
		`${stats.events} events / ${stats.unique_findings} unique / ${stats.sessions} sessions` +
		` — repeat-rate ${stats.repeat_rate.toFixed(1)} (${det})`
	);
}

// ===========================================
// Internals
// ===========================================

function isCaughtRow(value: unknown): value is RecurrenceEvent & { check_id: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Partial<RecurrenceEvent>;
	return (
		row.kind === "harness_caught" &&
		typeof row.check_id === "string" &&
		row.check_id.length > 0 &&
		typeof row.ts === "string"
	);
}

function tsMillis(ts: string): number {
	const ms = new Date(ts).getTime();
	// Unparseable timestamps sort as "oldest" deterministically instead of
	// poisoning every comparison with NaN (which reads false → fail-open).
	return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}
