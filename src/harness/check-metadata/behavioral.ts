// Metadata for session-level behavioral checks (cross-invocation patterns).
// Keys must match the behavioral-check identifiers wired into the evaluator.

import type { CheckMeta } from "./types.js";

/** Public API — consumed by doc generation and re-exported from check-metadata.ts. */
export const BEHAVIORAL_CHECK_META: Record<string, CheckMeta> = {
	repeated_edit_without_test: {
		name: "Repeated Edit Without Test",
		description: "File edited 3+ times without running tests",
		tier: 2,
		determinism: "heuristic",
	},
	suppression_as_workaround: {
		name: "Suppression as Workaround",
		description: "Suppression directive added after harness warning instead of fixing",
		tier: 1,
		determinism: "partially_deterministic",
	},
	domain_sensitive_test_nudge: {
		name: "Domain-Sensitive Test Nudge",
		description: "Security-sensitive code edited without running auth/security tests",
		tier: 2,
		determinism: "heuristic",
	},
	persistent_warning_escalation: {
		name: "Persistent Warning Reminder",
		description: "Repeated finding retained as advisory; repetition never increases severity or confidence",
		tier: 2,
		determinism: "heuristic",
	},
	tdd_cycle_violation: {
		name: "TDD Cycle Violation",
		description:
			"Implementation edits without establishing a red test first, or continued edits while tests are failing",
		tier: 2,
		determinism: "partially_deterministic",
	},
	tdd_regression: {
		name: "TDD Regression",
		description:
			"Tests were passing (green) but a subsequent edit caused them to fail (green→red)",
		tier: 1,
		determinism: "partially_deterministic",
	},
	tdd_green_confirmation: {
		name: "TDD Green Confirmation",
		description:
			"Positive signal: tests transitioned from red to green, completing the TDD cycle",
		tier: 2,
		determinism: "fully_deterministic",
	},
	tdd_commit_gate: {
		name: "TDD Commit Gate",
		description:
			"Pre-commit check ensuring tests pass and edited files have test coverage before git commit",
		tier: 1,
		determinism: "partially_deterministic",
	},
	test_timeout_inflation: {
		name: "Test Timeout Inflation",
		description:
			"An existing test-timeout literal ({timeout: N}, it() third-arg, or testTimeout config) is raised in the staged diff — buying wall-clock instead of fixing slowness or flakiness",
		tier: 1,
		determinism: "heuristic",
	},
	assertion_count_regression: {
		name: "Assertion Count Regression",
		description:
			"Staged test files net-removed assertions while production source changed — a deleted expect() weakens the oracle exactly when it should tighten (test-oracle-integrity.md)",
		tier: 1,
		determinism: "heuristic",
	},
	assertion_value_swap: {
		name: "Assertion Value Swap",
		description:
			"Same subject and matcher with a different expected value in one staged diff (toBe(5) → toBe(6)) — legitimate when the spec changed, the highest-signal line to review when it didn't; info-only, never blocks",
		tier: 1,
		determinism: "heuristic",
	},
};
