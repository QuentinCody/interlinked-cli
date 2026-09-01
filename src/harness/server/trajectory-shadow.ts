// ===========================================
// Trajectory engine — shadow (metric-only) activation
// ===========================================
//
// Wires the next-gen trajectory engine (src/harness/trajectory/) into the live
// daemon in SHADOW mode: per-session TrajectoryState is held here, each tool-call
// HarnessEvent is normalized into the engine's ToolEvent, the engine runs, and
// every firing verdict — INCLUDING catalog "block"/"nudge" ones — surfaces as a
// non-blocking `[interlinked:trajectory]` stderr warning. It never mutates the
// harness decision, never blocks, and never throws (fails open). Promotion of
// individual rules to real nudge/block happens later, after they are validated
// against the Fable interactive traces.
//
// Deterministic: no IO, no clock, no randomness — the engine reads only event
// data + the content hashes the harness already computed.

import { createState, evaluateTrajectory } from "../trajectory/index.js";
import { seedReadsFromSession } from "../trajectory/rehydrate.js";
import type { ToolEvent, TrajectoryState, Verdict } from "../trajectory/types.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

/** The only config slice this module reads. `GuardRulesConfig` carries a
 *  `trajectory_shadow?` field, so `ctx.rules` satisfies this structurally and
 *  passes straight through — no full-config coupling. */
interface TrajectoryShadowConfig {
	trajectory_shadow?: { enabled: boolean };
}

/** Per-session engine state, bounded so a long-lived daemon cannot grow without
 *  limit (the engine's own collections are separately capped in state.ts). */
const stateBySession = new Map<string, TrajectoryState>();
const SESSION_CAP = 256;

/**
 * Read-only peek for Stop-time aggregates (session-rework). Never creates
 * state: a session the shadow engine never folded has nothing to aggregate.
 */
export function peekTrajectoryState(session: string): TrajectoryState | null {
	return stateBySession.get(session) ?? null;
}

/**
 * Live engine state for a session, created on first sight.
 *
 * `filesRead` rehydrates a session that outlived the previous daemon (red-team
 * F4): this map is runtime-only, so a restart zeroes it mid-session and every
 * pre-restart read is forgotten while the edit history continues — which fired
 * `reb_blind_edit_unread_file` on files the agent had read. The session's own
 * `files_read` survives in `<id>.live.json`, so seeding from it restores the
 * fact the rules need. Seeding happens ONLY on creation; a warm state is never
 * overwritten.
 */
function getState(session: string, filesRead?: readonly string[]): TrajectoryState {
	const existing = stateBySession.get(session);
	if (existing) return existing;
	if (stateBySession.size >= SESSION_CAP) {
		const oldest = stateBySession.keys().next().value;
		if (oldest !== undefined) stateBySession.delete(oldest);
	}
	const fresh = createState(session);
	if (filesRead && filesRead.length > 0) seedReadsFromSession(fresh, filesRead);
	stateBySession.set(session, fresh);
	return fresh;
}

/** Map the harness's canonical outcome to the engine's success/fail/null. */
function mapOutcome(outcome: HarnessEvent["tool_outcome"]): "success" | "fail" | null {
	if (outcome === "success") return "success";
	if (outcome === "error" || outcome === "interrupted") return "fail";
	return null;
}

/** Copy only the string-valued input fields the engine reads. Omitting absent
 *  keys (rather than setting them to undefined) satisfies exactOptionalPropertyTypes. */
function toInput(raw: HarnessEvent["tool_input"]): ToolEvent["input"] {
	const input: ToolEvent["input"] = {};
	if (!raw) return input;
	if (typeof raw.file_path === "string") input.file_path = raw.file_path;
	if (typeof raw.old_string === "string") input.old_string = raw.old_string;
	if (typeof raw.new_string === "string") input.new_string = raw.new_string;
	if (typeof raw.content === "string") input.content = raw.content;
	if (typeof raw.command === "string") input.command = raw.command;
	return input;
}

/** Normalize a HarnessEvent (+ the decision computed for it) into the engine's ToolEvent. */
function toToolEvent(event: HarnessEvent, decision: HarnessDecision): ToolEvent {
	const toolEvent: ToolEvent = {
		ts: event.timestamp,
		session: event.session_id,
		agent: event.agent_source,
		tool: event.tool_name ?? "",
		toolUseId: event.tool_use_id ?? "",
		hook: event.hook_event,
		input: toInput(event.tool_input),
		toolOutcome: mapOutcome(event.tool_outcome),
		checkDecision: decision.decision === "block" ? "block" : "allow",
	};
	// contentSha256 is optional (populated at PostToolUse only) — omit when absent.
	if (event.tool_response_sha256 !== undefined) toolEvent.contentSha256 = event.tool_response_sha256;
	return toolEvent;
}

/** Format one verdict as a shadow metric line. In shadow mode the verdict's
 *  action ("block"/"nudge"/"silent_metric") is REPORTED, never enacted. */
export function formatTrajectoryVerdict(verdict: Verdict): string {
	return `[interlinked:trajectory] ${verdict.ruleId} (${verdict.severity}, shadow — would ${verdict.action}): ${verdict.reason}`;
}

/**
 * Run the trajectory engine in shadow mode for one tool-call event and return
 * the `[interlinked:trajectory]` warning lines to merge into the decision's
 * warnings. Returns [] when disabled, for non-tool events, or on any internal
 * error (fail-open — shadow telemetry must never disrupt the tool loop).
 *
 * Called on BOTH PreToolUse (where security/block-family rules evaluate) and
 * PostToolUse (where churn/verification-family rules evaluate); each rule
 * self-gates on its hook, so passing every tool event through is correct.
 */
export function trajectoryShadowWarnings(
	event: HarnessEvent,
	decision: HarnessDecision,
	config: TrajectoryShadowConfig,
	/** Session reads that survived a daemon restart; seeds a fresh state (F4). */
	filesRead?: readonly string[],
): string[] {
	try {
		if (config?.trajectory_shadow?.enabled !== true) return [];
		// PreToolUse/PostToolUse carry the tool-call rules; Stop carries the
		// obligation-ledger inventory (obl_net_open_at_stop). Other lifecycle events
		// (SessionStart/End, Subagent*, Skill*, UserPromptSubmit) have no rule.
		if (
			event.hook_event !== "PreToolUse" &&
			event.hook_event !== "PostToolUse" &&
			event.hook_event !== "Stop"
		)
			return [];
		if (!event.session_id) return [];
		const state = getState(event.session_id, filesRead);
		return evaluateTrajectory(state, toToolEvent(event, decision)).map(formatTrajectoryVerdict);
	} catch {
		return []; // fail-open: shadow telemetry never disrupts the tool loop
	}
}

/** Append the shadow warnings for `event` to `decision.warnings` in place.
 *  Metric-only: mutates ONLY the warnings array, never `decision.decision`. */
export function mergeTrajectoryShadow(
	event: HarnessEvent,
	decision: HarnessDecision,
	config: TrajectoryShadowConfig,
	/** Session reads that survived a daemon restart; seeds a fresh state (F4). */
	filesRead?: readonly string[],
): void {
	const warnings = trajectoryShadowWarnings(event, decision, config, filesRead);
	if (warnings.length === 0) return;
	decision.warnings = [...(decision.warnings ?? []), ...warnings];
}

/** Test-only: drop all per-session state (so cases start from a clean engine). */
export function __resetTrajectoryShadowForTest(): void {
	stateBySession.clear();
}
