// Tests for the two-pass re-verification layer. Each registered
// verify-pass runs stricter rules on a candidate finding to filter
// false positives. Adapted from the Mythos blog: their pipeline
// re-verified every candidate against the source before reporting.
// Generalizes the manual FP-suppression commits (e.g. aac4e2a
// "exempt typeof narrowing") into a single pluggable layer.

import { describe, expect, it } from "vitest";
import type { InlineMatch } from "../checks/shared.js";
import {
	applyVerifyPasses,
	getRegisteredVerifyPassIds,
	registerVerifyPass,
	resetVerifyPassesForTesting,
} from "./verify-pass.js";

function match(line: number, text: string): InlineMatch {
	return { line, text };
}

describe("applyVerifyPasses", () => {
	it("returns matches unchanged when no passes are registered for the checkId", () => {
		resetVerifyPassesForTesting();
		const matches = [match(1, "x"), match(2, "y")];
		expect(applyVerifyPasses("nonexistent", matches, "content", "src/x.ts")).toEqual(
			matches,
		);
	});

	it("drops matches where any registered pass returns false", () => {
		resetVerifyPassesForTesting();
		registerVerifyPass({
			checkId: "test_check",
			rationale: "drop even line numbers",
			verify: (m) => m.line % 2 !== 0,
		});
		const matches = [match(1, "a"), match(2, "b"), match(3, "c")];
		const out = applyVerifyPasses("test_check", matches, "content", "src/x.ts");
		expect(out.map((m) => m.line)).toEqual([1, 3]);
	});

	it("requires ALL passes to keep a match (AND semantics)", () => {
		// Two passes for the same checkId. A match must pass both.
		resetVerifyPassesForTesting();
		registerVerifyPass({
			checkId: "two_filter",
			rationale: "drop line < 5",
			verify: (m) => m.line >= 5,
		});
		registerVerifyPass({
			checkId: "two_filter",
			rationale: "drop line > 10",
			verify: (m) => m.line <= 10,
		});
		const matches = [match(3, "a"), match(7, "b"), match(12, "c")];
		const out = applyVerifyPasses("two_filter", matches, "content", "src/x.ts");
		expect(out.map((m) => m.line)).toEqual([7]);
	});

	it("isolates registrations by checkId — a pass for one check does not affect another", () => {
		resetVerifyPassesForTesting();
		registerVerifyPass({
			checkId: "filter_a",
			rationale: "drop all",
			verify: () => false,
		});
		const matches = [match(1, "x")];
		expect(applyVerifyPasses("filter_a", matches, "c", "src/x.ts")).toEqual([]);
		expect(applyVerifyPasses("filter_b", matches, "c", "src/x.ts")).toEqual(matches);
	});

	it("keeps a match when a registered verify-pass throws — fails open, never drops a legitimate finding", () => {
		resetVerifyPassesForTesting();
		registerVerifyPass({
			checkId: "throws_check",
			rationale: "simulate a bug inside a verify-pass",
			verify: () => {
				throw new Error("boom");
			},
		});
		const matches = [match(1, "x"), match(2, "y")];
		const out = applyVerifyPasses("throws_check", matches, "content", "src/x.ts");
		expect(out).toEqual(matches);
	});

	it("passes content and filePath to verify functions for context-aware filtering", () => {
		resetVerifyPassesForTesting();
		const seen: Array<{ content: string; filePath: string }> = [];
		registerVerifyPass({
			checkId: "context_check",
			rationale: "record context",
			verify: (_m, content, filePath) => {
				seen.push({ content, filePath });
				return true;
			},
		});
		applyVerifyPasses(
			"context_check",
			[match(1, "x")],
			"my-content",
			"path/to/file.ts",
		);
		expect(seen).toEqual([{ content: "my-content", filePath: "path/to/file.ts" }]);
	});
});

describe("registerVerifyPass + getRegisteredVerifyPassIds", () => {
	it("registers passes and returns their checkIds via the listing helper", () => {
		resetVerifyPassesForTesting();
		expect(getRegisteredVerifyPassIds()).toEqual([]);
		registerVerifyPass({
			checkId: "alpha",
			rationale: "r1",
			verify: () => true,
		});
		registerVerifyPass({
			checkId: "beta",
			rationale: "r2",
			verify: () => true,
		});
		// Two passes registered for two distinct checkIds.
		expect(getRegisteredVerifyPassIds().sort()).toEqual(["alpha", "beta"]);
	});

	it("preserves multiple passes for the same checkId in registration order", () => {
		resetVerifyPassesForTesting();
		registerVerifyPass({
			checkId: "same",
			rationale: "p1",
			verify: () => true,
		});
		registerVerifyPass({
			checkId: "same",
			rationale: "p2",
			verify: () => true,
		});
		// Listing returns the checkId once; the verify pipeline iterates
		// both internally.
		expect(getRegisteredVerifyPassIds()).toEqual(["same"]);
	});
});

describe("built-in verify passes (loaded by default)", () => {
	it("registers the magic_literal_in_conditional FP-suppression passes", async () => {
		// The module auto-registers a small set of passes on import. Force
		// a fresh load and verify the known check IDs are present.
		resetVerifyPassesForTesting();
		const mod = await import("./builtin-verify-passes.js");
		mod.registerAllBuiltinVerifyPasses();
		expect(getRegisteredVerifyPassIds()).toContain("magic_literal_in_conditional");
	});

	it("drops magic_literal_in_conditional findings inside `typeof x === 'string'` narrowing", async () => {
		// The recent aac4e2a fix landed the typeof exemption inline. The
		// verify-pass version generalizes that into a structural filter.
		resetVerifyPassesForTesting();
		const mod = await import("./builtin-verify-passes.js");
		mod.registerAllBuiltinVerifyPasses();

		const content = [
			"function foo(x: unknown) {", // L1
			"  if (typeof x === 'string') {", // L2 — typeof narrowing
			"    return x.length;", // L3
			"  }", // L4
			"}", // L5
		].join("\n");
		const matches = [match(2, "if (typeof x === 'string')")];
		const out = applyVerifyPasses(
			"magic_literal_in_conditional",
			matches,
			content,
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("keeps magic_literal_in_conditional findings unrelated to typeof / case", async () => {
		resetVerifyPassesForTesting();
		const mod = await import("./builtin-verify-passes.js");
		mod.registerAllBuiltinVerifyPasses();

		const content = [
			"function foo(x: number) {", // L1
			"  if (x === 42) {", // L2 — plain magic literal
			"    return true;", // L3
			"  }", // L4
			"}", // L5
		].join("\n");
		const matches = [match(2, "if (x === 42)")];
		const out = applyVerifyPasses(
			"magic_literal_in_conditional",
			matches,
			content,
			"src/x.ts",
		);
		expect(out).toEqual(matches);
	});

	it("drops magic_literal_in_conditional findings inside a switch case arm", async () => {
		resetVerifyPassesForTesting();
		const mod = await import("./builtin-verify-passes.js");
		mod.registerAllBuiltinVerifyPasses();

		const content = [
			"switch (x) {", // L1
			"  case 200:", // L2 — `case` arm, not a free conditional
			"    return ok();", // L3
			"  default:", // L4
			"    return err();", // L5
			"}", // L6
		].join("\n");
		const matches = [match(2, "case 200:")];
		const out = applyVerifyPasses(
			"magic_literal_in_conditional",
			matches,
			content,
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("drops magic_literal_in_conditional findings in fixture / test-data paths", async () => {
		resetVerifyPassesForTesting();
		const mod = await import("./builtin-verify-passes.js");
		mod.registerAllBuiltinVerifyPasses();

		const content = "if (x === 42) { ... }";
		const matches = [match(1, "if (x === 42)")];
		const fixturePath = "src/__fixtures__/sample.ts";
		expect(
			applyVerifyPasses(
				"magic_literal_in_conditional",
				matches,
				content,
				fixturePath,
			),
		).toEqual([]);
	});
});
