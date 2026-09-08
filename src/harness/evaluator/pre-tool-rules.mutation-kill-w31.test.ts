// Mutation-kill campaign (wave 31) for pre-tool-rules.ts. Each case is
// annotated with the mutantId(s) it targets (from mutation-manifest.json,
// symbol -> mutants -> status "survived"). Placement follows the
// companion file's conventions (baseRule/withCustomRule/bashEvent style).

import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../rules-loader.js";
import type { GuardRule, GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { evaluateDestructiveRules } from "./pre-tool-rules.js";

function withCustomRule(rule: GuardRule): GuardRulesConfig {
	const base = getDefaultConfig();
	return { ...base, rules: [rule, ...base.rules] };
}

function withCustomRules(rules: GuardRule[]): GuardRulesConfig {
	const base = getDefaultConfig();
	return { ...base, rules: [...rules, ...base.rules] };
}

function baseRule(overrides: Partial<GuardRule>): GuardRule {
	return {
		id: "custom-test-rule",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		action: "warn",
		patterns: [],
		reason: "custom test rule",
		severity: "low",
		...overrides,
	};
}

// SAFETY: mirrors the companion test file's fixture builder; the harness
// only reads the fields declared here on this evaluator path.
function bashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "pre-tool-rules-w31-test",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-06-15T00:00:00Z",
	};
}

// SAFETY: mirrors the companion test file's session fixture; only
// `soft_blocks` and `session_id` are read on this evaluator path.
function emptySession(): SessionTrajectory {
	return ({ ...makeSessionFixture(),
		session_id: "w31-soft-block-session",
		tool_sequence: [],
		commands_run: [],
		files_read: new Set(),
		files_written: new Set(),
		verification_observed: new Set(),
		soft_blocks: new Set<string>(),
	} satisfies SessionTrajectory);
}

describe("applyRuleAction — block/ask actions actually decide (5a46e99f, ff014c81, 9a261090, 1ad9c43f)", () => {
	// test-contract: public-api — `rule.action === "block"` must actually
	// gate the block branch; a matched block-action rule returns a block
	// decision naming the rule.
	it("returns a block decision for a matched block-action rule", () => {
		const rule = baseRule({
			id: "custom-real-block",
			action: "block",
			patterns: [{ field: "command", regex: "block-me" }],
		});
		const decision = evaluateDestructiveRules(bashEvent("block-me now"), withCustomRule(rule), undefined, []);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("custom-real-block");
	});

	// test-contract: public-api — `rule.action === "ask"` must actually
	// gate the ask branch; a matched ask-action rule returns an ask
	// decision naming the rule.
	it("returns an ask decision for a matched ask-action rule", () => {
		const rule = baseRule({
			id: "custom-real-ask",
			action: "ask",
			patterns: [{ field: "command", regex: "ask-me" }],
		});
		const decision = evaluateDestructiveRules(bashEvent("ask-me now"), withCustomRule(rule), undefined, []);
		expect(decision?.decision).toBe("ask");
		expect(decision?.rule_id).toBe("custom-real-ask");
	});
});

describe("applyRuleAction — soft_block key uses the SLICED prefix (ec0b865e)", () => {
	// test-contract: invariant — the soft-block key is derived from
	// `cmd.slice(0, SOFT_BLOCK_KEY_MAX)`, so two commands sharing only their
	// first 120 chars must collide on the same retry key.
	it("treats two commands sharing the first 120 chars as the same soft-block key", () => {
		const rule = baseRule({
			id: "custom-slice-softblock",
			action: "soft_block",
			patterns: [{ field: "command", regex: "slice-op" }],
		});
		const base = `slice-op-${"x".repeat(200)}`;
		const cmd1 = `${base}AAAA`;
		const cmd2 = `${base}BBBB`;
		const session = emptySession();

		const first = evaluateDestructiveRules(bashEvent(cmd1), withCustomRule(rule), session, []);
		expect(first?.decision).toBe("block");

		const warnings: string[] = [];
		const second = evaluateDestructiveRules(bashEvent(cmd2), withCustomRule(rule), session, warnings);
		expect(second).toBeNull();
		expect(warnings.some((w) => w.includes("retry allowed"))).toBe(true);
	});
});

describe("applyRuleAction — soft_block with undefined session never crashes (29b8ba8e, 176c304a)", () => {
	// test-contract: boundary — `session?.soft_blocks` and the guarding
	// `if (session)` must both stay optional-chain-safe; an undefined
	// session must not throw on a soft_block rule.
	it("blocks cleanly without throwing when session is undefined", () => {
		const rule = baseRule({
			id: "custom-optional-chain-softblock",
			action: "soft_block",
			patterns: [{ field: "command", regex: "solo-op" }],
		});
		let decision: ReturnType<typeof evaluateDestructiveRules> | undefined;
		expect(() => {
			decision = evaluateDestructiveRules(bashEvent("solo-op now"), withCustomRule(rule), undefined, []);
		}).not.toThrow();
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("custom-optional-chain-softblock");
	});
});

describe("applyRuleAction — rewrite branch is gated on action === 'rewrite' (8583e9c3)", () => {
	// test-contract: invariant — a `rule.rewrite` spec must be inert unless
	// `rule.action === "rewrite"`; a warn-action rule with a rewrite spec
	// present must not attempt the rewrite.
	it("does not attempt a rewrite for a warn-action rule even when rule.rewrite is set", () => {
		const rule = baseRule({
			id: "custom-warn-with-rewrite-field",
			action: "warn",
			patterns: [{ field: "command", regex: "zap" }],
			rewrite: { field: "command", match: "zap", replace: "boom" },
		});
		const decision = evaluateDestructiveRules(bashEvent("run zap now"), withCustomRule(rule), undefined, []);
		expect(decision).toBeNull();
	});
});

describe("applyRuleAction — rewrite log message text (2c4d26a0)", () => {
	// test-contract: public-api — the rewrite-notice warning string is a
	// user-facing contract; a successful rewrite must push the exact text.
	it("pushes the exact rewrite-notice string", () => {
		const rule = baseRule({
			id: "custom-rewrite-msg",
			action: "rewrite",
			patterns: [{ field: "command", regex: "foo" }],
			rewrite: { field: "command", match: "foo", replace: "bar" },
		});
		const warnings: string[] = [];
		evaluateDestructiveRules(bashEvent("run foo now"), withCustomRule(rule), undefined, warnings);
		expect(warnings).toContain("[interlinked:rewrite] Rewrote command per rule custom-rewrite-msg");
	});
});

describe("evaluateRuleLoop — quick-reject guards actually skip (6ad9444e, d90e3a40, bb168702, 0f362d39)", () => {
	// test-contract: public-api — `!shouldEvaluateRule(...)` must skip a
	// disabled rule rather than always evaluating it.
	it("skips a disabled rule entirely (shouldEvaluateRule)", () => {
		const rule = baseRule({
			id: "custom-disabled-block",
			action: "block",
			enabled: false,
			patterns: [{ field: "command", regex: "disabled-op" }],
		});
		const decision = evaluateDestructiveRules(bashEvent("disabled-op now"), withCustomRule(rule), undefined, []);
		expect(decision).toBeNull();
	});

	// test-contract: public-api — `!evaluateActiveWhen(...)` must skip a
	// rule whose active_when axis is unsatisfied rather than always
	// evaluating it.
	it("skips a rule whose active_when axis is not satisfied", () => {
		const rule = baseRule({
			id: "custom-activewhen-block",
			action: "block",
			patterns: [{ field: "command", regex: "scoped-op" }],
			active_when: { agent_source: "codex" },
		});
		const decision = evaluateDestructiveRules(bashEvent("scoped-op now"), withCustomRule(rule), undefined, []);
		expect(decision).toBeNull();
	});

	// test-contract: public-api — `!shouldEvaluateByKeywords(...)` must
	// skip a rule whose declared keywords don't appear in the command.
	it("skips a rule whose keywords don't appear in the command", () => {
		const rule = baseRule({
			id: "custom-keyword-block",
			action: "block",
			patterns: [{ field: "command", regex: "keyword-op" }],
			keywords: ["nomatch-kw"],
		});
		const decision = evaluateDestructiveRules(bashEvent("keyword-op now"), withCustomRule(rule), undefined, []);
		expect(decision).toBeNull();
	});

	// test-contract: public-api — `!matchesRule(...)` must skip a rule
	// whose pattern genuinely does not match the command.
	it("skips a rule whose pattern does not match the command", () => {
		const rule = baseRule({
			id: "custom-nomatch-block",
			action: "block",
			patterns: [{ field: "command", regex: "never-matches-xyz" }],
		});
		const decision = evaluateDestructiveRules(
			bashEvent("totally different command"),
			withCustomRule(rule),
			undefined,
			[],
		);
		expect(decision).toBeNull();
	});
});

describe("evaluateRuleLoop — a falsy (null) decision keeps walking the rule list (1abdf71a)", () => {
	// test-contract: invariant — `if (decision) return decision;` must not
	// short-circuit on a null (non-blocking) applyRuleAction result; a
	// warn-action match must fall through to a later block-action match.
	it("falls through a warn-action match to reach a later block-action match", () => {
		const warnRule = baseRule({
			id: "custom-dual-warn",
			action: "warn",
			patterns: [{ field: "command", regex: "dual-op" }],
		});
		const blockRule = baseRule({
			id: "custom-dual-block",
			action: "block",
			patterns: [{ field: "command", regex: "dual-op" }],
		});
		const decision = evaluateDestructiveRules(
			bashEvent("dual-op now"),
			withCustomRules([warnRule, blockRule]),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("custom-dual-block");
	});
});

describe("steerOutOfRepoCodeWrite — mode gate (33bd8d88)", () => {
	const SCRATCHPAD = "/tmp/claude-501/-Users-dev-project/pre-tool-rules-w31-test/scratchpad";

	// SAFETY: adds only `cwd`, a field this evaluator path reads directly.
	function bashEventWithCwd(command: string): HarnessEvent {
		return { ...bashEvent(command), cwd: "/Users/dev/project" };
	}

	// test-contract: public-api — `mode === "block"` must gate the
	// scratchpad block; with code_write_mode "warn" the same scratchpad
	// write must NOT block.
	it("does NOT block a scratchpad write when code_write_mode is 'warn'", () => {
		const base = getDefaultConfig();
		const rules: GuardRulesConfig = { ...base, scratchpad_guard: { code_write_mode: "warn" } };
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd(`echo x > ${SCRATCHPAD}/probe.ts`),
			rules,
			undefined,
			warnings,
		);
		expect(decision).toBeNull();
	});

	// test-contract: boundary — `resolved !== null` must gate the
	// scratchpad-allows check; an unresolvable write target (unknown
	// leading shell variable) must not block or throw.
	it("does not crash and does not block when the write target is unresolvable (resolved === null)", () => {
		const warnings: string[] = [];
		let decision: ReturnType<typeof evaluateDestructiveRules> | undefined;
		expect(() => {
			decision = evaluateDestructiveRules(
				bashEventWithCwd("echo x > $TOTALLY_UNDEFINED_VAR_XYZ123/probe.ts"),
				getDefaultConfig(),
				undefined,
				warnings,
			);
		}).not.toThrow();
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
	});

	// test-contract: public-api — the scratchpad block decision's declared
	// severity is "medium".
	it("stamps severity 'medium' on the scratchpad block", () => {
		const decision = evaluateDestructiveRules(
			bashEventWithCwd(`echo x > ${SCRATCHPAD}/probe.ts`),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.severity).toBe("medium");
	});

	// test-contract: public-api — the scratchpad block decision's declared
	// category is "harness-integrity".
	it("stamps category 'harness-integrity' on the scratchpad block", () => {
		const decision = evaluateDestructiveRules(
			bashEventWithCwd(`echo x > ${SCRATCHPAD}/probe.ts`),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.category).toBe("harness-integrity");
	});

	// test-contract: public-api — the out-of-repo scratch steer warning is
	// a user-facing message; its exact text is the contract.
	it("emits the exact out-of-repo scratch steer message text", () => {
		const warnings: string[] = [];
		evaluateDestructiveRules(bashEventWithCwd("echo x > /tmp/probe.mts"), getDefaultConfig(), undefined, warnings);
		const msg = warnings.find((w) => w.startsWith("[interlinked:scratch]"));
		expect(msg).toBe(
			"[interlinked:scratch] This command writes a code file outside the repo (/tmp/probe.mts). " +
				"Session/agent scripts belong in <repo>/scratch/ — gitignored but quality-gated and " +
				"rg-searchable (see scratch/README.md).",
		);
	});
});

describe("evaluateBashRoutedWrite — gated on isBash(toolName) && cmd, never on cmd alone (665d47a6, 0cf22e35)", () => {
	// test-contract: public-api — the bash-routed-write bypass path must
	// only engage for an actual Bash tool call; a non-Bash tool with a
	// command-shaped field must not trigger the block.
	it("does not treat a non-Bash tool call as a bash-routed write, even with a command-shaped field", () => {
		// SAFETY: overrides only tool_name/cwd, both read directly by this
		// evaluator path.
		const event = ({
			...bashEvent("echo x > src/foo.ts"),
			tool_name: "McpOtherTool",
			cwd: "/Users/dev/project",
		} satisfies HarnessEvent);
		const decision = evaluateDestructiveRules(event, getDefaultConfig(), undefined, []);
		expect(decision).toBeNull();
	});
});

describe("evaluateBashRoutedWrite — exact block reason fragments + severity/category (653a2e73, d8edb891, a5da16bc, 359096b4, 67af93cf, f299b4ac, 09304256, d116b75a, 671116f9)", () => {
	// test-contract: public-api — the bash-code-file-write-bypass reason is
	// a fixed, user-facing remediation message; every fragment (and the
	// declared severity/category) is part of the contract.
	it("blocks with every reason fragment intact and the right severity/category", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo x > src/foo.ts"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("bash-code-file-write-bypass");
		expect(decision?.severity).toBe("high");
		expect(decision?.category).toBe("harness-integrity");
	});

	// test-contract: public-api — the reason must name the written-to file
	// via the fixed lead-in fragment (StringLiteral mutant 653a2e73).
	it("names the written-to file in the reason", () => {
		const decision = evaluateDestructiveRules(bashEvent("echo x > src/foo.ts"), getDefaultConfig(), undefined, []);
		expect(decision?.reason ?? "").toContain("BLOCKED: This Bash command writes to a tracked source file (");
	});

	// test-contract: public-api — the reason must name the content-gate
	// bypass fragments (StringLiteral mutants d8edb891, a5da16bc).
	it("names the content-quality-gate bypass in the reason", () => {
		const decision = evaluateDestructiveRules(bashEvent("echo x > src/foo.ts"), getDefaultConfig(), undefined, []);
		const reason = decision?.reason ?? "";
		expect(reason).toContain("which bypasses the content-quality gates that run on");
		expect(reason).toContain(
			"the Write and Edit tools (pre_block registry, biome diff-overlay, tsc diff-overlay).",
		);
	});

	// test-contract: public-api — the reason must name the coordinated
	// multi-site change caveat (StringLiteral mutant 359096b4).
	it("names the coordinated multi-site change case in the reason", () => {
		const decision = evaluateDestructiveRules(bashEvent("echo x > src/foo.ts"), getDefaultConfig(), undefined, []);
		expect(decision?.reason ?? "").toContain(
			"a coordinated multi-site change (adding an import AND its use site). A transiently",
		);
	});

	// test-contract: public-api — the reason must name the transient-debt
	// discharge remediation (StringLiteral mutant 67af93cf).
	it("names the transient-debt discharge remediation in the reason", () => {
		const decision = evaluateDestructiveRules(bashEvent("echo x > src/foo.ts"), getDefaultConfig(), undefined, []);
		expect(decision?.reason ?? "").toContain(
			"counterpart edit discharges, so land the halves as ordinary sequential edits. If you",
		);
	});

	// test-contract: public-api — the reason must name the stdin-pipe
	// remediation and the temp-artifact caveat (StringLiteral mutants
	// f299b4ac, 09304256).
	it("names the stdin-pipe remediation in the reason", () => {
		const decision = evaluateDestructiveRules(bashEvent("echo x > src/foo.ts"), getDefaultConfig(), undefined, []);
		const reason = decision?.reason ?? "";
		expect(reason).toContain("genuinely need one atomic multi-file write, PIPE the manifest on stdin");
		expect(reason).toContain("written to a temp path is an ungated artifact that outlives the edit it served.");
	});
});

describe("evaluateCompoundDecomposition — gated on isBash(toolName) && separator regex, not either alone (c7d9e512, 19729d3d)", () => {
	// test-contract: public-api — compound decomposition must only engage
	// for an actual Bash tool call; a non-Bash tool with a separator-shaped
	// command must not be decomposed and checked.
	it("does not decompose a compound command for a non-Bash tool call", () => {
		const rule = baseRule({
			id: "custom-compound-force-block",
			action: "block",
			tool_match: ["Bash"],
			patterns: [{ field: "command", regex: "^rm -rf" }],
		});
		// SAFETY: overrides only tool_name, read directly by this
		// evaluator path.
		const event = ({
			...bashEvent("echo hi && rm -rf /tmp/x"),
			tool_name: "McpOtherTool",
		} satisfies HarnessEvent);
		const decision = evaluateDestructiveRules(event, withCustomRule(rule), undefined, []);
		expect(decision).toBeNull();
	});
});

describe("evaluateCompoundDecomposition — no updated_input means no allow decision (03708f7c)", () => {
	// test-contract: invariant — `if (compoundResult.updated_input)` must
	// gate the allow-with-rewrite branch; a compound command nobody
	// rewrote or blocked must return null, not a synthetic allow.
	it("returns null (not an allow) for a compound command nobody rewrote or blocked", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo alpha && echo beta"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision).toBeNull();
	});
});

describe("evaluateCompoundDecomposition — block warnings merge outer + compound (5a0e5279)", () => {
	// test-contract: public-api — a compound block decision's `warnings`
	// must be the outer warnings array concatenated with the compound
	// evaluator's own warnings, not an empty array.
	it("carries the outer warnings array through into a compound block decision", () => {
		const warnRule = baseRule({
			id: "custom-compound-warn-echo",
			action: "warn",
			tool_match: ["Bash"],
			patterns: [{ field: "command", regex: "echo mark" }],
		});
		const blockRule = baseRule({
			id: "custom-compound-block-rm",
			action: "block",
			tool_match: ["Bash"],
			patterns: [{ field: "command", regex: "^rm -rf" }],
		});
		const warnings: string[] = ["outer-seed"];
		const decision = evaluateDestructiveRules(
			bashEvent("echo mark && rm -rf /tmp/y"),
			withCustomRules([warnRule, blockRule]),
			undefined,
			warnings,
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings).toContain("outer-seed");
	});
});

describe("evaluateDestructiveRules — toolName/cmd defaults are '', not a sentinel string (73b17fc5, bf0e00df)", () => {
	// test-contract: boundary — `event.tool_name || ""` must default to the
	// empty string, not a sentinel; a tool_name-field rule must not fire
	// against the fallback-to-command value when tool_name is missing.
	it("does not fire a tool_name-field rule against a fallback-to-command value when tool_name is missing", () => {
		// SAFETY: constructs a minimal event with tool_name deliberately
		// absent to exercise the `|| ""` default.
		const event = ({
			hook_event: "PreToolUse",
			session_id: "w31-defaults-test",
			agent_source: "claude",
			tool_name: undefined,
			tool_input: { command: "just a normal command" },
			timestamp: "2026-06-15T00:00:00Z",
		} satisfies HarnessEvent);
		const rule = baseRule({
			id: "custom-toolname-default-block",
			action: "block",
			tool_match: ["*"],
			patterns: [{ field: "tool_name", regex: "Stryker" }],
		});
		const decision = evaluateDestructiveRules(event, withCustomRule(rule), undefined, []);
		expect(decision).toBeNull();
	});

	// test-contract: boundary — `(toolInput.command as string) || ""` must
	// default to the empty string, not a sentinel; a command-field rule
	// must not fire against the sentinel fallback when tool_input.command
	// is absent.
	it("does not fire a command-field rule against a sentinel fallback when tool_input.command is absent", () => {
		// SAFETY: constructs a minimal event with tool_input.command
		// deliberately absent to exercise the `|| ""` default.
		const event = ({
			hook_event: "PreToolUse",
			session_id: "w31-defaults-test-2",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: {},
			timestamp: "2026-06-15T00:00:00Z",
		} satisfies HarnessEvent);
		const rule = baseRule({
			id: "custom-cmd-default-block",
			action: "block",
			tool_match: ["Bash"],
			patterns: [{ field: "command", regex: "Stryker" }],
		});
		const decision = evaluateDestructiveRules(event, withCustomRule(rule), undefined, []);
		expect(decision).toBeNull();
	});
});

describe("evaluateDestructiveRules — matchInput actually exposes tool_name/agent_source (1f65d71c)", () => {
	// test-contract: public-api — the synthesized matchInput must spread
	// `tool_name`/`agent_source` onto the pattern-match target; an
	// agent_source-field rule must fire through it.
	it("fires an agent_source-field rule via the synthesized matchInput", () => {
		const rule = baseRule({
			id: "custom-agent-source-match",
			action: "block",
			tool_match: ["*"],
			patterns: [{ field: "agent_source", regex: "^claude$" }],
		});
		const decision = evaluateDestructiveRules(
			bashEvent("some harmless command"),
			withCustomRule(rule),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("custom-agent-source-match");
	});
});
