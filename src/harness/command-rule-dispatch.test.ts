// Companion test for command-rule-dispatch.ts, split out of
// command-decomposition.ts to relieve that file's line cap. Targets the
// per-rule dispatch (applyGuardRuleToSubcommand) and the trigger/tool-match
// gate (shouldEvaluateForBash) directly; applyRewrite/safeRegex retain their
// existing coverage via command-decomposition.test.ts and
// __tests__/cc-patterns.test.ts (unaffected — they're re-exported from the
// same public import path).

import { describe, expect, it } from "vitest";
import { applyGuardRuleToSubcommand, shouldEvaluateForBash } from "./command-rule-dispatch.js";
import type { GuardRule } from "./types.js";

function makeRule(overrides: Partial<GuardRule> = {}): GuardRule {
	return {
		id: "test-rule",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		action: "block",
		patterns: [{ field: "command", regex: "rm\\s+-rf" }],
		reason: "Blocked destructive command",
		severity: "critical",
		...overrides,
	};
}

const alwaysMatch = () => true;
const neverMatch = () => false;

describe("shouldEvaluateForBash", () => {
	it("P1: false when the rule is disabled", () => {
		expect(shouldEvaluateForBash(makeRule({ enabled: false }))).toBe(false);
	});

	it("P2: false when the trigger is neither PreToolUse nor both", () => {
		expect(shouldEvaluateForBash(makeRule({ trigger: "PostToolUse" }))).toBe(false);
	});

	it("P3: true for a wildcard tool_match", () => {
		expect(shouldEvaluateForBash(makeRule({ tool_match: ["*"] }))).toBe(true);
	});

	it("P4: true for a case-insensitive bash/shell tool_match", () => {
		expect(shouldEvaluateForBash(makeRule({ tool_match: ["BASH"] }))).toBe(true);
		expect(shouldEvaluateForBash(makeRule({ tool_match: ["Shell"] }))).toBe(true);
	});

	it("N1: false when tool_match names an unrelated tool", () => {
		expect(shouldEvaluateForBash(makeRule({ tool_match: ["Write"] }))).toBe(false);
	});

	it("P5: true when trigger is 'both'", () => {
		expect(shouldEvaluateForBash(makeRule({ trigger: "both" }))).toBe(true);
	});
});

describe("applyGuardRuleToSubcommand", () => {
	it("N1: returns {} when the rule doesn't apply to Bash", () => {
		const warnings: string[] = [];
		const outcome = applyGuardRuleToSubcommand(
			makeRule({ tool_match: ["Write"] }),
			"rm -rf /tmp",
			"rm -rf /tmp",
			undefined,
			alwaysMatch,
			warnings,
		);
		expect(outcome).toEqual({});
		expect(warnings).toEqual([]);
	});

	it("N2: returns {} when the matcher rejects the rule", () => {
		const warnings: string[] = [];
		const outcome = applyGuardRuleToSubcommand(
			makeRule(),
			"rm -rf /tmp",
			"rm -rf /tmp",
			undefined,
			neverMatch,
			warnings,
		);
		expect(outcome).toEqual({});
		expect(warnings).toEqual([]);
	});

	it("P1: returns a block outcome with the subcommand appended to the reason", () => {
		const warnings: string[] = [];
		const rule = makeRule({ id: "r1", severity: "high", category: "Security" });
		const outcome = applyGuardRuleToSubcommand(
			rule,
			"rm -rf /tmp",
			"rm -rf /tmp",
			undefined,
			alwaysMatch,
			warnings,
		);
		expect(outcome.block).toEqual({
			decision: "block",
			reason: "BLOCKED: Blocked destructive command (in subcommand: rm -rf /tmp)",
			warnings,
			rule_id: "r1",
			severity: "high",
			category: "Security",
		});
	});

	it("P2: truncates a long subcommand to 80 chars in the block reason", () => {
		const warnings: string[] = [];
		const longSub = `echo ${"x".repeat(100)}`;
		const outcome = applyGuardRuleToSubcommand(
			makeRule(),
			longSub,
			longSub,
			undefined,
			alwaysMatch,
			warnings,
		);
		expect(outcome.block?.reason).toBe(
			`BLOCKED: Blocked destructive command (in subcommand: ${longSub.slice(0, 80)})`,
		);
	});

	it("P3: pushes a warning and returns {} for a warn-action rule", () => {
		const warnings: string[] = [];
		const outcome = applyGuardRuleToSubcommand(
			makeRule({ action: "warn", reason: "Consider avoiding this" }),
			"rm -rf /tmp",
			"rm -rf /tmp",
			undefined,
			alwaysMatch,
			warnings,
		);
		expect(outcome).toEqual({});
		expect(warnings).toEqual(["[interlinked] Warning: Consider avoiding this (in subcommand: rm -rf /tmp)"]);
	});

	it("P4: returns rewritten and pushes a rewrite warning when the pattern changes the command", () => {
		const warnings: string[] = [];
		const outcome = applyGuardRuleToSubcommand(
			makeRule({
				action: "rewrite",
				rewrite: { field: "command", match: "rm -rf", replace: "rm -rfi" },
			}),
			"rm -rf /tmp",
			"rm -rf /tmp",
			undefined,
			alwaysMatch,
			warnings,
		);
		expect(outcome).toEqual({ rewritten: "rm -rfi /tmp" });
		expect(warnings).toEqual(["[interlinked:rewrite] Rewrote: rm -rf /tmp → rm -rfi /tmp"]);
	});

	it("N3: returns {} with no warning when a rewrite rule doesn't change the command", () => {
		const warnings: string[] = [];
		const outcome = applyGuardRuleToSubcommand(
			makeRule({
				action: "rewrite",
				rewrite: { field: "command", match: "nonmatching-pattern", replace: "x" },
			}),
			"rm -rf /tmp",
			"rm -rf /tmp",
			undefined,
			alwaysMatch,
			warnings,
		);
		expect(outcome).toEqual({});
		expect(warnings).toEqual([]);
	});

	it("N4: returns {} for a rewrite-action rule with no rewrite spec", () => {
		const warnings: string[] = [];
		const outcome = applyGuardRuleToSubcommand(
			makeRule({ action: "rewrite", rewrite: undefined }),
			"rm -rf /tmp",
			"rm -rf /tmp",
			undefined,
			alwaysMatch,
			warnings,
		);
		expect(outcome).toEqual({});
		expect(warnings).toEqual([]);
	});

	it("P5: applies the rule against the STRIPPED command via the matcher/subInput, but reports the ORIGINAL sub in messages", () => {
		const warnings: string[] = [];
		let seenCommand: string | undefined;
		const captureMatcher = (cmd: string) => {
			seenCommand = cmd;
			return true;
		};
		const outcome = applyGuardRuleToSubcommand(
			makeRule(),
			"FOO=bar rm -rf /tmp",
			"rm -rf /tmp",
			undefined,
			captureMatcher,
			warnings,
		);
		expect(seenCommand).toBe("rm -rf /tmp");
		expect(outcome.block?.reason).toContain("FOO=bar rm -rf /tmp");
	});
});
