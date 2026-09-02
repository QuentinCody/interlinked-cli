// ===========================================
// Guard-Rule Matching — extra-exception + temporal gating helpers
// ===========================================
//
// Extracted from `rule-matching.ts` (line-cap sibling) to keep `matchesRule`
// under the cyclomatic-complexity cap. Both helpers are pure boolean gates
// consulted by `matchesRule` after the content-pattern check has already
// hit — see the call sites there for the exact ordering contract.

import type { GuardRule, SessionTrajectory } from "../types.js";
import { evaluateForbidsAfter, evaluateRequiresPrior } from "./temporal-matching.js";

/** Extra exceptions from local config: a per-rule substring allowlist checked
 *  against the already-resolved command string. `true` means no exception fired. */
export function passesExtraExceptions(
	cmd: string,
	ruleId: string,
	extraExceptions: Record<string, string[]> | undefined,
): boolean {
	const exceptions = extraExceptions?.[ruleId];
	if (!exceptions) return true;
	for (const exc of exceptions) {
		if (cmd.includes(exc)) return false;
	}
	return true;
}

/** Temporal-precondition gating. Runs after content patterns + extra_exceptions
 *  so the rule is already a content-level hit. Semantics:
 *   - `requires_prior` fires when predicate NOT satisfied (precondition missing).
 *   - `forbids_after` fires when predicate IS satisfied (forbidden state present).
 *  Without a session in scope, rules with temporal predicates fall through to
 *  not-fire — content-level callers (compound decomposer) don't gate temporally. */
export function passesTemporalGating(
	rule: GuardRule,
	session: SessionTrajectory | undefined,
): boolean {
	if ((rule.requires_prior || rule.forbids_after) && !session) {
		return false;
	}
	if (rule.requires_prior && session) {
		const result = evaluateRequiresPrior(session, rule.requires_prior);
		if (result.satisfied) return false; // precondition met → rule stays dormant
	}
	if (rule.forbids_after && session) {
		const result = evaluateForbidsAfter(session, rule.forbids_after);
		if (!result.satisfied) return false; // forbidden state absent → rule stays dormant
	}
	return true;
}
