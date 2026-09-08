import { describe, expect, it } from "vitest";
import type { GuardRule } from "../types.js";
import { extractResolvedTargets, getField } from "./rule-matching.js";

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
	};
}

describe("getField — dot-path traversal (mutation-kill w35)", () => {
	// test-contract: invariant — a mutant that replaces the "." delimiter in
	// path.split(".") with "" would split into individual characters instead
	// of path segments, breaking nested traversal for any 3+ level path.
	it("P1: traverses a 3-level dot path by segment, not by character", () => {
		const obj = { a: { b: { c: 42 } } };
		expect(getField(obj, "a.b.c")).toBe(42);
	});

	// test-contract: invariant — same mutant (split("") instead of split("."))
	// would also corrupt a 2-level path whose keys are longer than 1 char,
	// since character-splitting would look up keys like "a" then "l" then "pha".
	it("N1: a multi-char-segment dot path resolves via segment split, not char split", () => {
		const obj = { alpha: { beta: "value" } };
		expect(getField(obj, "alpha.beta")).toBe("value");
	});
});

describe("extractResolvedTargets — rm-target cap enforcement (mutation-kill w35)", () => {
	// test-contract: boundary — a mutant that forces the entry guard
	// `acc.length >= MAX_RESOLVED_TARGETS` to a hardcoded `false` in
	// pushTarget disables cap enforcement entirely, letting a 6th target push
	// through past the documented MAX_RESOLVED_TARGETS (5) ceiling.
	it("P1: never accumulates more than 5 rm targets even with 6 candidates", () => {
		const targets = extractResolvedTargets(
			"Bash",
			{ command: "rm -rf /a /b /c /d /e /f" },
			makeRule(),
		);
		expect(targets).toHaveLength(5);
		expect(targets.map((t) => t.value)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
	});

	// test-contract: boundary — with exactly 5 candidates (at, not past, the
	// cap) every one must still be captured; guards against an over-eager
	// cap check that also drops the boundary-exact case.
	it("N1: captures all 5 targets when candidate count exactly equals the cap", () => {
		const targets = extractResolvedTargets(
			"Bash",
			{ command: "rm -rf /a /b /c /d /e" },
			makeRule(),
		);
		expect(targets.map((t) => t.value)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
	});
});
