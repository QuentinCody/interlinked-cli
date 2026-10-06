// ===========================================
// Deterministic Trajectory-Analysis Engine — public entry
// ===========================================
//
// Aggregates the implemented rule families and exposes the single
// `evaluateTrajectory` entry the daemon's shadow wiring calls
// (server/trajectory-shadow.ts — every verdict surfaces as a non-blocking
// `[interlinked:trajectory] <ruleId> (sev, shadow — would <action>)` warning).
//
// Deterministic by construction: `applyEvent` folds the event into state (no IO,
// no clock, no randomness), then every rule — a pure `(state, event) => Verdict |
// null` — runs against the folded state. Rules never mutate state and never throw.
//
// ---------------------------------------------------------------------------
// DEDUPE MAP — catalog family → implementing module, plus overlap with the
// OLDER, ACTIVE trajectory system (src/harness/sequence-checks/, 23 enforcing
// detectors) and the Stop reflection helpers. Consult BEFORE adding a family
// so the same behavior never double-fires (cf. the hook over-registration
// incident). Catalog: docs/design/deterministic-trajectory-rules.md.
//
//   Family 1  Churn                   → rules-churn.ts (7/23)
//     overlaps: sequence-checks `add_then_revert_loop` ≈ churn_literal_edit_revert;
//     `same_command_thrice_no_observe` ≈ churn_repeated_failing_bash.
//   Family 3  Obligation Ledger       → obligation-inventory.ts, lifted via
//     rules-obligations.ts (2/2). Overlaps the stubs-introduced Stop nudge in
//     verification-stop-checks.ts (content-scan; the ledger nets open-vs-closed).
//   Family 5  Security (+ F4/F11 strays) → rules-security.ts (9)
//     overlaps: sequence-checks security family (`lethal_trifecta_structural`,
//     `secret_read_then_network_call`, `download_then_execute`) — engine
//     variants stay shadow-only while those enforce.
//   Family 7  Verification Discipline → rules-verification.ts (4/23)
//     overlaps: verification-stop-checks.ts unverified-code nudge (Stop-time;
//     the engine rules fire mid-session) + commit-cadence.ts.
//   Family 9  Read/Edit Balance       → rules-read-edit.ts (5/21)
//     skipped as already covered: reb_stale_read_edit_sha_changed ≈
//     sequence-checks `stale_read_then_write`; reb_breaking_signature_edit_
//     without_caller_read ≈ `signature_change_callers_not_updated`;
//     reb_blind_edit_then_revert ≈ churn_literal_edit_revert;
//     reb_oscillating_read_edit_same_region ≈ churn_undo_war_value_toggle.
//   Families 2, 4, 6, 8, 10, 11       → unimplemented (Family 2 measured NOT
//     to predict failure — deprioritized; Family 8 must dedupe against the
//     sequence-checks cross-agent trio before building).
// ---------------------------------------------------------------------------

import { evaluateLtlShadow } from "./ltl/shadow.js";
import { CHURN_RULES } from "./rules-churn.js";
import { OBLIGATION_RULES } from "./rules-obligations.js";
import { READ_EDIT_RULES } from "./rules-read-edit.js";
import { SECURITY_RULES } from "./rules-security.js";
import { VERIFICATION_RULES } from "./rules-verification.js";
import { applyEvent } from "./state.js";
import type { ToolEvent, TrajectoryRule, TrajectoryState, Verdict } from "./types.js";

export { createState } from "./state.js";
export type { ToolEvent, TrajectoryState, Verdict } from "./types.js";

/** Every wired trajectory rule (churn + obligation + security + verification +
 *  read/edit-balance families), in evaluation order. */
export const TRAJECTORY_RULES: ReadonlyArray<TrajectoryRule> = [
	...CHURN_RULES,
	...OBLIGATION_RULES,
	...SECURITY_RULES,
	...VERIFICATION_RULES,
	...READ_EDIT_RULES,
];

/**
 * Fold `event` into `state`, then evaluate every rule against the folded state.
 * Returns all firing verdicts (empty when none fire). `applyEvent` performs the
 * incremental (mutating) fold; the rules are pure and total. Call on BOTH the
 * PreToolUse and PostToolUse of a tool call — security rules self-gate to Pre,
 * churn rules to Post, so passing every tool event through is correct and never
 * double-fires a rule.
 */
export function evaluateTrajectory(state: TrajectoryState, event: ToolEvent): Verdict[] {
	applyEvent(state, event);
	const verdicts: Verdict[] = [];
	for (const rule of TRAJECTORY_RULES) {
		try {
			const fired = rule(state, event);
			if (fired) verdicts.push(fired);
		} catch (error) {
			verdicts.push({ ruleId: `unavailable:${rule.name || "anonymous-rule"}`, action: "silent_metric", severity: "low",
				reason: `NOT CHECKED: trajectory rule failed: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	verdicts.push(...evaluateLtlShadow(state, event)); // formula rules, `ltl:`-prefixed silent metrics (ltl/shadow.ts)
	return verdicts;
}
