// Coverage-gap tests for command-decomposition.ts. The broad behavioral
// surface (decomposeCommand, stripEnvVarPrefix, evaluateCompoundCommand happy
// paths, inferAgentRole, ruleAppliesToRole, applyRewrite happy paths,
// classifyToolConcurrency) is already covered by
// `__tests__/cc-patterns.test.ts`; this file targets the specific
// lines/branches that suite doesn't reach: the rewrite-throws catch, the
// negated-pattern loop, the non-"command" field resolution path, the
// per-edit rewrite bookkeeping branches, shouldEvaluateForBash's
// disabled/wrong-trigger paths, the overlong-regex safeRegex guard, and the
// cohort-lineage / agent_type "lead" branches of inferAgentRole.

import { describe, expect, it } from "vitest";
import { CohortManager } from "./cohort.js";
import {
	classifyToolConcurrency,
	decomposeCommand,
	evaluateCompoundCommand,
	inferAgentRole,
	stripEnvVarPrefix,
} from "./command-decomposition.js";
import type { GuardRule, HarnessEvent } from "./types.js";

const FIXED_TIMESTAMP = new Date(1_700_000_000_000).toISOString();

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

describe("decomposeCommand — atomic spans and heredoc boundaries", () => {
	it("splits ordinary executed text rather than treating it as atomic", () => {
		expect(decomposeCommand("echo one && echo two")).toEqual(["echo one", "echo two"]);
	});

	it("splits around quoted spans at both span boundaries", () => {
		expect(decomposeCommand("echo 'one && two' && echo three")).toEqual([
			"echo 'one && two'",
			"echo three",
		]);
	});

	it("does not let a quoted span before a heredoc suppress an earlier split", () => {
		expect(decomposeCommand("echo before && echo 'quoted'\ncat <<EOF\nbody\nEOF")).toEqual([
			"echo before",
			"echo 'quoted'",
			"cat <<EOF\nbody\nEOF",
		]);
	});

	it("keeps operators before a heredoc attached to its receiving command", () => {
		expect(decomposeCommand("echo before && cat <<EOF\nbody\nEOF\necho after")).toEqual([
			"echo before && cat <<EOF\nbody\nEOF",
			"echo after",
		]);
	});

	it("does not glue an operator on a prior line to a later heredoc", () => {
		expect(decomposeCommand("echo before && echo ok\ncat <<EOF\nbody\nEOF")).toEqual([
			"echo before",
			"echo ok",
			"cat <<EOF\nbody\nEOF",
		]);
	});

	it("splits an operator after a heredoc closer", () => {
		expect(decomposeCommand("cat <<EOF\nbody\nEOF\necho after && echo final")).toEqual([
			"cat <<EOF\nbody\nEOF",
			"echo after",
			"echo final",
		]);
	});

	it("keeps an operator at the first heredoc-body byte atomic", () => {
		expect(decomposeCommand("cat <<EOF\n&& body\nEOF\necho after")).toEqual([
			"cat <<EOF\n&& body\nEOF",
			"echo after",
		]);
	});
});

describe("evaluateCompoundCommand — shouldEvaluateForBash gating", () => {
	it("ignores disabled rules", () => {
		const rules = [makeRule({ enabled: false })];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("ignores rules whose trigger excludes PreToolUse", () => {
		const rules = [makeRule({ trigger: "PostToolUse" })];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("accepts both-trigger, wildcard, Bash, and Shell rules", () => {
		for (const rule of [
			makeRule({ trigger: "both" }),
			makeRule({ tool_match: ["*"] }),
			makeRule({ tool_match: ["Bash", "OtherTool"] }),
			makeRule({ tool_match: ["shell"] }),
		]) {
			expect(evaluateCompoundCommand("echo safe && rm -rf /", [rule]).decision).toBe("block");
		}
	});

	it("rejects a rule whose tool matches neither Bash nor Shell", () => {
		const result = evaluateCompoundCommand("echo safe && rm -rf /", [
			makeRule({ tool_match: ["OtherTool"] }),
		]);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});
});

describe("evaluateCompoundCommand — default matcher field resolution + negation", () => {
	it("treats an empty positive-pattern field value as non-matching", () => {
		const rules = [makeRule({ patterns: [{ field: "nonexistent_field", regex: "x" }] })];
		const result = evaluateCompoundCommand("cd /tmp && anything", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("applies a rule containing only a non-matching negated pattern", () => {
		const result = evaluateCompoundCommand("cd /tmp && anything", [
			makeRule({ patterns: [{ field: "command", regex: "never", negate: true }] }),
		]);
		expect(result.decision).toBe("block");
	});

	it("uses case-insensitive matching when flags are omitted", () => {
		const result = evaluateCompoundCommand("cd /tmp && RM -RF /", [
			makeRule({ patterns: [{ field: "command", regex: "rm\\s+-rf" }] }),
		]);
		expect(result.decision).toBe("block");
	});

	it("uses case-insensitive matching for negated patterns too", () => {
		const result = evaluateCompoundCommand("cd /tmp && rm SAFE", [
			makeRule({
				patterns: [
					{ field: "command", regex: "rm" },
					{ field: "command", regex: "safe", negate: true },
				],
			}),
		]);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("does not let an empty negated field exclude a matching command", () => {
		const result = evaluateCompoundCommand("cd /tmp && rm target", [
			makeRule({
				patterns: [
					{ field: "command", regex: "rm" },
					{ field: "missing", regex: "^$", negate: true },
				],
			}),
		]);
		expect(result.decision).toBe("block");
	});

	it("does not treat a non-matching positive regex as a match", () => {
		const result = evaluateCompoundCommand("cd /tmp && echo safe", [
			makeRule({ patterns: [{ field: "command", regex: "^rm$" }] }),
		]);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("treats an invalid configured regex as non-matching", () => {
		const result = evaluateCompoundCommand("cd /tmp && echo safe", [
			makeRule({ patterns: [{ field: "command", regex: "[invalid" }] }),
		]);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("keeps undefined tool-input fields distinct from the empty string", () => {
		const result = evaluateCompoundCommand("cd /tmp && echo safe", [
			makeRule({ patterns: [{ field: "missing", regex: "^undefined$" }] }),
		]);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("accepts a regex exactly at the trusted-config length cap", () => {
		const pattern = "a".repeat(200);
		const result = evaluateCompoundCommand(`cd /tmp && ${pattern}`, [
			makeRule({ patterns: [{ field: "command", regex: pattern }] }),
		]);
		expect(result.decision).toBe("block");
	});

	it("rejects an overlong regex even when its text would otherwise match", () => {
		const pattern = "a".repeat(201);
		const result = evaluateCompoundCommand(`cd /tmp && ${pattern}`, [
			makeRule({ patterns: [{ field: "command", regex: pattern }] }),
		]);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("does not let an empty positive-pattern field satisfy an empty regex", () => {
		const result = evaluateCompoundCommand("cd /tmp && echo safe", [
			makeRule({ patterns: [{ field: "missing", regex: "^$" }] }),
		]);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("does not call test on an invalid negated regex", () => {
		const result = evaluateCompoundCommand("cd /tmp && rm target", [
			makeRule({
				patterns: [
					{ field: "command", regex: "rm" },
					{ field: "command", regex: "[invalid", negate: true },
				],
			}),
		]);
		expect(result.decision).toBe("block");
	});

	it("does not treat a missing tool-input field as nonempty", () => {
		const result = evaluateCompoundCommand("cd /tmp && echo safe", [
			makeRule({ patterns: [{ field: "missing", regex: ".+" }] }),
		]);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("excludes the rule when a negated pattern matches a non-command field", () => {
		const rules = [
			makeRule({
				action: "block",
				patterns: [
					{ field: "command", regex: "rm" },
					{ field: "command", regex: "safe", negate: true },
				],
			}),
		];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /tmp/safe", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("still blocks when a negated pattern's field resolves empty (nothing to exclude on)", () => {
		const rules = [
			makeRule({
				action: "block",
				patterns: [
					{ field: "command", regex: "rm" },
					{ field: "nonexistent_field", regex: "x", negate: true },
				],
			}),
		];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /tmp/x", rules);
		expect(result.decision).toBe("block");
	});

	it("rejects an overlong pattern regex (safeRegex length guard) as non-matching", () => {
		const longPattern = "a".repeat(201);
		const rules = [makeRule({ patterns: [{ field: "command", regex: longPattern }] })];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("returns the fast-path result exactly for a single command", () => {
		expect(evaluateCompoundCommand("rm -rf /", [makeRule()])).toEqual({
			decision: "allow",
			warnings: [],
		});
	});
});

describe("evaluateCompoundCommand — rewrite bookkeeping", () => {
	it("does not record a rewrite when the replacement produces no textual change", () => {
		const rules = [
			makeRule({
				action: "rewrite",
				patterns: [{ field: "command", regex: "^ls$" }],
				rewrite: { field: "command", match: "^ls$", replace: "ls" },
			}),
		];
		const result = evaluateCompoundCommand("cd /tmp && ls", rules);
		expect(result.decision).toBe("allow");
		expect(result.updated_input).toBeUndefined();
	});

	it("rewrites every matching subcommand without resetting the rewritten-parts buffer", () => {
		const rules = [
			makeRule({
				action: "rewrite",
				patterns: [{ field: "command", regex: "^rm " }],
				rewrite: { field: "command", match: "^rm (.+)", replace: "trash $1" },
			}),
		];
		const result = evaluateCompoundCommand("rm a.txt && rm b.txt", rules);
		expect(result.decision).toBe("allow");
		expect(result.updated_input).toEqual({ command: "trash a.txt && trash b.txt" });
	});

	it("passes the stripped command to custom matchers and preserves rewrite diagnostics", () => {
		const seen: Array<{ command: string; inputCommand: unknown }> = [];
		const long = "rm " + "x".repeat(100);
		const result = evaluateCompoundCommand(
			`cd /tmp && ${long}`,
			[
				makeRule({
					action: "rewrite",
					patterns: [{ field: "command", regex: "^rm " }],
					rewrite: { field: "command", match: "^rm ", replace: "trash " },
				}),
			],
			undefined,
			(command, input) => {
				seen.push({ command, inputCommand: input.command });
				return command.startsWith("rm ");
			},
		);
		expect(seen.at(-1)).toEqual({ command: long, inputCommand: long });
		expect(result.updated_input?.command).toBe(`cd /tmp && ${long.replace("rm ", "trash ")}`);
		expect(result.warnings).toEqual([
			`[interlinked:rewrite] Rewrote: ${long.slice(0, 40)} → ${long.replace("rm ", "trash ").slice(0, 40)}`,
		]);
	});

	it("truncates block reasons to the documented subcommand preview length", () => {
		const long = "rm " + "x".repeat(100);
		const result = evaluateCompoundCommand(`cd /tmp && ${long}`, [
			makeRule({ patterns: [{ field: "command", regex: "^rm " }] }),
		]);
		expect(result.reason).toBe(
			`BLOCKED: Blocked destructive command (in subcommand: ${long.slice(0, 80)})`,
		);
	});

	it("does not rewrite a warning rule even when it carries rewrite metadata", () => {
		const result = evaluateCompoundCommand("cd /tmp && rm target", [
			makeRule({
				action: "warn",
				patterns: [{ field: "command", regex: "^rm" }],
				rewrite: { field: "command", match: "rm", replace: "trash" },
			}),
		]);
		expect(result.updated_input).toBeUndefined();
		expect(result.warnings).toEqual([
			"[interlinked] Warning: Blocked destructive command (in subcommand: rm target)",
		]);
	});

	it("truncates warning diagnostics to 60 characters", () => {
		const long = "rm " + "x".repeat(100);
		const result = evaluateCompoundCommand(`cd /tmp && ${long}`, [
			makeRule({
				action: "warn",
				patterns: [{ field: "command", regex: "^rm " }],
			}),
		]);
		expect(result.warnings).toEqual([
			`[interlinked] Warning: Blocked destructive command (in subcommand: ${long.slice(0, 60)})`,
		]);
	});

	it("reports dangerous environment variables with security metadata", () => {
		const result = evaluateCompoundCommand("cd /tmp && LD_PRELOAD=/evil.so ls", []);
		expect(result).toMatchObject({
			decision: "block",
			severity: "critical",
			category: "Security",
		});
	});

	it("strips unknown environment assignments before deny matching", () => {
		const result = evaluateCompoundCommand("CUSTOM_VAR=x npm run && echo done", [
			makeRule({ patterns: [{ field: "command", regex: "^npm run$" }] }),
		]);
		expect(result.decision).toBe("block");
	});

	it("passes the deny-stripped command to a custom matcher", () => {
		const seen: string[] = [];
		evaluateCompoundCommand(
			"CUSTOM_VAR=x npm run && echo done",
			[makeRule({ action: "warn", patterns: [{ field: "command", regex: "^npm run$" }] })],
			undefined,
			(command) => {
				seen.push(command);
				return false;
			},
		);
		expect(seen).toContain("npm run");
	});
});

describe("inferAgentRole — cohort lineage and agent_type lead inference", () => {
	it("infers subagent from cohort-recorded parent lineage when the event itself carries none", () => {
		const cohort = new CohortManager();
		cohort.subagentJoined(
			makeEvent({ agent_name: "sub-1", tool_input: { parent_agent: "lead-1" } }),
		);
		const event = makeEvent({ agent_name: "sub-1" });
		expect(inferAgentRole(event, cohort)).toBe("subagent");
	});

	it("infers lead from agent_type containing 'lead'", () => {
		expect(inferAgentRole(makeEvent({ agent_type: "lead-driver" }))).toBe("lead");
	});

	it("infers lead from agent_type containing 'coordinator'", () => {
		expect(inferAgentRole(makeEvent({ agent_type: "coordinator-driver" }))).toBe("lead");
	});

	it("infers subagent from SubagentStop events", () => {
		expect(inferAgentRole(makeEvent({ hook_event: "SubagentStop" }))).toBe("subagent");
	});

	it("returns unknown for an agent with no role signals", () => {
		const cohort = new CohortManager();
		expect(inferAgentRole(makeEvent({ agent_name: "unlisted-agent" }), cohort)).toBe("unknown");
	});
});

describe("stripEnvVarPrefix — normalization boundaries", () => {
	it("trims surrounding whitespace before stripping assignments", () => {
		expect(stripEnvVarPrefix("  NODE_ENV=test npm test  ", "deny")).toEqual({
			stripped: "npm test",
		});
	});

	it("collapses repeated whitespace between assignments and the command", () => {
		expect(stripEnvVarPrefix("NODE_ENV=test  npm test", "deny")).toEqual({
			stripped: "npm test",
		});
	});

	it("handles a command made only of assignments without reading past the array", () => {
		expect(stripEnvVarPrefix("NODE_ENV=test", "deny")).toEqual({ stripped: "" });
	});

	it("requires an assignment token to begin with its variable name", () => {
		expect(stripEnvVarPrefix("-FOO=bar npm test", "deny")).toEqual({
			stripped: "-FOO=bar npm test",
		});
	});
});

describe("classifyToolConcurrency — supported aliases", () => {
	it("classifies read-only aliases as read_only", () => {
		for (const tool of [
			"FileRead",
			"ReadFile",
			"read_file",
			"GlobTool",
			"GrepTool",
			"Ls",
			"ListFiles",
			"web_search",
			"ToolSearch",
			"web_fetch",
			"TaskGet",
			"TaskList",
			"AskUserQuestion",
		]) {
			expect(classifyToolConcurrency(tool)).toBe("read_only");
		}
	});

	it("classifies state-changing aliases as state_changing", () => {
		for (const tool of [
			"WriteFile",
			"write_file",
			"FileWrite",
			"EditFile",
			"edit_file",
			"FileEdit",
			"Shell",
			"shell",
			"run_command",
			"TaskCreate",
			"TaskUpdate",
		]) {
			expect(classifyToolConcurrency(tool)).toBe("state_changing");
		}
	});
});
