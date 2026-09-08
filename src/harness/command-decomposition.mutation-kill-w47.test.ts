import { makeMinimalEvent as completeEventFixture } from "./__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import {
	applyRewrite,
	classifyToolConcurrency,
	decomposeCommand,
	evaluateCompoundCommand,
	inferAgentRole,
	stripEnvVarPrefix,
} from "./command-decomposition.js";
import type { GuardRule, HarnessEvent, InputRewrite } from "./types.js";

function makeRule(overrides: Partial<GuardRule>): GuardRule {
	return {
		id: "test-rule",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		action: "block",
		patterns: [{ field: "command", regex: "SHOULD_NOT_MATCH_ANYTHING_XYZ" }],
		reason: "test reason",
		severity: "high",
		...overrides,
	};
}

function baseEvent(overrides: Partial<HarnessEvent>): HarnessEvent {
	return ({ ...completeEventFixture(), ...{
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		...overrides,
	} }); // SAFETY: test fixture only sets the fields inferAgentRole reads; other required HarnessEvent fields are irrelevant to this pure function.
}

describe("decomposeCommand — heredocStartsAt uses .some (mutant cc308729)", () => {
	it("does not split a pipe on the heredoc header line even when other heredocs exist", () => {
		// A single heredoc: `cat <<EOF | grep x` must stay whole (no split on the
		// pipe following the heredoc header). If .some were mutated to .every,
		// a single-heredoc array would still behave the same for .some(...)===.every(...)
		// on length 1 sets in some cases, so use two heredocs where only ONE
		// starts at a given position to force divergence between some/every.
		const cmd = "cat <<EOF\nbody\nEOF\ncat <<FOO | grep x\nbody2\nFOO";
		const parts = decomposeCommand(cmd);
		// Expect exactly 2 top-level commands (the two heredoc-bearing cat calls),
		// with the pipe inside the second header NOT causing a split.
		expect(parts.length).toBe(2);
		expect(parts[1]).toContain("| grep x");
	});
});

describe("decomposeCommand — pendingHeredocOnLine lineEnd fallback (mutants 379c57d5, 55df8b09)", () => {
	it("handles a heredoc header with no trailing newline in the command (command ends after header)", () => {
		// No trailing newline after the heredoc header line at all — lineEnd
		// must fall back to command.length so pendingHeredocOnLine's range
		// check `s.start <= lineEnd + 1` uses a sane value instead of -1 or +1.
		const cmd = "cat <<EOF";
		expect(() => decomposeCommand(cmd)).not.toThrow();
		const parts = decomposeCommand(cmd);
		expect(parts).toEqual(["cat <<EOF"]);
	});

	it("does not split && appearing before a heredoc's opening on the same final line", () => {
		const cmd = "echo hi && cat <<EOF";
		const parts = decomposeCommand(cmd);
		// The && before the heredoc header must split normally (two top-level
		// commands): "echo hi" and "cat <<EOF". This exercises the lineEnd
		// computation on the last line (no newline after).
		expect(parts).toEqual(["echo hi", "cat <<EOF"]);
	});
});

describe("decomposeCommand — atomicEndFor uses > not >= (mutant 56c0b11f)", () => {
	it("splits on && that appears immediately after an atomic span ends", () => {
		// "echo 'a'&&echo b" — the quoted span 'a' is atomic; the && starts
		// exactly at s.end (idx === s.end, not idx > s.end). With s.start > idx
		// mutated to >=, a heredoc-adjacent idx check elsewhere is affected;
		// this test targets the general atomic-boundary handling by ensuring
		// commands split correctly right at atomic-span boundaries.
		const cmd = "echo 'a' && echo b";
		const parts = decomposeCommand(cmd);
		expect(parts).toEqual(["echo 'a'", "echo b"]);
	});
});

describe("decomposeCommand — push() trims and drops empty segments (mutant fa6e9fc7)", () => {
	it("does not push an empty/whitespace-only segment between consecutive separators", () => {
		const cmd = "echo a ;; echo b";
		const parts = decomposeCommand(cmd);
		// Consecutive `;` separators must not produce an empty middle part.
		expect(parts).toEqual(["echo a", "echo b"]);
	});

	it("does not push a leading empty segment when command starts with a separator", () => {
		const cmd = " ; echo a";
		const parts = decomposeCommand(cmd);
		expect(parts).toEqual(["echo a"]);
	});
});

describe("decomposeCommand — bracket depth tracking (mutants deb2d0d3, 084d91cb)", () => {
	it("does not split operators inside a parenthesized subshell", () => {
		const cmd = "(echo a && echo b) && echo c";
		const parts = decomposeCommand(cmd);
		// The && inside (...) must stay glued to the subshell; only the
		// outer && at depth 0 splits.
		expect(parts.length).toBe(2);
		expect(parts[0]).toBe("(echo a && echo b)");
		expect(parts[1]).toBe("echo c");
	});

	it("splits top-level operators once depth returns to 0 after a subshell closes", () => {
		const cmd = "(echo a) && echo b";
		const parts = decomposeCommand(cmd);
		expect(parts).toEqual(["(echo a)", "echo b"]);
	});
});

describe("stripEnvVarPrefix — mode gating (mutants 060b209c, 80c1ff63)", () => {
	it("in allow mode, stops stripping at the first non-SAFE env var", () => {
		const result = stripEnvVarPrefix("NODE_ENV=production FOO=bar echo hi", "allow");
		// NODE_ENV is safe and stripped; FOO is not safe, so stripping stops
		// there and FOO=bar remains in the output.
		expect(result.stripped).toBe("FOO=bar echo hi");
	});

	it("in deny mode, strips ALL non-dangerous env vars regardless of safety", () => {
		const result = stripEnvVarPrefix("NODE_ENV=production FOO=bar echo hi", "deny");
		expect(result.stripped).toBe("echo hi");
	});

	it("in allow mode, an all-safe prefix is fully stripped (mode==='allow' branch true)", () => {
		const result = stripEnvVarPrefix("NODE_ENV=production DEBUG=1 echo hi", "allow");
		expect(result.stripped).toBe("echo hi");
	});
});

describe("evaluateSubcommand dangerous env var block (mutants 0ede7c16, d42279d4)", () => {
	it("blocks with the dangerous-env-var reason text and category Security", () => {
		const rules: GuardRule[] = [];
		const result = evaluateCompoundCommand("LD_PRELOAD=/tmp/x.so echo hi && echo b", rules);
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("BLOCKED: Dangerous environment variable LD_PRELOAD=");
		expect(result.reason).toContain(
			"This can hijack library loading or alter execution.",
		);
		expect(result.category).toBe("Security");
		expect(result.severity).toBe("critical");
	});
});

describe("applyRewrite — length cap (mutant 4e3ae6c1)", () => {
	it("returns the command unchanged when the rewrite pattern exceeds 200 chars", () => {
		const longMatch = "a".repeat(201);
		const rewrite: InputRewrite = { field: "command", match: longMatch, replace: "x" };
		expect(applyRewrite("some command", rewrite)).toBe("some command");
	});

	it("applies the rewrite when the pattern is exactly at/under the cap and matches", () => {
		const rewrite: InputRewrite = { field: "command", match: "foo", replace: "bar" };
		expect(applyRewrite("run foo now", rewrite)).toBe("run bar now");
	});
});

describe("safeRegex cache (mutants c9df379a, 67f3495)", () => {
	it("caches a failed compile as null and consistently fails the rewrite both times", () => {
		// An invalid regex pattern (unbalanced group) fails to compile.
		const rewrite: InputRewrite = { field: "command", match: "(unclosed", replace: "x" };
		const first = applyRewrite("run (unclosed thing", rewrite);
		const second = applyRewrite("run (unclosed thing", rewrite);
		// Both calls must return the original command unchanged (regex is null
		// both times — the cache path must return null on a cache hit too,
		// not silently allow through / crash).
		expect(first).toBe("run (unclosed thing");
		expect(second).toBe("run (unclosed thing");
	});

	it("reuses a compiled regex across repeated calls with the same pattern (cache hit succeeds)", () => {
		const rewrite: InputRewrite = { field: "command", match: "foo", replace: "bar" };
		expect(applyRewrite("foo1", rewrite)).toBe("bar1");
		expect(applyRewrite("foo2", rewrite)).toBe("bar2");
	});
});

describe("defaultMatchRule field resolution (mutants c41e31f3, 08fab295)", () => {
	it("matches against the command string when pattern field is 'command'", () => {
		const rule = makeRule({
			patterns: [{ field: "command", regex: "danger" }],
		});
		const result = evaluateCompoundCommand("echo danger && echo b", [rule]);
		expect(result.decision).toBe("block");
	});

	it("matches against tool_input field (not command) when field !== 'command'", () => {
		const rule = makeRule({
			patterns: [{ field: "other_field", regex: "danger" }],
		});
		// The subcommand text itself contains "danger" but the pattern targets
		// a tool_input field that is never populated for subcommands (only
		// `command` is set on subInput) — so it must NOT match via the command
		// text, proving field resolution routes through toolInput, not command.
		const result = evaluateCompoundCommand("echo danger && echo b", [rule]);
		expect(result.decision).toBe("allow");
	});
});

describe("classifyToolConcurrency (mutant 8a1e8624)", () => {
	it("classifies Bash (a STATE_CHANGING_TOOLS member) as state_changing, not unknown", () => {
		expect(classifyToolConcurrency("Bash")).toBe("state_changing");
	});

	it("classifies an unrecognized tool name as unknown, not state_changing", () => {
		expect(classifyToolConcurrency("SomeUnknownTool")).toBe("unknown");
	});

	it("classifies Read as read_only", () => {
		expect(classifyToolConcurrency("Read")).toBe("read_only");
	});
});

describe("inferAgentRole (mutants 3e29eb78..64f87e50)", () => {
	it("returns the explicit agent_role when present, ignoring all inference", () => {
		const event = baseEvent({ agent_role: "lead" });
		expect(inferAgentRole(event, null)).toBe("lead");
	});

	it("infers subagent from parent_agent when agent_role absent", () => {
		const event = baseEvent({ parent_agent: "parent-1" });
		expect(inferAgentRole(event, null)).toBe("subagent");
	});

	it("infers subagent from hook_event === SubagentStart", () => {
		const event = baseEvent({ hook_event: "SubagentStart" });
		expect(inferAgentRole(event, null)).toBe("subagent");
	});

	it("does NOT infer subagent from an unrelated hook_event like PreToolUse", () => {
		const event = baseEvent({ hook_event: "PreToolUse" });
		expect(inferAgentRole(event, null)).toBe("unknown");
	});

	it("infers subagent from agent_type containing 'explore' or 'plan' (OR, not AND)", () => {
		const exploreEvent = baseEvent({ hook_event: "PreToolUse", agent_type: "explorer" });
		expect(inferAgentRole(exploreEvent, null)).toBe("subagent");

		const planEvent = baseEvent({ hook_event: "PreToolUse", agent_type: "planner" });
		expect(inferAgentRole(planEvent, null)).toBe("subagent");
	});

	it("infers worker from agent_type containing 'worker'", () => {
		const event = baseEvent({ hook_event: "PreToolUse", agent_type: "build-worker" });
		expect(inferAgentRole(event, null)).toBe("worker");
	});

	it("lowercases agent_name before matching (mutant 3c9fcfc8 toUpperCase check)", () => {
		const event = baseEvent({ hook_event: "PreToolUse", agent_name: "MY-WORKER-AGENT" });
		expect(inferAgentRole(event, null)).toBe("worker");
	});

	it("infers worker from agent_name containing 'worker' (lowercase path)", () => {
		const event = baseEvent({ hook_event: "PreToolUse", agent_name: "task-worker-3" });
		expect(inferAgentRole(event, null)).toBe("worker");
	});

	it("infers lead from agent_name containing 'lead' OR 'coordinator' (not AND)", () => {
		const leadOnly = baseEvent({ hook_event: "PreToolUse", agent_name: "team-lead" });
		expect(inferAgentRole(leadOnly, null)).toBe("lead");

		const coordinatorOnly = baseEvent({
			hook_event: "PreToolUse",
			agent_name: "the-coordinator",
		});
		expect(inferAgentRole(coordinatorOnly, null)).toBe("lead");
	});

	it("returns unknown for a name with neither 'lead' nor 'coordinator' nor 'worker'", () => {
		const event = baseEvent({ hook_event: "PreToolUse", agent_name: "assistant-bob" });
		expect(inferAgentRole(event, null)).toBe("unknown");
	});
});

describe("READ_ONLY_TOOLS string literals (mutants e1f2615e..1c7bfd04)", () => {
	it.each([
		["Read", "read_only"],
		["Glob", "read_only"],
		["Grep", "read_only"],
		["WebSearch", "read_only"],
		["WebFetch", "read_only"],
	])("classifies %s as %s", (tool, expected) => {
		expect(classifyToolConcurrency(tool)).toBe(expected);
	});

	it.each([
		["Write", "state_changing"],
		["Edit", "state_changing"],
		["Bash", "state_changing"],
		["NotebookEdit", "state_changing"],
	])("classifies %s as %s", (tool, expected) => {
		expect(classifyToolConcurrency(tool)).toBe(expected);
	});
});
