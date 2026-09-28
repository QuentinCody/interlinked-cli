import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkExpressionMeasurement } from "./expression-readability.js";
import {
	checkCatchAndLog,
	checkHardcodedTimeout,
	checkJsonParseUnsafe,
	checkNestedTernaries,
	checkTargetBlankNoRel,
} from "./js-ts-general.js";

const TS = "src/lib/foo.ts";
const TSX = "src/ui/Comp.tsx";

// Genuine (non-exempt-path, non-vacuous) catch-log body: K&R `} catch` with a
// pure-console body, used across the isCatchLogExemptPath and
// checkCatchAndLog test groups below. Several existing companion-file tests
// use a "} catch" with NO leading "{" on the same/adjacent 3 lines, or an
// Allman `catch` with no preceding "}" on that line — both of those never
// reach the outer `/\}\s*catch\s*/` detection at all, so they pass vacuously
// regardless of isCatchLogExemptPath's/detection-regex's real behavior. This
// scaffold genuinely reaches scanCatchBody.
const GENUINE_CATCH_LOG = [
	"function h() {",
	"  try {",
	"    risky();",
	"  } catch (e) {",
	"    console.error(e);",
	"  }",
	"}",
].join("\n");

// ===========================================
// checkNestedTernaries — survivor kills
// ===========================================
describe("checkNestedTernaries — mutation kills", () => {
	// test-contract: invariant — the `extends ... ?` conditional-type skip must
	// fire even when the line has NO `type X =` prefix (e.g. a bare generic
	// constraint), isolating it from the separate type-alias skip regex.
	it("P: skips a bare `extends ... ?` conditional-type chain with no `type` keyword", () => {
		const code = "declare function pick<T extends A ? X : T extends B ? Y : Z>(x: T): T;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	// test-contract: invariant — the type-alias skip (`type X = ... ?`) must
	// tolerate MULTIPLE whitespace chars between `type` and the identifier.
	it("P: skips a type-alias line with two spaces after `type`", () => {
		const code = "type  Cond = A ? B : C ? D : E;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	// test-contract: invariant — the type-alias skip must tolerate a multi-char
	// gap (generic parameter list) between the alias name and `=`.
	it("P: skips a type-alias line with a generic parameter list before `=`", () => {
		const code = "type Foo<T> = A ? B : C ? D : E;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	// test-contract: invariant — a standalone optional-property declaration line
	// (`name?: ...`) is skipped even when its value expression itself contains
	// two real ternary `?`s (the CLEANUP regex alone must not be relied on).
	it("P: skips a standalone optional-property line whose value has two ternaries", () => {
		const code = "  name?: a ? b : c ? d : e;";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	// test-contract: invariant — the standalone-property skip is ANCHORED to
	// line start; a property-like `id?: ` fragment buried mid-line (e.g. inside
	// an object literal) must NOT cause the whole line to be skipped.
	it("N: does not skip a line where an optional-property fragment appears mid-line", () => {
		const code = "const cfg = { retries?: 3 }; const x = a ? b : c ? d : e;";
		expect(checkNestedTernaries(code, TS)).toEqual([
			{ line: 1, text: "const cfg = { retries?: 3 }; const x = a ? b : c ? d : e;" },
		]);
	});

	// test-contract: invariant — inline optional-property cleanup
	// (`\w+\?\s*:` → "X:") must require NO whitespace between the identifier
	// and the `?`, but allow a space between `?` and `:`; a line whose two
	// optional properties both have a space there must still be neutralized.
	it("P: does not mistake `id? :` (space before colon) optional properties for ternaries", () => {
		const code = "const obj: { id? : number, label? : string } = makeObj();";
		expect(checkNestedTernaries(code, TS)).toEqual([]);
	});

	// Parser migration: these old regex-survivor fixtures are malformed programs.
	// They must produce unavailable evidence, not invented ternary findings.
	it.each(["a?id?:.b ? c", "a?(?:.b ? c", "a?*?.b ? c", "a?/re/.b ? c"])(
		"reports incomplete syntax as NOT CHECKED: %s", (code) => {
			expect(checkNestedTernaries(code, TS)).toEqual([]);
			expect(checkExpressionMeasurement(code, TS)).toMatchObject([
				{ text: expect.stringContaining("NOT CHECKED") },
			]);
		},
	);

	// test-contract: public-api — the reported `text` is the TRIMMED original
	// line; leading/trailing whitespace around a genuinely flagged line must
	// not leak into the reported text.
	it("P: reports trimmed text even when the original line has leading/trailing whitespace", () => {
		const code = "   const x = a ? b : c ? d : e;   ";
		const out = checkNestedTernaries(code, TS);
		expect(out).toEqual([{ line: 1, text: "const x = a ? b : c ? d : e;" }]);
	});
});

// ===========================================
// checkCatchAndLog / scanCatchBody — survivor kills
// (scanCatchBody is unexported; exercised through the public checkCatchAndLog)
// ===========================================
describe("checkCatchAndLog — scanCatchBody mutation kills", () => {
	// test-contract: invariant — an EMPTY catch body (no console call at all)
	// must not be flagged; hasConsole must start false and never flip true on
	// its own, isolating scanCatchBody's `hasConsole` initializer.
	it("P: does not flag a catch block with a genuinely empty body", () => {
		const code = ["function f() {", "  try {", "    risky();", "  } catch (e) {", "  }", "}"].join(
			"\n",
		);
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	// test-contract: invariant — when the 8-line scan window never finds a
	// closing brace, `foundClose` must stay false; placed so the file's first
	// four lines are blank (avoiding the unrelated closeIdx=-1 fallback path
	// in hasMeaningfulCodeAfterCatch from masking the result).
	it("P: does not flag when no closing brace is found within the 8-line scan window", () => {
		const code = [
			"",
			"",
			"",
			"",
			"} catch (e) {",
			"  console.log(1);",
			"  console.log(2);",
			"  console.log(3);",
			"  console.log(4);",
			"  console.log(5);",
			"  console.log(6);",
			"  console.log(7);",
		].join("\n");
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	// test-contract: boundary — the scan window's upper bound is `j <
	// Math.min(braceStart + 8, strippedLines.length)`. When the array is
	// shorter than braceStart+8, the loop must stop at the array's own end
	// (not read one past it, which would throw via nonNull).
	it("P: does not throw when the catch body is the very last content in a short file", () => {
		const code = ["function f() {", "  try {", "    risky();", "  } catch (e)", "  {"].join("\n");
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	// test-contract: invariant — depth tracking must correctly find the REAL
	// closing brace across several console-only body lines (Allman style, so
	// the try-block's own closing brace doesn't share a line with the catch's
	// opening brace and skew the depth count).
	it("P: flags a multi-line all-console catch body, finding the real closing brace", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e)",
			"  {",
			"    console.log(1);",
			"    console.log(2);",
			"    console.log(3);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toEqual([{ line: 4, text: "} catch (e)" }]);
	});

	// test-contract: invariant — a BLANK line inside the catch body must be
	// treated as "fine" (not misread as non-console content that would abort
	// scanning early).
	it("P: flags a catch body with a blank line between two console calls", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e)",
			"  {",
			"    console.log(1);",
			"",
			"    console.log(2);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toEqual([{ line: 4, text: "} catch (e)" }]);
	});

	// test-contract: invariant — the console-call regex's `^` anchor must
	// require the console call to lead the line; a line with real code BEFORE
	// an embedded `console.log(` must be classified as non-console (onlyConsole
	// = false), not console-only.
	it("P: does not flag when a body line has real code before an embedded console.log(", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e)",
			"  {",
			"    x(); console.log(1);",
			"  }",
			"}",
		].join("\n");
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	// test-contract: invariant — the console-call regex requires WHITESPACE
	// (not non-whitespace) between the method name and the opening paren; a
	// spaced call `console.log (1)` is still a real console call.
	it("P: flags a catch body whose only line is a spaced `console.log (1);`", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e)",
			"  {",
			"    console.log (1);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toEqual([{ line: 4, text: "} catch (e)" }]);
	});

	// test-contract: invariant — a non-console, non-blank, non-closing-brace
	// body line MUST flip onlyConsole to false and stop the scan (so a LATER
	// real console call in the same body can't paper over it).
	it("P: does not flag when non-console code precedes a console call in the body", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e)",
			"  {",
			"    cleanup();",
			"    console.log(1);",
			"  }",
			"}",
		].join("\n");
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	// test-contract: boundary — `depth <= 0` (not `depth < 0`) must recognize
	// the closing brace when depth returns to EXACTLY zero; padded with blank
	// lines (never another brace) so a strict `< 0` mutant can never find
	// closure within the 8-line window and the two behaviors diverge.
	it("P: flags when the catch body closes with depth exactly zero (no further brace nearby)", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch (e)",
			"  {",
			"    console.log(1);",
			"  }",
			"",
			"",
			"",
			"",
			"",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toEqual([{ line: 4, text: "} catch (e)" }]);
	});
});

// ===========================================
// checkJsonParseUnsafe / module-level TRY_OPEN, CATCH_CLOSE, JSON_PARSE,
// INLINE_TRY_PARSE_CATCH — survivor kills
// ===========================================
describe("checkJsonParseUnsafe — TRY_OPEN mutation kills", () => {
	// test-contract: invariant — TRY_OPEN's K&R alternative allows ZERO or more
	// whitespace between `try` and `{`; a compact `try{` (no space) must still
	// open a try scope so the JSON.parse inside it is not flagged.
	it("P: does not flag JSON.parse inside a compact `try{` with no space before the brace", () => {
		const code = ["try{", "  const d = JSON.parse(x);", "} catch (e) {", "  y = null;", "}"].join(
			"\n",
		);
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	// test-contract: invariant — TRY_OPEN's bare-`try` alternative is anchored
	// at line START; a word merely ENDING in "try" (e.g. `retry`) must not be
	// mistaken for a try-opener.
	it("P: flags a bare JSON.parse even when an earlier line's identifier ends in 'try'", () => {
		const code = ["const x = retry;", "const data = JSON.parse(input);"].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([
			{ line: 2, text: "const data = JSON.parse(input);" },
		]);
	});

	// test-contract: invariant — TRY_OPEN's bare-`try` alternative is anchored
	// at line END; a `try` that is merely a PREFIX of a longer identifier/call
	// (e.g. `tryFoo()`) must not be mistaken for a try-opener.
	it("P: flags a bare JSON.parse even when an earlier line starts with 'try' as an identifier prefix", () => {
		const code = ["  tryFoo();", "const data = JSON.parse(input);"].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([
			{ line: 2, text: "const data = JSON.parse(input);" },
		]);
	});

	// test-contract: invariant — the bare-`try` alternative allows LEADING
	// whitespace before `try` (an indented Allman-style opener).
	it("P: does not flag JSON.parse inside an indented bare `try` (Allman style)", () => {
		const code = [
			"  try",
			"  {",
			"    const data = JSON.parse(input);",
			"  }",
			"  catch (e) {}",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	// test-contract: invariant — the bare-`try` alternative allows TRAILING
	// whitespace after `try` before the line ends.
	it("P: does not flag JSON.parse inside a bare `try ` with a trailing space", () => {
		const code = ["try ", "{", "  const data = JSON.parse(input);", "}", "catch (e) {}"].join(
			"\n",
		);
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});
});

describe("checkJsonParseUnsafe — CATCH_CLOSE mutation kills", () => {
	// test-contract: bug — CATCH_CLOSE's line-start alternative is ANCHORED; a
	// promise `.catch(` chain (documented exemption in the source comment) must
	// NOT be mistaken for a try-block closer and decrement tryDepth.
	it("P: does not treat a `.catch(` promise chain as closing the enclosing try block", () => {
		const code = [
			"try {",
			"  promise.catch(handleError);",
			"  const data = JSON.parse(input);",
			"} catch (e) {",
			"  recover();",
			"}",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	// test-contract: invariant — CATCH_CLOSE's line-start alternative allows
	// LEADING whitespace before `catch` (an indented Allman-style `catch`).
	it("P: closes the try scope for an indented bare `catch` on its own line", () => {
		const code = [
			"try",
			"{",
			"  setup();",
			"}",
			"  catch (e) {",
			"  recover();",
			"}",
			"const data = JSON.parse(input);",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([
			{ line: 8, text: "const data = JSON.parse(input);" },
		]);
	});

	// test-contract: invariant — CATCH_CLOSE's `}`-prefixed alternative allows
	// MULTIPLE whitespace chars between `}` and `catch`.
	it("P: closes the try scope when `}` and `catch` are separated by two spaces", () => {
		const code = [
			"try {",
			"  setup();",
			"}  catch (e) {",
			"  recover();",
			"}",
			"const data = JSON.parse(input);",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([
			{ line: 6, text: "const data = JSON.parse(input);" },
		]);
	});
});

describe("checkJsonParseUnsafe — JSON_PARSE and INLINE_TRY_PARSE_CATCH mutation kills", () => {
	// test-contract: invariant — JSON_PARSE allows whitespace between `.parse`
	// and the opening paren.
	it("P: flags a spaced `JSON.parse (x)` call", () => {
		const code = "const d = JSON.parse (x);";
		expect(checkJsonParseUnsafe(code, TS)).toEqual([{ line: 1, text: code }]);
	});

	// Shared scaffold for the INLINE_TRY_PARSE_CATCH mutants below: a
	// single-line `try { JSON.parse(...); } catch (...) { ... }` followed by a
	// SEPARATE bare JSON.parse. When INLINE correctly recognizes line 1 as the
	// safe single-line shape, it `continue`s past the JSON.parse push AND past
	// that line's own CATCH_CLOSE check, leaving tryDepth at its post-TRY_OPEN
	// value of 1 — so the line-2 JSON.parse reads as "still inside a try" and
	// is (surprisingly, but correctly per the current contract) NOT flagged.
	// When INLINE fails to recognize the shape, execution falls through to the
	// CATCH_CLOSE check on line 1, which resets tryDepth to 0, and the line-2
	// JSON.parse IS flagged. This flip is what each mutant below is caught by.

	// test-contract: invariant — INLINE's try-open gap (`\btry\s*\{`) accepts
	// 0+ whitespace; two spaces after `try` on the single-line shape.
	it("P: does not flag the trailing bare JSON.parse after a single-line try-catch with 2 spaces after try", () => {
		const code = [
			"try  { JSON.parse(x); } catch (e) { fallback(); }",
			"const d2 = JSON.parse(y);",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	// test-contract: invariant — INLINE's standard single-space single-line
	// try-catch shape must still be recognized as safe.
	it("P: does not flag the trailing bare JSON.parse after a standard single-line try-catch", () => {
		const code = [
			"try { JSON.parse(x); } catch (e) { fallback(); }",
			"const d2 = JSON.parse(y);",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	// test-contract: invariant — INLINE's gap between `{` and `JSON.parse`
	// accepts an arbitrary-length prefix (e.g. a variable declaration), not
	// just a single character.
	it("P: does not flag the trailing bare JSON.parse when the single-line try has a long prefix before JSON.parse", () => {
		const code = [
			"try { const d = JSON.parse(x); } catch (e) { fallback(); }",
			"const d2 = JSON.parse(y);",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	// test-contract: invariant — INLINE's gap between the JSON.parse call and
	// the closing `}` accepts an arbitrary-length suffix (e.g. multiple call
	// arguments), not just a single character.
	it("P: does not flag the trailing bare JSON.parse when the single-line JSON.parse call has multiple arguments", () => {
		const code = [
			"try { JSON.parse(x, y); } catch (e) { fallback(); }",
			"const d2 = JSON.parse(z);",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});

	// test-contract: invariant — INLINE's gap between `}` and `catch` accepts
	// 0+ whitespace; two spaces before `catch` on the single-line shape.
	it("P: does not flag the trailing bare JSON.parse after a single-line try-catch with 2 spaces before catch", () => {
		const code = [
			"try { JSON.parse(x); }  catch (e) { fallback(); }",
			"const d2 = JSON.parse(y);",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([]);
	});
});

describe("checkJsonParseUnsafe — text formatting and tryDepth-guard mutation kills", () => {
	// test-contract: public-api — the reported `text` is truncated to 150
	// chars via `.slice(0, 150)` after trimming.
	it("P: truncates a long flagged line's text to exactly 150 chars", () => {
		const longTail = "x".repeat(200);
		const code = `const data = JSON.parse(input); // ${longTail}`;
		const out = checkJsonParseUnsafe(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text.length).toBe(150);
	});

	// test-contract: public-api — the reported `text` is the TRIMMED original
	// line; leading/trailing whitespace must not leak into the reported text.
	it("P: reports trimmed text for a flagged line with leading/trailing whitespace", () => {
		const code = "   const data = JSON.parse(input);   ";
		expect(checkJsonParseUnsafe(code, TS)).toEqual([
			{ line: 1, text: "const data = JSON.parse(input);" },
		]);
	});

	// test-contract: invariant — the CATCH_CLOSE decrement is guarded so a
	// stray unmatched `catch` cannot push tryDepth negative.
	it("P: a stray unmatched catch does not push tryDepth negative and corrupt a later real try block", () => {
		const code = [
			"const a = JSON.parse(x);",
			"} catch (e) {",
			"  recover();",
			"}",
			"try {",
			"  const b = JSON.parse(y);",
			"} catch (e2) {",
			"  recover2();",
			"}",
		].join("\n");
		expect(checkJsonParseUnsafe(code, TS)).toEqual([{ line: 1, text: "const a = JSON.parse(x);" }]);
	});
});

// ===========================================
// checkCatchAndLog — isCatchLogExemptPath mutation kills
// (isCatchLogExemptPath is unexported; exercised through checkCatchAndLog)
// ===========================================
describe("checkCatchAndLog — isCatchLogExemptPath mutation kills", () => {
	// test-contract: invariant — a genuine route-segment path must exempt the
	// file entirely, regardless of the OR-vs-AND combination of the two
	// exemption regexes or whether the function body runs at all.
	it("P: exempts a genuine route-handler path with real catch-log content", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src/routes/users.ts")).toEqual([]);
	});

	// test-contract: invariant — Windows-style backslash separators must be
	// normalized to forward slashes before the path-segment regex runs.
	it("P: exempts a route-handler path using backslash separators", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src\\routes\\users.ts")).toEqual([]);
	});

	// test-contract: invariant — the `routes?` alternative's `?` makes the
	// trailing `s` optional; a SINGULAR `route` segment must also exempt.
	it("P: exempts a singular /route/ path segment", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src/route/users.ts")).toEqual([]);
	});

	// test-contract: invariant — same optional-`s` contract for `handlers?`.
	it("P: exempts a singular /handler/ path segment", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src/handler/users.ts")).toEqual([]);
	});

	// test-contract: invariant — same optional-`s` contract for `endpoints?`.
	it("P: exempts a singular /endpoint/ path segment", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src/endpoint/users.ts")).toEqual([]);
	});

	// test-contract: invariant — same optional-`s` contract for `webhooks?`.
	it("P: exempts a singular /webhook/ path segment", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src/webhook/users.ts")).toEqual([]);
	});

	// test-contract: invariant — same optional-`s` contract for `actions?`.
	it("P: exempts a singular /action/ path segment", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src/action/users.ts")).toEqual([]);
	});

	// test-contract: invariant — the filename-suffix regex is anchored at the
	// end (`$`); a `.route.tsx` fragment followed by a real `.ts` extension
	// is not the true end of the filename, so it must not exempt.
	it("N: does not exempt a `.route.tsx`-like fragment that is not the true end of the filename", () => {
		const out = checkCatchAndLog(GENUINE_CATCH_LOG, "src/users.route.tsx.ts");
		expect(out).toEqual([{ line: 4, text: "} catch (e) {" }]);
	});

	// test-contract: invariant — the filename-suffix regex's extension char
	// class `[jt]` and its trailing optional `x` together must recognize a
	// plain `.ts` suffix (no `x`) as an exempt filename-suffix shape.
	it("P: exempts a `.route.ts` filename suffix with no trailing x", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src/users.route.ts")).toEqual([]);
	});
});

// ===========================================
// checkCatchAndLog — own mutation kills (extension gate, detection regex,
// braceStart search, text formatting)
// ===========================================
describe("checkCatchAndLog — own mutation kills", () => {
	// test-contract: invariant — the extension gate must apply even when the
	// (unrealistic-for-the-language) content contains a genuine catch-log
	// shape; a `.py` path must never be scanned.
	it("P: does not flag catch-log content in a non-JS/TS file", () => {
		expect(checkCatchAndLog(GENUINE_CATCH_LOG, "src/foo.py")).toEqual([]);
	});

	// test-contract: invariant — the outer detection regex tolerates MULTIPLE
	// spaces between `}` and `catch`.
	it("P: flags a catch-log block with 2 spaces between `}` and `catch`", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  }  catch (e) {",
			"    console.error(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toEqual([{ line: 4, text: "}  catch (e) {" }]);
	});

	// test-contract: invariant — the outer detection regex tolerates ZERO
	// whitespace between `catch` and the following `(`.
	it("P: flags a catch-log block with no space between `catch` and `(`", () => {
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			"  } catch(e) {",
			"    console.error(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toEqual([{ line: 4, text: "} catch(e) {" }]);
	});

	// test-contract: invariant — when no `{` is found within the 3-line
	// braceStart lookahead, `braceStart` must stay at its `-1` sentinel so the
	// scan is skipped; an initial value other than -1 makes the function
	// scan from an ARBITRARY unrelated index and can fabricate a match.
	it("P: does not fabricate a match when no opening brace is found near a bare `} catch` line", () => {
		const code = ["} catch", "console.log(1);", "console.log(2);", "}"].join("\n");
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	// test-contract: boundary — the braceStart lookahead window is bounded by
	// `Math.min(i + 3, strippedLines.length)`; on a 1-line file this must stop
	// at the array's own end, not read past it.
	it("P: does not throw when a bare `} catch` line is the only content in the file", () => {
		const code = "} catch";
		expect(checkCatchAndLog(code, TS)).toEqual([]);
	});

	// test-contract: public-api — the reported `text` is truncated to 150
	// chars (trim then slice); a long trailing comment on the `} catch` line
	// itself must not leak past the cap.
	it("P: truncates a long `} catch` line's reported text to exactly 150 chars", () => {
		const longTail = "z".repeat(300);
		const code = [
			"function f() {",
			"  try {",
			"    risky();",
			`  } catch (e) { // ${longTail}`,
			"    console.error(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchAndLog(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text.length).toBe(150);
	});

	// test-contract: public-api — the reported `text` is the TRIMMED original
	// `} catch` line.
	it("P: reports trimmed text for a `} catch` line with leading/trailing whitespace", () => {
		const code = ["function f() {", "  try {", "    risky();", "     } catch (e) {   ", "    console.error(e);", "  }", "}"].join(
			"\n",
		);
		const out = checkCatchAndLog(code, TS);
		expect(out).toEqual([{ line: 4, text: "} catch (e) {" }]);
	});
});

// ===========================================
// checkTargetBlankNoRel — survivor kills
// ===========================================
describe("checkTargetBlankNoRel — mutation kills", () => {
	// test-contract: invariant — the rel-value char class `[^"']*` allows
	// arbitrary non-quote text before `noopener`/`noreferrer` inside the
	// quotes (e.g. another rel token like `nofollow`).
	it("P: does not flag when rel has another token before noopener", () => {
		const code = '<a target="_blank" rel="nofollow noopener">x</a>';
		expect(checkTargetBlankNoRel(code, TSX)).toEqual([]);
	});

	// test-contract: boundary — the forward "new element" stop-scan must only
	// apply STRICTLY AFTER the target line (`j > i`), never at the target
	// line itself, even when that line starts with `<`.
	it("P: finds rel on the line after a target line that itself starts with `<`", () => {
		const code = ['<a target="_blank"', '  rel="noreferrer">x</a>'].join("\n");
		expect(checkTargetBlankNoRel(code, TSX)).toEqual([]);
	});

	// test-contract: invariant — the "new element" stop-scan regex is
	// ANCHORED at line start; a `<`/`>` appearing mid-line (e.g. inside a
	// comparison expression) must not be mistaken for a new JSX element.
	it("P: does not stop scanning at a mid-line `>` inside an unrelated expression", () => {
		const code = ['<a target="_blank">link</a>', "const cmp = a > b;", 'rel="noreferrer"'].join(
			"\n",
		);
		expect(checkTargetBlankNoRel(code, TSX)).toEqual([]);
	});

	// test-contract: invariant — the "new element" stop-scan regex tolerates
	// LEADING WHITESPACE (indentation) before the `<`/`>`.
	it("P: stops the forward rel-scan at an indented new element", () => {
		const code = [
			'  <a target="_blank">link</a>',
			"  <div>",
			'  <span rel="noopener">later</span>',
		].join("\n");
		const out = checkTargetBlankNoRel(code, TSX);
		expect(out).toEqual([{ line: 1, text: '<a target="_blank">link</a>' }]);
	});

	// test-contract: public-api — the reported `text` is truncated to 150
	// chars (trim then slice).
	it("P: truncates a long flagged anchor's text to exactly 150 chars", () => {
		const longTail = "y".repeat(200);
		const code = `<a target="_blank">${longTail}</a>`;
		const out = checkTargetBlankNoRel(code, TSX);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text.length).toBe(150);
	});

	// test-contract: public-api — the reported `text` is the TRIMMED original
	// line.
	it("P: reports trimmed text for a flagged anchor with leading/trailing whitespace", () => {
		const code = '   <a target="_blank">x</a>   ';
		expect(checkTargetBlankNoRel(code, TSX)).toEqual([{ line: 1, text: '<a target="_blank">x</a>' }]);
	});
});

// ===========================================
// checkHardcodedTimeout — survivor kills
// ===========================================
describe("checkHardcodedTimeout — mutation kills", () => {
	// test-contract: invariant — the pattern tolerates whitespace between
	// `setTimeout`/`setInterval` and the opening `(`.
	it("P: flags a spaced `setTimeout (fn, 5000)` call", () => {
		const code = "setTimeout (fn, 5000);";
		expect(checkHardcodedTimeout(code, TS)).toEqual([{ line: 1, text: code }]);
	});

	// test-contract: invariant — the pattern tolerates MULTIPLE whitespace
	// chars between the comma and the delay digits.
	it("P: flags a `setTimeout` call with 2 spaces after the comma", () => {
		const code = "setTimeout(fn,  5000);";
		expect(checkHardcodedTimeout(code, TS)).toEqual([{ line: 1, text: code }]);
	});

	// test-contract: invariant — the pattern tolerates whitespace between the
	// delay digits and the closing `)`.
	it("P: flags a `setTimeout` call with a space before the closing paren", () => {
		const code = "setTimeout(fn, 5000 );";
		expect(checkHardcodedTimeout(code, TS)).toEqual([{ line: 1, text: code }]);
	});

	// test-contract: public-api — the reported `text` is truncated to 150
	// chars (trim then slice).
	it("P: truncates a long flagged timeout line's text to exactly 150 chars", () => {
		const longTail = "w".repeat(200);
		const code = `setTimeout(fn, 5000); // ${longTail}`;
		const out = checkHardcodedTimeout(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text.length).toBe(150);
	});

	// test-contract: public-api — the reported `text` is the TRIMMED original
	// line.
	it("P: reports trimmed text for a flagged timeout line with leading/trailing whitespace", () => {
		const code = "   setTimeout(fn, 5000);   ";
		expect(checkHardcodedTimeout(code, TS)).toEqual([{ line: 1, text: "setTimeout(fn, 5000);" }]);
	});
});
