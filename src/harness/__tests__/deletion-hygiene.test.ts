import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkDeletionCommentAdded,
	checkDeprecationAdded,
	checkOrphanedTests,
	checkReplacedWithStub,
	checkTestGutted,
} from "../deletion-hygiene.js";

// ===========================================
// Layer 2: Diff-Aware Zombie Detectors
// ===========================================

describe("checkReplacedWithStub", () => {
	it("detects working code replaced with throw Not implemented", () => {
		const oldStr =
			"function process(data) {\n  if (data.valid) {\n    return transform(data);\n  }\n  return fallback();\n}";
		const newStr = 'function process(data) {\n  throw new Error("Not implemented");\n}';
		const findings = checkReplacedWithStub(oldStr, newStr, "handler.ts");
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("replaced-with-stub");
	});

	it("detects working code replaced with return null", () => {
		const oldStr =
			"function getData() {\n  const res = await fetch(url);\n  if (!res.ok) throw new Error();\n  return res.json();\n}";
		const newStr = "function getData() {\n  return null;\n}";
		const findings = checkReplacedWithStub(oldStr, newStr, "api.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT flag when old code was already trivial", () => {
		const oldStr = "function noop() {\n  return;\n}";
		const newStr = "function noop() {\n  return null;\n}";
		expect(checkReplacedWithStub(oldStr, newStr, "util.ts")).toEqual([]);
	});

	it("does NOT flag when new code has real logic", () => {
		const oldStr = "function old() {\n  if (x) return a;\n  return b;\n}";
		const newStr = "function updated() {\n  if (y) return c;\n  return d;\n}";
		expect(checkReplacedWithStub(oldStr, newStr, "handler.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const oldStr = "function process() {\n  if (x) return a;\n  return b;\n}";
		const newStr = 'function process() {\n  throw new Error("Not implemented");\n}';
		expect(checkReplacedWithStub(oldStr, newStr, "handler.test.ts")).toEqual([]);
	});

	it("message reports the exact old-line count", () => {
		const oldStr = "function process(data) {\n  if (data.valid) {\n    return transform(data);\n  }\n  return fallback();\n}";
		const newStr = 'function process(data) {\n  throw new Error("Not implemented");\n}';
		const findings = checkReplacedWithStub(oldStr, newStr, "handler.ts");
		// 6 non-blank lines in oldStr, counted before any brace-stripping.
		expect(nonNull(findings[0]).message).toBe(
			"Working code (6 lines) was replaced with a stub. If removing this function, delete it entirely instead of stubbing it out.",
		);
	});

	it("does NOT flag when old code has only a single substantive line, even with control flow", () => {
		// hasRealCode requires >= 2 non-structural lines; a single-line body
		// never qualifies as "real code" regardless of its content.
		const oldStr = "if (x) { return 1; }";
		const newStr = "throw new Error('Not implemented');";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts")).toEqual([]);
	});

	it("flags at the exact boundary of two substantive control-flow lines", () => {
		// Exactly 2 lines survive brace-stripping and each independently
		// matches a code indicator -- this is the >= 2 threshold, not > 2.
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "return null;";
		const findings = checkReplacedWithStub(oldStr, newStr, "a.ts");
		expect(findings.length).toBe(1);
	});

	it("does NOT count a stray closing brace-semicolon line as real code", () => {
		// "};" alone must be stripped before counting lines/indicators --
		// otherwise a single real statement plus a stray "};" would look
		// like two lines, and "};" itself matches the indicator regex.
		const oldStr = "return x;\n};";
		const newStr = "return null;";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts")).toEqual([]);
	});

	it("does NOT count a stray opening or closing brace line as real code", () => {
		const oldStrOpen = "return x;\n{";
		const oldStrClose = "return x;\n}";
		const newStr = "return null;";
		expect(checkReplacedWithStub(oldStrOpen, newStr, "a.ts")).toEqual([]);
		expect(checkReplacedWithStub(oldStrClose, newStr, "a.ts")).toEqual([]);
	});

	it("recognizes 'return <value>' as an indicator even with more than one space", () => {
		const oldStr = "return  y;\nconst z = 1;";
		const newStr = "return null;";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("recognizes a brace/semicolon indicator with zero characters before the trailing non-space char", () => {
		const oldStr = "const z = 1;\n}x;";
		const newStr = "return null;";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("recognizes a brace/semicolon indicator when a real space separates it from the trailing char", () => {
		const oldStr = "const z = 1;\n} x;";
		const newStr = "return null;";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("recognizes each control-flow/declaration keyword as a code indicator", () => {
		// Each of these lines individually matches the indicator regex via a
		// different keyword alternative; paired with any second matching
		// line they push codeLineCount to the >=2 threshold.
		const keywordLines = [
			"for (const x of xs) log(x);",
			"while (running) tick();",
			"switch (mode) { case 1: break; }",
			"try { risky(); } catch (e) { handle(e); }",
			"const value = compute();",
			"let value = compute();",
			"var value = compute();",
			"await settle();",
		];
		for (const line of keywordLines) {
			const oldStr = `${line}\nconst other = 2;`;
			const newStr = "return null;";
			const findings = checkReplacedWithStub(oldStr, newStr, "a.ts");
			expect(findings.length).toBe(1);
		}
	});

	it("does NOT flag when replacement is a throw stub mentioning fixme", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "throw new Error('fixme: handle this');";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("recognizes each stub-return form (undefined, [], {}, false, void 0, bare return)", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const stubs = ["return undefined;", "return [];", "return {};", "return false;", "return void 0;", "return;"];
		for (const stub of stubs) {
			expect(checkReplacedWithStub(oldStr, stub, "a.ts").length).toBe(1);
		}
	});

	it("recognizes a bare throw stub without `new Error`", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		expect(checkReplacedWithStub(oldStr, "throw 'todo';", "a.ts").length).toBe(1);
		expect(checkReplacedWithStub(oldStr, 'throw "stub";', "a.ts").length).toBe(1);
	});

	it("strips a function/arrow signature wrapper before judging the body a stub", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		expect(
			checkReplacedWithStub(oldStr, "export async function foo() {\n  return null;\n}", "a.ts").length,
		).toBe(1);
		expect(
			checkReplacedWithStub(oldStr, "const foo = async (x) => {\n  return null;\n}", "a.ts").length,
		).toBe(1);
		expect(checkReplacedWithStub(oldStr, "foo(x) {\n  return null;\n}", "a.ts").length).toBe(1);
	});

	it("strips a dangling `);` continuation line before judging the body a stub", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = ");\nreturn null;";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("does not count an untrimmed stray brace-line in the REPLACEMENT body as real content (isStubContent trim matters)", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "return null;\n }; ";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("does NOT flag a replacement body with more than 2 substantive lines", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "doThing();\nreturn null;\nconsole.log('done');";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts")).toEqual([]);
	});

	// KNOWN DEFECT, asserted as the INTENDED behavior and expected to fail.
	//
	// `throwStub` and `bareThrow` in `isStubContent` have no trailing `$`, so a
	// throw-stub line followed by real code still reads as "replaced with a
	// stub" — a false positive from a detector whose whole job is accusing an
	// agent of gutting a function.
	//
	// Written as `it.fails` on purpose. The obvious alternative — asserting the
	// CURRENT buggy result so the test passes — cements the defect: whoever adds
	// the `$` anchor then has to edit a green test, indistinguishable from
	// breaking a real invariant. This way the suite documents the INTENT, stays
	// green while the bug exists, and the moment someone fixes the anchor
	// `it.fails` itself goes red — turning the fix into a forcing function to
	// flip this to a normal assertion rather than a silent regression risk.
	// Tracked as a source defect; see the campaign task ledger.
	it.fails("throw-stub followed by real code should NOT be flagged as a stub", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = 'throw new Error("not implemented");\nextra1();';
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts")).toEqual([]);
	});

	it("source field is 'quality'", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "return null;";
		const findings = checkReplacedWithStub(oldStr, newStr, "a.ts");
		expect(nonNull(findings[0]).source).toBe("quality");
	});

	it("does not let a whitespace-only or blank line dodge the reported old-line count", () => {
		// hasRealCode still sees >= 2 substantive lines ("if (x) {" and
		// "return 1;"); the message's own line-counter has a SEPARATE filter
		// that must also correctly discount blank/whitespace-only lines.
		const oldStr = "if (x) {\n\n   \n  return 1;\n}";
		const newStr = "return null;";
		const findings = checkReplacedWithStub(oldStr, newStr, "a.ts");
		expect(nonNull(findings[0]).message).toBe(
			"Working code (3 lines) was replaced with a stub. If removing this function, delete it entirely instead of stubbing it out.",
		);
	});

	it("does not count an untrimmed stray brace-line as real code (hasRealCode trim matters)", () => {
		const oldStr = "return x;\n }; ";
		const newStr = "return null;";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts")).toEqual([]);
	});

	it("recognizes 'return' and its value split across two lines only when a real space joins them", () => {
		// isStubContent joins surviving lines with a literal space; without
		// it, "return" and "null;" would concatenate into "returnnull;",
		// which fails the returnDefault regex's mandatory \s+.
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "return\nnull;";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("does not let blank lines dodge the stub-body line-count cap", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "\n\nreturn null;";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("does not let stray structural brace/paren lines dodge the stub-body line-count cap", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		for (const stray of ["{", "}", "};", ");"]) {
			const newStr = `${stray}\nreturn null;`;
			expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
		}
	});

	it("treats a wholly-structural replacement body (nothing survives stripping) as a stub", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "{\n}";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts").length).toBe(1);
	});

	it("does NOT treat a 3-real-line replacement as a stub even when the first line alone would match", () => {
		// throwStub has no trailing $, so it would match a body whose FIRST
		// line alone is a throw-stub; the length > 2 gate must still reject
		// once there are 3 independently-surviving real lines.
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = 'throw new Error("not implemented");\nextra1();\nextra2();';
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts")).toEqual([]);
	});

	it("unanchored function-signature regex would over-match a corrupted-looking line -- confirm it does NOT", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		const newStr = "xfunction foo() {\n  return null;\n}";
		expect(checkReplacedWithStub(oldStr, newStr, "a.ts")).toEqual([]);
	});

	it("requires the export/async keywords be followed by real whitespace, not a single fixed space, when stripping a signature", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		expect(
			checkReplacedWithStub(oldStr, "export  function foo() {\n  return null;\n}", "a.ts")
				.length,
		).toBe(1);
		expect(
			checkReplacedWithStub(oldStr, "async  function foo() {\n  return null;\n}", "a.ts").length,
		).toBe(1);
		expect(
			checkReplacedWithStub(oldStr, "function  foo() {\n  return null;\n}", "a.ts").length,
		).toBe(1);
	});

	it("strips an arrow-function const/let/var wrapper across its space/anchor/optionality boundaries", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		// anchor: garbage prefix must NOT be swallowed by an unanchored regex
		expect(
			checkReplacedWithStub(oldStr, "xconst foo = (\n  return null;\n);", "a.ts"),
		).toEqual([]);
		// zero-or-more space before identifier, before "=", and after "="
		expect(
			checkReplacedWithStub(oldStr, "const  foo = (\n  return null;\n);", "a.ts").length,
		).toBe(1);
		expect(
			checkReplacedWithStub(oldStr, "const foo=(\n  return null;\n);", "a.ts").length,
		).toBe(1);
		expect(
			checkReplacedWithStub(oldStr, "const foo =(\n  return null;\n);", "a.ts").length,
		).toBe(1);
		// the "async" keyword clause is genuinely OPTIONAL
		expect(
			checkReplacedWithStub(oldStr, "const foo = (\n  return null;\n);", "a.ts").length,
		).toBe(1);
		// and when present, "async" needs real whitespace before "("
		expect(
			checkReplacedWithStub(oldStr, "const foo = async  (\n  return null;\n);", "a.ts").length,
		).toBe(1);
	});

	it("recognizes throw-stub content across the throwStub regex's space/anchor boundaries", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		// anchor: garbage-prefixed line must not be treated as content, so
		// the whole 2-line body fails to reduce to a clean stub.
		expect(
			checkReplacedWithStub(oldStr, "doOtherThing();\nthrow new Error('not implemented');", "a.ts"),
		).toEqual([]);
		// mandatory single space where the source allows one-or-more
		expect(
			checkReplacedWithStub(oldStr, "throw  new Error('not implemented');", "a.ts").length,
		).toBe(1);
		expect(
			checkReplacedWithStub(oldStr, "throw new  Error('not implemented');", "a.ts").length,
		).toBe(1);
		// zero-or-more space around "(" must allow both zero and a real space
		expect(
			checkReplacedWithStub(oldStr, "throw new Error ('not implemented');", "a.ts").length,
		).toBe(1);
		expect(
			checkReplacedWithStub(oldStr, "throw new Error( 'not implemented');", "a.ts").length,
		).toBe(1);
		// "not" and "implemented" may be joined with zero-or-more space
		expect(
			checkReplacedWithStub(oldStr, "throw new Error('notimplemented');", "a.ts").length,
		).toBe(1);
	});

	it("recognizes return-default stub content across the returnDefault regex's space/anchor/optionality boundaries", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		// missing trailing $ would let trailing garbage after the value slip through
		expect(
			checkReplacedWithStub(oldStr, "return null; doSomethingElse();", "a.ts"),
		).toEqual([]);
		// mandatory single space where the source allows one-or-more
		expect(checkReplacedWithStub(oldStr, "return  null;", "a.ts").length).toBe(1);
		expect(checkReplacedWithStub(oldStr, "return void  0;", "a.ts").length).toBe(1);
		// the trailing semicolon is genuinely OPTIONAL
		expect(checkReplacedWithStub(oldStr, "return null", "a.ts").length).toBe(1);
		// zero-or-more space before the (optional) semicolon must allow a real space
		expect(checkReplacedWithStub(oldStr, "return null ;", "a.ts").length).toBe(1);
	});

	it("recognizes a bare `return;` stub across the bareReturn regex's anchor/quantifier boundaries", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		expect(checkReplacedWithStub(oldStr, "doOtherThing();\nreturn;", "a.ts")).toEqual([]);
		expect(checkReplacedWithStub(oldStr, "return; doSomething();", "a.ts")).toEqual([]);
		expect(checkReplacedWithStub(oldStr, "return ;", "a.ts").length).toBe(1);
	});

	it("recognizes a bare throw-string stub across the bareThrow regex's space/anchor boundaries", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		expect(checkReplacedWithStub(oldStr, "doOtherThing();\nthrow 'todo';", "a.ts")).toEqual([]);
		expect(checkReplacedWithStub(oldStr, "throw  'todo';", "a.ts").length).toBe(1);
		expect(checkReplacedWithStub(oldStr, "throw 'notimplemented';", "a.ts").length).toBe(1);
		expect(checkReplacedWithStub(oldStr, "throw 'not implemented';", "a.ts").length).toBe(1);
	});

	it("strips a bare call-signature wrapper across its anchor/quantifier/optionality boundaries", () => {
		const oldStr = "if (x) {\n  return 1;\n}";
		// anchor
		expect(checkReplacedWithStub(oldStr, "!foo(x) {\n  return null;\n}", "a.ts")).toEqual([]);
		// [^)]* must allow ZERO chars (empty parens), not require exactly one
		expect(checkReplacedWithStub(oldStr, "foo() {\n  return null;\n}", "a.ts").length).toBe(1);
		// \s* before "(" must allow a real space, not forbid it
		expect(checkReplacedWithStub(oldStr, "foo (x) {\n  return null;\n}", "a.ts").length).toBe(1);
		// \s* before the optional brace must allow zero spaces
		expect(checkReplacedWithStub(oldStr, "foo(x){\n  return null;\n}", "a.ts").length).toBe(1);
		// the trailing brace is genuinely OPTIONAL
		expect(checkReplacedWithStub(oldStr, "foo(x)\n  return null;\n", "a.ts").length).toBe(1);
	});

	it("AUDIT: leading/trailing \\s*<->\\S* swaps on throwStub/returnDefault/bareReturn/bareThrow ARE observable when a real (non-whitespace) token abuts the stub literal directly -- these are NOT equivalent mutants", () => {
		// Prior art in this file assumed body is always separated from any
		// neighboring token by whitespace, so a \s*<->\S* swap can always
		// backtrack to zero and land the same verdict. That holds only when
		// SOMETHING whitespace-shaped actually separates the two -- when a
		// single surviving line glues a prefix or suffix directly onto the
		// stub literal with no space at all, \S* can consume the glued token
		// (a swap can't) and the swapped regex flips real code into a false
		// "stub" verdict. Each case here: real code must NOT be flagged.
		const oldStr = "if (x) {\n  return 1;\n}";
		// leading: garbage glued directly in front of the keyword
		expect(checkReplacedWithStub(oldStr, "xthrow new Error('not implemented')", "a.ts")).toEqual(
			[],
		);
		expect(checkReplacedWithStub(oldStr, "xreturn null;", "a.ts")).toEqual([]);
		expect(checkReplacedWithStub(oldStr, "xreturn ;", "a.ts")).toEqual([]);
		expect(checkReplacedWithStub(oldStr, "xthrow 'todo'", "a.ts")).toEqual([]);
		// trailing: real code glued directly after the stub with no space
		expect(checkReplacedWithStub(oldStr, "return null;extra();", "a.ts")).toEqual([]);
		expect(checkReplacedWithStub(oldStr, "return;extra();", "a.ts")).toEqual([]);
	});
});

describe("checkTestGutted", () => {
	it("detects test converted to it.skip", () => {
		const oldStr = 'it("validates input", () => {\n  expect(validate("x")).toBe(true);\n});';
		const newStr = `it.${"skip"}("validates input", () => {\n});`;
		const findings = checkTestGutted(oldStr, newStr, "validate.test.ts");
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("test-gutted");
	});

	it("detects test body emptied", () => {
		const oldStr =
			'it("parses JSON", () => {\n  const result = parse("{}");\n  expect(result).toEqual({});\n});';
		const newStr = 'it("parses JSON", () => {\n});';
		const findings = checkTestGutted(oldStr, newStr, "parser.test.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT flag when assertions remain", () => {
		const oldStr = 'it("adds", () => {\n  expect(1+1).toBe(2);\n  expect(2+2).toBe(4);\n});';
		const newStr = 'it("adds", () => {\n  expect(1+1).toBe(2);\n});';
		expect(checkTestGutted(oldStr, newStr, "math.test.ts")).toEqual([]);
	});

	it("does NOT flag non-test files", () => {
		const oldStr = 'it("validates", () => {\n  expect(true).toBe(true);\n});';
		const newStr = `it.${"skip"}("validates", () => {});`;
		expect(checkTestGutted(oldStr, newStr, "handler.ts")).toEqual([]);
	});

	it("does NOT flag when old code had no assertions", () => {
		const oldStr = 'it("logs", () => {\n  console.log("test");\n});';
		const newStr = 'it("logs", () => {});';
		expect(checkTestGutted(oldStr, newStr, "log.test.ts")).toEqual([]);
	});

	it("message reports the fixed gutted-test text verbatim", () => {
		const oldStr = 'it("validates input", () => {\n  expect(validate("x")).toBe(true);\n});';
		const newStr = 'it.skip("validates input", () => {\n});';
		const findings = checkTestGutted(oldStr, newStr, "validate.test.ts");
		expect(nonNull(findings[0]).message).toBe(
			"Test was gutted instead of deleted. If the feature is gone, delete the test entirely.",
		);
	});

	it("detects test.todo as a gutting conversion, not just it/test.skip", () => {
		const oldStr = 'test("validates input", () => {\n  expect(validate("x")).toBe(true);\n});';
		const newStr = 'test.todo("validates input");';
		expect(checkTestGutted(oldStr, newStr, "validate.test.ts").length).toBe(1);
	});

	it("recognizes assertions via .should. and .toEqual without requiring expect(", () => {
		const oldStr = 'it("checks", () => {\n  result.should.be.true;\n});';
		const newStr = 'it("checks", () => {});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("does NOT flag when the remaining gutted body has more than 2 structural lines", () => {
		// Body kept 3 non-structural/closing lines -- below the "gutted" line
		// threshold, so this must not fire even though assertions are gone.
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {\n  doA();\n  doB();\n  doC();\n});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts")).toEqual([]);
	});

	it("recognizes /__tests__/ and /tests/ directory paths as test files", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {});';
		expect(checkTestGutted(oldStr, newStr, "src/__tests__/thing.ts").length).toBe(1);
		expect(checkTestGutted(oldStr, newStr, "src/tests/thing.ts").length).toBe(1);
		expect(checkTestGutted(oldStr, newStr, "src/test/thing.ts").length).toBe(1);
	});

	it("does NOT treat an ordinary source path as a test file", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {});';
		expect(checkTestGutted(oldStr, newStr, "src/handlers/thing.ts")).toEqual([]);
	});

	it("source field is 'quality'", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {});';
		const findings = checkTestGutted(oldStr, newStr, "a.test.ts");
		expect(nonNull(findings[0]).source).toBe("quality");
	});

	it("does NOT treat a path merely ending in 'test.tsx.bak' as a test file (extension anchor matters)", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {});';
		expect(checkTestGutted(oldStr, newStr, "handler.test.tsx.bak")).toEqual([]);
	});

	it("recognizes an unlabeled assert() call, not just expect()/.toBe()-style matchers", () => {
		const oldStr = 'it("checks", () => {\n  assert(x === 1);\n});';
		const newStr = 'it("checks", () => {});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("recognizes assert()/expect() even with a space before the paren", () => {
		const oldStr = 'it("checks", () => {\n  assert (x === 1);\n});';
		const newStr = 'it("checks", () => {});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("flags at the exact boundary of 2 remaining gutted-body lines", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {\n  doA();\n});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("does not let a blank body line dodge the gutted-body line-count cap (unfiltered length must not be used)", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {\n\n  doA();\n});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("does not let a stray bare '}' body line dodge the gutted-body line-count cap", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {\n}\ndoA();\n});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("does not let a stray mid-body '});' line dodge the gutted-body line-count cap", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {\n});\ndoA();\n});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("does not let a stray bare '{' body line dodge the gutted-body line-count cap", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {\n{\ndoA();\n});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("trims each structural-line comparison independently -- a padded stray '}'/'});'/'{'  line must still be stripped", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		expect(
			checkTestGutted(oldStr, 'it("checks", () => {\n  }  \ndoA();\n});', "a.test.ts").length,
		).toBe(1);
		expect(
			checkTestGutted(oldStr, 'it("checks", () => {\n  });  \ndoA();\n});', "a.test.ts").length,
		).toBe(1);
		expect(
			checkTestGutted(oldStr, 'it("checks", () => {\n  {  \ndoA();\n});', "a.test.ts").length,
		).toBe(1);
	});

	it("does not let a whitespace-only body line dodge the gutted-body line-count cap (trim matters, not raw length)", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it("checks", () => {\n   \ndoA();\n});';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("detects it.todo() as a gutting conversion via the unanchored skip/todo regex", () => {
		const oldStr = 'it("checks", () => {\n  expect(a).toBe(1);\n});';
		const newStr = 'it.todo("checks");';
		expect(checkTestGutted(oldStr, newStr, "a.test.ts").length).toBe(1);
	});

	it("recognizes it.skip( even with a space before the paren", () => {
		const oldStr = 'it("validates input", () => {\n  expect(validate("x")).toBe(true);\n});';
		const newStr = 'it.skip ("validates input", () => {\n});';
		expect(checkTestGutted(oldStr, newStr, "validate.test.ts").length).toBe(1);
	});

	it("recognizes a bare it(/test( call with a space before the paren as an empty-body candidate", () => {
		const oldStr = 'it("validates input", () => {\n  expect(validate("x")).toBe(true);\n});';
		const newStr = 'it ("validates input", () => {\n});';
		expect(checkTestGutted(oldStr, newStr, "validate.test.ts").length).toBe(1);
	});
});

describe("checkDeprecationAdded", () => {
	it("detects new @deprecated annotation", () => {
		const oldStr = "/** Helper function */\nexport function old() { return 1; }";
		const newStr = "/** @deprecated */\nexport function old() { return 1; }";
		const findings = checkDeprecationAdded(oldStr, newStr, "api.ts");
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("deprecation-added");
	});

	it("detects new console.warn with deprecated", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr =
			'function handler() {\n  console.warn("handler is deprecated");\n  return process();\n}';
		const findings = checkDeprecationAdded(oldStr, newStr, "handler.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT flag when @deprecated already existed", () => {
		const oldStr = "/** @deprecated */\nexport function old() { return 1; }";
		const newStr = "/** @deprecated Use new() */\nexport function old() { return 2; }";
		expect(checkDeprecationAdded(oldStr, newStr, "api.ts")).toEqual([]);
	});

	it("does NOT flag when no deprecation is added", () => {
		const oldStr = "function a() { return 1; }";
		const newStr = "function a() { return 2; }";
		expect(checkDeprecationAdded(oldStr, newStr, "util.ts")).toEqual([]);
	});

	it("message text is exact", () => {
		const oldStr = "export function old() { return 1; }";
		const newStr = "/** @deprecated */\nexport function old() { return 1; }";
		const findings = checkDeprecationAdded(oldStr, newStr, "api.ts");
		expect(nonNull(findings[0]).message).toBe(
			"Deprecation notice was added instead of deleting the code. If removing this, just delete it — don't add ceremony.",
		);
	});

	it("detects console.log (not just console.warn) with 'removed'", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr = 'function handler() {\n  console.log("handler removed");\n  return process();\n}';
		expect(checkDeprecationAdded(oldStr, newStr, "handler.ts").length).toBe(1);
	});

	it("detects the 'no longer' variant distinct from 'deprecated'/'removed'", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr = 'function handler() {\n  console.warn("handler no longer supported");\n  return process();\n}';
		expect(checkDeprecationAdded(oldStr, newStr, "handler.ts").length).toBe(1);
	});

	it("source field is 'quality'", () => {
		const oldStr = "export function old() { return 1; }";
		const newStr = "/** @deprecated */\nexport function old() { return 1; }";
		const findings = checkDeprecationAdded(oldStr, newStr, "api.ts");
		expect(nonNull(findings[0]).source).toBe("quality");
	});

	it("recognizes an existing console.warn(deprecated) even with a long argument, not just a 1-char gap", () => {
		// The old-deprecation gate must allow ANY amount of text between the
		// call's opening paren and the word "deprecated" -- not just a
		// single character.
		const oldStr = 'console.warn("this call is deprecated");\nexport function old() { return 1; }';
		const newStr = "/** @deprecated */\nexport function old() { return 1; }";
		// hadDeprecation(oldStr) is true, so nothing new was added -- no finding.
		expect(checkDeprecationAdded(oldStr, newStr, "api.ts")).toEqual([]);
	});

	it("recognizes an existing console.warn(deprecated) with zero space before the paren", () => {
		const oldStr = 'console.warn("deprecated");\nexport function old() { return 1; }';
		const newStr = "/** @deprecated */\nexport function old() { return 1; }";
		expect(checkDeprecationAdded(oldStr, newStr, "api.ts")).toEqual([]);
	});

	it("recognizes an existing console.warn(deprecated) even with a space before the paren", () => {
		const oldStr = 'console.warn ("deprecated");\nexport function old() { return 1; }';
		const newStr = "/** @deprecated */\nexport function old() { return 1; }";
		expect(checkDeprecationAdded(oldStr, newStr, "api.ts")).toEqual([]);
	});

	it("detects a new console.warn with a space before the paren", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr = 'function handler() {\n  console.warn ("this is removed");\n  return process();\n}';
		expect(checkDeprecationAdded(oldStr, newStr, "handler.ts").length).toBe(1);
	});

	it("detects the 'no longer' variant with zero space between 'no' and 'longer'", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr = 'function handler() {\n  console.warn("nolonger needed");\n  return process();\n}';
		expect(checkDeprecationAdded(oldStr, newStr, "handler.ts").length).toBe(1);
	});
});

describe("checkDeletionCommentAdded", () => {
	it("detects new deletion narration comment", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr =
			"// Removed the old validation logic\nfunction handler() {\n  return process();\n}";
		const findings = checkDeletionCommentAdded(oldStr, newStr, "handler.ts");
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("deletion-comment-added");
	});

	it("detects 'no longer needed' comment added", () => {
		const oldStr = "return data;";
		const newStr = "// No longer needed after refactor\nreturn data;";
		const findings = checkDeletionCommentAdded(oldStr, newStr, "api.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT flag when deletion comment already existed", () => {
		const oldStr = "// Previously this called oldFunc()\nreturn newFunc();";
		const newStr = "// Previously this called oldFunc()\nreturn updatedFunc();";
		expect(checkDeletionCommentAdded(oldStr, newStr, "handler.ts")).toEqual([]);
	});

	it("does NOT flag regular comments", () => {
		const oldStr = "return data;";
		const newStr = "// Process the incoming data\nreturn data;";
		expect(checkDeletionCommentAdded(oldStr, newStr, "handler.ts")).toEqual([]);
	});

	it("message text is exact", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr = "// Removed the old validation logic\nfunction handler() {\n  return process();\n}";
		const findings = checkDeletionCommentAdded(oldStr, newStr, "handler.ts");
		expect(nonNull(findings[0]).message).toBe(
			"Comment narrating a deletion was added. Git history records what was removed — don't leave prose about it in the code.",
		);
	});

	it("detects each deletion-vocabulary alternative distinctly", () => {
		const base = "return data;";
		const variants = [
			"// deleted the old handler\nreturn data;",
			"// stripped out the legacy path\nreturn data;",
			"// no longer used after refactor\nreturn data;",
			"// no longer required\nreturn data;",
			"// previously called oldFunc()\nreturn data;",
			"// used to call oldFunc()\nreturn data;",
			"// used to be synchronous\nreturn data;",
			"// old value was: 42\nreturn data;",
		];
		for (const v of variants) {
			expect(checkDeletionCommentAdded(base, v, "handler.ts").length).toBe(1);
		}
	});

	it("source field is 'quality'", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr = "// Removed the old validation logic\nfunction handler() {\n  return process();\n}";
		const findings = checkDeletionCommentAdded(oldStr, newStr, "handler.ts");
		expect(nonNull(findings[0]).source).toBe("quality");
	});

	it("does NOT flag when the SAME deletion comment already existed unchanged (early-exit gate)", () => {
		// Both old and new contain the identical deletion-narrating comment;
		// the "already existed" gate must fire and suppress the finding
		// rather than re-flagging unchanged old content.
		const oldStr = "// removed the old validation\nreturn process();";
		const newStr = "// removed the old validation\nreturn process();";
		expect(checkDeletionCommentAdded(oldStr, newStr, "handler.ts")).toEqual([]);
	});

	it("requires each multi-word alternative's mandatory internal space, not zero-width", () => {
		const base = "return data;";
		const variants = [
			"// stripped  out the legacy path\nreturn data;",
			"// no  longer used\nreturn data;",
			"// no longer  needed\nreturn data;",
			"// previously  called oldFunc()\nreturn data;",
			"// used  to call oldFunc()\nreturn data;",
			"// used to  call oldFunc()\nreturn data;",
		];
		for (const v of variants) {
			expect(checkDeletionCommentAdded(base, v, "handler.ts").length).toBe(1);
		}
	});

	it("allows real whitespace around the 'was:' colon, and requires it be a real word after", () => {
		const base = "return data;";
		expect(
			checkDeletionCommentAdded(base, "// old value was : 42\nreturn data;", "handler.ts").length,
		).toBe(1);
		expect(
			checkDeletionCommentAdded(base, "// old value was:42\nreturn data;", "handler.ts").length,
		).toBe(1);
		expect(
			checkDeletionCommentAdded(base, "// old value was: value123\nreturn data;", "handler.ts")
				.length,
		).toBe(1);
	});

	it("requires a real comment marker with no space, not just any leading text before the vocabulary", () => {
		const base = "return data;";
		const newStr = "//removed the old handler\nreturn data;";
		expect(checkDeletionCommentAdded(base, newStr, "handler.ts").length).toBe(1);
	});
});

// ===========================================
// Layer 3: Session-Level Orphaned Tests
// ===========================================

describe("checkOrphanedTests", () => {
	it("detects removed symbol still referenced in test file", () => {
		const testContent =
			'import { validateToken } from "../auth";\n\ndescribe("validateToken", () => {\n  it("validates", () => {\n    expect(validateToken("x")).toBe(true);\n  });\n});';
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, false);
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("orphaned-test-reference");
		expect(nonNull(findings[0]).message).toContain("validateToken");
	});

	it("detects multiple removed symbols", () => {
		const testContent =
			"describe('auth', () => {\n  it('validates', () => validateToken());\n  it('refreshes', () => refreshToken());\n});";
		const findings = checkOrphanedTests(
			["validateToken", "refreshToken"],
			"auth.test.ts",
			testContent,
			false,
		);
		expect(findings.length).toBe(2);
	});

	it("does NOT flag when test file was already edited", () => {
		const testContent = "validateToken();";
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, true);
		expect(findings).toEqual([]);
	});

	it("does NOT flag when symbol is not referenced in test", () => {
		const testContent =
			'describe("other", () => {\n  it("works", () => expect(1).toBe(1));\n});';
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, false);
		expect(findings).toEqual([]);
	});

	it("does NOT flag with empty removed symbols list", () => {
		const findings = checkOrphanedTests([], "auth.test.ts", "anything", false);
		expect(findings).toEqual([]);
	});

	it("uses word boundaries to avoid partial matches", () => {
		const testContent = "getUserById(); getUser();";
		const findings = checkOrphanedTests(["get"], "user.test.ts", testContent, false);
		// "get" should NOT match "getUser" or "getUserById" due to word boundaries
		expect(findings).toEqual([]);
	});

	it("message text is exact for a single removed symbol", () => {
		const testContent = "validateToken();";
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, false);
		expect(nonNull(findings[0]).message).toBe(
			'"validateToken" was removed but auth.test.ts still references it. Delete or update the test.',
		);
	});

	it("detects a reference sitting at the very end of the file with no trailing char", () => {
		// idx + symbol.length === testFileContent.length exactly: the "after"
		// char must fall back to the default boundary rather than reading
		// past the end of the string.
		const testContent = "foo bar validateToken";
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, false);
		expect(findings.length).toBe(1);
	});

	it("rejects a match that is actually a substring of a longer identifier at the start of the file", () => {
		// idx > 0 here (idx === 1): the real preceding char "x" is a word
		// char, so this must NOT be treated as a standalone reference.
		const testContent = "xvalidateToken();";
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, false);
		expect(findings).toEqual([]);
	});

	it("caps findings at 5 even when more than 5 symbols are referenced", () => {
		const symbols = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
		const testContent = symbols.map((s) => `${s}();`).join(" ");
		const findings = checkOrphanedTests(symbols, "big.test.ts", testContent, false);
		expect(findings.length).toBe(5);
	});

	it("source field is 'quality'", () => {
		const testContent = "validateToken();";
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, false);
		expect(nonNull(findings[0]).source).toBe("quality");
	});

	it("does NOT flag when the only occurrence sits at the end of a larger word (search loop exhausts without a boundary match)", () => {
		// "a" occurs once inside "ba" with a word char immediately before it
		// and no character after (idx + 1 reaches content.length exactly), so
		// the boundary check fails and the while loop's search position
		// advances past content.length -- exiting via the loop condition
		// itself rather than the idx === -1 early return. This exercises
		// referencesSymbolAsWord's trailing `return false` after the loop.
		const findings = checkOrphanedTests(["a"], "x.test.ts", "ba", false);
		expect(findings).toEqual([]);
	});
});
