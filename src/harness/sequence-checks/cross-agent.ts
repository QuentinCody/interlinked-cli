// Cross-agent staleness sequence detectors. Multi-player coordination
// shapes that fire when another agent has touched a file under the
// same workspace, exposed via `loadRecentWorkspaceEvents` reading
// `.interlinked/activity.jsonl`. Per the design doc
// (`trajectory-sequence-detectors.md` §§3.4, 3.6, 3.10), this family
// is the single point where sequence-detector logic crosses the
// per-session in-memory model — the cross-session reader is bounded
// (trailing 500 events) and cached so dispatch stays sub-10ms.
//
// Detectors exported below: see each detector's `id` field for the
// snake-case identifier surfaced to agents and config.

import { isAbsolute, resolve } from "node:path";

import {
	loadRecentWorkspaceEvents,
	type WorkspaceActivityEvent,
} from "../cross-session.js";
import type { SessionTrajectory } from "../types.js";
import type { SequenceDetector, SequenceMatch } from "./types.js";

/** Canonicalize a file path against `cwd` so the trajectory's
 *  dual-stored raw + absolute entries (see session-state.ts) collapse to
 *  one key. */
function canonicalKey(path: string, cwd: string): string {
	if (!path) return "";
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Tool names that constitute a write/edit operation in our model. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit"]);

/** Window for subagent_diverged_edit: parent and other-agent writes within
 *  this span (measured backward from now) count as concurrent. */
const SUBAGENT_DIVERGENCE_WINDOW_MS = 30 * 60 * 1000;

/** Window for file_overwrite_after_other_agent: another agent's write
 *  within this span counts as "still recent enough to matter". */
const OVERWRITE_RECENT_WINDOW_MS = 60 * 60 * 1000;

/** Indirection over `Date.now()` so tests using `vi.setSystemTime`
 *  control the clock cleanly. Production: returns wall-clock ms. */
function now(): number {
	return Date.now();
}

function isWriteCandidate(toolName: string | undefined): boolean {
	return typeof toolName === "string" && WRITE_TOOLS.has(toolName);
}

function getFilePath(toolInput: { file_path?: unknown } | undefined): string {
	if (!toolInput) return "";
	const fp = toolInput.file_path;
	return typeof fp === "string" ? fp : "";
}

/** Stable file-path key for cross-session comparison. The hook writes
 *  whatever the agent passed verbatim (raw or absolute); we compare on
 *  both forms because the trajectory tracker stores both (see
 *  `session-state.ts::recordEvent`). */
function fileMatches(eventFile: string, targetFile: string): boolean {
	if (!eventFile || !targetFile) return false;
	if (eventFile === targetFile) return true;
	// Tail-match (one side absolute, the other relative).
	if (eventFile.endsWith(targetFile)) return true;
	if (targetFile.endsWith(eventFile)) return true;
	return false;
}

/** Extract the file_path from a workspace activity event's tool_input, returning ""
 *  when the event has no path (Bash, etc.). */
function eventFilePath(ev: WorkspaceActivityEvent): string {
	return getFilePath(ev.tool_input);
}

/** Compare ISO timestamps lexicographically — safe because they're
 *  RFC-3339 / ISO-8601 and all in the same Z-suffixed UTC form. */
function isAfter(a: string, b: string): boolean {
	if (!a || !b) return false;
	return a > b;
}

/**
 * True when a workspace activity row was written by a genuinely different
 * ACTOR than the trajectory under evaluation — the only case these
 * detectors should treat as "another agent".
 *
 * Root cause (found 2026-09-02, ~30 false positives across a 105-agent
 * campaign): a subagent's tool calls land in `activity.jsonl` under the
 * PARENT session id, but each row's `agent_name` is the subagent's own
 * per-call hash (e.g. `a24a6a5628eeba5b3`), not the parent's. Both
 * detectors compared `agent_name` alone, so a subagent's own prior write —
 * same session, different `agent_name` — read as "another agent wrote it".
 * `agent_name` is the identity that differs; `session_id` is the identity
 * that is shared. A same `session_id` is therefore self regardless of
 * `agent_name`. Same `agent_name` is still self too (legacy rule, kept for
 * activity rows with no `session_id`).
 */
function isOtherAgent(
	ev: WorkspaceActivityEvent,
	trajectory: Readonly<SessionTrajectory>,
): boolean {
	if (!ev.agent_name) return false;
	if (ev.agent_name === trajectory.agent_name) return false;
	if (ev.session_id && trajectory.session_id && ev.session_id === trajectory.session_id) {
		return false;
	}
	return true;
}

/** True when `ev` is a write to `filePath` performed by an actor other than
 *  the trajectory under evaluation. The three-way test (write tool, other
 *  actor, same file) shared by the two cross-session scans below. */
function isOtherAgentWriteTo(
	ev: WorkspaceActivityEvent,
	filePath: string,
	trajectory: Readonly<SessionTrajectory>,
): boolean {
	if (!ev.tool_name || !WRITE_TOOLS.has(ev.tool_name)) return false;
	if (!isOtherAgent(ev, trajectory)) return false;
	return fileMatches(eventFilePath(ev), filePath);
}

/** Every other-agent write to `filePath` whose timestamp is after
 *  `trajectory.started_at`, in event order. */
function otherAgentWritesSinceStart(
	events: readonly WorkspaceActivityEvent[],
	filePath: string,
	trajectory: Readonly<SessionTrajectory>,
): WorkspaceActivityEvent[] {
	const offending: WorkspaceActivityEvent[] = [];
	for (const ev of events) {
		if (!isOtherAgentWriteTo(ev, filePath, trajectory)) continue;
		if (!isAfter(ev.timestamp, trajectory.started_at)) continue;
		offending.push(ev);
	}
	return offending;
}

/** The most recent other-agent write to `filePath` at or after
 *  `windowStartMs`, scanning newest-first; `null` when there is none. */
function latestOtherAgentWriteInWindow(
	events: readonly WorkspaceActivityEvent[],
	filePath: string,
	trajectory: Readonly<SessionTrajectory>,
	windowStartMs: number,
): WorkspaceActivityEvent | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (!ev) continue;
		if (!isOtherAgentWriteTo(ev, filePath, trajectory)) continue;
		const evMs = Date.parse(ev.timestamp);
		if (Number.isNaN(evMs) || evMs < windowStartMs) continue;
		return ev;
	}
	return null;
}

// ============================================================
// §3.4 stale_read_then_write (pre_warn)
// ============================================================

/**
 * Fires when the candidate is a Write/Edit to a file the session has
 * read AND `activity.jsonl` shows another agent (different `agent_name`)
 * wrote the same file after this session's `started_at`. Approximation
 * of the design-doc shape: rather than tracking per-read ISO timestamps,
 * we anchor on the session start — any other-agent write later than
 * `started_at` is "newer than the session's view of the file" because
 * the read must have happened during the session, i.e. after start.
 *
 * Why pre_warn: the operator may have intentionally accepted the
 * other agent's edit. Warning gives the agent a chance to re-read
 * before overwriting.
 */
export const staleReadThenWrite: SequenceDetector = {
	id: "stale_read_then_write",
	description:
		"Write/Edit to a file another agent wrote since this session started, without a re-read",
	family: "cross-agent",
	phase: "pre_warn",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		if (!isWriteCandidate(candidate.tool_name)) return [];
		const filePath = getFilePath(candidate.tool_input);
		if (!filePath) return [];
		if (!trajectory.files_read.has(filePath)) return [];
		const cwd = candidate.cwd;
		if (!cwd) return [];
		const events = loadRecentWorkspaceEvents(cwd, trajectory.started_at);
		const offending = otherAgentWritesSinceStart(events, filePath, trajectory);
		if (offending.length === 0) return [];
		// "No re-read since": file_read_at stores tool_call_count of the
		// most recent read. We can't time-correlate it directly; the
		// pragmatic check is that the session still considers its read
		// authoritative — i.e., no later read step exists. Since the Map
		// only holds the last read, a re-read would update the entry but
		// not the offending-agent-write timestamp. Treat presence in
		// files_read AND an other-agent write after started_at as the
		// stale shape, per the spec's simplification.
		const last = offending.at(-1);
		if (!last) return [];
		const otherAgent = last.agent_name ?? "another agent";
		const match: SequenceMatch = {
			prior_event_count: offending.length,
			prior_summary: `${otherAgent} wrote ${filePath} at ${last.timestamp}`,
			message:
				`About to write ${filePath}, but ${otherAgent} wrote it ${offending.length} time(s) ` +
				`since this session started (${trajectory.started_at}). Your in-session read is stale. ` +
				"Re-read the file before overwriting, or acknowledge with " +
				"`// interlinked: defer stale_read_then_write -- <reason>`.",
			evidence: [filePath, last.timestamp],
		};
		return [match];
	},
};

// ============================================================
// §3.6 subagent_diverged_edit (stop)
// ============================================================

/**
 * Coarse Stop-phase approximation of the design-doc §3.6 shape. Per the
 * task spec: fire when a file appears in BOTH `trajectory.files_written`
 * AND a recent (within the last 30 minutes, measured from "now") write
 * by a different `agent_name` in `loadRecentWorkspaceEvents`. This is a
 * conservative proxy for "parent and subagent both wrote X without
 * coordination" — the precise version (per `SubagentStop` event + read-
 * write time ordering) is a follow-up.
 *
 * Why stop: prevents the "parent applies stale edits over subagent's
 * work" pattern at end-of-turn rather than every PreToolUse, keeping
 * the dispatch hot-path cheap.
 */
/** One `trajectory.files_written` entry's worth of the `subagentDivergedEdit`
 *  loop body, extracted to keep the detector flat. Returns the match for
 *  the first qualifying `events` row (mirrors the original inner-loop
 *  `break`), or `null` when the file was already reported or no event
 *  qualifies (mirrors the original `continue`s). Mutates `reportedFiles`
 *  on a hit, same as the original inline loop did. */
function findDivergedEditForFile(
	filePath: string,
	cwd: string,
	trajectory: Readonly<SessionTrajectory>,
	events: readonly WorkspaceActivityEvent[],
	windowStartMs: number,
	reportedFiles: Set<string>,
): SequenceMatch | null {
	const key = canonicalKey(filePath, cwd);
	if (reportedFiles.has(key)) return null;
	for (const ev of events) {
		if (!ev.tool_name || !WRITE_TOOLS.has(ev.tool_name)) continue;
		if (!ev.agent_name || ev.agent_name === trajectory.agent_name) continue;
		if (!fileMatches(eventFilePath(ev), filePath)) continue;
		const evMs = Date.parse(ev.timestamp);
		if (Number.isNaN(evMs)) continue;
		if (evMs < windowStartMs) continue;
		const otherAgent = ev.agent_name ?? "another agent";
		reportedFiles.add(key);
		return {
			prior_event_count: 1,
			prior_summary: `${otherAgent} wrote ${filePath} at ${ev.timestamp}`,
			message:
				`Both this session and ${otherAgent} wrote ${filePath} in the last 30 minutes. ` +
				"Coarse proxy for parent/subagent divergence — verify the final on-disk state " +
				"matches intent, or acknowledge with " +
				"`// interlinked: defer subagent_diverged_edit -- <reason>`.",
			evidence: [filePath, ev.timestamp],
		};
	}
	return null;
}

export const subagentDivergedEdit: SequenceDetector = {
	id: "subagent_diverged_edit",
	description:
		"File written this session was also recently written by a different agent (coarse parent/subagent divergence proxy)",
	family: "cross-agent",
	phase: "stop",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		const cwd = candidate.cwd;
		if (!cwd) return [];
		if (trajectory.files_written.size === 0) return [];
		const windowStartMs = now() - SUBAGENT_DIVERGENCE_WINDOW_MS;
		const sinceIso = new Date(windowStartMs).toISOString();
		const events = loadRecentWorkspaceEvents(cwd, sinceIso);
		const matches: SequenceMatch[] = [];
		// `files_written` stores both the raw and resolved form of every
		// path (see session-state.ts) — canonicalize so we report at most
		// one match per actual file.
		const reportedFiles = new Set<string>();
		for (const filePath of trajectory.files_written) {
			const match = findDivergedEditForFile(
				filePath,
				cwd,
				trajectory,
				events,
				windowStartMs,
				reportedFiles,
			);
			if (match) matches.push(match);
		}
		return matches;
	},
};

// ============================================================
// §3.10 file_overwrite_after_other_agent (pre_warn)
// ============================================================

/**
 * Fires when the candidate is a Write to file X AND `activity.jsonl`
 * shows another agent (different `agent_name`) wrote X in the last
 * hour AND this session has NOT read X at all. Strict superset of
 * §3.4 — fires even when the parent never read X, just is about to
 * overwrite what someone else just wrote.
 *
 * Why pre_warn: legitimate when the operator deliberately starts a new
 * agent to overwrite stale work. Block would create a friction wall
 * around multi-agent collaboration.
 */
export const fileOverwriteAfterOtherAgent: SequenceDetector = {
	id: "file_overwrite_after_other_agent",
	description:
		"Write to a file another agent wrote within the last hour, without reading it first",
	family: "cross-agent",
	phase: "pre_warn",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		if (!isWriteCandidate(candidate.tool_name)) return [];
		const filePath = getFilePath(candidate.tool_input);
		if (!filePath) return [];
		if (trajectory.files_read.has(filePath)) return [];
		const cwd = candidate.cwd;
		if (!cwd) return [];
		const windowStartMs = now() - OVERWRITE_RECENT_WINDOW_MS;
		const sinceIso = new Date(windowStartMs).toISOString();
		const events = loadRecentWorkspaceEvents(cwd, sinceIso);
		const ev = latestOtherAgentWriteInWindow(events, filePath, trajectory, windowStartMs);
		if (!ev) return [];
		const otherAgent = ev.agent_name ?? "another agent";
		return [
			{
				prior_event_count: 1,
				prior_summary: `${otherAgent} wrote ${filePath} at ${ev.timestamp}`,
				message:
					`About to write ${filePath}, but ${otherAgent} wrote it within the last hour ` +
					"and this session has not read it. Read the current contents first to confirm " +
					"the overwrite is intended, or acknowledge with " +
					"`// interlinked: defer file_overwrite_after_other_agent -- <reason>`.",
				evidence: [filePath, ev.timestamp],
			},
		];
	},
};

export const CROSS_AGENT_DETECTORS: ReadonlyArray<SequenceDetector> = [
	staleReadThenWrite,
	subagentDivergedEdit,
	fileOverwriteAfterOtherAgent,
];
