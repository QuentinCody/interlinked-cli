// Mutation-directed companion for keyword-quick-reject.ts (kill-proof census
// 2026-11-05). Fault: the backtick leaves TOKEN_BOUNDARY, so a command word
// inside a `…` substitution keeps its backtick attached and a rule keyworded
// on that word is quick-rejected before its regex ever runs.
import { describe, expect, it } from "vitest";
import type { GuardRule } from "../types.js";
import { commandKeywordTokens, shouldEvaluateByKeywords } from "./keyword-quick-reject.js";

function makeRule(keywords?: string[]): GuardRule {
	return {
		id: "test",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		action: "block",
		patterns: [],
		reason: "test",
		severity: "high",
		keywords,
	};
}

describe("commandKeywordTokens — backtick command substitution", () => {
	// test-contract: public-api - backticks are token boundaries, so the substituted command word is a bare keyword candidate
	it("exposes the command word inside a backtick substitution as its own token", () => {
		const tokens = commandKeywordTokens("echo `rm -rf /tmp/x`");
		expect(tokens.has("rm")).toBe(true);
		expect(tokens.has("`rm")).toBe(false);
	});

	// test-contract: invariant - a rule keyworded on the substituted command is still evaluated (never quick-rejected)
	it("keeps a rule keyworded on the substituted command in evaluation", () => {
		const tokens = commandKeywordTokens("result=`dd if=/dev/zero of=/dev/sda`");
		expect(shouldEvaluateByKeywords(makeRule(["dd"]), tokens)).toBe(true);
	});
});
