import { describe, expect, it } from "vitest";

import type { GuardRule } from "../types.js";
import {
	overlayIdPrefix,
	validateOverlayEmission,
	type ValidationOpts,
} from "./overlay-loader.js";
import { DEFAULT_METACODER_CONFIG } from "./types.js";

const SESSION = "abc12345-def0";
const FLOOR_IDS = new Set<string>(["block_rm_rf", "no_force_push", "no_curl_pipe_sh"]);

const VALIDATION_OPTS: ValidationOpts = {
	floorRuleIds: FLOOR_IDS,
	sessionId: SESSION,
	config: DEFAULT_METACODER_CONFIG,
};

function makeOverlayRule(overrides: Partial<GuardRule> = {}): GuardRule {
	return {
		id: `${overlayIdPrefix(SESSION)}0`,
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Edit", "Write"],
		action: "block",
		patterns: [{ field: "file_path", regex: "src/legacy/payments/" }],
		reason: "Out of scope for this prompt.",
		severity: "high",
		...overrides,
	};
}

describe("overlayIdPrefix", () => {
	it("returns a deterministic prefix derived from the session id", () => {
		// sanitizeSessionId whitelist is [A-Za-z0-9_-]; the slug can contain dashes.
		expect(overlayIdPrefix("abc12345-def0")).toMatch(/^overlay:[A-Za-z0-9_-]+:$/);
	});

	it("produces the same prefix for the same session id", () => {
		expect(overlayIdPrefix(SESSION)).toBe(overlayIdPrefix(SESSION));
	});
});

describe("validateOverlayEmission — happy path", () => {
	it("accepts a single well-formed overlay rule", () => {
		const result = validateOverlayEmission(
			{ version: 1, rules: [makeOverlayRule()] },
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(1);
		expect(result.warnings).toHaveLength(0);
	});

	it("preserves system_prompt_addendum when within the size cap", () => {
		const result = validateOverlayEmission(
			{ version: 1, rules: [], system_prompt_addendum: "Stay focused on payments." },
			VALIDATION_OPTS,
		);
		expect(result.addendum).toBe("Stay focused on payments.");
	});

	it("supports negated patterns as exceptions inside the rule itself", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						patterns: [
							{ field: "file_path", regex: "src/legacy/payments/" },
							{
								field: "file_path",
								regex: "src/legacy/payments/migrate\\.ts",
								negate: true,
							},
						],
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].patterns).toHaveLength(2);
	});
});

describe("validateOverlayEmission — floor invariant", () => {
	it("drops a rule that collides with a floor rule id", () => {
		const result = validateOverlayEmission(
			{ version: 1, rules: [makeOverlayRule({ id: "block_rm_rf" })] },
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/collid|floor/i);
	});

	it("drops a rule whose id lacks the overlay prefix", () => {
		const result = validateOverlayEmission(
			{ version: 1, rules: [makeOverlayRule({ id: "no_namespace_prefix" })] },
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/prefix/i);
	});

	it("drops a rule whose action is not 'block'", () => {
		for (const action of ["ask", "warn", "soft_block", "rewrite"] as const) {
			const result = validateOverlayEmission(
				{ version: 1, rules: [makeOverlayRule({ action })] },
				VALIDATION_OPTS,
			);
			expect(result.rules, `${action} should be rejected`).toHaveLength(0);
			expect(result.warnings.join(" ")).toMatch(/action/i);
		}
	});

	it("drops a top-level disabled_rules field entirely", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [makeOverlayRule()],
				disabled_rules: ["block_rm_rf"],
			},
			VALIDATION_OPTS,
		);
		expect(result.warnings.join(" ")).toMatch(/disabled_rules/);
		// surviving overlay rule still loads
		expect(result.rules).toHaveLength(1);
	});

	it("drops top-level extra_exceptions and additional_patterns", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [makeOverlayRule()],
				extra_exceptions: { whatever: ["foo"] },
				additional_patterns: { whatever: [{ field: "command", regex: "rm" }] },
			},
			VALIDATION_OPTS,
		);
		const joined = result.warnings.join(" ");
		expect(joined).toMatch(/extra_exceptions/);
		expect(joined).toMatch(/additional_patterns/);
		expect(result.rules).toHaveLength(1);
	});

	it("rejects all rules over the configured cap", () => {
		const overcap = DEFAULT_METACODER_CONFIG.max_rules + 5;
		const rules = Array.from({ length: overcap }, (_, i) =>
			makeOverlayRule({ id: `${overlayIdPrefix(SESSION)}${i}` }),
		);
		const result = validateOverlayEmission(
			{ version: 1, rules },
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(DEFAULT_METACODER_CONFIG.max_rules);
		expect(result.warnings.join(" ")).toMatch(/cap|max/i);
	});

	it("caps validation by raw input count, not by survivor count (P1 round 5)", () => {
		// Plan §reviewer-P1 (round 5): a runaway model that emits 100
		// invalid rules must not force us to compile up to
		// (100 × max_patterns_per_rule) regexes waiting for survivors to
		// reach the cap they'll never reach. The cap is applied to the
		// raw input length before validation runs.
		const inflated = DEFAULT_METACODER_CONFIG.max_rules * 5;
		// 4× the cap as invalid (action: "warn" is rejected), then a few
		// valid ones at the end that the loop should never reach.
		const invalidThenValid = [
			...Array.from({ length: inflated - 3 }, (_, i) => ({
				id: `${overlayIdPrefix(SESSION)}${i}`,
				enabled: true,
				trigger: "PreToolUse",
				tool_match: ["Edit"],
				action: "warn",
				patterns: [{ field: "file_path", regex: `pattern_${i}` }],
				reason: "should be rejected for action",
				severity: "low",
			})),
			...Array.from({ length: 3 }, (_, j) =>
				makeOverlayRule({
					id: `${overlayIdPrefix(SESSION)}valid${j}`,
				}),
			),
		];
		const result = validateOverlayEmission(
			{ version: 1, rules: invalidThenValid },
			VALIDATION_OPTS,
		);
		// The valid rules sit beyond the cap, so none survive — the
		// loop only ever processed the first `max_rules` entries (all
		// invalid). 0 survivors and a pre-validation drop warning.
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/dropped pre-validation/);
	});
});

describe("validateOverlayEmission — positive-pattern requirement (P1 round 4)", () => {
	// The matcher treats zero positive patterns as vacuously matching, so a
	// malformed overlay rule without a positive pattern turns into a global
	// block on every tool call. The loader rejects such rules outright.

	it("drops a rule with no patterns field at all", () => {
		// validateOverlayEmission accepts `unknown`; pass a raw object that
		// omits `patterns` rather than mutating a typed GuardRule.
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					{
						id: `${overlayIdPrefix(SESSION)}0`,
						enabled: true,
						trigger: "PreToolUse",
						tool_match: ["Edit"],
						action: "block",
						reason: "no patterns field at all",
						severity: "high",
					},
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/patterns/);
	});

	it("drops a rule with a non-array patterns field", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					{
						id: `${overlayIdPrefix(SESSION)}0`,
						enabled: true,
						trigger: "PreToolUse",
						tool_match: ["Edit"],
						action: "block",
						patterns: "not an array",
						reason: "patterns must be an array",
						severity: "high",
					},
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/patterns/i);
	});

	it("drops a rule with an empty patterns array", () => {
		const result = validateOverlayEmission(
			{ version: 1, rules: [makeOverlayRule({ patterns: [] })] },
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/positive/i);
	});

	it("drops a rule whose patterns are all negate:true", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						patterns: [
							{ field: "file_path", regex: "src/legacy/", negate: true },
							{ field: "file_path", regex: "src/auth/", negate: true },
						],
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/positive/i);
	});

	it("accepts a rule with mixed positive + negate patterns", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						patterns: [
							{ field: "file_path", regex: "src/legacy/payments/" },
							{ field: "file_path", regex: "src/legacy/payments/migrate\\.ts", negate: true },
						],
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(1);
	});
});

describe("validateOverlayEmission — active_when.after_command regex validation (P2 round 4)", () => {
	// `evaluator/active-when.ts::evaluateAfterCommandAxis` compiles
	// `after_command.pattern` with `new RegExp` and no try/catch, so an
	// invalid regex throws on every PreToolUse and a ReDoS shape hangs the
	// hook. The loader must drop the rule before the evaluator sees it.

	it("drops a rule with an invalid after_command.pattern", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						active_when: { after_command: { pattern: "[unclosed" } },
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/after_command/);
	});

	it("drops a rule with a ReDoS-shaped after_command.pattern", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						active_when: { after_command: { pattern: "^(a+)+$" } },
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/after_command|ReDoS/i);
	});

	it("drops a rule with an over-length after_command.pattern", () => {
		const huge = "a".repeat(DEFAULT_METACODER_CONFIG.max_pattern_length + 1);
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						active_when: { after_command: { pattern: huge } },
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/after_command|length/i);
	});

	it("preserves a valid after_command.pattern on the returned rule", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						active_when: { after_command: { pattern: "^git push", window_steps: 5 } },
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].active_when?.after_command).toEqual({
			pattern: "^git push",
			window_steps: 5,
		});
	});
});

describe("validateOverlayEmission — active_when carry-through", () => {
	// Plan §reviewer-P3: previously the loader validated the active_when
	// regex but discarded the entire field on the returned rule, so a
	// scoped overlay rule fired on every tool call session-wide.
	it("preserves a file_scope active_when on the returned rule", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						active_when: { file_scope: "^src/payments/" },
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].active_when).toEqual({ file_scope: "^src/payments/" });
	});

	it("preserves an agent_source active_when on the returned rule", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						active_when: { agent_source: ["claude"] },
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].active_when?.agent_source).toEqual(["claude"]);
	});

	it("omits active_when when the input has no recognized axes", () => {
		const result = validateOverlayEmission(
			{ version: 1, rules: [makeOverlayRule({ active_when: {} })] },
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].active_when).toBeUndefined();
	});
});

describe("validateOverlayEmission — regex validation", () => {
	it("drops a rule with a catastrophic-backtracking regex", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						patterns: [{ field: "file_path", regex: "^(a+)+$" }],
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/regex|ReDoS|nested/i);
	});

	it("drops a rule with an invalid regex", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						patterns: [{ field: "file_path", regex: "[unclosed" }],
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/regex|invalid/i);
	});

	it("drops a rule with too many patterns", () => {
		const tooMany = Array.from(
			{ length: DEFAULT_METACODER_CONFIG.max_patterns_per_rule + 1 },
			(_, i) => ({ field: "file_path", regex: `pattern_${i}` }),
		);
		const result = validateOverlayEmission(
			{ version: 1, rules: [makeOverlayRule({ patterns: tooMany })] },
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/pattern/i);
	});

	it("validates regexes in active_when.file_scope too", () => {
		const result = validateOverlayEmission(
			{
				version: 1,
				rules: [
					makeOverlayRule({
						active_when: { file_scope: "^(a+)+$" },
					}),
				],
			},
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/active_when|regex|ReDoS/i);
	});
});

describe("validateOverlayEmission — malformed input", () => {
	it("returns empty result with a warning when emission is not an object", () => {
		const result = validateOverlayEmission("not json", VALIDATION_OPTS);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("returns empty result when rules field is missing", () => {
		const result = validateOverlayEmission({ version: 1 }, VALIDATION_OPTS);
		expect(result.rules).toHaveLength(0);
	});

	it("returns empty result when version is wrong", () => {
		const result = validateOverlayEmission(
			{ version: 2, rules: [makeOverlayRule()] },
			VALIDATION_OPTS,
		);
		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join(" ")).toMatch(/version/i);
	});

	it("truncates an over-length system_prompt_addendum", () => {
		const huge = "x".repeat(DEFAULT_METACODER_CONFIG.max_addendum_chars + 500);
		const result = validateOverlayEmission(
			{ version: 1, rules: [], system_prompt_addendum: huge },
			VALIDATION_OPTS,
		);
		expect(result.addendum?.length ?? 0).toBeLessThanOrEqual(
			DEFAULT_METACODER_CONFIG.max_addendum_chars,
		);
		expect(result.warnings.join(" ")).toMatch(/addendum|truncat/i);
	});
});
