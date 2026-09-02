import { describe, expect, it } from "vitest";
import type { GuardRule, SessionTrajectory } from "../types.js";
import { passesExtraExceptions, passesTemporalGating } from "./rule-matching-guards.js";

function makeRule(overrides: Partial<GuardRule> = {}): GuardRule {
	return {
		id: "test-rule",
		category: "test",
		severity: "medium",
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		patterns: [{ field: "command", regex: "rm\\s+-rf" }],
		action: "block",
		reason: "do not delete everything",
		enabled: true,
		...overrides,
	} as GuardRule;
}

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: "2026-07-31T00:00:00.000Z",
		tool_call_count: 0,
		tool_sequence: [],
		files_touched: [],
		...overrides,
	} as unknown as SessionTrajectory;
}

describe("passesExtraExceptions — positive (must return true)", () => {
	it("P1: no extraExceptions map at all", () => {
		expect(passesExtraExceptions("rm -rf /tmp", "test-rule", undefined)).toBe(true);
	});

	it("P2: extraExceptions map exists but has no entry for this rule id", () => {
		expect(
			passesExtraExceptions("rm -rf /tmp", "test-rule", { "other-rule": ["safe"] }),
		).toBe(true);
	});

	it("P3: entry exists for this rule id but command matches none of the substrings", () => {
		expect(
			passesExtraExceptions("rm -rf /tmp", "test-rule", { "test-rule": ["--dry-run"] }),
		).toBe(true);
	});
});

describe("passesExtraExceptions — negative (must return false)", () => {
	it("N1: command includes one of the exception substrings for this rule id", () => {
		expect(
			passesExtraExceptions("rm -rf /tmp --dry-run", "test-rule", {
				"test-rule": ["--dry-run"],
			}),
		).toBe(false);
	});

	it("N2: command includes a later substring in a multi-entry exception list", () => {
		expect(
			passesExtraExceptions("rm -rf /tmp --safe", "test-rule", {
				"test-rule": ["--dry-run", "--safe"],
			}),
		).toBe(false);
	});
});

// Note on polarity: `passesTemporalGating` returns "gate passes, rule stays
// eligible to match" — for `requires_prior` that means the PRECONDITION IS
// MISSING (the rule fires because the required prior step never happened);
// for `forbids_after` it means the FORBIDDEN STATE IS PRESENT (the rule
// fires because the forbidden thing did happen). See the doc comment on
// `passesTemporalGating` for the full semantics.
describe("passesTemporalGating — positive (must return true)", () => {
	it("P1: rule has neither requires_prior nor forbids_after", () => {
		expect(passesTemporalGating(makeRule(), undefined)).toBe(true);
		expect(passesTemporalGating(makeRule(), makeSession())).toBe(true);
	});

	it("P2: requires_prior present and its precondition is NOT satisfied (missing)", () => {
		const rule = makeRule({ requires_prior: { tool: "Read" } });
		const session = makeSession({ tool_sequence: [] });
		expect(passesTemporalGating(rule, session)).toBe(true);
	});

	it("P3: forbids_after present and the forbidden state IS present in the session", () => {
		const rule = makeRule({ forbids_after: { tool: "Write" } });
		const session = makeSession({ tool_sequence: ["Write:foo.ts"] });
		expect(passesTemporalGating(rule, session)).toBe(true);
	});
});

describe("passesTemporalGating — negative (must return false)", () => {
	it("N1: rule declares a temporal predicate but no session is in scope", () => {
		const rule = makeRule({ requires_prior: { tool: "Read" } });
		expect(passesTemporalGating(rule, undefined)).toBe(false);
	});

	it("N2: requires_prior present and its precondition IS satisfied (present)", () => {
		const rule = makeRule({ requires_prior: { tool: "Read" } });
		const session = makeSession({ tool_sequence: ["Read:foo.ts"] });
		expect(passesTemporalGating(rule, session)).toBe(false);
	});

	it("N3: forbids_after present and the forbidden state is absent from the session", () => {
		const rule = makeRule({ forbids_after: { tool: "Write" } });
		const session = makeSession({ tool_sequence: [] });
		expect(passesTemporalGating(rule, session)).toBe(false);
	});
});
