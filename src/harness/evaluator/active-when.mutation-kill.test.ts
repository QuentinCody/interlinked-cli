import { describe, expect, it } from "vitest";
import type { GuardRule, HarnessEvent } from "../types.js";
import { evaluateActiveWhen } from "./active-when.js";

const rule: GuardRule = {
	id: "kill-rule",
	enabled: true,
	trigger: "PreToolUse",
	tool_match: ["Bash"],
	action: "block",
	patterns: [],
	reason: "test",
	severity: "high",
	active_when: { file_scope: "^src/" },
};

const event = (tool_input: Record<string, unknown>): HarnessEvent => ({
	hook_event: "PreToolUse",
	session_id: "kill-session",
	agent_source: "claude",
	timestamp: "2026-10-04T00:00:00Z",
	tool_input,
});

describe("active-when mutation-kill", () => {
	// test-contract: public-api — a runner that sends `path` instead of `file_path` still activates a file_scope rule
	it("falls back to tool_input.path for the file_scope axis", () => {
		expect(evaluateActiveWhen(rule, undefined, event({ path: "src/foo.ts" }))).toBe(true);
	});

	// test-contract: boundary — a `path` outside the scope keeps the rule dormant
	it("stays dormant when tool_input.path is outside the scope", () => {
		expect(evaluateActiveWhen(rule, undefined, event({ path: "tests/foo.ts" }))).toBe(false);
	});
});
