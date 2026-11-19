import { describe, expect, it } from "vitest";
import type { GuardRule } from "../types.js";
import { passesTemporalGating } from "./rule-matching-guards.js";

function rule(overrides: Partial<GuardRule>): GuardRule {
	return {
		id: "temporal-rule",
		category: "test",
		severity: "medium",
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		patterns: [{ field: "command", regex: "git\\s+push" }],
		action: "block",
		reason: "temporal",
		enabled: true,
		...overrides,
	};
}

// Census fault: `(rule.requires_prior || rule.forbids_after) && !session` →
// `rule.requires_prior && !session` survived the companion test
// (docs/reviews/kill-proof-census-harness.md).
describe("passesTemporalGating — no session", () => {
	// test-contract: bug — a forbids_after rule cannot see the forbidden state without a session, so it must stay dormant instead of blocking
	it("keeps a forbids_after rule dormant when there is no session", () => {
		expect(passesTemporalGating(rule({ forbids_after: { tool: "Write" } }), undefined)).toBe(false);
	});

	// test-contract: invariant — a rule with no temporal clause is unaffected by a missing session
	it("lets a rule with no temporal clause through without a session", () => {
		expect(passesTemporalGating(rule({}), undefined)).toBe(true);
	});
});
