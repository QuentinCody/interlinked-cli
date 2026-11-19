// Mutation-kill campaign (wave 29, pass1). Targets specific SURVIVED mutants
// listed in .interlinked/mutation-manifest.json for b-series.ts. Each case
// hand-traces pristine behavior vs. the named mutant and asserts the exact
// pristine result.

import { describe, expect, it } from "vitest";
import {
	checkAssertionFreeTests,
	checkInfiniteRecursion,
	checkSyncIoInAsync,
	checkUnreachableCode,
} from "./b-series.js";

describe("checkUnreachableCode — mutation-kill w29", () => {
	// test-contract: bug — kill mutant 1396946458dbfef5 — isIncompleteReturnOrThrow's
	// `!/^return\b/.test(trimmed) && !/^throw\b/.test(trimmed)` forced to `false`.
	// A break/continue line embedding "foo(" after the semicolon is treated as
	// a *complete* statement in original (first branch short-circuits to
	// `return false`); the mutant instead falls through to the bracket-ending
	// check, sees the trailing "(" and marks it incomplete, suppressing the
	// unreachable-code report entirely.
	it("still flags unreachable code after `break; foo(` even though it looks bracket-open", () => {
		const content = ["function f() {", "  break; foo(", "  bar();", "}", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "bar();" }]);
	});

	// test-contract: bug — kill mutant b789b5948b495988 — `/^return\b/` unanchored to
	// `/return\b/` inside isIncompleteReturnOrThrow. A `continue;`-prefixed line
	// that later embeds "return value(" doesn't start with "return", so the
	// original anchored test is false and the whole guard short-circuits to
	// "not incomplete." The unanchored mutant instead matches the embedded
	// "return", flips the guard, and the trailing "(" then marks it incomplete.
	it("still flags unreachable code after `continue; return value(`", () => {
		const content = ["function f() {", "  continue; return value(", "  bar();", "}", "}"].join(
			"\n",
		);
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "bar();" }]);
	});

	// test-contract: bug — kill mutant aade25508b6a2df0 — `/^throw\b/` unanchored to
	// `/throw\b/`. Symmetric to the return case above but via `throw` embedded
	// after a `continue;` prefix.
	it("still flags unreachable code after `continue; throw err(`", () => {
		const content = ["function f() {", "  continue; throw err(", "  bar();", "}", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "bar();" }]);
	});

	// test-contract: bug — kill mutant f554c3bb22bb7e3c — `/^return\s*[?:]/` (the
	// interface-property-declaration skip) unanchored to `/return\s*[?:]/`.
	// A real, complete `return` statement whose line ALSO happens to embed
	// "return:" further along (e.g. via `x.return: 2;`) must still be treated
	// as a real return statement by the anchored original (skip-check false,
	// since the property pattern isn't at position 0) and reported as
	// followed by unreachable code. The unanchored mutant matches the
	// embedded occurrence and wrongly treats the whole line as a property
	// declaration, skipping it and losing the unreachable-code report.
	it("still flags unreachable code after a real `return` whose line embeds `return:` later", () => {
		const content = ["function f() {", "  return 1; x.return: 2;", "  doStuff();", "}"].join(
			"\n",
		);
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "doStuff();" }]);
	});

	// test-contract: bug — kill mutant 7b30c179f600c096 — `indent < 0` weakened to
	// `indent <= 0`. A return/throw statement at column 0 (indent === 0) must
	// still be scanned for unreachable code that follows it; the mutant's
	// `<= 0` treats indent-0 as "invalid" and skips the line entirely.
	it("still flags unreachable code after a column-0 (unindented) return statement", () => {
		const content = "return 1;\ndoStuff();";
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 2, text: "doStuff();" }]);
	});
});

describe("checkAssertionFreeTests — mutation-kill w29", () => {
	// test-contract: bug — kill mutant a6687bf0801b4e4b — a `false` boolean literal in
	// the test-tracking state machine (inTestBlock init and/or the
	// hasAssertion reset on entering a new test block) flipped to `true`.
	// Two back-to-back it() blocks — first WITH an assertion, second WITHOUT —
	// exercise both the "does this block correctly start fresh" path (a stuck
	// `inTestBlock=true` would never recognize the first `it(` as an entry and
	// would misattribute an empty `testName`) and the per-entry reset (a
	// `hasAssertion` that never resets to false would let the assertion-free
	// second block slip through unflagged). Only the second block should be
	// reported, with its real name and line.
	it("flags only the assertion-free block among two sequential it() blocks", () => {
		const content = [
			"it('has assertion', () => {",
			"  expect(1).toBe(1);",
			"});",
			"it('missing assertion', () => {",
			"  doStuff();",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([
			{ line: 4, text: "it('missing assertion', () => {" },
		]);
	});

	// test-contract: bug — kill mutant f1c193def82d23a3 — `/\bthrows\s*\(/` (zero-or-
	// more whitespace before the paren) narrowed to `/\bthrows\s\(/` (exactly
	// one whitespace char required). A `throws(` call with NO space before the
	// paren is a valid assertion under the original (zero whitespace allowed)
	// but is missed by the mutant, which would wrongly flag the block.
	// The line scanner these mutants lived in is gone: checkAssertionFreeTests now delegates to the registered
	// detector, which counts `throws` only when it is BOUND to an assert module (an unbound `throws(fn)` may be
	// any local helper). The contract pinned here is that bound form, with and without the space.
	it("recognizes `throws(` with no space before the paren as an assertion", () => {
		const content = ['import { throws } from "node:assert";', "it('does something', () => {", "  throws(fn);", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	// test-contract: bug — kill mutant 3fdbe332fe66128d — the same `/\bthrows\s*\(/`
	// widened to `/\bthrows\S*\(/` (non-whitespace run instead of whitespace).
	// A `throws (` call WITH a space before the paren is valid under the
	// original (\s* allows any amount of whitespace) but the mutant's \S*
	// cannot consume the space and then fails to see the required `(`
	// immediately after, so it wrongly flags the block.
	it("recognizes `throws (` with a space before the paren as an assertion", () => {
		const content = ['import { throws } from "node:assert";', "it('does something', () => {", "  throws (fn);", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});
	// test-contract: public-api — the registered assertion_free_test detector counts `throws` as an assertion only
	// when it is bound to an assert module; an unbound `throws(fn)` may be any local helper and asserts nothing.
	it("an UNBOUND `throws(fn)` is not an assertion (one implementation: the registered detector's contract)", () => {
		const content = ["it('does something', () => {", "  throws(fn);", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([{ line: 1, text: "it('does something', () => {" }]);
	});
});

describe("checkInfiniteRecursion — mutation-kill w29", () => {
	// test-contract: bug — kill mutants fb2fb1ec4752c6b8 (`initialBraceDepth <= 0`
	// forced to `false`) and 4f7be1564d288a17 (`initialBraceDepth <= 0`
	// weakened to `initialBraceDepth < 0`). Both make the guard fail to skip a
	// one-liner function definition whose braces already close on the
	// definition line (`initialBraceDepth === 0`). A same-named call appearing
	// in unrelated code AFTER that one-liner — with no guard-looking line in
	// between — must NOT be reported by the pristine code (it deliberately
	// skips one-liner defs since their own body has no interesting recursion
	// to scan); both mutants instead scan past the one-liner into the
	// following bare block and wrongly report the later call as an unguarded
	// self-call.
	it("does not scan past a one-liner function definition for a later unrelated call", () => {
		const content = ["function f() {}", "{", "  f();", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});
});

describe("checkSyncIoInAsync — mutation-kill w29", () => {
	// test-contract: bug — kill mutant 706ab46f6cb84e6a — `/=\s*async\s*(\(|[^=])/`
	// (zero-or-more whitespace right after `=`) narrowed to
	// `/=\sasync\s*(\(|[^=])/` (exactly one whitespace char required). An
	// arrow-function assignment with NO space between `=` and `async`
	// (`=async(`) is recognized as entering an async function by the
	// original; the mutant's required single whitespace can never match zero
	// spaces, so it never marks the function as async and the sync
	// filesystem call inside is never reported.
	it("still detects an async arrow function with no space before `async` (`=async(`)", () => {
		const content = ["const foo =async(x) => {", "  readFileSync('a');", "};"].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([
			{ line: 2, text: "readFileSync('a');" },
		]);
	});

	// test-contract: bug — kill mutant 9f7de9456969dec4 — the second `\s*` (between
	// `async` and the following group) widened to `\S*` (non-whitespace run).
	// `\S*` can greedily consume a stray literal `=` immediately after
	// `async` (since `=` is non-whitespace) and then match the following `(`
	// via the group's `(\(|[^=])` alternation — something the original's
	// whitespace-only `\s*` cannot do (it can't consume a non-whitespace `=`,
	// and the required group then fails to match that same `=`). So an
	// (admittedly malformed) `async=(` construct is wrongly recognized as
	// async-entry by the mutant but not by the original.
	it("does not treat a stray `async=(` as entering an async function", () => {
		const content = ["x = async=(y) => {", "  readFileSync('a');", "};"].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([]);
	});

	// test-contract: bug — kill mutant 039c25756a42f839 — the `inAsyncFn` variable
	// reference in the sync-IO-check condition forced to the literal `true`.
	// A sync filesystem call inside a plain, non-async function must not be
	// reported by the original (inAsyncFn stays false throughout); the mutant
	// checks the sync-IO pattern unconditionally and wrongly reports it.
	it("does not flag a sync filesystem call inside a non-async function", () => {
		const content = ["function regular() {", "  readFileSync('a');", "}"].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([]);
	});
});

describe("checkInfiniteRecursion — lineLooksLikeGuard mutation-kill w29", () => {
	// test-contract: bug — kill mutant fa57784ac4a373bb — `/[!=]==?/` (comparison
	// detector inside the unexported lineLooksLikeGuard helper) negated to
	// `/[^!=]==?/`. Exercised indirectly through checkInfiniteRecursion: a
	// guard-candidate line consisting of a comparison at the very start of
	// the (trimmed) line — "==foo", with no other guard-looking feature and
	// no character preceding the leading "==" — is recognized as a guard by
	// the original (`[!=]` matches the first "=", literal "=" matches the
	// second). The negated class requires some OTHER character immediately
	// before a "=", which doesn't exist at the start of the string, so the
	// mutant fails to recognize it as a guard and wrongly reports the
	// following self-call as unguarded.
	it("treats a bare `==foo` line as a guard, suppressing the later self-call report", () => {
		const content = ["function outerRecursive() {", "  ==foo", "  outerRecursive();", "}"].join(
			"\n",
		);
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});
});
