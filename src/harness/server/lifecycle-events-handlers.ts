import { readOptionalToolString } from "../evaluator/tool-input-values.js";
// interlinked-tdd: exempt
// ===========================================
// Lifecycle event handlers — leaf helpers
// ===========================================
// Extracted from lifecycle-events.ts (2026-06 line-cap decomposition) to keep
// the dispatcher module under the per-file line cap. These are leaf helpers —
// the subagent-parent resolver, the SubagentStop handler, the Skill
// enter/leave/list handlers, and the UserPromptSubmit URL-stashing helpers.
// None depend on module-private state in lifecycle-events.ts; the dispatcher
// imports them back. Behavior is byte-identical to the original inline code.

import type { CohortManager } from "../cohort.js";
import {
	getActiveSkills,
	recordSkillEnter,
	recordSkillLeave,
	type SessionTracker,
} from "../session-state.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Allowed `SkillEnter.source` values forwarded by the CLI / hook. Anything
 *  else degrades to "cli" (the default origin). */
const SKILL_SOURCE_HOOK = "hook";
const SKILL_SOURCE_MANUAL = "manual";

/**
 * Resolve the parent session_id for a SubagentStop event so the subagent's
 * verification signals can be rolled up into the parent's trajectory.
 * Subagent tool calls arrive under the subagent's own session_id, so the
 * parent linkage has to be reconstructed: the cohort records each
 * subagent's `parent_agent` (a name); resolve that name back to a session.
 * Falls through several shapes because runners populate the linkage
 * inconsistently. Returns undefined when no parent session can be found —
 * the caller then simply skips the roll-up (no worse than before).
 */
export function resolveParentSessionId(
	event: HarnessEvent,
	cohort: CohortManager,
	sessions: SessionTracker,
): string | undefined {
	const ti = event.tool_input;
	const subName =
		event.subagent_id ||
		event.agent_name ||
		(typeof ti?.subagent_id === "string" ? ti.subagent_id : undefined) ||
		(typeof ti?.agent_id === "string" ? ti.agent_id : undefined);
	const parentName =
		(subName ? cohort.findAgentByIdentity(subName)?.parent_agent : undefined) ??
		event.parent_agent ??
		(typeof ti?.parent_agent_name === "string" ? ti.parent_agent_name : undefined) ??
		(typeof ti?.parent_agent === "string" ? ti.parent_agent : undefined);
	if (!parentName) return undefined;
	// parentName is normally an agent name — map it back to a session_id.
	const byAgent = cohort.findAgentByIdentity(parentName)?.session_id;
	if (byAgent && sessions.get(byAgent)) return byAgent;
	// Some runners pass the parent session_id directly as the linkage value.
	if (sessions.get(parentName)) return parentName;
	return undefined;
}

/** SubagentStop — cohort tracking + verification-signal rollup into the
 *  parent session so the parent's Stop nudge doesn't false-positive when
 *  the agent delegated testing/verification to a subagent. */
export function handleSubagentStop(ctx: ServerRuntime, event: HarnessEvent): void {
	const { cohort, sessions, log } = ctx;
	cohort.subagentLeft(event);
	const parentSessionId = resolveParentSessionId(event, cohort, sessions);
	if (
		parentSessionId &&
		sessions.rollUpVerificationSignals(event.session_id, parentSessionId)
	) {
		log(`Subagent verification rolled up into parent session ${parentSessionId}`);
	}
	// File-tracking rollup (PB&J item #7) — merges subagent's files_written
	// into parent so the git-session-scope-gate doesn't refuse a parent's
	// `git commit` for files its subagent legitimately wrote.
	if (parentSessionId && sessions.rollUpFileTracking(event.session_id, parentSessionId)) {
		log(`Subagent file-tracking rolled up into parent session ${parentSessionId}`);
	}
	log(`Subagent left: ${event.agent_name || "unnamed"}`);
}

/** SkillEnter — record a skill as active in the target session(s). When
 *  `event.session_id` is set the change is scoped; otherwise it broadcasts
 *  to every live session (CLI-driven enable-everywhere). */
export function handleSkillEnter(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): HarnessDecision {
	const { sessions, log } = ctx;
	const name = readOptionalToolString(event.tool_input?.name)?.trim();
	if (!name) {
		return { decision: "allow", warnings: ["SkillEnter: missing tool_input.name"] };
	}
	const ttlRaw = event.tool_input?.ttl_seconds;
	const ttl = typeof ttlRaw === "number" && Number.isFinite(ttlRaw) ? ttlRaw : undefined;
	const sourceRaw = readOptionalToolString(event.tool_input?.source);
	const source: "cli" | "hook" | "manual" =
		sourceRaw === SKILL_SOURCE_HOOK || sourceRaw === SKILL_SOURCE_MANUAL
			? sourceRaw
			: "cli";
	const targetSessions = event.session_id ? [session] : sessions.getAll();
	let count = 0;
	for (const target of targetSessions) {
		recordSkillEnter(target, {
			name,
			...(ttl !== undefined ? { ttl_seconds: ttl } : {}),
			source,
		});
		count++;
	}
	log(`SkillEnter: ${name} (${source}, ${count} session${count === 1 ? "" : "s"})`);
	return { decision: "allow" };
}

/** SkillLeave — drop a skill from the target session(s). Same broadcast
 *  semantics as SkillEnter. */
export function handleSkillLeave(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): HarnessDecision {
	const { sessions, log } = ctx;
	const name = readOptionalToolString(event.tool_input?.name)?.trim();
	if (!name) {
		return { decision: "allow", warnings: ["SkillLeave: missing tool_input.name"] };
	}
	const targetSessions = event.session_id ? [session] : sessions.getAll();
	let removed = 0;
	for (const target of targetSessions) {
		if (recordSkillLeave(target, name)) removed++;
	}
	log(`SkillLeave: ${name} (removed from ${removed} session${removed === 1 ? "" : "s"})`);
	return { decision: "allow" };
}

/** SkillList — serialize active skills across the target session(s) into
 *  `additional_context` for the CLI to parse. `additional_context` is the
 *  only string-typed escape hatch on HarnessDecision; the CLI parses it
 *  as JSON. Acceptable because the caller is `interlinked skill list`,
 *  not an agent hook. */
export function handleSkillList(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): HarnessDecision {
	const { sessions } = ctx;
	const targetSessions = event.session_id ? [session] : sessions.getAll();
	const collected = targetSessions.map((target) => ({
		session_id: target.session_id,
		agent_name: target.agent_name,
		skills: getActiveSkills(target),
	}));
	return {
		decision: "allow",
		additional_context: JSON.stringify(collected),
	};
}
