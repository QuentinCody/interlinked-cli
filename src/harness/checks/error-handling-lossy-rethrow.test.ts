// Companion tests for the lossy-rethrow / inconsistent-strategy cluster
// extracted out of error-handling.ts (line-cap burn-down). Full behavioral
// coverage for these exports already lives in error-handling.test.ts and
// error-handling.mutation-kill-w53.test.ts (importing via the parent's
// re-export) — this is a smoke test proving the moved code still works when
// imported directly from its new home.
import { describe, expect, it } from "vitest";
import {
	blankStringLiteralsPreserveLength,
	checkInconsistentErrorStrategy,
	checkLossyErrorRethrow,
} from "./error-handling-lossy-rethrow.js";

const TS = "src/lib/foo.ts";

describe("blankStringLiteralsPreserveLength — positive (must fire)", () => {
	it("P1: blanks a double-quoted string's contents, preserving length", () => {
		const out = blankStringLiteralsPreserveLength('x = "abc";');
		expect(out).toBe('x = "   ";');
		expect(out.length).toBe('x = "abc";'.length);
	});
});

describe("blankStringLiteralsPreserveLength — negative (must not fire)", () => {
	it("N1: leaves code with no string literals unchanged", () => {
		expect(blankStringLiteralsPreserveLength("x = 1 + 2;")).toBe("x = 1 + 2;");
	});
});

describe("checkLossyErrorRethrow — positive (must fire)", () => {
	it("P1: flags throw new Error in catch without { cause }", () => {
		const code = ["function f() {", "  try {}", "  catch (e) {", "    throw new Error('wrapped');", "  }", "}"].join(
			"\n",
		);
		const matches = checkLossyErrorRethrow(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("without { cause: e }");
	});
});

describe("checkLossyErrorRethrow — negative (must not fire)", () => {
	it("N1: does not flag throw new Error with { cause: e }", () => {
		const code = [
			"function f() {",
			"  try {}",
			"  catch (e) {",
			"    throw new Error('wrapped', { cause: e });",
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("N2: skips test files", () => {
		const code = "catch (e) { throw new Error('x'); }";
		expect(checkLossyErrorRethrow(code, "src/lib/foo.test.ts")).toEqual([]);
	});
});

describe("checkInconsistentErrorStrategy — positive (must fire)", () => {
	it("P1: flags a file mixing throw, return null, and return {error}", () => {
		const lines = [
			"function a() { throw new Error('x'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return { error: true }; }",
		];
		while (lines.length < 20) lines.push(`// pad ${lines.length}`);
		const matches = checkInconsistentErrorStrategy(lines.join("\n"), TS);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("3 different error strategies");
	});
});

describe("checkInconsistentErrorStrategy — negative (must not fire)", () => {
	it("N1: does not flag a file using only one strategy", () => {
		const lines = ["function a() { throw new Error('x'); }", "function b() { throw new Error('y'); }"];
		while (lines.length < 20) lines.push(`// pad ${lines.length}`);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), TS)).toEqual([]);
	});

	it("N2: skips short files (< 20 lines)", () => {
		const code = "throw new Error('x');\nreturn null;\nreturn { error: true };";
		expect(checkInconsistentErrorStrategy(code, TS)).toEqual([]);
	});
});
