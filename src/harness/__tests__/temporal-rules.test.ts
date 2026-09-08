// ===========================================
// Temporal-Precondition Rules — Test Suite
// ===========================================
//
// Exercises both layers:
//   1) The primitive evaluators in `evaluator/temporal-matching.ts`
//      (evaluateRequiresPrior / evaluateForbidsAfter), including
//      single-axis, multi-axis (AND), window boundaries, and empty
//      session edge cases.
//   2) The three concrete built-in rules wired into PreToolUse via
//      `evaluatePreToolUse`:
//        - builtin-git-force-push-requires-inspection
//        - builtin-rm-requires-prior-inspection
//        - builtin-npm-publish-requires-tests-pass
//
// All session fixtures use the same shape as `evaluator.test.ts` so
// changes to `SessionTrajectory` will fail both files in lockstep.

import { describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import {
	evaluateForbidsAfter,
	evaluateRequiresPrior,
} from "../evaluator/temporal-matching.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type {
	GuardRulesConfig,
	HarnessEvent,
	SessionTrajectory,
	TemporalPredicate,
} from "../types.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		verification_observed: new Set(),
		...overrides,
	};
}

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

function loadConfig(): GuardRulesConfig {
	const rules = getDefaultConfig();
	const loaded = loadRules(process.cwd());
	rules.rules = loaded.rules;
	// Same relaxation as evaluator.test.ts — keep test-first mode out of
	// the way for these non-TDD assertions.
	if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
	return rules;
}

// ===========================================
// Primitive: evaluateRequiresPrior
// ===========================================

describe("evaluateRequiresPrior", () => {
	it("tool predicate: satisfied when a matching ToolName:target entry exists in window", () => {
		const session = makeSession({
			tool_sequence: ["Read:src/foo.ts", "Edit:src/foo.ts"],
		});
		const pred: TemporalPredicate = { tool: "Read", within_last_n: 10 };
		const result = evaluateRequiresPrior(session, pred);
		expect(result.satisfied).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it("tool predicate: unsatisfied on empty tool_sequence", () => {
		const session = makeSession({ tool_sequence: [] });
		const pred: TemporalPredicate = { tool: "Read", within_last_n: 5 };
		const result = evaluateRequiresPrior(session, pred);
		expect(result.satisfied).toBe(false);
		expect(result.reason).toContain("no prior `Read` tool call");
	});

	it("tool predicate: within_last_n boundary excludes entries older than the window", () => {
		// Read at position 0, then 5 more Edits. within_last_n=5 must scan
		// only the last 5 (the Edits) — and miss the older Read.
		const session = makeSession({
			tool_sequence: [
				"Read:src/foo.ts",
				"Edit:a.ts",
				"Edit:b.ts",
				"Edit:c.ts",
				"Edit:d.ts",
				"Edit:e.ts",
			],
		});
		const result = evaluateRequiresPrior(session, { tool: "Read", within_last_n: 5 });
		expect(result.satisfied).toBe(false);
	});

	it("tool predicate: within_last_n=N inclusive of position -N (boundary present)", () => {
		// Six entries; within_last_n=6 must include the leading Read.
		const session = makeSession({
			tool_sequence: [
				"Read:src/foo.ts",
				"Edit:a.ts",
				"Edit:b.ts",
				"Edit:c.ts",
				"Edit:d.ts",
				"Edit:e.ts",
			],
		});
		const result = evaluateRequiresPrior(session, { tool: "Read", within_last_n: 6 });
		expect(result.satisfied).toBe(true);
	});

	it("tool predicate: '*' wildcard matches any tool entry", () => {
		const session = makeSession({ tool_sequence: ["Bash:ls -la"] });
		const result = evaluateRequiresPrior(session, { tool: "*", within_last_n: 5 });
		expect(result.satisfied).toBe(true);
	});

	it("bash_match predicate: regex matches a commands_run entry", () => {
		const session = makeSession({
			commands_run: ["npm test", "git log --oneline -10"],
		});
		const pred: TemporalPredicate = {
			bash_match: "git\\s+(log|diff|status)\\b",
			within_last_n: 10,
		};
		expect(evaluateRequiresPrior(session, pred).satisfied).toBe(true);
	});

	it("bash_match predicate: unsatisfied when no matching command in window", () => {
		const session = makeSession({
			commands_run: ["npm test", "rm -rf dist"],
		});
		const pred: TemporalPredicate = {
			bash_match: "git\\s+(log|diff|status)\\b",
			within_last_n: 10,
		};
		const result = evaluateRequiresPrior(session, pred);
		expect(result.satisfied).toBe(false);
		expect(result.reason).toContain("no prior command matching");
	});

	it("bash_match predicate: case-insensitive by default", () => {
		const session = makeSession({ commands_run: ["GIT STATUS"] });
		const pred: TemporalPredicate = { bash_match: "git\\s+status", within_last_n: 5 };
		expect(evaluateRequiresPrior(session, pred).satisfied).toBe(true);
	});

	it("file_read predicate: exact-match hits Set membership", () => {
		const session = makeSession({
			files_read: new Set(["src/a.ts", "src/b.ts"]),
		});
		expect(
			evaluateRequiresPrior(session, { file_read: "src/a.ts" }).satisfied,
		).toBe(true);
	});

	it("file_read predicate: glob matches under any depth (** semantics)", () => {
		const session = makeSession({
			files_read: new Set(["src/deep/nested/file.ts"]),
		});
		expect(
			evaluateRequiresPrior(session, { file_read: "src/**/file.ts" }).satisfied,
		).toBe(true);
	});

	it("verification_kind predicate: hits when set membership holds", () => {
		const session = makeSession({
			verification_observed: new Set(["test", "typecheck"]),
		});
		expect(
			evaluateRequiresPrior(session, { verification_kind: "test" }).satisfied,
		).toBe(true);
		expect(
			evaluateRequiresPrior(session, { verification_kind: "lint" }).satisfied,
		).toBe(false);
	});

	it("multi-field predicate: AND-combined — every field must hold", () => {
		const session = makeSession({
			tool_sequence: ["Read:src/foo.ts"],
			verification_observed: new Set(["test"]),
		});
		// Both populated and both satisfied → satisfied
		expect(
			evaluateRequiresPrior(session, {
				tool: "Read",
				verification_kind: "test",
				within_last_n: 5,
			}).satisfied,
		).toBe(true);
		// One populated unsatisfied → overall unsatisfied
		expect(
			evaluateRequiresPrior(session, {
				tool: "Read",
				verification_kind: "lint",
				within_last_n: 5,
			}).satisfied,
		).toBe(false);
	});

	it("empty predicate (no fields): vacuously satisfied", () => {
		const session = makeSession();
		expect(evaluateRequiresPrior(session, {}).satisfied).toBe(true);
	});

	it("within_last_n surfaced in reason", () => {
		const session = makeSession({ tool_sequence: [] });
		const pred: TemporalPredicate = { tool: "Read", within_last_n: 7 };
		const result = evaluateRequiresPrior(session, pred);
		expect(result.satisfied).toBe(false);
		expect(result.reason).toContain("within last 7 actions");
	});
});

// ===========================================
// Primitive: evaluateForbidsAfter
// ===========================================

describe("evaluateForbidsAfter", () => {
	it("returns satisfied=true when the predicate matches (rule SHOULD fire)", () => {
		const session = makeSession({
			tool_sequence: ["mcp__chrome-devtools__navigate_page:about:blank"],
		});
		const pred: TemporalPredicate = {
			tool: "mcp__chrome-devtools__navigate_page",
			within_last_n: 5,
		};
		expect(evaluateForbidsAfter(session, pred).satisfied).toBe(true);
	});

	it("returns satisfied=false when predicate does NOT match (rule stays dormant)", () => {
		const session = makeSession({ tool_sequence: ["Read:foo.ts"] });
		const result = evaluateForbidsAfter(session, {
			tool: "Bash",
			within_last_n: 5,
		});
		expect(result.satisfied).toBe(false);
		expect(result.reason).toBeUndefined();
	});

	it("multi-field forbids_after also AND-combined", () => {
		const session = makeSession({
			tool_sequence: ["Bash:rm dist"],
			verification_observed: new Set(["build"]),
		});
		// Both fields present → forbidden state present → satisfied
		expect(
			evaluateForbidsAfter(session, {
				tool: "Bash",
				verification_kind: "build",
				within_last_n: 5,
			}).satisfied,
		).toBe(true);
		// One field missing → forbidden state absent → unsatisfied
		expect(
			evaluateForbidsAfter(session, {
				tool: "Bash",
				verification_kind: "test", // not in the set
				within_last_n: 5,
			}).satisfied,
		).toBe(false);
	});
});

// ===========================================
// Concrete Rule: builtin-git-force-push-requires-inspection
// ===========================================
//
// Note: the hard-block `builtin-git-force-push` rule runs earlier in
// the array, so under default config force-push is always blocked. We
// verify the temporal-gate rule by disabling the hard-block — the
// `disabled_rules` config knob is the documented escape hatch users
// can apply if they want softer behavior, and this exercises the
// temporal-gate logic without re-ordering the rule arrays.

function configWithDisabled(...ids: string[]): GuardRulesConfig {
	const cfg = loadConfig();
	cfg.rules = cfg.rules.map((r) =>
		ids.includes(r.id) ? { ...r, enabled: false } : r,
	);
	return cfg;
}

describe("builtin-git-force-push-requires-inspection (temporal rule)", () => {
	it("asks when no prior git log/diff/status in the last 10 commands", () => {
		const rules = configWithDisabled("builtin-git-force-push");
		const session = makeSession({
			commands_run: ["npm install", "npm run build"], // no git inspection
		});
		const event = makeEvent({
			tool_input: { command: "git push --force origin main" },
		});
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("ask");
		expect(result.rule_id).toBe("builtin-git-force-push-requires-inspection");
	});

	it("stays dormant when a recent `git log` is in commands_run", () => {
		const rules = configWithDisabled("builtin-git-force-push");
		const session = makeSession({
			commands_run: ["git log --oneline -5"],
		});
		const event = makeEvent({
			tool_input: { command: "git push --force origin main" },
		});
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		// Temporal predicate satisfied → temporal rule dormant. The
		// hard-block is disabled in this fixture, so no other rule
		// fires and the call falls through to `allow`.
		expect(result.decision).toBe("allow");
	});

	it("stays dormant when `git diff` (not log) is the recent command", () => {
		const rules = configWithDisabled("builtin-git-force-push");
		const session = makeSession({
			commands_run: ["git diff HEAD~3"],
		});
		const event = makeEvent({
			tool_input: { command: "git push -f origin main" },
		});
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
		// The temporal-gate rule must not have fired at all (not just
		// resolved to "allow") — distinguishes real predicate-satisfied
		// dormancy from a bug that trivially treats any non-empty
		// commands_run as satisfying the "git log" requirement.
		expect(result.rule_id).not.toBe("builtin-git-force-push-requires-inspection");
	});

	it("does not match `--force-with-lease` (the safer variant)", () => {
		const rules = configWithDisabled("builtin-git-force-push");
		const session = makeSession({ commands_run: [] });
		const event = makeEvent({
			tool_input: { command: "git push --force-with-lease origin main" },
		});
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
		// `--force-with-lease` must not even trip the temporal-gate rule's
		// pattern (it's a distinct command shape from `--force`/`-f`), not
		// merely happen to end up allowed for some other reason.
		expect(result.rule_id).not.toBe("builtin-git-force-push-requires-inspection");
	});

	it("under default config (hard-block enabled), force-push still BLOCKS", () => {
		// Regression: the temporal rule must not weaken the existing
		// hard-block when it sits earlier in the rule array.
		const rules = loadConfig();
		const session = makeSession({
			commands_run: ["npm install"], // no inspection
		});
		const event = makeEvent({
			tool_input: { command: "git push --force origin main" },
		});
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("block");
		expect(result.rule_id).toBe("builtin-git-force-push");
	});
});

// ===========================================
// Concrete Rule: builtin-rm-requires-prior-inspection
// ===========================================

describe("builtin-rm-requires-prior-inspection (temporal rule)", () => {
	it("asks when `rm <path>` has no prior Read in the last 20 actions", () => {
		const rules = loadConfig();
		const session = makeSession({ tool_sequence: [] });
		// Use a path outside the negation allowlist (dist/build/.cache/...)
		// so the temporal rule actually gets a chance to fire.
		const event = makeEvent({ tool_input: { command: "rm src/old-feature.ts" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("ask");
		expect(result.rule_id).toBe("builtin-rm-requires-prior-inspection");
	});

	it("stays dormant when at least one Read has occurred recently", () => {
		const rules = loadConfig();
		const session = makeSession({
			tool_sequence: ["Read:src/foo.ts", "Edit:src/foo.ts"],
		});
		const event = makeEvent({ tool_input: { command: "rm src/stale-feature.ts" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
	});

	it("does not fire on safe artifact paths like dist/ even without a Read", () => {
		// `dist/` is on the negation allowlist (common build artifact).
		// Without this exemption, every routine rebuild cleanup would nag.
		const rules = loadConfig();
		const session = makeSession({ tool_sequence: [] });
		const event = makeEvent({ tool_input: { command: "rm -rf dist/" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
		// The negation allowlist must exempt this path from the rule
		// entirely — distinguishes the exemption from a bug that just
		// happens to resolve "allow" (e.g. an empty tool_sequence being
		// misread as "no prior actions to worry about").
		expect(result.rule_id).not.toBe("builtin-rm-requires-prior-inspection");
	});

	it("does not fire on subcommand `rm` like `vercel rm <name>`", () => {
		// The rule's regex anchors to command start / separator, not bare
		// whitespace, so the `rm` token of `vercel rm my-deployment` is
		// not the command verb. The earlier vercel-specific rule will
		// still block the call; we only assert the temporal rule does
		// not shadow that path.
		const rules = loadConfig();
		const session = makeSession({ tool_sequence: [] });
		const event = makeEvent({ tool_input: { command: "vercel rm my-deployment" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		// Vercel's hard-block fires (block), not the temporal ask.
		expect(result.rule_id).not.toBe("builtin-rm-requires-prior-inspection");
	});

	it("does NOT shadow the hard-block on `rm -rf /` (block must still win)", () => {
		// Regression: dangerous shapes are caught by the earlier hard-block.
		// The temporal rule must not change that — it sits later in the array.
		const rules = loadConfig();
		const session = makeSession({
			tool_sequence: ["Read:src/foo.ts"], // would satisfy temporal rule
		});
		const event = makeEvent({ tool_input: { command: "rm -rf /" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("block");
		expect(result.rule_id).toBe("builtin-rm-rf-root");
	});
});

// ===========================================
// Concrete Rule: builtin-npm-publish-requires-tests-pass
// ===========================================

describe("builtin-npm-publish-requires-tests-pass (temporal rule)", () => {
	// This rule's action is `warn`, not `ask` — it coexists with the
	// existing `builtin-npm-publish` warn rule in SECURITY_AND_SAFETY_RULES
	// rather than overriding it. Both warnings get emitted when the
	// temporal predicate is unsatisfied; the call still proceeds with
	// `decision: "allow"`. See the rule's inline rationale comment for
	// the trade-off.

	function warningsFromRule(result: { warnings?: string[] | undefined }, ruleReason: string): boolean {
		return !!result.warnings?.some((w) => w.includes(ruleReason));
	}

	it("warns when `npm publish` runs with no test verification observed", () => {
		const rules = loadConfig();
		const session = makeSession({ verification_observed: new Set() });
		const event = makeEvent({ tool_input: { command: "npm publish" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
		expect(warningsFromRule(result, "run tests first")).toBe(true);
	});

	it("stays dormant when test verification was observed", () => {
		const rules = loadConfig();
		const session = makeSession({
			verification_observed: new Set(["test"]),
		});
		const event = makeEvent({ tool_input: { command: "npm publish" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		// Predicate satisfied → no extra temporal-rule warning. The
		// upstream `builtin-npm-publish` warn rule may still fire on
		// its own merits.
		expect(result.decision).toBe("allow");
		expect(warningsFromRule(result, "run tests first")).toBe(false);
	});

	it("matches yarn publish and pnpm publish too", () => {
		const rules = loadConfig();
		const session = makeSession({ verification_observed: new Set() });
		for (const cmd of ["yarn publish", "pnpm publish"]) {
			const event = makeEvent({ tool_input: { command: cmd } });
			const result = evaluatePreToolUse(
				event,
				rules,
				session,
				new ReservationManager(),
				new CohortManager(),
			);
			expect(result.decision).toBe("allow");
			expect(warningsFromRule(result, "run tests first")).toBe(true);
		}
	});

	it("does NOT fire on `npm publish --dry-run` (negation pattern)", () => {
		// `--dry-run` is the safe preview path — already carved out by the
		// existing `builtin-npm-publish` warn rule and matches user intent.
		const rules = loadConfig();
		const session = makeSession({ verification_observed: new Set() });
		const event = makeEvent({ tool_input: { command: "npm publish --dry-run" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(warningsFromRule(result, "run tests first")).toBe(false);
	});
});

// ===========================================
// Cross-cutting: MatchRuleContext.session is optional (fail-open)
// ===========================================

describe("MatchRuleContext.session optional", () => {
	it("when no session is in scope, temporal rules stay dormant (fail-open)", async () => {
		// Direct call into matchesRule with the temporal-gated rule but no
		// session — should not fire. Verifies the early-return guard in
		// `rule-matching.ts` so the compound-command decomposition path
		// (which sometimes doesn't have a session) doesn't crash.
		const { matchesRule } = await import("../evaluator/rule-matching.js");
		const temporalRule = {
			id: "test-temporal",
			enabled: true,
			trigger: "PreToolUse" as const,
			tool_match: ["Bash"],
			action: "ask" as const,
			patterns: [{ field: "command", regex: "npm publish" }],
			reason: "test",
			severity: "medium" as const,
			category: "test",
			requires_prior: { verification_kind: "test" as const, within_last_n: 50 },
		};
		expect(
			matchesRule({
				command: "npm publish",
				toolInput: { command: "npm publish" },
				rule: temporalRule,
				// session omitted — fail-open path
			}),
		).toBe(false);
	});
});
