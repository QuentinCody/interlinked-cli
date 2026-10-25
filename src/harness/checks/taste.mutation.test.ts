// Mutation-hardening tests for taste.ts. Each test states the intended
// behavior documented in the JSDoc of the function under test (cited per test)
// and was written to kill a surviving mutant of the module.
import { describe, expect, it } from "vitest";
import {
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkFunctionArity,
	checkManyOptionalParams,
	checkPositionalOptionalBoolean,
} from "./taste.js";

describe("checkBooleanTrap — documented skips and thresholds", () => {
	// taste.ts JSDoc: "Only runs on JS/TS files. Skips test files."
	it("returns no matches for a test file even when the call has two boolean literals", () => {
		expect(checkBooleanTrap("createUser(true, false);", "src/foo.test.ts")).toEqual([]);
	});

	// taste.ts JSDoc: "Detect function calls with 2+ boolean literal arguments"
	it("does not flag a call with a single boolean literal argument", () => {
		expect(checkBooleanTrap('createUser("alice", true);', "src/foo.ts")).toEqual([]);
	});

	it("flags a call with exactly two boolean literal arguments", () => {
		expect(checkBooleanTrap('createUser("alice", true, false);', "src/foo.ts")).toHaveLength(1);
	});

	// InlineMatch.line is 1-based (same convention the existing generic-type test pins).
	it("reports the 1-based line number and the trimmed original line text", () => {
		const src = ["const a = 1;", "const b = 2;", "  setFlags(true, false);  "].join("\n");
		const matches = checkBooleanTrap(src, "src/foo.ts");
		expect(matches).toEqual([{ line: 3, text: "setFlags(true, false);" }]);
	});
});

describe("checkFunctionArity — what counts as a function and where it is reported", () => {
	// taste.ts JSDoc: "Detect functions with more than 4 parameters" — a plain call is not a function.
	it("does not flag a call expression that passes five arguments", () => {
		expect(checkFunctionArity("doThing(a, b, c, d, e);", "src/foo.ts")).toEqual([]);
	});

	it("reports the 1-based line of the function signature that has five parameters", () => {
		const src = ["const x = 1;", "", "function foo(a, b, c, d, e) { return a; }"].join("\n");
		const matches = checkFunctionArity(src, "src/foo.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(3);
	});

	it("does not flag a function with four parameters", () => {
		expect(checkFunctionArity("function foo(a, b, c, d) { return a; }", "src/foo.ts")).toEqual([]);
	});
});

describe("checkPositionalOptionalBoolean — documented shapes", () => {
	// JSDoc: "Skips: ... Test files, non-JS/TS files."
	it("returns no matches for a test file", () => {
		expect(checkPositionalOptionalBoolean("function f(flag?: boolean) {}", "src/foo.test.ts")).toEqual(
			[],
		);
	});

	// JSDoc: "Fires on three shapes: `flag: boolean = false` (typed default)"
	it("flags a typed default boolean parameter", () => {
		const matches = checkPositionalOptionalBoolean("function f(flag: boolean = false) {}", "src/foo.ts");
		expect(matches).toHaveLength(1);
	});

	// JSDoc: "`flag = false` (inferred default)"
	it("flags an inferred-default boolean parameter", () => {
		const matches = checkPositionalOptionalBoolean("function f(flag = false) {}", "src/foo.ts");
		expect(matches).toHaveLength(1);
	});

	// JSDoc: "`flag?: boolean` (TS optional marker)" — a boolean that is not the first parameter.
	it("flags an optional boolean that follows another positional parameter", () => {
		const matches = checkPositionalOptionalBoolean(
			"function f(name: string, flag?: boolean) {}",
			"src/foo.ts",
		);
		expect(matches).toHaveLength(1);
	});

	// JSDoc: "Union types (`flag?: boolean | null`) — kept narrow to avoid FP"
	it("does not flag a union-typed optional boolean", () => {
		expect(checkPositionalOptionalBoolean("function f(flag?: boolean | null) {}", "src/foo.ts")).toEqual(
			[],
		);
	});

	// Source comment: "one match per function is enough"
	it("reports one match per function even when several parameters qualify", () => {
		const matches = checkPositionalOptionalBoolean(
			"function f(a?: boolean, b?: boolean, c = true) {}",
			"src/foo.ts",
		);
		expect(matches).toHaveLength(1);
	});

	// JSDoc: "Required positional booleans (`flag: boolean`) — checkBooleanTrap catches ..."
	it("does not flag a required boolean parameter", () => {
		expect(checkPositionalOptionalBoolean("function f(flag: boolean) {}", "src/foo.ts")).toEqual([]);
	});
});

describe("checkManyOptionalParams — what counts as optional", () => {
	// JSDoc: "Detect function signatures with 3+ optional parameters."
	it("does not flag a function with exactly two optional parameters", () => {
		expect(checkManyOptionalParams("function f(a?: number, b?: number) {}", "src/foo.ts")).toEqual([]);
	});

	it("flags a function with exactly three optional parameters", () => {
		expect(
			checkManyOptionalParams("function f(a?: number, b?: number, c?: number) {}", "src/foo.ts"),
		).toHaveLength(1);
	});

	// JSDoc: "Skips: test files, non-JS/TS files."
	it("returns no matches for a test file", () => {
		expect(
			checkManyOptionalParams("function f(a?: number, b?: number, c?: number) {}", "src/foo.test.ts"),
		).toEqual([]);
	});

	// JSDoc: '"Optional" = `?:` (TS optional marker) OR `=` default value'
	it("counts parameters with `=` defaults as optional", () => {
		expect(checkManyOptionalParams("function f(a = 1, b = 2, c = 3) {}", "src/foo.ts")).toHaveLength(1);
	});

	// A conditional type's `?` is not the `?:` optional marker.
	it("does not count a conditional-type annotation as an optional parameter", () => {
		const src = "function f(a: T extends U ? X : Y, b: T extends U ? X : Y, c: T extends U ? X : Y) {}";
		expect(checkManyOptionalParams(src, "src/foo.ts")).toEqual([]);
	});

	// The `=>` of a function type is not a `=` default.
	it("does not count function-typed parameters as having defaults", () => {
		const src = "function f(a?: number, b?: number, cb: () => void) {}";
		expect(checkManyOptionalParams(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkCatchAndIgnore — multi-line catch bodies", () => {
	// JSDoc: "`catch(e) { return null }` pretends everything is fine."
	it("flags a multi-line catch block that only returns a default value", () => {
		const src = ["try {", "  work();", "} catch (e) {", "  return null;", "}"].join("\n");
		const matches = checkCatchAndIgnore(src, "src/foo.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(3);
	});

	// collectCatchBody JSDoc: "Collect a catch block's body text (up to 8 lines)"
	it("still sees a default return on the eighth line of the catch window", () => {
		const src = [
			"try { a(); } catch (e) {",
			"  step();",
			"  step();",
			"  step();",
			"  step();",
			"  step();",
			"  step();",
			"  return null;",
			"}",
		].join("\n");
		expect(checkCatchAndIgnore(src, "src/foo.ts")).toHaveLength(1);
	});

	// collectCatchBody JSDoc: "tracking brace depth to find the matching close."
	it("stops reading the body at the matching close brace", () => {
		const src = ["catch (e) {", "  return null;", "}", "const x = 1;"].join("\n");
		expect(checkCatchAndIgnore(src, "src/foo.ts")).toHaveLength(1);
	});

	// JSDoc: "Skips: ... catch blocks with explanatory comments."
	it("does not flag a default-return catch that carries an explanatory comment", () => {
		const src = ["try {", "  work();", "} catch (e) {", "  // intentionally ignored", "  return null;", "}"].join(
			"\n",
		);
		expect(checkCatchAndIgnore(src, "src/foo.ts")).toEqual([]);
	});

	// isHandledCatchBody comment: "loose prefix matching so reportError, logWarning, etc. are caught"
	it("recognizes logging calls regardless of letter case", () => {
		const src = "try { work(); } catch (e) { LogWarning(e); return null; }";
		expect(checkCatchAndIgnore(src, "src/foo.ts")).toEqual([]);
	});

	// Source comment: "Find the catch block's opening brace (skip the } from try block)"
	it("judges only the catch body, not handling words inside the try block", () => {
		const src = "try { log(x); } catch (e) { return null; }";
		expect(checkCatchAndIgnore(src, "src/foo.ts")).toHaveLength(1);
	});
});
