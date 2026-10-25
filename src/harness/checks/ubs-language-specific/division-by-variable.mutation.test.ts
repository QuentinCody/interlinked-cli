// Campaign A mutation-hardening tests for `division-by-variable.ts`.
// Each case pins behavior stated in the module's doc comments (cited per test)
// and kills a specific surviving mutant of the module.
import { describe, expect, it } from "vitest";
import { checkDivisionByVariable } from "./division-by-variable.js";

describe("checkDivisionByVariable — behavior pinned by module docs", () => {
	// division-by-variable.ts:64-69 — the Path-join suppression is a PYTHON rule.
	it("does not apply the pathlib Path-join suppression to non-Python files", () => {
		const code = "const base = Path('/tmp');\nconst target = base / sub;";
		expect(checkDivisionByVariable(code, "paths.ts")).toEqual([
			{ line: 2, text: "const target = base / sub;" },
		]);
	});

	// division-by-variable.ts:41-43 — comments and strings are stripped first.
	it("ignores division-looking text inside string literals", () => {
		expect(checkDivisionByVariable('const s = "total / count";', "calc.ts")).toEqual([]);
	});

	// division-by-variable.ts:239 — `if (divisor > 0) {` is a recognized enclosing guard.
	it("treats a preceding `if (n > 0) {` as an enclosing guard", () => {
		const code = "function f(n) {\n  if (n > 0) {\n    return total / n;\n  }\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	// division-by-variable.ts:240-241 — the Python guard is an OPEN `if n > 0:`;
	// a one-line `if n > 0: stmt` does not enclose the following line.
	it("does not treat a one-line `if n > 0: stmt` as enclosing the next line", () => {
		const code = "def f(n):\n    if n > 0: log()\n    return total / n";
		expect(checkDivisionByVariable(code, "calc.py")).toEqual([
			{ line: 3, text: "return total / n" },
		]);
	});

	// division-by-variable.ts:241 — Python falsy guard `if not divisor: return`.
	it("treats a preceding `if not n: return` as a falsy guard", () => {
		const code = "def f(n):\n    if not n: return 0\n    return total / n";
		expect(checkDivisionByVariable(code, "calc.py")).toEqual([]);
	});

	// division-by-variable.ts:242-243 — fallback default `divisor ||= 1`.
	it("treats a preceding `n ||= 1` as a fallback-default guard", () => {
		const code = "function f(n) {\n  n ||= 1;\n  return total / n;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	// division-by-variable.ts:242-243 — fallback default `divisor = divisor or 1`.
	it("treats a preceding `n = n or 1` as a fallback-default guard", () => {
		const code = "def f(n):\n    n = n or 1\n    return total / n";
		expect(checkDivisionByVariable(code, "calc.py")).toEqual([]);
	});
});
