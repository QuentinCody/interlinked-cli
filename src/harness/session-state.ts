// ===========================================
// Session State — Per-session trajectory tracking
// ===========================================

import { resolve as resolvePath } from "node:path";
import type { JsonObject } from "../lib/json-types.js";

// `captureGitBaseline` lives in its own module (session-git-baseline.ts) to
// keep this file under the per-file line cap; re-exported below so existing
// `from "./session-state.js"` importers keep working unchanged.
export { captureGitBaseline } from "./session-git-baseline.js";
// Sequence-detector input population (recent_line_edits / literal_occurrences)
// lives in session-literals.ts (a line-cap split). recordEvent drives the four
// helpers below; the full set is re-exported for existing importers.
export {
	extractNonTrivialLiterals,
	extractWriteChunks,
	isPostToolUseEvent,
	isSequenceWriteOperation,
	recordLiteralOccurrences,
	recordRecentLineEdit,
} from "./session-literals.js";

// Active-skill markers live in session-skills.ts (a line-cap split). recordEvent
// drives gcExpiredSkills; the full set + SkillEnterArgs are re-exported below.
import { trackDebtEvasion } from "./debt-evasion.js";
import { gcExpiredSkills } from "./session-skills.js";

export type { SkillEnterArgs } from "./session-skills.js";
export {
	gcExpiredSkills,
	getActiveSkills,
	recordSkillEnter,
	recordSkillLeave,
} from "./session-skills.js";

// Snapshot serialize/hydrate coercion helpers live in session-snapshot-codec.ts
// (also a line-cap split). They are internal to serialize()/hydrate() and were
// never part of this module's public API, so they are imported, not re-exported.
import {
	readActiveSkills,
	readAssertionCountsMap,
	readBoolean,
	readCapturedPlan,
	readConsecutivePattern,
	readFailedFiles,
	readGitSessionBaseline,
	readNumber,
	readNumberArray,
	readNumberMap,
	readNumberRecord,
	readObservedChecks,
	readPendingCompletions,
	readSensitivity,
	readString,
	readStringArray,
	readStringMap,
	readStringSet,
	readStubsIntroduced,
	readTaintSources,
	readTddCycles,
	readTestRuns,
	readWarnings,
	serializeCapturedPlan,
} from "./session-snapshot-codec.js";
// Per-event trajectory mutators + session-ack helpers live in
// session-state-mutators.ts (a line-cap split). The SessionTracker class below
// drives them; acknowledgeChecks/isAcknowledged are re-exported because external
// consumers (post-tool-file-checks*) import them from this module.
import {
	appendStubsCapped,
	createFreshSession,
	mergeObservedChecks,
	mergeVerificationObserved,
	trackCommand,
	trackErrorOutcome,
	trackFileOperations,
	trackToolCall,
} from "./session-state-mutators.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

export { acknowledgeChecks, isAcknowledged } from "./session-state-mutators.js";

/** Bumped when the serialized snapshot shape changes incompatibly. Hydrate
 *  refuses snapshots from a higher version (newer harness wrote it) and
 *  best-effort upgrades older shapes. */
export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1;

/** Phase 1 Channel 5 (rollback feasibility) provenance check. Returns true
 *  iff the session has a successful write to this exact file in its trajectory.
 *  Path-shape agnostic: matches whether the caller passes the raw form (as the
 *  runner originally sent it) or the resolved absolute form. Without this, the
 *  rollback channel would either miss legitimate edits (when stored shape !=
 *  lookup shape) or attribute the user's own changes to Interlinked. */
export function isFileTrackedAsWritten(
	session: SessionTrajectory,
	filePath: string,
	cwd?: string,
): boolean {
	if (session.files_written.has(filePath)) return true;
	const baseCwd = cwd ?? process.cwd();
	const absPath = resolvePath(baseCwd, filePath);
	return session.files_written.has(absPath);
}

export class SessionTracker {
	private sessions: Map<string, SessionTrajectory> = new Map();
	/** G3 per-session event-ordinal high-water marks. Kept beside (not on) the
	 *  trajectory: the ordinal is daemon-observation state, and
	 *  types/session.ts sits at the line cap. Serialized as `last_seq`. */
	private seqCounters: Map<string, number> = new Map();

	get(sessionId: string): SessionTrajectory | undefined {
		return this.sessions.get(sessionId);
	}

	/** G3 (docs/design/reproducibility/g3-event-ordinal.md): mint the next
	 *  per-session event ordinal. Every event the daemon observes increments —
	 *  serial observation IS the canonical total order; `ts` is ms-precision
	 *  and collides for parallel calls. Rides serialize()/hydrate() as
	 *  `last_seq` so a daemon restart continues the sequence, never reuses. */
	nextSeq(sessionId: string): number {
		const next = (this.seqCounters.get(sessionId) ?? 0) + 1;
		this.seqCounters.set(sessionId, next);
		return next;
	}

	recordEvent(event: HarnessEvent): SessionTrajectory {
		const session = this.getOrCreateSession(event);

		// Update agent name if resolved later (e.g., after register_agent)
		if (event.agent_name && session.agent_name.startsWith("session-")) {
			session.agent_name = event.agent_name;
		}

		trackToolCall(session, event);
		trackErrorOutcome(session, event);
		trackFileOperations(session, event);
		trackCommand(session, event);
		trackDebtEvasion(session, event);

		gcExpiredSkills(session);

		return session;
	}

	/**
	 * Look up the session for this event, creating (and registering) a fresh
	 * trajectory on first sight. Defensive: events without a session_id (some
	 * SessionStart variants, malformed probes) get a synthesized fallback id
	 * rather than crashing — a dropped trajectory beats a dead harness that
	 * fails open on the next PreToolUse scan.
	 */
	private getOrCreateSession(event: HarnessEvent): SessionTrajectory {
		const sessionId = event.session_id || `unknown-${Date.now().toString(36)}`;
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const session = createFreshSession(event, sessionId);
		this.sessions.set(sessionId, session);
		return session;
	}

	remove(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.seqCounters.delete(sessionId);
	}

	/**
	 * Roll the verification-related signals of one session (typically a
	 * subagent's) into another (its parent). Called at SubagentStop so a
	 * parent's Stop nudge doesn't false-positive ("no verification this
	 * session", "no tests run") when the agent delegated testing or
	 * verification to a subagent — exactly the test-runner-subagent pattern
	 * the agentic-engineering-patterns guide recommends.
	 *
	 * Merges `verification_observed` (set union), `test_runs` and
	 * `tdd_cycles` (gap-fill only — the parent's own entry for a file is
	 * newer and authoritative, never clobbered), and `stubs_introduced`
	 * (append, capped). Returns true when both sessions exist and distinct.
	 */
	rollUpVerificationSignals(fromSessionId: string, toSessionId: string): boolean {
		if (fromSessionId === toSessionId) return false;
		const from = this.sessions.get(fromSessionId);
		const to = this.sessions.get(toSessionId);
		if (!from || !to) return false;

		mergeVerificationObserved(from, to);

		// Gap-fill only: a run/cycle the parent already tracks for a file is
		// newer than the subagent's, so never overwrite it.
		for (const [file, run] of from.test_runs) {
			if (!to.test_runs.has(file)) to.test_runs.set(file, { ...run });
		}
		for (const [file, cycle] of from.tdd_cycles) {
			if (!to.tdd_cycles.has(file)) to.tdd_cycles.set(file, { ...cycle });
		}

		mergeObservedChecks(from, to);
		appendStubsCapped(from, to);
		return true;
	}

	/**
	 * Roll a subagent's file-tracking state into its parent at SubagentStop.
	 * Parallel to {@link rollUpVerificationSignals}: verification signals and
	 * file-tracking state are independent concerns sharing a call site, so
	 * they get parallel functions rather than one monolithic rollup. The
	 * git-baseline is deliberately NOT rolled up — the parent's baseline is
	 * canonical. Without this rollup, parent agents can't legitimately commit
	 * files their subagents wrote (git-session-scope-gate would refuse).
	 *
	 * Merge semantics:
	 *  - files_written / files_read: set union (parent ∪ subagent).
	 *  - file_write_times: gap-fill (don't clobber parent's newer entries).
	 *  - file_edit_counts: sum (parent + subagent counts).
	 */
	rollUpFileTracking(fromSessionId: string, toSessionId: string): boolean {
		if (fromSessionId === toSessionId) return false;
		const from = this.sessions.get(fromSessionId);
		const to = this.sessions.get(toSessionId);
		if (!from || !to) return false;

		for (const f of from.files_written) to.files_written.add(f);
		for (const f of from.files_read) to.files_read.add(f);

		for (const [file, ts] of from.file_write_times) {
			if (!to.file_write_times.has(file)) to.file_write_times.set(file, ts);
		}

		for (const [file, count] of from.file_edit_counts) {
			to.file_edit_counts.set(file, (to.file_edit_counts.get(file) ?? 0) + count);
		}

		return true;
	}

	/**
	 * Serialize a session trajectory to a JSON-safe snapshot. Used for both
	 * the post-end `<id>.trajectory.json` archive and the in-flight
	 * `<id>.live.json` snapshot — the shape is identical and lossless against
	 * `hydrate()`. The runtime-only `trajectoryDetector` is intentionally
	 * dropped (it's lazily reconstructed on the next event when feature flags
	 * call for it). `step_limit` of `Infinity` is encoded as `null` because
	 * JSON has no Infinity literal; `hydrate()` reverses the mapping.
	 */
	serialize(sessionId: string): JsonObject | null {
		const s = this.sessions.get(sessionId);
		if (!s) return null;
		const endedAt = new Date().toISOString();
		const stepLimit = Number.isFinite(s.step_limit) ? s.step_limit : null;
		return {
			schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
			session_id: s.session_id,
			last_seq: this.seqCounters.get(sessionId) ?? 0,
			agent_name: s.agent_name,
			started_at: s.started_at,
			ended_at: endedAt,
			duration_s: Math.round(
				(new Date(endedAt).getTime() - new Date(s.started_at).getTime()) / 1000,
			),
			tool_call_count: s.tool_call_count,
			error_count: s.error_count,
			mcp_tools_used: s.mcp_tools_used,
			local_tools_used: s.local_tools_used,
			sensitivity_level: s.sensitivity_level,
			step_limit: stepLimit,
			consecutive_pattern: s.consecutive_pattern,
			last_coordination_at: s.last_coordination_at,
			last_coordination_ts: s.last_coordination_ts,
			files_read: [...s.files_read],
			files_written: [...s.files_written],
			commands_run: s.commands_run,
			test_commands_run: s.test_commands_run ?? [],
			tool_sequence: s.tool_sequence,
			curl_localhost_count: s.curl_localhost_count,
			taint_sources: s.taint_sources,
			injection_detected_steps: s.injection_detected_steps,
			pii_detected_steps: s.pii_detected_steps,
			suggested_permissions: [...s.suggested_permissions],
			acknowledged_checks: [...s.acknowledged_checks],
			fired_reminders: [...s.fired_reminders],
			soft_blocks: [...s.soft_blocks],
			silent_failure_warned: [...s.silent_failure_warned],
			bloat_warned: [...s.bloat_warned],
			...serializeSessionExtras(s),
		};
	}

	/**
	 * Reconstruct a SessionTrajectory from a `serialize()` snapshot and add it
	 * to the tracker. Used on harness restart when the next event for an
	 * already-active session arrives — without this, every restart would
	 * silently reset session-relative behavior (acknowledged checks, edit
	 * counts, fired reminders, TDD cycles, ...).
	 *
	 * Defensive: every field is coerced through a reader that falls back to
	 * the same default `recordEvent` uses for a fresh session. Returns null
	 * only on missing `session_id` (the one required field).
	 */
	hydrate(snapshot: JsonObject): SessionTrajectory | null {
		const schemaVersion = readNumber(snapshot.schema_version, 0);
		if (schemaVersion > SESSION_SNAPSHOT_SCHEMA_VERSION) return null;

		const sessionId = readString(snapshot.session_id);
		if (!sessionId) return null;

		const stepLimit =
			snapshot.step_limit === null || snapshot.step_limit === undefined
				? Number.POSITIVE_INFINITY
				: typeof snapshot.step_limit === "number" && Number.isFinite(snapshot.step_limit)
					? snapshot.step_limit
					: Number.POSITIVE_INFINITY;

		const session: SessionTrajectory = {
			session_id: sessionId,
			agent_name: readString(snapshot.agent_name) ?? `session-${sessionId.slice(0, 8)}`,
			started_at: readString(snapshot.started_at) ?? new Date().toISOString(),
			tool_call_count: readNumber(snapshot.tool_call_count, 0),
			error_count: readNumber(snapshot.error_count, 0),
			mcp_tools_used: readNumber(snapshot.mcp_tools_used, 0),
			local_tools_used: readNumber(snapshot.local_tools_used, 0),
			sensitivity_level: readSensitivity(snapshot.sensitivity_level),
			step_limit: stepLimit,
			consecutive_pattern: readConsecutivePattern(snapshot.consecutive_pattern),
			last_coordination_at: readNumber(snapshot.last_coordination_at, 0),
			last_coordination_ts: readNumber(snapshot.last_coordination_ts, Date.now()),
			files_read: readStringSet(snapshot.files_read),
			files_written: readStringSet(snapshot.files_written),
			commands_run: readStringArray(snapshot.commands_run),
			test_commands_run: readStringArray(snapshot.test_commands_run),
			tool_sequence: readStringArray(snapshot.tool_sequence),
			curl_localhost_count: readNumberRecord(snapshot.curl_localhost_count),
			taint_sources: readTaintSources(snapshot.taint_sources),
			injection_detected_steps: readNumberArray(snapshot.injection_detected_steps),
			pii_detected_steps: readNumberArray(snapshot.pii_detected_steps),
			suggested_permissions: readStringSet(snapshot.suggested_permissions),
			acknowledged_checks: readStringSet(snapshot.acknowledged_checks),
			fired_reminders: readStringSet(snapshot.fired_reminders),
			soft_blocks: readStringSet(snapshot.soft_blocks),
			silent_failure_warned: readStringSet(snapshot.silent_failure_warned),
			bloat_warned: readStringSet(snapshot.bloat_warned),
			file_write_times: readStringMap(snapshot.file_write_times),
			file_read_at: readNumberMap(snapshot.file_read_at),
			failed_files: readFailedFiles(snapshot.failed_files),
			pending_completions: readPendingCompletions(snapshot.pending_completions),
			file_edit_counts: readNumberMap(snapshot.file_edit_counts),
			warnings_issued: readWarnings(snapshot.warnings_issued),
			tdd_cycles: readTddCycles(snapshot.tdd_cycles),
			consecutive_tool_failures: readNumberMap(snapshot.consecutive_tool_failures),
			test_runs: readTestRuns(snapshot.test_runs),
			active_skills: readActiveSkills(snapshot.active_skills),
			non_doc_files_edited_since_commit: readStringSet(
				snapshot.non_doc_files_edited_since_commit,
			),
			doc_files_edited_since_commit: readNumber(snapshot.doc_files_edited_since_commit, 0),
			mid_session_nudge_emitted: readBoolean(snapshot.mid_session_nudge_emitted),
			stop_nudge_emitted: readBoolean(snapshot.stop_nudge_emitted),
			assertion_counts: readAssertionCountsMap(snapshot.assertion_counts),
			verification_observed: readStringSet(snapshot.verification_observed),
			observed_checks: readObservedChecks(snapshot.observed_checks),
			stubs_introduced: readStubsIntroduced(snapshot.stubs_introduced),
			declared_plan: readCapturedPlan(snapshot.declared_plan),
			git_session_baseline: readGitSessionBaseline(snapshot.git_session_baseline),
		};

		this.sessions.set(sessionId, session);
		this.seqCounters.set(sessionId, readNumber(snapshot.last_seq, 0));
		return session;
	}

	getAll(): SessionTrajectory[] {
		return [...this.sessions.values()];
	}

	/** Detect sessions that haven't had events in the given timeout (used for lost agent cleanup) */
	detectStale(timeoutMs: number): SessionTrajectory[] {
		const cutoff = Date.now() - timeoutMs;
		return this.getAll().filter(
			(s) => s.tool_call_count > 0 && new Date(s.started_at).getTime() < cutoff,
		);
	}
}

/**
 * The back half of `serialize()`'s field set, split into two cohesive halves
 * purely to keep `serialize` (already grandfathered over the function-token
 * cap before this split) — and each half itself — under the canonical
 * per-function token cap. No behavior change — every field here is spread
 * back into the same snapshot object `serialize` used to build inline.
 */
function serializeSessionExtras(s: SessionTrajectory): JsonObject {
	return { ...serializeSessionExtrasFileState(s), ...serializeSessionExtrasVerification(s) };
}

/** File/edit/warning-tracking half of the split `serialize()` field set. */
function serializeSessionExtrasFileState(s: SessionTrajectory): JsonObject {
	return {
		file_write_times: Object.fromEntries(s.file_write_times),
		file_read_at: Object.fromEntries(s.file_read_at),
		failed_files: Object.fromEntries(
			[...s.failed_files.entries()].map(([k, v]) => [k, { ...v }]),
		),
		pending_completions: Object.fromEntries(
			[...s.pending_completions.entries()].map(([k, v]) => [
				k,
				{ ...v, resolved_files: [...v.resolved_files] },
			]),
		),
		file_edit_counts: Object.fromEntries(s.file_edit_counts),
		warnings_issued: Object.fromEntries(
			[...s.warnings_issued.entries()].map(([k, v]) => [k, { ...v }]),
		),
		tdd_cycles: Object.fromEntries([...s.tdd_cycles.entries()].map(([k, v]) => [k, { ...v }])),
		consecutive_tool_failures: Object.fromEntries(s.consecutive_tool_failures),
		non_doc_files_edited_since_commit: s.non_doc_files_edited_since_commit
			? [...s.non_doc_files_edited_since_commit]
			: [],
		doc_files_edited_since_commit: s.doc_files_edited_since_commit ?? 0,
	};
}

/** Verification/TDD/plan/git-baseline half of the split `serialize()` field set. */
function serializeSessionExtrasVerification(s: SessionTrajectory): JsonObject {
	return {
		test_runs: Object.fromEntries([...s.test_runs.entries()].map(([k, v]) => [k, { ...v }])),
		active_skills: s.active_skills
			? Object.fromEntries([...s.active_skills.entries()].map(([k, v]) => [k, { ...v }]))
			: {},
		mid_session_nudge_emitted: s.mid_session_nudge_emitted ?? false,
		stop_nudge_emitted: s.stop_nudge_emitted ?? false,
		assertion_counts: Object.fromEntries(
			[...s.assertion_counts.entries()].map(([k, v]) => [k, { ...v }]),
		),
		verification_observed: s.verification_observed ? [...s.verification_observed] : [],
		observed_checks: s.observed_checks
			? Object.fromEntries([...s.observed_checks.entries()].map(([k, v]) => [k, { ...v }]))
			: {},
		stubs_introduced: s.stubs_introduced ? s.stubs_introduced.map((e) => ({ ...e })) : [],
		declared_plan: s.declared_plan ? serializeCapturedPlan(s.declared_plan) : null,
		git_session_baseline: s.git_session_baseline
			? {
					head_sha: s.git_session_baseline.head_sha,
					modified: [...s.git_session_baseline.modified],
					staged: [...s.git_session_baseline.staged],
					untracked: [...s.git_session_baseline.untracked],
				}
			: null,
	};
}
