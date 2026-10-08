// ===========================================
// Operator taint control — shared core
// ===========================================
//
// Why this exists: the session sensitivity label ratchets UP and never down
// (Bell-LaPadula, see taint-tracker.ts). That is the right default for a live
// session, but it has no recovery path. On 2026-10-02 session
// c698b9a9-d8f0-449f-a527-d7c3efd48402 went Confidential because a downloaded
// YouTube page carried YouTube's own public API key, and the source recorded
// for the ratchet was the opaque `<command-output>` with no detail. The
// detectors were fixed, yet the LABEL persists: the daemon re-hydrates
// `.interlinked/sessions/<id>.live.json`, so every resume of that session is
// network-blocked forever and nothing can re-judge the original evidence.
//
// This module is the inspect-and-clear core behind `interlinked harness
// taint`. It holds no I/O: the daemon handler (server/taint-control.ts), the
// snapshot-file path (taint-snapshot.ts) and the CLI (commands/harness-taint*)
// all build their views and mutations here so the three surfaces cannot
// disagree about what a level means or what clearing it does.
//
// NOT A SECURITY BOUNDARY. Clearing is gated on an interactive terminal plus a
// typed confirmation, which an agent's Bash tool call does not have. That is a
// convenience gate — exactly like every other local check in this repo (see
// skills/interlinked-harness/SKILL.md: "not a security trust boundary (it's
// local and bypassable)"). Anything that can write `.interlinked/sessions/`
// can already set any level it likes.

import {
	wireAbsentOptional,
	wireArray,
	wireBoolean,
	wireLiteral,
	wireNullable,
	wireNumber,
	wireObject,
	wireString,
} from "../lib/value-validation.js";
import { clearTaintedFiles, taintedFileCount } from "./taint-file-lineage.js";
import {
	type ActorLineageEntry,
	clearAllActorLevels,
	clearOneActorLevel,
	lineageEntries,
} from "./taint-lineage.js";
import { findTaintSetter, SENSITIVITY_ORDER } from "./taint-tracker.js";
import type {
	SensitivityLevel,
	SessionTrajectory,
	TaintSource,
	TaintTrackingConfig,
} from "./types.js";

/** Raw-socket `hook_event` the CLI uses to reach the daemon's taint control.
 *  Same control-channel shape as `HookCoverage` — one line of JSON in, one
 *  `HarnessDecision` out, the report carried in `additional_context`. */
export const TAINT_CONTROL_EVENT = "TaintControl";

/** Pseudo-path recorded for the operator's clear, so the history says WHY the
 *  level dropped instead of simply losing the ratchet. */
export const OPERATOR_CLEAR_FILE = "<operator-clear>";

/** How many trailing sources `status` reports. */
export const RECENT_SOURCE_COUNT = 5;

export type TaintControlRequest =
	| { operation: "status"; session_id?: string }
	| { operation: "clear"; session_id: string; reason: string; actor?: string };

const statusRequest = wireObject({
	operation: wireLiteral("status"),
	session_id: wireAbsentOptional(wireString),
});
const clearRequest = wireObject({
	operation: wireLiteral("clear"),
	session_id: wireString,
	reason: wireString,
	/** Clear ONE actor's level instead of the whole session (B3). */
	actor: wireAbsentOptional(wireString),
});

export function isTaintControlRequest(raw: unknown): raw is TaintControlRequest {
	return statusRequest(raw) || clearRequest(raw);
}

/** The source that set the level, plus whether that attribution is proven
 *  (`escalated` flag present) or inferred from a pre-flag snapshot. */
export interface TaintSetterView {
	file: string;
	level: SensitivityLevel;
	at_step: number;
	detail: string | null;
	inferred: boolean;
}

/** Where a view was read from. A daemon-memory view is the state actually
 *  governing tool calls right now; a snapshot view is what the next resume
 *  would hydrate. */
export type TaintViewOrigin = "daemon-memory" | "live-snapshot";

export interface TaintSessionView {
	session_id: string;
	agent_name: string | null;
	sensitivity_level: SensitivityLevel;
	/** `null` means unlimited (`Infinity`, which JSON cannot carry). */
	step_limit: number | null;
	network_block_at: SensitivityLevel;
	network_blocked: boolean;
	set_by: TaintSetterView | null;
	source_count: number;
	recent_sources: TaintSource[];
	origin: TaintViewOrigin;
	/** Per-actor levels, root first (B3). Absent when the carrier has no
	 *  per-actor data: a snapshot written before the lineage existed, where
	 *  every actor reads the session level. */
	actors?: ActorLineageEntry[];
	/** Files a tainted actor wrote in this session (B5). */
	tainted_files?: number;
}

export interface TaintClearOutcome {
	session_id: string;
	previous_level: SensitivityLevel;
	previous_step_limit: number | null;
	new_level: SensitivityLevel;
	new_step_limit: number | null;
	/** The source that had set the previous level, for the audit row. */
	set_by: string;
	set_by_inferred: boolean;
	reason: string;
	applied_to: TaintViewOrigin[];
}

export interface TaintControlReport {
	ok: boolean;
	reason?: string;
	session?: TaintSessionView;
	sessions?: TaintSessionView[];
	cleared?: TaintClearOutcome;
}

/** `Infinity` is not representable in JSON; the snapshot codec already uses
 *  `null` for it, so every surface here does the same. */
export function finiteOrNull(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

export function networkBlockedAt(level: SensitivityLevel, blockAt: SensitivityLevel): boolean {
	return SENSITIVITY_ORDER[level] >= SENSITIVITY_ORDER[blockAt];
}

function setterView(
	sources: readonly TaintSource[],
	level: SensitivityLevel,
): TaintSetterView | null {
	const found = findTaintSetter(sources, level);
	if (!found) return null;
	return {
		file: found.source.file,
		level: found.source.level,
		at_step: found.source.at_step,
		detail: found.source.detail ?? null,
		inferred: found.inferred,
	};
}

/** The taint facts any carrier (live session or parsed snapshot) can supply. */
export interface TaintViewInput {
	session_id: string;
	agent_name: string | null;
	sensitivity_level: SensitivityLevel;
	step_limit: number | null;
	sources: readonly TaintSource[];
	config: TaintTrackingConfig;
	origin: TaintViewOrigin;
	actors?: ActorLineageEntry[] | undefined;
	tainted_files?: number | undefined;
}

/** One view builder, so the daemon and the snapshot-file path cannot render
 *  the same state differently. */
export function buildTaintView(input: TaintViewInput): TaintSessionView {
	const { config, sources } = input;
	return {
		session_id: input.session_id,
		agent_name: input.agent_name,
		sensitivity_level: input.sensitivity_level,
		step_limit: input.step_limit,
		network_block_at: config.network_block_at,
		network_blocked: networkBlockedAt(input.sensitivity_level, config.network_block_at),
		set_by: setterView(sources, input.sensitivity_level),
		source_count: sources.length,
		recent_sources: sources.slice(-RECENT_SOURCE_COUNT),
		origin: input.origin,
		...(input.actors ? { actors: input.actors } : {}),
		...(input.tainted_files === undefined ? {} : { tainted_files: input.tainted_files }),
	};
}

export function viewFromSession(
	session: SessionTrajectory,
	config: TaintTrackingConfig,
): TaintSessionView {
	return buildTaintView({
		session_id: session.session_id,
		agent_name: session.agent_name || null,
		sensitivity_level: session.sensitivity_level,
		step_limit: finiteOrNull(session.step_limit),
		sources: session.taint_sources,
		config,
		origin: "daemon-memory",
		actors: lineageEntries(session),
		tainted_files: taintedFileCount(session),
	});
}

/** The marker appended to `taint_sources` when an operator clears a level.
 *  The history is never truncated — a cleared session still shows every
 *  source that was recorded, with the clear as the newest entry. */
export function operatorClearSource(reason: string, atStep: number): TaintSource {
	return {
		file: OPERATOR_CLEAR_FILE,
		level: "Public",
		at_step: atStep,
		provenance: "local_read",
		detail: reason,
	};
}

/** Lower a live session to Public in place, reset its step limit from config,
 *  and append the clear marker. Returns the pre-clear facts for the audit
 *  row; the caller records where it applied them. */
export function clearSessionTaint(
	session: SessionTrajectory,
	config: TaintTrackingConfig,
	reason: string,
): Omit<TaintClearOutcome, "applied_to"> {
	const previousLevel = session.sensitivity_level;
	const previousStepLimit = finiteOrNull(session.step_limit);
	const setter = setterView(session.taint_sources, previousLevel);
	session.sensitivity_level = "Public";
	session.step_limit = config.step_limits.Public;
	// Every actor and every file a tainted actor wrote: a clear that left one
	// actor or one file above Public would re-ratchet the session immediately.
	clearAllActorLevels(session);
	clearTaintedFiles(session);
	session.taint_sources.push(operatorClearSource(reason, session.tool_call_count));
	return {
		session_id: session.session_id,
		previous_level: previousLevel,
		previous_step_limit: previousStepLimit,
		new_level: "Public",
		new_step_limit: finiteOrNull(config.step_limits.Public),
		set_by: setter?.file ?? "unknown",
		set_by_inferred: setter?.inferred ?? false,
		reason,
	};
}

export type ActorClearResult =
	| { ok: true; previous_level: SensitivityLevel; files_dropped: number }
	| { ok: false; reason: string };

/**
 * Clear ONE actor's level (B3), leaving the session level and every other
 * actor alone, and drop the files that actor tainted. Refuses the root and an
 * unknown actor: the root level IS the session level, so lowering it is the
 * whole-session clear.
 */
export function clearActorTaint(
	session: SessionTrajectory,
	actor: string,
	reason: string,
): ActorClearResult {
	const previous = clearOneActorLevel(session, actor);
	if (previous === null) {
		return {
			ok: false,
			reason: `${actor} is not a registered subagent of ${session.session_id} — clear the session to lower its root level`,
		};
	}
	if (previous === "Public") return { ok: false, reason: `Actor ${actor} is already Public` };
	const filesDropped = clearTaintedFiles(session, actor);
	session.taint_sources.push({ ...operatorClearSource(reason, session.tool_call_count), actor });
	return { ok: true, previous_level: previous, files_dropped: filesDropped };
}

// ===========================================
// Wire validators for the report
// ===========================================
// The CLI parses the report out of a `HarnessDecision.additional_context`
// string. A daemon built before this command existed answers that event with
// a plain allow and no context, so the CLI must be able to tell "this is not a
// taint report" from "this is one" and fall back to the snapshot file instead
// of rendering an empty level.

const SENSITIVITY = wireLiteral("Public", "Internal", "Confidential", "HighlyConfidential");

const isTaintSetterView = wireObject<TaintSetterView>({
	file: wireString,
	level: SENSITIVITY,
	at_step: wireNumber,
	detail: wireNullable(wireString),
	inferred: wireBoolean,
});

const isTaintSource = wireObject<TaintSource>({
	file: wireString,
	level: SENSITIVITY,
	at_step: wireNumber,
	provenance: wireLiteral(
		"fetched_external",
		"mcp_remote",
		"document_content",
		"user_provided",
		"local_read",
	),
	escalated: wireAbsentOptional(wireBoolean),
	detail: wireAbsentOptional(wireString),
	actor: wireAbsentOptional(wireString),
});

const isActorLineageEntry = wireObject<ActorLineageEntry>({
	actor: wireString,
	parent: wireNullable(wireString),
	level: SENSITIVITY,
	spawned_at: wireNullable(wireNumber),
});

const isTaintSessionView = wireObject<TaintSessionView>({
	session_id: wireString,
	agent_name: wireNullable(wireString),
	sensitivity_level: SENSITIVITY,
	step_limit: wireNullable(wireNumber),
	network_block_at: SENSITIVITY,
	network_blocked: wireBoolean,
	set_by: wireNullable(isTaintSetterView),
	source_count: wireNumber,
	recent_sources: wireArray(isTaintSource),
	origin: wireLiteral("daemon-memory", "live-snapshot"),
	// Absent-optional on purpose: a daemon built before the lineage existed
	// answers without them, and its report must still parse.
	actors: wireAbsentOptional(wireArray(isActorLineageEntry)),
	tainted_files: wireAbsentOptional(wireNumber),
});

const isTaintClearOutcome = wireObject<TaintClearOutcome>({
	session_id: wireString,
	previous_level: SENSITIVITY,
	previous_step_limit: wireNullable(wireNumber),
	new_level: SENSITIVITY,
	new_step_limit: wireNullable(wireNumber),
	set_by: wireString,
	set_by_inferred: wireBoolean,
	reason: wireString,
	applied_to: wireArray(wireLiteral("daemon-memory", "live-snapshot")),
});

export const isTaintControlReport = wireObject<TaintControlReport>({
	ok: wireBoolean,
	reason: wireAbsentOptional(wireString),
	session: wireAbsentOptional(isTaintSessionView),
	sessions: wireAbsentOptional(wireArray(isTaintSessionView)),
	cleared: wireAbsentOptional(isTaintClearOutcome),
});

export function unknownSessionReport(sessionId: string): TaintControlReport {
	return {
		ok: false,
		reason: `Unknown session ${sessionId}: no live daemon state and no .interlinked/sessions/${sessionId}.live.json`,
	};
}
