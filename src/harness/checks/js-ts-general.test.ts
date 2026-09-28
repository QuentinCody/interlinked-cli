import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkCatchAndLog,
	checkDisabledTests,
	checkHardcodedTimeout,
	checkJsonParseUnsafe,
	checkNestedTernaries,
	checkTargetBlankNoRel,
} from "./js-ts-general.js";

// Non-test source paths the checks should actually run on.
const TS = "src/lib/foo.ts";
const JS = "src/lib/foo.js";
const TSX = "src/ui/Comp.tsx";
const JSX = "src/ui/Comp.jsx";
const HTML = "public/page.html";
// A genuine test file (suppresses the source-only checks; enables checkDisabledTests).
const TEST = "src/lib/foo.test.ts";

// ===========================================
// checkNestedTernaries
// ===========================================
describe("checkNestedTernaries", () => {
	it("flags a line with two ternary operators", () => {
		const code = "const x = a ? b : c ? d : e;";
		const out = checkNestedTernaries(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
		expect(nonNull(out[0]).text).toBe("const x = a ? b : c ? d : e;");
	});

	it("does not flag a single ternary", () => {
		expect(checkNestedTernaries("const x = a ? b : c;", TS)).toEqual([]);
	});

	it("reports the original (un-stripped) text, truncated to 150 chars", () => {
		const longTail = "z".repeat(300);
		const code = `const x = a ? b : c ? d : e; // ${longTail}`;
		const out = checkNestedTernaries(code, TS);
		expect(out).toHaveLength(1);
		// Truncation is applied to the trimmed original line.
		expect(nonNull(out[0]).text.length).toBe(150);
		expect(nonNull(out[0]).text.startsWith("const x = a ? b : c ? d : e;")).toBe(true);
	});

	it("inspects nested conditional computations in test files", () => {
		expect(checkNestedTernaries("const x = a ? b : c ? d : e;", TEST)).toHaveLength(1);
	});

	it("returns [] for non-JS/TS extensions (gate)", () => {
		expect(checkNestedTernaries("const x = a ? b : c ? d : e;", "src/foo.py")).toEqual([]);
		expect(checkNestedTernaries("x = a ? b : c ? d : e", "src/foo.go")).toEqual([]);
	});

	it("skips TypeScript conditional types (extends ... ?)", () => {
		const code = "type R<T> = T extends string ? number : T extends boolean ? 1 : 0;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("skips type-alias lines with conditionals", () => {
		// `type X ... = ... ?` branch: avoid `extends` so this exercises the
		// SECOND skip rule, not the conditional-type one.
		const code = "type Flag = Cond == 1 ? A ? X : Y : B ? P : Q;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("skips a standalone optional property declaration line", () => {
		const code = "  name?: string;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("does not mistake two optional-property colons for a nested ternary", () => {
		// After `name?: type` rewriting these become `X: type` — no `?` left.
		const code = "const obj: { id?: number; label?: string } = makeObj();";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("does not mistake regex groups / lookaheads for ternaries", () => {
		// (?:...) and (?=...) would each contribute a `?` without the cleanup.
		const code = "const re = build((?:abc), (?=def), (?!ghi));";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("does not mistake lazy quantifiers for ternaries", () => {
		const code = "const re = matcher('a*?b', 'c+?d');";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("does not mistake a regex literal for a nested ternary", () => {
		// `/.../ ` is stripped to `X`. Without that, the two `?` inside would fire.
		const code = "const re = /a?b?c/.test(s);";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("does not treat optional chaining (?.) as a ternary operator", () => {
		const code = "const v = a?.b?.c?.d;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("does not treat nullish coalescing (??) as a ternary operator", () => {
		const code = "const v = a ?? b ?? c ?? d;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	it("retains every finding so an inventory cannot silently truncate", () => {
		const line = "const x = a ? b : c ? d : e;";
		const code = Array.from({ length: 15 }, () => line).join("\n");
		const out = checkNestedTernaries(code, TS);
		expect(out).toHaveLength(15);
	});
});

// ===========================================
// checkCatchAndLog
// ===========================================
describe("checkCatchAndLog", () => {
	it("flags a catch block that only logs and then ends", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e) {",
			"    console.error(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toHaveLength(1);
		// Line of the `} catch` (4 here, 1-based).
		expect(nonNull(out[0]).line).toBe(4);
		expect(nonNull(out[0]).text).toContain("catch");
	});

	it("flags catch-only-log with the body brace on the following line", () => {
		// Exercises the braceStart lookahead loop: `} catch (e)` matches the
		// entry regex on line 4, but the body `{` is on line 5.
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e)",
			"  {",
			"    console.log(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(4);
	});

	it("does not flag when the catch body does real work besides logging", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e) {",
			"    console.error(e);",
			"    cleanup();",
			"  }",
			"}",
		].join("\n");
		// `cleanup()` after the console line makes onlyConsole false → not flagged.
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	it("does not flag a catch with no console call at all", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e) {",
			"    handle(e);",
			"  }",
			"}",
		].join("\n");
		// handle(e) is the first body line → onlyConsole=false immediately; hasConsole stays false.
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	it("does not flag when meaningful code follows the closed catch block", () => {
		// Exercises hasMeaningfulCodeAfterCatch → continue (error not swallowed).
		const code = [
			"function f() {",
			"  let ok = true;",
			"  try {",
			"    risky();",
			"  } catch (e) {",
			"    console.error(e);",
			"  }",
			"  ok = false;",
			"  return ok;",
			"}",
		].join("\n");
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	it("treats a lone `);` after the catch as NOT meaningful (still flags)", () => {
		// The only line after closeIdx is `);` (closing a call expression) —
		// hasMeaningfulCodeAfterCatch must treat it as non-meaningful and flag.
		const code = [
			"wrap(function () {",
			"  try {",
			"    risky();",
			"  } catch (e) {",
			"    console.error(e);",
			"  }",
			");",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(4);
	});

	it("treats a lone `}` after the catch as NOT meaningful (still flags)", () => {
		// The only line after closeIdx is the function's closing `}` —
		// hasMeaningfulCodeAfterCatch=false, so the swallowed error IS flagged.
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e) {",
			"    console.warn(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(4);
	});

	it("returns [] for catch-and-log in test files (gate)", () => {
		const code = ["try { x(); } catch (e) {", "  console.error(e);", "}"].join("\n");
		expect(checkCatchAndLog(code, TEST)).toEqual([]);
	});

	it("returns [] for non-JS/TS extensions (gate)", () => {
		const code = ["try:", "  x()", "except Exception as e:", "  print(e)"].join("\n");
		expect(checkCatchAndLog(code, "src/foo.py")).toEqual([]);
	});

	it("returns [] for route-handler PATH-segment exempt files", () => {
		const code = [
			"export function handler() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    console.error(e);",
			"  }",
			"}",
		].join("\n");
		expect(checkCatchAndLog(code, "src/routes/users.ts")).toEqual([]);
		expect(checkCatchAndLog(code, "src/api/orders.ts")).toEqual([]);
		expect(checkCatchAndLog(code, "src/pages/api/login.ts")).toEqual([]);
	});

	it("returns [] for route-handler FILENAME-suffix exempt files", () => {
		const code = [
			"function h() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    console.error(e);",
			"  }",
			"}",
		].join("\n");
		expect(checkCatchAndLog(code, "src/users.controller.ts")).toEqual([]);
		expect(checkCatchAndLog(code, "src/auth.middleware.tsx")).toEqual([]);
	});

	it("does not flag when no closing brace is found within the 8-line window", () => {
		// catch body never closes within the 8-line scan window → foundClose=false.
		const longBody = Array.from({ length: 12 }, () => "    console.log(1);").join("\n");
		const code = [
			"function f() {",
			"  try {",
			"    x();",
			"  } catch (e) {",
			longBody,
		].join("\n");
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	it("does not flag when the catch keyword has no opening brace nearby", () => {
		// `} catch` matches the regex but no `{` within the 3-line lookahead → braceStart -1.
		const code = ["} catch", "x", "y"].join("\n");
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	it("caps results at 10 catch-and-log blocks", () => {
		// Each block is separated by blank lines so nothing meaningful follows
		// any catch's close within the 4-line look-ahead (otherwise the next
		// block's code would count as "error not swallowed" and suppress it).
		const block = [
			"  try {",
			"  } catch (e) {",
			"    console.log(1);",
			"  }",
			"",
			"",
			"",
			"",
		].join("\n");
		const code = Array.from({ length: 12 }, () => block).join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toHaveLength(10);
	});
});

// ===========================================
// checkJsonParseUnsafe
// ===========================================
describe("checkJsonParseUnsafe", () => {
	it("flags a bare JSON.parse outside any try block", () => {
		const code = "const data = JSON.parse(input);";
		const out = checkJsonParseUnsafe(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
		expect(nonNull(out[0]).text).toContain("JSON.parse");
	});

	it("does not flag JSON.parse inside a multi-line try block", () => {
		const code = [
			"try {",
			"  const data = JSON.parse(input);",
			"} catch (e) {",
			"  data = null;",
			"}",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	it("does not flag a single-line try/JSON.parse/catch", () => {
		// Exercises the inline try-catch-on-one-line skip branch.
		const code = "try { JSON.parse(x); } catch (e) { fallback(); }";
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	// FP regression: Allman brace style puts `{` on its own line after `try`,
	// so the same-line `/\btry\s*\{/` opener never fired and the wrapped
	// JSON.parse looked unguarded.
	it("does not flag JSON.parse inside an Allman-brace try block", () => {
		const code = [
			"try",
			"{",
			"  const data = JSON.parse(input);",
			"}",
			"catch (e)",
			"{",
			"  data = null;",
			"}",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	it("still flags an unguarded JSON.parse after an Allman try block closes", () => {
		const code = [
			"try",
			"{",
			"  setup();",
			"}",
			"catch (e)",
			"{",
			"  recover();",
			"}",
			"const data = JSON.parse(raw);",
		].join("\n");
		const out = checkJsonParseUnsafe(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(9);
	});

	it("flags JSON.parse AFTER a try block has closed (tryDepth back to 0)", () => {
		const code = [
			"try {",
			"  setup();",
			"} catch (e) {",
			"  recover();",
			"}",
			"const data = JSON.parse(input);",
		].join("\n");
		const out = checkJsonParseUnsafe(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(6);
	});

	it("handles nested try blocks: JSON.parse inside inner try is safe", () => {
		const code = [
			"try {",
			"  try {",
			"    const x = JSON.parse(a);",
			"  } catch (inner) {",
			"    x = null;",
			"  }",
			"} catch (outer) {",
			"  fail();",
			"}",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	it("flags a bare JSON.parse and does not underflow on a stray catch (tryDepth stays 0)", () => {
		// A `} catch` with no matching `try` before it must not decrement
		// tryDepth below zero — the bare JSON.parse on line 1 is still flagged.
		const code = [
			"const a = JSON.parse(x);",
			"} catch (e) {",
			"  recover();",
			"}",
		].join("\n");
		const out = checkJsonParseUnsafe(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
	});

	it("does not flag the safeJsonParse shape — regex .replace chain (with [}\\]] braces) between try and JSON.parse (B2 regression)", () => {
		// The exact shape that produced a dogfood FP on config-loosening-gate.ts:
		// a `try {`, a multi-line `.replace(...)` chain whose regex literals contain
		// `}` / `]`, then `return JSON.parse(cleaned)`. The brace-counting depth
		// tracker must not be fooled by braces inside the regex literals.
		const code = [
			"function safeJsonParse(text) {",
			"  try {",
			"    const cleaned = text",
			"      .replace(/^\\s*\\/\\/.*$/gm, '')",
			"      .replace(/,(\\s*[}\\]])/g, '$1');",
			"    return JSON.parse(cleaned);",
			"  } catch {",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	it("returns [] for test files (gate)", () => {
		expect(checkJsonParseUnsafe("const d = JSON.parse(x);", TEST)).toEqual([]);
	});

	it("returns [] for non-JS/TS extensions (gate)", () => {
		expect(checkJsonParseUnsafe("d = JSON.parse(x)", "src/foo.py")).toEqual([]);
	});

	it("caps results at 10 unsafe JSON.parse calls", () => {
		const code = Array.from({ length: 13 }, (_, i) => `const v${i} = JSON.parse(s${i});`).join(
			"\n",
		);
		const out = checkJsonParseUnsafe(code, TS);
		expect(out).toHaveLength(10);
	});
});

// ===========================================
// checkHardcodedTimeout
// ===========================================
describe("checkHardcodedTimeout", () => {
	it("flags setTimeout with a hardcoded delay >= 100ms", () => {
		const code = "setTimeout(() => doThing(), 5000);";
		const out = checkHardcodedTimeout(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
		expect(nonNull(out[0]).text).toContain("setTimeout");
	});

	it("flags setInterval with a hardcoded delay >= 100ms", () => {
		const code = "setInterval(poll, 1000);";
		const out = checkHardcodedTimeout(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("setInterval");
	});

	it("flags exactly at the 100ms boundary", () => {
		expect(checkHardcodedTimeout("setTimeout(fn, 100);", TS)).toHaveLength(1);
	});

	it("does not flag delays below 100ms", () => {
		expect(checkHardcodedTimeout("setTimeout(fn, 50);", TS)).toEqual([]);
		expect(checkHardcodedTimeout("setTimeout(fn, 0);", TS)).toEqual([]);
	});

	it("does not flag setTimeout whose delay is a named variable", () => {
		// Pattern requires a numeric literal as the 2nd arg.
		expect(checkHardcodedTimeout("setTimeout(fn, DELAY_MS);", TS)).toEqual([]);
	});

	it("returns [] for test files (gate)", () => {
		expect(checkHardcodedTimeout("setTimeout(fn, 5000);", TEST)).toEqual([]);
	});

	it("returns [] for non-JS/TS extensions (gate)", () => {
		expect(checkHardcodedTimeout("setTimeout(fn, 5000);", "src/foo.py")).toEqual([]);
	});

	it("caps results at 10 hardcoded timeouts", () => {
		const code = Array.from({ length: 13 }, (_, i) => `setTimeout(f${i}, 1000);`).join("\n");
		expect(checkHardcodedTimeout(code, TS)).toHaveLength(10);
	});
});

// ===========================================
// checkDisabledTests
// ===========================================
describe("checkDisabledTests", () => {
	it("flags it.skip in a test file", () => {
		const code = ["describe('x', () => {", "  it.skip('todo', () => {});", "});"].join("\n");
		const out = checkDisabledTests(code, TEST);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(2);
		expect(nonNull(out[0]).text).toContain("it.skip");
	});

	it("flags describe.skip, test.skip, xit, xdescribe, xtest", () => {
		const code = [
			"describe.skip('a', () => {});",
			"test.skip('b', () => {});",
			"xit('c', () => {});",
			"xdescribe('d', () => {});",
			"xtest('e', () => {});",
		].join("\n");
		const out = checkDisabledTests(code, TEST);
		expect(out).toHaveLength(5);
		expect(out.map((m) => m.line)).toEqual([1, 2, 3, 4, 5]);
	});

	it("does not flag enabled tests", () => {
		const code = ["it('runs', () => {});", "test('also runs', () => {});"].join("\n");
		expect(checkDisabledTests(code, TEST)).toEqual([]);
	});

	it("returns [] for NON-test files (inverse gate)", () => {
		// This check runs ONLY on test files — opposite of the others.
		expect(checkDisabledTests("it.skip('x', () => {});", TS)).toEqual([]);
	});

	it("returns [] for a test-named file with a non-JS/TS extension", () => {
		// `foo_test.py` is a test file, but the ext gate rejects it.
		expect(checkDisabledTests("it.skip('x')", "src/foo_test.py")).toEqual([]);
	});

	it("N1: does not flag a `.skip(` call on an identifier merely ending in 'it'/'test' — regex word boundary", () => {
		// The marker is `\b(?:it\.skip|...)`; "contest" ends in "test" but there is
		// no word boundary before it, so `contest.skip(...)` (a quiz app's
		// pagination helper) must not read as a disabled `test.skip`.
		const code = "contest.skip(currentIndex);";
		expect(checkDisabledTests(code, TEST)).toEqual([]);
	});

	it("N2: does not flag it.skip mentioned inside a comment", () => {
		// stripCommentsAndStrings blanks comment text before the marker regex
		// runs, so a mention IN a comment is not a live skip marker.
		const code = "// TODO: remove the old it.skip('flaky', () => {}) call below";
		expect(checkDisabledTests(code, TEST)).toEqual([]);
	});

	it("N3: does not flag it.skip mentioned inside a string literal", () => {
		// String contents are likewise stripped before matching, so referring to
		// the marker in a message string is not itself a skip.
		const code = "const note = \"run it.skip('x') locally to disable\";";
		expect(checkDisabledTests(code, TEST)).toEqual([]);
	});

	it("N4: does not flag a legitimately parameterized test via it.each", () => {
		// `.each(...)` is a distinct jest/vitest modifier from `.skip` and is not
		// in the marker set at all.
		const code = "it.each([[1], [2]])('handles %s', (x) => { expect(x).toBeDefined(); });";
		expect(checkDisabledTests(code, TEST)).toEqual([]);
	});
});

// ===========================================
// checkTargetBlankNoRel
// ===========================================
describe("checkTargetBlankNoRel", () => {
	it("flags target=\"_blank\" without a rel attribute in TSX", () => {
		const code = '<a href="x" target="_blank">link</a>';
		const out = checkTargetBlankNoRel(code, TSX);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
		expect(nonNull(out[0]).text).toContain('target="_blank"');
	});

	it("flags in JSX and HTML extensions too", () => {
		const code = '<a target="_blank">x</a>';
		expect(checkTargetBlankNoRel(code, JSX)).toHaveLength(1);
		expect(checkTargetBlankNoRel(code, HTML)).toHaveLength(1);
	});

	it("supports single-quoted target='_blank'", () => {
		const code = "<a target='_blank'>x</a>";
		expect(checkTargetBlankNoRel(code, TSX)).toHaveLength(1);
	});

	it("does not flag when rel=noopener is on the same line", () => {
		const code = '<a target="_blank" rel="noopener noreferrer">x</a>';
		expect(checkTargetBlankNoRel(code, TSX)).toEqual([]);
	});

	it("does not flag when rel is on a nearby line of the same element", () => {
		const code = ["<a", '  target="_blank"', '  rel="noreferrer"', ">x</a>"].join("\n");
		expect(checkTargetBlankNoRel(code, TSX)).toEqual([]);
	});

	it("finds rel on a PRECEDING line within the ±5 window", () => {
		const code = ['<a rel="noopener"', '   href="x"', '   target="_blank">link</a>'].join("\n");
		expect(checkTargetBlankNoRel(code, TSX)).toEqual([]);
	});

	it("flags when a new element appears before the rel (forward scan stops at it)", () => {
		// After the target line, a `<div>` line (no rel) appears before the
		// `rel` line. The forward scan breaks at the new element and never
		// reaches the later rel, so the anchor is flagged.
		const code = [
			'  <a target="_blank">link</a>',
			"<div>",
			'<span rel="noopener">later</span>',
		].join("\n");
		const out = checkTargetBlankNoRel(code, TSX);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain('target="_blank"');
	});

	it("returns [] for target=_blank in test files (gate)", () => {
		const code = '<a target="_blank">x</a>';
		expect(checkTargetBlankNoRel(code, "src/ui/Comp.test.tsx")).toEqual([]);
	});

	it("returns [] for non-tsx/jsx/html extensions (gate)", () => {
		const code = '<a target="_blank">x</a>';
		expect(checkTargetBlankNoRel(code, TS)).toEqual([]);
		expect(checkTargetBlankNoRel(code, JS)).toEqual([]);
	});

	it("does not flag a line without target=\"_blank\"", () => {
		expect(checkTargetBlankNoRel('<a href="x">link</a>', TSX)).toEqual([]);
	});

	it("caps results at 10 offending anchors", () => {
		// Separate each anchor with a non-element line so the ±5 rel-scan window
		// from one anchor can't be mistaken; none have rel, so all 13 would fire.
		const code = Array.from({ length: 13 }, (_, i) => `const a${i} = <a target="_blank" />;`).join(
			"\n",
		);
		const out = checkTargetBlankNoRel(code, TSX);
		expect(out).toHaveLength(10);
	});
});
