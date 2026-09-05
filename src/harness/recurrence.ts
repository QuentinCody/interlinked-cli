// ===========================================
// Recurrence Aggregation
// ===========================================
// Small JSONL-backed primitive for grouping repeated harness findings and
// user-reported misses into actionable recurrence rows.

import { recordRecurrenceEvent } from "./recurrence-io.js";
export { recordRecurrenceEvent, recurrencesPath, loadRecurrenceEvents, iterateRecurrenceEvents } from "./recurrence-io.js";
import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import {
	deriveSignature,
	SIGNATURE_ASSEMBLY_CAP,
	signaturePayload,
} from "./recurrence-signature.js";
import {
	parseDurationMs,
	resolveSinceCutoff,
	updateSeenBounds,
} from "./recurrence-time.js";
import { assemblyIndexOfTokens } from "./spec/assembly-score.js";

// deriveSignature is part of this module's public API — re-export it so
// existing consumers keep importing it from recurrence.js.
// parseDurationMs / resolveSinceCutoff stay part of this module's public API.
export { deriveSignature, parseDurationMs, resolveSinceCutoff };

export type RecurrenceKind =
	| "harness_caught"
	| "harness_missed"
	| "codebase_existing"
	| "outcome_marker"
	| "tool_failure";

/** Phase 1 FP-telemetry additions (see docs/plans/11-phase1-...md). */
export type RecurrencePhase = "pre_block" | "pre_warn" | "post";
export type RecurrenceSeverity = "error" | "warning";
/**
 * Outcome of a prior fire — emitted later in the session lifecycle, not at
 * fire time. Phase 2's FP-rate aggregator uses these as the FP-candidate set
 * (`agent_fixed` is the implicit positive). Storage shape is `outcome_marker`
 * events that cross-reference the original fire by (check_id, file,
 * session_id, fire_ts).
 */
export type OutcomeSignal =
	| "agent_fixed"
	| "agent_suppressed"
	| "user_overrode"
	| "check_reverted";

export interface RecurrenceEvent {
	scan_id?: string;
	snapshot_id?: string;
	finding_id?: string;
	observation?: "introduced" | "changed";
	ts: string;
	kind: RecurrenceKind;
	check_id?: string | undefined;
	agent_source?: string | undefined;
	session_id?: string | undefined;
	file?: string | undefined;
	message?: string | undefined;
	signature?: string | undefined;
	/** Phase the originating check declared. Optional for backwards compat
	 *  with rows written before Phase 1 of the rollout. */
	phase?: RecurrencePhase | undefined;
	/** Severity at the originating check. Optional for backwards compat. */
	severity?: RecurrenceSeverity | undefined;
	/** Set on `outcome_marker` rows; identifies what happened to the fire. */
	outcome_signal?: OutcomeSignal | undefined;
	/** Free-text one-liner explaining the outcome (e.g., the suppression
	 *  directive text + justification). */
	outcome_reason?: string | undefined;
	/** Set on `outcome_marker` rows; the `ts` of the original fire being
	 *  marked. Lets the aggregator pair markers to fires deterministically. */
	fire_ts?: string | undefined;
}

export interface Recurrence {
	kind: RecurrenceKind;
	signature: string;
	check_id?: string | undefined;
	count: number;
	first_seen: string;
	last_seen: string;
	distinct_sessions: number;
	distinct_files: number;
	agent_sources: string[];
	sample_files: string[];
	/** Structural significance of the signature, measured as its assembly index
	 *  (Re-Pair grammar size, spike 14 §8.3). Higher = more structurally
	 *  load-bearing; used as the within-equal-count ranking tiebreaker below so
	 *  a complex recurring pattern outranks a trivial one seen equally often.
	 *  Production consumer of assembly-score (round-2 #33). The raw index, not
	 *  significance() — that prior saturates at e^12 for any real-length
	 *  signature and so cannot order them. */
	assembly_significance: number;
}

export interface RecurrenceFilters {
	kind?: RecurrenceKind;
	since?: string;
	agent_source?: string;
	check_id?: string;
}

export interface RecurrenceAction {
	kind: "ratchet" | "scaffold_rule" | "cleanup_pr";
	headline: string;
	detail: string;
}

export function aggregateRecurrences(
	events: Iterable<RecurrenceEvent>,
	filters: RecurrenceFilters = {},
): Recurrence[] {
	const buckets = new Map<
		string,
		{
			kind: RecurrenceKind;
			signature: string;
			/** All distinct check_ids seen in this bucket. The emitted row
			 *  claims one only when exactly one appeared — ambiguity is sticky
			 *  once two distinct ids show up (round-14 sol #1). */
			checkIds: Set<string>;
			count: number;
			first_seen: string;
			last_seen: string;
			sessions: Set<string>;
			agent_sources: Set<string>;
			/** file -> latest ts (one entry per distinct file; see trackFile). */
			fileLatest: Map<string, string>;
		}
	>();

	for (const event of events) {
		if (!matchesFilters(event, filters)) continue;
		const signature = deriveSignature(event);
		// Bucket by (kind, signature), not signature alone (round-12 sol #1);
		// `kind` is a newline-free enum, so the newline separator is unambiguous.
		const bucketKey = `${event.kind}\n${signature}`;
		const row =
			buckets.get(bucketKey) ??
			{
				kind: event.kind,
				signature,
				checkIds: new Set<string>(),
				count: 0,
				first_seen: event.ts,
				last_seen: event.ts,
				sessions: new Set<string>(),
				agent_sources: new Set<string>(),
				fileLatest: new Map<string, string>(),
			};

		row.count++;
		// Accumulate every distinct check_id (including "" — a present-but-empty
		// id is still distinct from "bash", round-15 sol #1); the row claims one
		// only when exactly one was seen (round-13 #2, round-14 #1 — sticky).
		if (typeof event.check_id === "string") row.checkIds.add(event.check_id);
		updateSeenBounds(row, event.ts);
		if (event.session_id) row.sessions.add(event.session_id);
		if (event.file) trackFile(row.fileLatest, event.file, event.ts);
		if (event.agent_source) row.agent_sources.add(event.agent_source);
		buckets.set(bucketKey, row);
	}

	return [...buckets.values()]
		.map((row): Recurrence => ({
			kind: row.kind,
			signature: row.signature,
			// Emit the single observed id AS-IS — a present-but-empty "" is a
			// distinct value the contract preserves (round-16 sol #2); only a
			// genuinely empty bucket (size 0) or an ambiguous one (size >1) is
			// undefined.
			check_id: row.checkIds.size === 1 ? [...row.checkIds][0] : undefined,
			count: row.count,
			first_seen: row.first_seen,
			last_seen: row.last_seen,
			distinct_sessions: row.sessions.size,
			distinct_files: row.fileLatest.size,
			agent_sources: [...row.agent_sources].sort(),
			sample_files: recentUniqueFiles(
				[...row.fileLatest].map(([file, ts]) => ({ file, ts })),
			),
			// Structural-complexity tiebreak (#33): Re-Pair index of the
			// kind-stripped signature payload, bounded by SIGNATURE_ASSEMBLY_CAP.
			assembly_significance: assemblyIndexOfTokens([
				...signaturePayload(row.signature).slice(0, SIGNATURE_ASSEMBLY_CAP),
			]),
		}))
		// Count stays the dominant signal (users expect frequency ordering), but
		// among equally-frequent rows the structurally load-bearing signature —
		// higher assembly index — surfaces first (spike 14). Signature breaks any
		// remaining tie for stable output.
		.sort(
			(a, b) =>
				b.count - a.count ||
				b.assembly_significance - a.assembly_significance ||
				a.signature.localeCompare(b.signature),
		);
}

export function proposeAction(row: Recurrence): RecurrenceAction {
	if (row.kind === "harness_missed") {
		return {
			kind: "scaffold_rule",
			headline: `Scaffold a new rule for ${row.signature.replace(/^harness_missed:/, "")}`,
			detail:
				"Create a deterministic rule or quality check for this repeated user-reported miss, then add regression tests from the sample files.",
		};
	}
	if (row.kind === "codebase_existing") {
		return {
			kind: "cleanup_pr",
			headline: `Open cleanup PR for ${row.distinct_files} file(s) with ${row.check_id ?? row.signature}`,
			detail: `Fix existing findings across sample files: ${row.sample_files.join(", ") || "none recorded"}.`,
		};
	}
	return {
		kind: "ratchet",
		headline: `Ratchet recurring ${row.check_id ?? row.signature} findings`,
		detail:
			"Promote or tune the recurring check in guard-rules.local.json so repeated agent mistakes become harder to reintroduce.",
	};
}

function matchesFilters(event: RecurrenceEvent, filters: RecurrenceFilters): boolean {
	if (filters.kind && event.kind !== filters.kind) return false;
	if (filters.agent_source && event.agent_source !== filters.agent_source) return false;
	if (filters.check_id && event.check_id !== filters.check_id) return false;
	if (filters.since) {
		const sinceMs = new Date(filters.since).getTime();
		// A malformed `since` is treated as no filter; a malformed event
		// timestamp can't be shown to satisfy the cutoff, so exclude it rather
		// than fail open (round-12 sol #5).
		if (Number.isFinite(sinceMs)) {
			const eventMs = new Date(event.ts).getTime();
			if (!Number.isFinite(eventMs) || eventMs < sinceMs) return false;
		}
	}
	return true;
}

/** Record a file's LATEST timestamp (NaN-safe), one entry per distinct file.
 *  Deduping to file→latest-ts is the real memory bound (round-18/19): storage
 *  is O(distinct files), not O(events), and every file keeps its most-recent
 *  ts so `sample_files` stays recent (round-20 sol #2) and `distinct_files`
 *  stays EXACT (round-20 sol #1). A hard file-count cap was tried and reverted:
 *  it made the count undercount and the sample stale — you cannot have an exact
 *  distinct count AND a fixed memory bound, and a signature spanning millions
 *  of distinct files is not a real threat for the harness's own recurrence log
 *  (accepted tradeoff, not a silent one). */
function trackFile(fileLatest: Map<string, string>, file: string, ts: string): void {
	const prev = fileLatest.get(file);
	if (prev === undefined) {
		fileLatest.set(file, ts);
		return;
	}
	const p = new Date(prev).getTime();
	const t = new Date(ts).getTime();
	if (!Number.isFinite(p) || (Number.isFinite(t) && t > p)) fileLatest.set(file, ts);
}

/** Max distinct files retained per row: sample_files is a bounded SAMPLE, so a
 *  signature spanning many (possibly attacker-controlled) filenames cannot
 *  amplify memory/output (round-18 sol #1). */
const SAMPLE_FILES_CAP = 10;

function recentUniqueFiles(events: Array<{ file: string; ts: string }>): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	// A malformed timestamp sorts as OLDEST (round-14 sol #4).
	const tsOf = (e: { ts: string }): number => {
		const t = new Date(e.ts).getTime();
		return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
	};
	// Compare, never subtract: -Infinity - -Infinity is NaN, an unstable
	// comparator return (round-18 sol #3).
	const sorted = [...events].sort((a, b) => {
		const ta = tsOf(a);
		const tb = tsOf(b);
		return ta === tb ? 0 : tb > ta ? 1 : -1;
	});
	for (const event of sorted) {
		if (files.length >= SAMPLE_FILES_CAP) break;
		if (seen.has(event.file)) continue;
		seen.add(event.file);
		files.push(event.file);
	}
	return files;
}

// ===========================================
// Wiring helpers — convert callsite signals into recurrence events
// ===========================================

/** Record a harness_caught recurrence from a check failure observed by
 *  the harness (PostToolUse quality / structural check). Single-line
 *  callsite for `server.ts` so the wiring is grep-able. Storage failures
 *  are swallowed here — this is on the PostToolUse hot path, where an
 *  observability write must never abort the hook response. CLI callers
 *  that *want* to surface storage failures use `recordRecurrenceEvent`
 *  or `recordHarnessMissed` directly. */
export function recordHarnessCaught(opts: {
	check_id: string;
	agent_source: string;
	session_id: string;
	file: string;
	message?: string | undefined;
	cwd?: string | undefined;
	ts?: string | undefined;
	phase?: RecurrencePhase | undefined;
	severity?: RecurrenceSeverity | undefined;
}): void {
	// Capacity/backpressure rows are retained by the structured check-results
	// sink. They are not repeat source defects and must never propose a source
	// ratchet through recurrence aggregation.
	if (isOperationalCheckDeferral(opts.check_id)) return;
	try {
		recordRecurrenceEvent(
			{
				ts: opts.ts ?? new Date().toISOString(),
				kind: "harness_caught",
				check_id: opts.check_id,
				agent_source: opts.agent_source,
				session_id: opts.session_id,
				file: opts.file,
				message: opts.message,
				phase: opts.phase,
				severity: opts.severity,
			},
			opts.cwd ?? process.cwd(),
		);
	} catch (e) {
		void e;
	}
}

/** Phase 1 Channel 1 — tool-failure recurrence. Single grep-able callsite for
 *  the harness handler in `server.ts` to record a tool failure under the
 *  recurrence substrate so `interlinked recurrence list --kind tool_failure`
 *  can aggregate "this exact failure happened N times in M sessions". The
 *  harness builds the signature `tool_failure:<tool>:<error_class>:<message-prefix>`
 *  and passes it in directly; we don't try to re-derive it here because
 *  triage classification (Channel 2) is what produces the error_class. Storage
 *  failures swallowed for the same reason as `recordHarnessCaught` — this
 *  fires on the PostToolUse hot path. */
export function recordToolFailure(opts: {
	tool_name: string;
	signature: string;
	agent_source: string;
	session_id: string;
	file?: string | undefined;
	message?: string | undefined;
	cwd?: string | undefined;
	ts?: string | undefined;
}): void {
	try {
		recordRecurrenceEvent(
			{
				ts: opts.ts ?? new Date().toISOString(),
				kind: "tool_failure",
				check_id: opts.tool_name,
				agent_source: opts.agent_source,
				session_id: opts.session_id,
				file: opts.file,
				signature: opts.signature,
				message: opts.message,
			},
			opts.cwd ?? process.cwd(),
		);
	} catch (e) {
		void e;
	}
}

/**
 * Public API surface for Phase 2's FP-rate aggregator. Mark an outcome for
 * a prior `harness_caught` fire — idempotent on (check_id, file, session_id,
 * fire_ts). The aggregator dedupes when multiple paths emit (e.g., agent
 * fixes a finding *and* suppresses an adjacent one). Storage failures
 * swallowed for the same reason as `recordHarnessCaught`.
 *
 * Phase 1 commits to emission only — the producer paths (fix-detection,
 * suppression-detection, user-override hook) land in Phase 2. This export
 * intentionally has no in-tree consumers yet; do not remove. */
export function markOutcome(opts: {
	check_id: string;
	file: string;
	session_id: string;
	signal: OutcomeSignal;
	reason?: string | undefined;
	fire_ts?: string | undefined;
	cwd?: string | undefined;
	ts?: string | undefined;
}): void {
	try {
		recordRecurrenceEvent(
			{
				ts: opts.ts ?? new Date().toISOString(),
				kind: "outcome_marker",
				check_id: opts.check_id,
				session_id: opts.session_id,
				file: opts.file,
				outcome_signal: opts.signal,
				outcome_reason: opts.reason,
				fire_ts: opts.fire_ts,
			},
			opts.cwd ?? process.cwd(),
		);
	} catch (e) {
		void e;
	}
}

/** Record a harness_missed recurrence — a pattern that recurred without
 *  any rule firing. v1 surface is manual: the user runs `interlinked
 *  recurrence flag <signature>` after noticing a repeated mistake the
 *  harness didn't catch. v2 will detect from git-history heuristics
 *  (e.g., "same function reverted N times in M sessions"); the v2 hook
 *  lands here, calling this function once per detected pattern. */
export function recordHarnessMissed(opts: {
	signature: string;
	check_id?: string | undefined;
	file?: string | undefined;
	message?: string | undefined;
	cwd?: string | undefined;
	ts?: string | undefined;
}): void {
	recordRecurrenceEvent(
		{
			ts: opts.ts ?? new Date().toISOString(),
			kind: "harness_missed",
			check_id: opts.check_id,
			file: opts.file,
			signature: opts.signature,
			message: opts.message,
		},
		opts.cwd ?? process.cwd(),
	);
}
