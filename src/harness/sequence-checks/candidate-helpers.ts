// Shared helpers for sequence detectors: candidate-event accessors, the
// confidential-sensitivity set, and the declared-plan tool-hint predicate.
//
// These lived as byte-identical copies in `injection.ts`, `security.ts`, and
// `quality.ts`. They carry no family-specific meaning — a Bash candidate is a
// Bash candidate in every family — so they collapse to one definition here.

import { actorKeyOf } from "../session-state-mutators.js";
import { actorLevel } from "../taint-lineage.js";
import type { HarnessEvent, SensitivityLevel, SessionTrajectory, TaintSource } from "../types.js";

/** Sensitivity levels that count as "sensitive data is in flight". */
export const CONFIDENTIAL_LEVELS: ReadonlySet<SensitivityLevel> = new Set<SensitivityLevel>([
	"Confidential",
	"HighlyConfidential",
]);

/**
 * The sensitivity in flight for the actor making THIS tool call (B3). A
 * subagent's calls arrive under the parent session id, so the session field is
 * the max over every actor and would block a clean concurrent sibling for
 * another actor's read (session c698b9a9: 41 actors). The lineage keeps the
 * acting actor's own level; an unknown actor reads the session level.
 */
export function candidateSensitivity(
	trajectory: Readonly<SessionTrajectory>,
	candidate: Readonly<HarnessEvent>,
): SensitivityLevel {
	return actorLevel(trajectory, actorKeyOf(candidate, trajectory));
}

/**
 * Taint sources that count as evidence for the acting actor: the ones no actor
 * was recorded for (a session-wide ratchet, and every pre-lineage snapshot)
 * plus the actor's own. A source recorded for a DIFFERENT actor is excluded —
 * if it also raised this actor, `candidateSensitivity` already says so.
 */
export function candidateTaintSources(
	trajectory: Readonly<SessionTrajectory>,
	candidate: Readonly<HarnessEvent>,
): TaintSource[] {
	const actor = actorKeyOf(candidate, trajectory);
	return trajectory.taint_sources.filter((s) => s.actor === undefined || s.actor === actor);
}

/** Extract the Bash command string from a candidate's tool input, or "". */
export function getCommand(toolInput: { command?: unknown } | undefined): string {
	if (!toolInput) return "";
	const cmd = toolInput.command;
	return typeof cmd === "string" ? cmd : "";
}

/** True when the candidate event is a Bash tool call. */
export function isBashCandidate(toolName: string | undefined): boolean {
	return toolName === "Bash";
}

/**
 * True when the candidate tool is consistent with the declared plan's tool
 * hints. Absent plan, absent hints, or an absent candidate tool all read as
 * "no divergence evidence", so the predicate returns true.
 */
export function planHintsContainTool(
	candidateTool: string | undefined,
	plan: { steps?: ReadonlyArray<{ tool_hint?: string }> } | undefined,
): boolean {
	const hints = plan?.steps
		?.map((s) => s.tool_hint)
		.filter((h): h is string => typeof h === "string" && h.length > 0);
	if (!hints || hints.length === 0) return true;
	if (!candidateTool) return true;
	const normalized = candidateTool.toLowerCase();
	return hints.some((h) => h.toLowerCase() === normalized);
}
