// Behavioral coverage-gap companion for b-series.ts.
// Targets the specific uncovered lines/branches from coverage/lcov.info:
// checkUnreachableCode (incl. isIncompleteReturnOrThrow, findUnreachableMatch),
// checkSilentCatch, checkAssertionFreeTests, checkTrivialAssertions,
// checkHardcodedCredentials, checkInfiniteRecursion, checkSyncIoInAsync.

import { describe, expect, it } from "vitest";
import {
	checkAssertionFreeTests,
	checkHardcodedCredentials,
	checkInfiniteRecursion,
	checkSilentCatch,
	checkSuppressionDensity,
	checkSyncIoInAsync,
	checkTrivialAssertions,
	checkUnreachableCode,
} from "./b-series.js";

// ===========================================================================
// checkUnreachableCode
// ===========================================================================
describe("checkUnreachableCode", () => {
	it("returns [] for a non-JS/TS extension", () => {
		expect(checkUnreachableCode("return 1;\nx();", "notes.txt")).toEqual([]);
	});

	it("returns [] for a .d.ts file even with a return-then-code shape", () => {
		const content = "declare function f(): void;\nreturn 1;\nx();";
		expect(checkUnreachableCode(content, "types.d.ts")).toEqual([]);
	});

	it("skips a property-declaration line shaped like `return?: Handler`", () => {
		const content = ["interface Foo {", "  return?: Handler;", "  x: number;", "}"].join("\n");
		expect(checkUnreachableCode(content, "foo.ts")).toEqual([]);
	});

	it("skips a property-declaration line with a space before the `?:` (return ?: Type)", () => {
		const content = ["interface Foo {", "  return ?: Handler;", "  x: number;", "}"].join("\n");
		expect(checkUnreachableCode(content, "foo.ts")).toEqual([]);
	});

	it("flags unreachable code after a `break;` with no space before the semicolon", () => {
		const content = ["function f() {", "  break;", "  doStuff();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "doStuff();" }]);
	});

	it("flags unreachable code after a `break ;` with a space before the semicolon", () => {
		const content = ["function f() {", "  break ;", "  doStuff();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "doStuff();" }]);
	});

	it("flags unreachable code after a `continue;` with no space before the semicolon", () => {
		const content = ["function f() {", "  continue;", "  doStuff();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "doStuff();" }]);
	});

	it("flags unreachable code after a `continue ;` with a space before the semicolon", () => {
		const content = ["function f() {", "  continue ;", "  doStuff();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "doStuff();" }]);
	});

	it("does not treat a line merely CONTAINING `break;` mid-line as a control-flow statement", () => {
		// The control-flow filter is anchored (^break\s*;). A line that only
		// contains "break;" after other code must not be recognized, so the
		// following line must NOT be flagged as unreachable.
		const content = ["function f() {", "  x = 1; break;", "  doStuff();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("skips a return statement continued via an open paren (incomplete statement)", () => {
		const content = [
			"function f() {",
			"  return (",
			"    1",
			"  );",
			"  console.log('after');",
			"}",
		].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("flags a complete return statement followed by same-indent code (exact match shape)", () => {
		const content = ["function f() {", "  return 1;", "  doStuff();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([
			{ line: 3, text: "doStuff();" },
		]);
	});

	it("does not treat an earlier ternary as an incomplete return", () => {
		const content = [
			"function f() {",
			"  return condition ? left : right;",
			"  doStuff();",
			"}",
		].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "doStuff();" }]);
	});

	it("does not flag when the next non-empty line closes the block", () => {
		const content = ["function f() {", "  if (x) {", "    return 1;", "  }", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("does not flag when the next non-empty line is a case/default label", () => {
		const content = [
			"switch (x) {",
			"  case 1:",
			"    return 1;",
			"  case 2:",
			"    return 2;",
			"}",
		].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("does not flag when the next non-empty line sits at a shallower indent (no brace)", () => {
		const content = [
			"for (let i = 0; i < 1; i++)",
			"  return 1;",
			"console.log('shallower, not unreachable per this heuristic');",
		].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("skips blank lines when scanning forward for the next statement", () => {
		const content = ["function f() {", "  return 1;", "", "  doStuff();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([
			{ line: 4, text: "doStuff();" },
		]);
	});

	it("returns [] when the return statement is followed only by blank/EOF lines", () => {
		// Return is the second-to-last line, and the file ends with a single
		// blank line — findUnreachableMatch's j-loop runs out of lines to check.
		const content = "function f() {\n  return 1;\n";
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("caps at 10 matches even when more than 10 unreachable statements exist", () => {
		const lines: string[] = [];
		for (let i = 0; i < 15; i++) {
			lines.push(`  return ${i};`);
			lines.push(`  dead${i}();`);
		}
		const content = ["function f() {", ...lines, "}"].join("\n");
		const result = checkUnreachableCode(content, "f.ts");
		expect(result).toHaveLength(10);
	});

	// Exercises every entry in the accepted-extension array individually — a
	// mutant that empties one string literal (e.g. ".tsx" -> "") is invisible
	// to a test that only ever uses ".ts" files.
	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs"])(
		"flags unreachable code in a %s file",
		(ext) => {
			const content = ["function f() {", "  return 1;", "  doStuff();", "}"].join("\n");
			expect(checkUnreachableCode(content, `f${ext}`)).toEqual([{ line: 3, text: "doStuff();" }]);
		},
	);

	it("truncates unreachable-code text to 150 characters", () => {
		const long = "x".repeat(200);
		const content = ["function f() {", "  return 1;", `  ${long};`, "}"].join("\n");
		const result = checkUnreachableCode(content, "f.ts");
		expect(result).toEqual([{ line: 3, text: `${long};`.slice(0, 150) }]);
	});

	it("does not flag when the closing brace sits at the SAME indent as the return (raw-line boundary)", () => {
		// findUnreachableMatch's closing-brace check compares the TRIMMED next
		// line against "}"/"};" before ever consulting indentation. If that
		// exact-equality check were skipped, the untrimmed line's indent would
		// equal the return's indent and produce a spurious match.
		const content = ["function f() {", "  return 1;", "  }"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("does not flag when the next line is a same-indent `};` close", () => {
		const content = ["function f() {", "  return 1;", "  };"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("recognizes a same-indent `case 1:` label and does not flag it", () => {
		const content = ["function f() {", "  return 1;", "  case 1:", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("recognizes a same-indent `default:` label (no internal whitespace) and does not flag it", () => {
		const content = ["function f() {", "  return 1;", "  default:", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("recognizes `default :` (whitespace before the colon) and does not flag it", () => {
		const content = ["function f() {", "  return 1;", "  default :", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("does NOT treat a line merely starting with `case` (no following whitespace) as a label", () => {
		const content = ["function f() {", "  return 1;", "  casey = 1;", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "casey = 1;" }]);
	});

	it("does NOT treat a line merely starting with `default` (no colon) as a label", () => {
		const content = ["function f() {", "  return 1;", "  defaults = 5;", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "defaults = 5;" }]);
	});

	it("only recognizes case/default at the START of the line, not as a mid-line substring", () => {
		// The case/default regex is anchored (^). A line that merely CONTAINS
		// "case " after other text (e.g. a same-line closing brace) must still
		// be flagged as unreachable, not silently treated as a safe label.
		const content = ["function f() {", "  return 1;", "  };case 1:", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 3, text: "};case 1:" }]);
	});

	it("does not extend the unreachable-code scan beyond 3 lines ahead", () => {
		const content = [
			"function f() {",
			"  return 1;",
			"",
			"",
			"",
			"  farAway();",
			"}",
		].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("includes exactly the 3rd line ahead when it is the first non-blank line", () => {
		const content = ["function f() {", "  return 1;", "", "", "  doStuff();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([{ line: 5, text: "doStuff();" }]);
	});

	it.each([
		["[", "return (["],
		["{", "return ({"],
		[",", "return 1,"],
		["+", "return 1 +"],
		["-", "return 1 -"],
		["|", "return 1 |"],
		["&", "return 1 &"],
		["?", "return cond ?"],
		[":", "return cond ? a :"],
	])("treats a return line ending in %s as an incomplete multi-line continuation", (_label, line) => {
		const content = ["function f() {", `  ${line}`, "    1", "  );", "  after();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	it("flags a return statement missing its terminating semicolon as complete (not a continuation)", () => {
		// isIncompleteReturnOrThrow's tail branch: no bracket/operator at EOL,
		// but also no trailing ";" -> still treated as incomplete (statement
		// continues). Only a return ending in ";" (or a bare value with no
		// continuation character) is complete.
		const content = ["function f() {", "  return 1", "  after();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	// test-contract: boundary — a multiline throw expression remains a continuation and must not report its following expression as unreachable
	it("skips a throw statement continued via an open paren", () => {
		const content = [
			"function f() {",
			"  throw (",
			"    new Error('failure')",
			"  );",
			"  recover();",
			"}",
		].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([]);
	});

	// test-contract: public-api — a completed throw statement reports the next same-indent statement as unreachable
	it("flags a complete throw statement followed by same-indent code", () => {
		const content = ["function f() {", "  throw error;", "  recover();", "}"].join("\n");
		expect(checkUnreachableCode(content, "f.ts")).toEqual([
			{ line: 3, text: "recover();" },
		]);
	});
});

// ===========================================================================
// checkSilentCatch
// ===========================================================================
describe("checkSilentCatch", () => {
	it("flags a bare empty catch block", () => {
		const content = ["try {", "  risky();", "} catch (e) {}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([
			{ line: 3, text: "} catch (e) {}" },
		]);
	});

	it("does not flag a catch block with an inline comment between the braces", () => {
		const content = ["try {", "  risky();", "} catch (e) { /* expected */ }"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("still flags an empty catch even when an unrelated comment follows on the next line", () => {
		// The next-line-comment guard (checkSilentCatch's multi-line branch) only
		// suppresses when the catch's own line ends in a bare unclosed `{` — a
		// same-line empty catch `{}` never satisfies that, so this is still flagged.
		const content = ["try {", "  risky();", "} catch (e) {}", "// explanation below"].join(
			"\n",
		);
		expect(checkSilentCatch(content, "f.ts")).toEqual([
			{ line: 3, text: "} catch (e) {}" },
		]);
	});

	it("caps at 10 matches even when more than 10 empty catches exist", () => {
		const lines: string[] = [];
		for (let i = 0; i < 15; i++) {
			lines.push(`try { risky${i}(); } catch (e) {}`);
		}
		const result = checkSilentCatch(lines.join("\n"), "f.ts");
		expect(result).toHaveLength(10);
	});

	it("returns [] for a non-JS/TS extension", () => {
		expect(checkSilentCatch("catch (e) {}", "notes.txt")).toEqual([]);
	});

	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs"])("flags a bare empty catch in a %s file", (ext) => {
		const content = ["try {", "  risky();", "} catch (e) {}"].join("\n");
		expect(checkSilentCatch(content, `f${ext}`)).toEqual([{ line: 3, text: "} catch (e) {}" }]);
	});

	it("flags a catch with just a space between the braces", () => {
		const content = ["try {", "  risky();", "} catch (e) { }"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([{ line: 3, text: "} catch (e) { }" }]);
	});

	it("flags an empty catch with no whitespace after `catch`", () => {
		const content = ["try {", "  risky();", "} catch(e) {}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([{ line: 3, text: "} catch(e) {}" }]);
	});

	it("flags an empty catch with no binding parens (optional catch binding)", () => {
		const content = ["try {", "  risky();", "} catch {}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([{ line: 3, text: "} catch {}" }]);
	});

	it("flags an empty catch with a multi-character binding name", () => {
		const content = ["try {", "  risky();", "} catch (err) {}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([{ line: 3, text: "} catch (err) {}" }]);
	});

	it("flags an empty catch with no whitespace before the brace", () => {
		const content = ["try {", "  risky();", "} catch (e){}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([{ line: 3, text: "} catch (e){}" }]);
	});

	it("does not flag a same-line comment with no whitespace after `catch`", () => {
		const content = ["try {", "  risky();", "} catch(e) { /* expected */ }"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("does not flag a same-line comment with no binding parens", () => {
		const content = ["try {", "  risky();", "} catch { /* expected */ }"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("does not flag a same-line comment with a multi-character binding name", () => {
		const content = ["try {", "  risky();", "} catch (err) { /* expected */ }"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("does not flag a same-line comment with no whitespace before the brace", () => {
		const content = ["try {", "  risky();", "} catch (e){ /* expected */ }"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("does not flag a same-line comment that starts immediately after the brace", () => {
		const content = ["try {", "  risky();", "} catch (e) {/* expected */}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("does not flag a genuinely intentional multi-line empty catch with a reason comment", () => {
		const content = [
			"try {",
			"  risky();",
			"} catch (e) {",
			"  // deliberately empty, reason X",
			"}",
		].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("trims and truncates the reported empty-catch line", () => {
		const content = `    } catch (e) {${" ".repeat(180)}}`;
		expect(checkSilentCatch(content, "f.ts")).toEqual([
			{ line: 1, text: content.trim().slice(0, 150) },
		]);
	});

	it("recognizes the multi-line comment guard with no whitespace after `catch`", () => {
		const content = ["try {", "  risky();", "} catch(e) {", "  // reason", "}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("recognizes the multi-line comment guard with no binding parens", () => {
		const content = ["try {", "  risky();", "} catch {", "  // reason", "}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("recognizes the multi-line comment guard with a multi-character binding name", () => {
		const content = ["try {", "  risky();", "} catch (err) {", "  // reason", "}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});

	it("recognizes the multi-line comment guard with no whitespace before the brace", () => {
		const content = ["try {", "  risky();", "} catch (e){", "  // reason", "}"].join("\n");
		expect(checkSilentCatch(content, "f.ts")).toEqual([]);
	});
});

// ===========================================================================
// checkAssertionFreeTests
// ===========================================================================
describe("checkAssertionFreeTests", () => {
	it("returns [] for a non-test file", () => {
		const content = "it('does something', () => {\n  doStuff();\n});";
		expect(checkAssertionFreeTests(content, "src/thing.ts")).toEqual([]);
	});

	it("flags an it() block with no assertion", () => {
		const content = ["it('does something', () => {", "  doStuff();", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([
			{ line: 1, text: "it('does something', () => {" },
		]);
	});

	it("N: a brace inside a string literal, a template literal or a line comment is text, not block structure", () => {
		// Before the fix a `"{bad"` literal on line 2 raised the depth and the real `});` could not close the block,
		// so the assertion on line 3 was counted for the wrong block (or the block was flagged).
		const content = [
			"it('parses', () => {",
			'  const bad = "{bad"; // a stray } in a comment',
			"  expect(parse(bad)).toEqual({ ok: false });",
			"});",
			"it('templates', () => {",
			"  const t = `}}}`; const q = '{';",
			"  expect(t).toBe('}}}');",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	it("P: an escaped quote inside a string does not end the string early", () => {
		const content = ["it('x', () => {", '  const s = "a \\" {";', "  run(s);", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([{ line: 1, text: "it('x', () => {" }]);
	});

	it("skips leading non-test-block lines before finding the it() block", () => {
		// Exercises the `if (testMatch)` false branch (a line evaluated while
		// not yet inside a test block that does NOT start one) before the true
		// branch fires on the actual it() line.
		const content = [
			"// setup comment, not a test block starter",
			"const helper = 1;",
			"it('does something', () => {",
			"  doStuff();",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([
			{ line: 3, text: "it('does something', () => {" },
		]);
	});

	it("does not flag an it() block that contains expect(...)", () => {
		const content = [
			"it('does something', () => {",
			"  const x = doStuff();",
			"  expect(x).toBe(1);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	it("does not recognize an indented it() block if the line were used untrimmed (leading-whitespace boundary)", () => {
		const content = ["  it('indented', () => {", "    doStuff();", "  });"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([
			{ line: 1, text: "it('indented', () => {" },
		]);
	});

	it("does not recognize `it(` as a test start when it is not at the start of the line", () => {
		const content = ["const result = it('x', () => {", "  doStuff();", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	it("recognizes `it (` with whitespace before the opening paren", () => {
		const content = ["it ('spaced call', () => {", "  doStuff();", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([
			{ line: 1, text: "it ('spaced call', () => {" },
		]);
	});

	it("truncates the reported line to 150 characters (the registered detector's format)", () => {
		const longTitle = `it('${"x".repeat(200)}', () => {`;
		const content = [longTitle, "  doStuff();", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([
			{ line: 1, text: longTitle.slice(0, 150) },
		]);
	});
	it("N: block comments, multi-line templates and an `it(` inside a fixture string are not test structure (seventh review)", () => {
		const blockComment = ["it('works', () => {", "  /* } */", "  expect(1).toBe(1);", "});"].join("\n");
		const multilineTemplate = ["it('works', () => {", "  const text = `", "}", "`;", "  expect(text).toBeTruthy();", "});"].join("\n");
		const fixture = ["it('real', () => { expect(1).toBe(2); });", "const src = `", "it('fixture', () => {", "  foo();", "});", "`;"].join("\n");
		for (const content of [blockComment, multilineTemplate, fixture]) expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});
	it("P: an `expect(` that only appears in a comment is not an assertion", () => {
		const content = ["it('none', () => {", "  // expect(x).toBe(1)", "  run();", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([{ line: 1, text: "it('none', () => {" }]);
	});

	it("recognizes `expect (` with whitespace before the opening paren as an assertion", () => {
		const content = ["it('does something', () => {", "  expect (x).toBe(1);", "});"].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	it("recognizes `.throws()` with no internal whitespace as an assertion", () => {
		const content = [
			"it('does something', () => {",
			"  expect(() => risky()).throws();",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	it("recognizes `.throws ()` with whitespace before the opening paren as an assertion", () => {
		const content = [
			"it('does something', () => {",
			"  expect(() => risky()).throws ();",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	it("recognizes `.throws` with several spaces before the opening paren", () => {
		const content = [
			"it('does something', () => {",
			"  expect(() => risky()).throws    ();",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	// test-contract: public-api — the documented assert-style assertion keeps an otherwise assertion-free test from being reported
	it("recognizes an assert call as a test assertion", () => {
		const content = [
			"it('checks the result', () => {",
			"  assert(result);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([]);
	});

	it("caps at 10 matches even when more than 10 assertion-free test blocks exist", () => {
		const lines: string[] = [];
		for (let i = 0; i < 15; i++) {
			lines.push(`it('test ${i}', () => {`);
			lines.push("  doStuff();");
			lines.push("});");
		}
		const result = checkAssertionFreeTests(lines.join("\n"), "thing.test.ts");
		expect(result).toHaveLength(10);
	});

	it("independently tracks a second test block after the first one closes", () => {
		const content = [
			"it('first', () => {",
			"  doStuff();",
			"});",
			"it('second', () => {",
			"  doStuff();",
			"});",
		].join("\n");
		expect(checkAssertionFreeTests(content, "thing.test.ts")).toEqual([
			{ line: 1, text: "it('first', () => {" },
			{ line: 4, text: "it('second', () => {" },
		]);
	});
});

// ===========================================================================
// checkTrivialAssertions
// ===========================================================================
describe("checkTrivialAssertions", () => {
	it("returns [] for a non-test file", () => {
		expect(checkTrivialAssertions("expect(true).toBeTruthy();", "src/thing.ts")).toEqual([]);
	});

	it("flags expect(true).toBeTruthy() as a tautological assertion", () => {
		const content = "expect(true).toBeTruthy();";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{
				line: 1,
				text: "Tautological assertion: expect(true).toBeTruthy() always passes.",
			},
		]);
	});

	it("flags expect(false).toBeFalsy() as a tautological assertion", () => {
		const content = "expect(false).toBeFalsy();";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{
				line: 1,
				text: "Tautological assertion: expect(false).toBeFalsy() always passes.",
			},
		]);
	});

	it("does not flag a meaningful assertion", () => {
		const content = "expect(computeSum(1, 2)).toBe(3);";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([]);
	});

	it("does not flag expect(1).toBe(2) — same shape, different literal values", () => {
		expect(checkTrivialAssertions("expect(1).toBe(2);", "thing.test.ts")).toEqual([]);
	});

	it.each([
		["true", "true"],
		["false", "false"],
		["null", "null"],
		["undefined", "undefined"],
		["42", "42"],
		["'abc'", "'abc'"],
		['"abc"', '"abc"'],
	])("flags expect(%s).toBe(%s) as tautological", (left, right) => {
		const content = `expect(${left}).toBe(${right});`;
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{
				line: 1,
				text: `Tautological assertion: expect(${left}).toBe(${right}) always passes. Assert on actual code behavior instead.`,
			},
		]);
	});

	// test-contract: boundary — indentation in a test source does not hide a tautological literal assertion from the public diagnostic
	it("flags an indented tautological literal assertion", () => {
		expect(checkTrivialAssertions("  expect(false).toBeFalsy();", "thing.test.ts")).toEqual([
			{
				line: 1,
				text: "Tautological assertion: expect(false).toBeFalsy() always passes.",
			},
		]);
	});

	it("flags expect(x).toEqual(x) (not just .toBe) as tautological", () => {
		const content = "expect(5).toEqual(5);";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{
				line: 1,
				text: "Tautological assertion: expect(5).toBe(5) always passes. Assert on actual code behavior instead.",
			},
		]);
	});

	it("flags expect(x).toStrictEqual(x) (not just .toBe) as tautological", () => {
		const content = "expect(null).toStrictEqual(null);";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{
				line: 1,
				text: "Tautological assertion: expect(null).toBe(null) always passes. Assert on actual code behavior instead.",
			},
		]);
	});

	it("flags expect( true ).toBeTruthy() with extra internal whitespace", () => {
		const content = "expect( true ).toBeTruthy();";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{ line: 1, text: "Tautological assertion: expect(true).toBeTruthy() always passes." },
		]);
	});

	it("flags expect( false ).toBeFalsy() with extra internal whitespace", () => {
		const content = "expect( false ).toBeFalsy();";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{ line: 1, text: "Tautological assertion: expect(false).toBeFalsy() always passes." },
		]);
	});

	it("flags assert( true ) with extra internal whitespace", () => {
		const content = "assert( true );";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{ line: 1, text: "Tautological assertion: assert(true) always passes." },
		]);
	});

	it("flags assert.ok( true ) with extra internal whitespace", () => {
		const content = "assert.ok( true );";
		expect(checkTrivialAssertions(content, "thing.test.ts")).toEqual([
			{ line: 1, text: "Tautological assertion: assert(true) always passes." },
		]);
	});

	it("returns [] for a plain assert(x) call on a non-literal", () => {
		expect(checkTrivialAssertions("assert(x);", "thing.test.ts")).toEqual([]);
	});

	it.each([
		"expect(true).toBe(true);",
		"expect( true ).toBe( true );",
		"expect(true) .toBe(true);",
		"expect(true).toBe(true );",
	])("flags literal equality despite matcher whitespace: %s", (content) => {
		expect(checkTrivialAssertions(content, "thing.test.ts")).toHaveLength(1);
	});

	it.each(["assert (true);", "assert(true);", "assert(true );", "assert.ok (true);", "assert.ok(true);", "assert.ok(true );"])(
		"flags tautological assert syntax: %s",
		(content) => {
			expect(checkTrivialAssertions(content, "thing.test.ts")).toHaveLength(1);
		},
	);
});

// ===========================================================================
// checkSuppressionDensity
// ===========================================================================
describe("checkSuppressionDensity", () => {
	function makeLines(n: number, suppressed: number): string {
		const lines: string[] = [];
		for (let i = 0; i < n; i++) {
			lines.push(i < suppressed ? "// @ts-ignore reason" : `const x${i} = ${i};`);
		}
		return lines.join("\n");
	}

	it("returns [] for a test file regardless of density", () => {
		const content = makeLines(20, 20);
		expect(checkSuppressionDensity(content, "thing.test.ts")).toEqual([]);
	});

	it("returns [] for a generated file regardless of density", () => {
		const content = ["// @generated", ...makeLines(20, 20).split("\n")].join("\n");
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([]);
	});

	it("returns [] for a file under 20 lines even at 100% suppression density", () => {
		const content = makeLines(10, 10);
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([]);
	});

	it("returns [] at exactly 19 lines (just under the size boundary)", () => {
		const content = makeLines(19, 19);
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([]);
	});

	it("evaluates density at exactly 20 lines (the size boundary is inclusive)", () => {
		const content = makeLines(20, 20);
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([
			{
				line: 1,
				text: "High suppression density: 20 directives in 20 lines (100.0%). Fix the underlying issues instead of suppressing them.",
			},
		]);
	});

	it("returns [] when density is over 2% but the absolute count is under 3", () => {
		// 2 suppressions in 40 lines = 5% density, but count < 3.
		const content = makeLines(40, 2);
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([]);
	});

	it("returns [] when count is >= 3 but density is at/under 2%", () => {
		// 3 suppressions in 200 lines = 1.5% density.
		const content = makeLines(200, 3);
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([]);
	});

	it("flags a file over both the density and count thresholds", () => {
		// 5 suppressions in 100 lines = 5% density, count >= 3.
		const content = makeLines(100, 5);
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([
			{
				line: 1,
				text: "High suppression density: 5 directives in 100 lines (5.0%). Fix the underlying issues instead of suppressing them.",
			},
		]);
	});

	it("returns [] at exactly 2.0% density (boundary is strictly greater-than)", () => {
		// 4 suppressions in 200 lines = exactly 2%.
		const content = makeLines(200, 4);
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([]);
	});

	it("flags at exactly count === 3 (boundary is inclusive)", () => {
		const content = makeLines(50, 3);
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([
			{
				line: 1,
				text: "High suppression density: 3 directives in 50 lines (6.0%). Fix the underlying issues instead of suppressing them.",
			},
		]);
	});

	it("counts eslint-disable and biome-ignore directives toward density", () => {
		const lines: string[] = [];
		lines.push("// eslint-disable-next-line");
		lines.push("// biome-ignore lint/x: reason");
		lines.push("// @ts-expect-error reason");
		for (let i = lines.length; i < 100; i++) lines.push(`const x${i} = ${i};`);
		const content = lines.join("\n");
		expect(checkSuppressionDensity(content, "thing.ts")).toEqual([
			{
				line: 1,
				text: "High suppression density: 3 directives in 100 lines (3.0%). Fix the underlying issues instead of suppressing them.",
			},
		]);
	});
});

// ===========================================================================
// checkHardcodedCredentials
// ===========================================================================
describe("checkHardcodedCredentials", () => {
	it("flags a hardcoded credential assignment", () => {
		const content = 'const apiKey = "sk-real-looking-value-123";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([
			{ line: 1, text: content },
		]);
	});

	it("skips a value that looks like a type annotation (e.g. bare `string`)", () => {
		const content = 'const apiKey = "string";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it("returns [] for a test file", () => {
		const content = 'const apiKey = "sk-real-looking-value-123";';
		expect(checkHardcodedCredentials(content, "config.test.ts")).toEqual([]);
	});

	it("caps at 10 matches even when more than 10 credentials exist", () => {
		const lines: string[] = [];
		for (let i = 0; i < 15; i++) {
			lines.push(`const secret${i} = "sk-real-looking-value-${i}00";`);
		}
		const result = checkHardcodedCredentials(lines.join("\n"), "config.ts");
		expect(result).toHaveLength(10);
	});

	it.each([
		["password", 'const password = "realSecretValue";'],
		["passwd", 'const passwd = "realSecretValue";'],
		["secret", 'const secret = "realSecretValue";'],
		["apikey (no underscore)", 'const apikey = "realSecretValue";'],
		["api_key (with underscore)", 'const api_key = "realSecretValue";'],
		["apisecret (no underscore)", 'const apisecret = "realSecretValue";'],
		["api_secret (with underscore)", 'const api_secret = "realSecretValue";'],
		["authtoken (no underscore)", 'const authtoken = "realSecretValue";'],
		["auth_token (with underscore)", 'const auth_token = "realSecretValue";'],
		["accesstoken (no underscore)", 'const accesstoken = "realSecretValue";'],
		["access_token (with underscore)", 'const access_token = "realSecretValue";'],
		["privatekey (no underscore)", 'const privatekey = "realSecretValue";'],
		["private_key (with underscore)", 'const private_key = "realSecretValue";'],
	])("flags a hardcoded credential named %s", (_label, content) => {
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([{ line: 1, text: content }]);
	});

	it("matches case-insensitively (PASSWORD)", () => {
		const content = 'const PASSWORD = "realSecretValue";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([{ line: 1, text: content }]);
	});

	it("recognizes the Go walrus assignment form", () => {
		const content = 'password := "realSecretValue"';
		expect(checkHardcodedCredentials(content, "config.go")).toEqual([{ line: 1, text: content }]);
	});

	it("recognizes the YAML/struct colon assignment form", () => {
		const content = 'password: "realSecretValue"';
		expect(checkHardcodedCredentials(content, "config.yaml")).toEqual([{ line: 1, text: content }]);
	});

	it("does not match a bare `==` comparison (no assignment)", () => {
		const content = 'if (password == "realSecretValue") {}';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it("does not match a value shorter than 4 characters", () => {
		const content = 'const password = "abc";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it("matches a value at exactly 4 characters (the length boundary)", () => {
		const content = 'const password = "abcd";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([{ line: 1, text: content }]);
	});

	it("skips a variable with a descriptive suffix (Pattern)", () => {
		const content = 'const passwordPattern = "someRegexPlaceholder1";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it("does NOT skip a variable whose suffix is not in the descriptive list (Value)", () => {
		const content = 'const passwordValue = "realSecretValue";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([{ line: 1, text: content }]);
	});

	it.each(["disabled", "none", "null", "undefined", "empty", "redacted", "change_me", "change-me"])(
		"skips the known-safe exact value %s",
		(value) => {
			const content = `const apiKey = "${value}";`;
			expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
		},
	);

	it("matches the known-safe exact value check case-insensitively (DISABLED)", () => {
		const content = 'const password = "DISABLED";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it.each([
		"example",
		"test",
		"mock",
		"demo",
		"placeholder",
		"changeme",
		"your-",
		"your_",
		"xxx",
		"dummy",
		"fake",
		"sample",
		"replace",
		"insert",
		"todo",
		"fixme",
	])("skips a value starting with the known-safe prefix %s", (prefix) => {
		const content = `const apiKey = "${prefix}Value123";`;
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it("does not skip a value merely containing (not starting with) a safe prefix", () => {
		const content = 'const apiKey = "realFakeValue123";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([{ line: 1, text: content }]);
	});

	it("skips a type-annotation-shaped value (z.string())", () => {
		const content = 'const apiKey = "z.string()";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it.each(["password", "secret"])("skips the safe exact credential value %s", (value) => {
		const content = `const apiKey = "${value}";`;
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it("does not skip a descriptive-looking suffix unless it is at the end", () => {
		const content = 'const passwordPatternValue = "realSecretValue";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([{ line: 1, text: content }]);
	});

	it("does not skip a type-looking substring inside a real credential", () => {
		const content = 'const apiKey = "realstringValue";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([{ line: 1, text: content }]);
	});

	it("accepts an assignment with no whitespace after the equals sign", () => {
		const content = 'const apiKey ="realSecretValue";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([{ line: 1, text: content }]);
	});

	it("skips a vendored/fixture path even without a test-file name", () => {
		const content = 'const apiKey = "realSecretValue123";';
		expect(checkHardcodedCredentials(content, "vendor/config.ts")).toEqual([]);
	});

	it("scans non-JS/TS extensions (credential scan is language-agnostic)", () => {
		const content = 'password: "realSecretValue"';
		expect(checkHardcodedCredentials(content, "config.env")).toEqual([{ line: 1, text: content }]);
	});

	it("truncates a very long credential line to 150 characters and trims it", () => {
		const long = "z".repeat(200);
		const content = `    const apiKey = "${long}";`;
		const result = checkHardcodedCredentials(content, "config.ts");
		expect(result).toEqual([{ line: 1, text: content.trim().slice(0, 150) }]);
	});
});

// ===========================================================================
// checkInfiniteRecursion
// ===========================================================================
describe("checkInfiniteRecursion", () => {
	it("flags a self-call with no guard", () => {
		const content = ["function loop() {", "  loop();", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([
			{ line: 2, text: "loop();" },
		]);
	});

	it("does not flag a self-call guarded by an if/return base case", () => {
		const content = [
			"function fact(n) {",
			"  if (n <= 1) return 1;",
			"  return n * fact(n - 1);",
			"}",
		].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});

	it("caps at 5 matches even when more than 5 unguarded recursive functions exist", () => {
		const lines: string[] = [];
		for (let i = 0; i < 8; i++) {
			lines.push(`function loop${i}() {`);
			lines.push(`  loop${i}();`);
			lines.push(`}`);
		}
		const result = checkInfiniteRecursion(lines.join("\n"), "f.ts");
		expect(result).toHaveLength(5);
	});

	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs"])("flags unguarded recursion in a %s file", (ext) => {
		const content = ["function loop() {", "  loop();", "}"].join("\n");
		expect(checkInfiniteRecursion(content, `f${ext}`)).toEqual([{ line: 2, text: "loop();" }]);
	});

	it.each([
		["if", "if (x) {}"],
		["switch", "switch (n) {}"],
		["return", "return;"],
		["while", "while (x) {}"],
		["for", "for (;;) {}"],
		["ternary", "x ? y : z;"],
		["logical &&/||", "x&&y;"],
		[".length/.size", "arr.length;"],
		["== / !=", "a==b;"],
		["< / >", "a<b;"],
	])("suppresses the flag when a %s guard precedes the self-call", (_label, guardLine) => {
		const content = ["function loop(n) {", `  ${guardLine}`, "  loop(n);", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});

	it("still flags the self-call when the preceding line is NOT guard-shaped", () => {
		const content = ["function loop(n) {", "  doSomethingUnrelated();", "  loop(n);", "}"].join(
			"\n",
		);
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([
			{ line: 3, text: "loop(n);" },
		]);
	});

	// test-contract: boundary — a non-equality guard using != is still a visible base case and suppresses the recursion warning
	it("recognizes a not-equal comparison as a recursion guard", () => {
		const content = ["function loop(n) {", "  if (n != 0) return;", "  loop(n);", "}"].join(
			"\n",
		);
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});

	it("does not treat a mid-line control word as a recursion guard", () => {
		const content = [
			"function loop(n) {",
			"  doWork(); if (n) {}",
			"  loop(n);",
			"}",
		].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([{ line: 3, text: "loop(n);" }]);
	});

	it("requires the ternary guard to have a following expression", () => {
		const content = ["function loop(n) {", "  value ?n : fallback;", "  loop(n);", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});

	it("does not flag recursion in a non-JS/TS file", () => {
		const content = ["function loop() {", "  loop();", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.txt")).toEqual([]);
	});

	it("recognizes function declarations with multiple spaces", () => {
		const content = ["function   loop() {", "  loop();", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([{ line: 2, text: "loop();" }]);
	});

	it.each([
		["const with spaced declaration", "const   loop = (n) => {"],
		["const without spaces around equals", "const loop= (n) => {"],
		["const without spaces after equals", "const loop =(n) => {"],
		["async arrow with multiple spaces", "const loop = async   (n) => {"],
		["arrow with multiple parameters", "const loop = (n, m) => {"],
	])("recognizes edge-case %s arrow recursion", (_label, defLine) => {
		const content = [defLine, "  loop(n);", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([{ line: 2, text: "loop(n);" }]);
	});

	it("recognizes the space-before-paren self-call form", () => {
		const content = ["function outer(n) {", "  outer (n - 1);", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([
			{ line: 2, text: "outer (n - 1);" },
		]);
	});

	it("does not misattribute a same-named call outside the function body as self-recursion", () => {
		const content = ["function outer(n) {", "  doStuff();", "}", "outer(5);"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});

	it("stops scanning once a nested bare block closes the depth to zero mid-function", () => {
		const content = ["function outer(n) {", "  {", "    outer(n - 1);", "  }", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([
			{ line: 3, text: "outer(n - 1);" },
		]);
	});

	it("skips a balanced one-liner function definition entirely", () => {
		const content = ["function noop() {}", "noop();"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});

	it("does not scan beyond the 15-line lookahead window", () => {
		const filler = Array.from({ length: 14 }, (_, i) => `  x${i}();`);
		const content = ["function outer(n) {", ...filler, "  outer(n - 1);", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});

	it("finds a self-call at exactly the 14th line inside the lookahead window", () => {
		const filler = Array.from({ length: 13 }, (_, i) => `  x${i}();`);
		const content = ["function outer(n) {", ...filler, "  outer(n - 1);", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([
			{ line: 15, text: "outer(n - 1);" },
		]);
	});

	it.each([
		["const with parens", "const loop = (n) => {"],
		["let with parens", "let loop = (n) => {"],
		["var with parens", "var loop = (n) => {"],
		["const async", "const loop = async (n) => {"],
		["const no-paren single param", "const loop = n => {"],
	])("recognizes a %s arrow-function definition", (_label, defLine) => {
		const content = [defLine, "  loop(n - 1);", "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([
			{ line: 2, text: "loop(n - 1);" },
		]);
	});

	it("truncates a long self-call line to 150 characters and trims it", () => {
		const long = "x".repeat(200);
		const line = `  loop(${long});`;
		const content = ["function loop() {", line, "}"].join("\n");
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([
			{ line: 2, text: line.trim().slice(0, 150) },
		]);
	});
});

// ===========================================================================
// checkSyncIoInAsync
// ===========================================================================
describe("checkSyncIoInAsync", () => {
	it("flags a sync fs call inside an async function", () => {
		const content = [
			"async function f() {",
			"  const x = readFileSync('a.txt');",
			"  return x;",
			"}",
		].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([
			{ line: 2, text: "const x = readFileSync('a.txt');" },
		]);
	});

	it("does not flag a sync fs call outside any async function", () => {
		const content = "function f() {\n  const x = readFileSync('a.txt');\n  return x;\n}";
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([]);
	});

	it("does not flag sync I/O in a non-JS/TS file", () => {
		const content = ["async function f() {", "  readFileSync('a.txt');", "}"].join("\n");
		expect(checkSyncIoInAsync(content, "f.txt")).toEqual([]);
	});

	it("recognizes an async function with multiple spaces after async", () => {
		const content = ["async   function f() {", "  readFileSync('a.txt');", "}"].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([{ line: 2, text: "readFileSync('a.txt');" }]);
	});

	it("recognizes arrow async syntax without spaces around equals or after async", () => {
		const noBeforeSpace = ["const f=async () => {", "  readFileSync('a.txt');", "}"].join("\n");
		const noAfterAsyncSpace = ["const f = async() => {", "  readFileSync('a.txt');", "}"].join("\n");
		expect(checkSyncIoInAsync(noBeforeSpace, "f.ts")).toEqual([{ line: 2, text: "readFileSync('a.txt');" }]);
		expect(checkSyncIoInAsync(noAfterAsyncSpace, "f.ts")).toEqual([{ line: 2, text: "readFileSync('a.txt');" }]);
	});

	it("recognizes sync calls with whitespace before their argument list", () => {
		const content = ["async function f() {", "  readFileSync   ('a.txt');", "}"].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([{ line: 2, text: "readFileSync   ('a.txt');" }]);
	});

	it("keeps a same-line closed async function in scope for the following call", () => {
		const content = "async function f() {} readFileSync('a.txt');";
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([{ line: 1, text: content }]);
	});

	it("caps at 10 matches even when more than 10 sync calls exist in one async fn", () => {
		const lines = ["async function f() {"];
		for (let i = 0; i < 15; i++) {
			lines.push(`  readFileSync('a${i}.txt');`);
		}
		lines.push("}");
		const result = checkSyncIoInAsync(lines.join("\n"), "f.ts");
		expect(result).toHaveLength(10);
	});

	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs"])("flags a sync fs call in a %s file", (ext) => {
		const content = ["async function f() {", "  readFileSync('a.txt');", "}"].join("\n");
		expect(checkSyncIoInAsync(content, `f${ext}`)).toEqual([
			{ line: 2, text: "readFileSync('a.txt');" },
		]);
	});

	it.each([
		["async function keyword form", "async function f() {"],
		["async arrow with parens", "const f = async () => {"],
		["async arrow no-paren single param", "const f = async x => {"],
	])("recognizes %s as an async-function start", (_label, defLine) => {
		const content = [defLine, "  readFileSync('a.txt');", "}"].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([
			{ line: 2, text: "readFileSync('a.txt');" },
		]);
	});

	it.each([
		"readFileSync",
		"writeFileSync",
		"appendFileSync",
		"mkdirSync",
		"readdirSync",
		"statSync",
		"existsSync",
		"unlinkSync",
		"rmdirSync",
		"renameSync",
		"copyFileSync",
	])("flags %s inside an async function", (fn) => {
		const content = ["async function f() {", `  ${fn}('a');`, "}"].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([{ line: 2, text: `${fn}('a');` }]);
	});

	it("does not flag a sync fs call after an async function has already closed", () => {
		const content = [
			"async function f() {",
			"  return 1;",
			"}",
			"readFileSync('a.txt');",
		].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([]);
	});

	it("still recognizes a sync fs call nested inside a block within an async function", () => {
		const content = [
			"async function f() {",
			"  if (x) {",
			"    readFileSync('a.txt');",
			"  }",
			"}",
		].join("\n");
		expect(checkSyncIoInAsync(content, "f.ts")).toEqual([
			{ line: 3, text: "readFileSync('a.txt');" },
		]);
	});

	it("trims and truncates a long sync-call line to 150 characters", () => {
		const long = "x".repeat(200);
		const line = `    readFileSync('${long}');`;
		const content = ["async function f() {", line, "}"].join("\n");
		const result = checkSyncIoInAsync(content, "f.ts");
		expect(result).toEqual([{ line: 2, text: line.trim().slice(0, 150) }]);
	});
});
