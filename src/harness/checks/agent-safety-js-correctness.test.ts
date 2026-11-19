import { describe, expect, it } from "vitest";
import {
	checkBroadObjectTypes,
	checkConstantCondition,
	checkEvalUsage,
	checkInnerHtmlUsage,
	checkJsLooseEquality,
	checkMagicLiteralInConditional,
	checkNanComparison,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkUnsafeOptionalChaining,
} from "./agent-safety-js-correctness.js";

// Smoke-test coverage for the agent-safety JS/TS type-safety and correctness
// check family. Deeper coverage lives in `src/harness/__tests__/` (e.g.
// `ubs-js-loose-equality.test.ts`, `generic-checks-extended-*.test.ts`) — this
// file satisfies the harness's per-source-file test rule and guards the shape
// of the exported check functions.

describe("agent-safety js-correctness check surface — smoke", () => {
	// test-contract: checkNonNullAssertions returns an array
	it("checkNonNullAssertions returns an array", () => {
		expect(Array.isArray(checkNonNullAssertions("", "a.ts"))).toBe(true);
	});

	// test-contract: checkMagicLiteralInConditional returns an array
	it("checkMagicLiteralInConditional returns an array", () => {
		expect(Array.isArray(checkMagicLiteralInConditional("", "a.ts"))).toBe(true);
	});

	// test-contract: checkBroadObjectTypes returns an array
	it("checkBroadObjectTypes returns an array", () => {
		expect(Array.isArray(checkBroadObjectTypes("", "a.ts"))).toBe(true);
	});

	// test-contract: checkEvalUsage returns an array
	it("checkEvalUsage returns an array", () => {
		expect(Array.isArray(checkEvalUsage("", "a.ts"))).toBe(true);
	});

	// test-contract: checkInnerHtmlUsage returns an array
	it("checkInnerHtmlUsage returns an array", () => {
		expect(Array.isArray(checkInnerHtmlUsage("", "a.ts"))).toBe(true);
	});

	// test-contract: checkNanComparison returns an array
	it("checkNanComparison returns an array", () => {
		expect(Array.isArray(checkNanComparison("", "a.ts"))).toBe(true);
	});

	// test-contract: checkJsLooseEquality returns an array
	it("checkJsLooseEquality returns an array", () => {
		expect(Array.isArray(checkJsLooseEquality("", "a.ts"))).toBe(true);
	});

	// test-contract: checkConstantCondition returns an array
	it("checkConstantCondition returns an array", () => {
		expect(Array.isArray(checkConstantCondition("", "a.ts"))).toBe(true);
	});

	// test-contract: checkUnsafeOptionalChaining returns an array
	it("checkUnsafeOptionalChaining returns an array", () => {
		expect(Array.isArray(checkUnsafeOptionalChaining("", "a.ts"))).toBe(true);
	});

	// test-contract: checkNumberPrecisionLoss returns an array
	it("checkNumberPrecisionLoss returns an array", () => {
		expect(Array.isArray(checkNumberPrecisionLoss("", "a.ts"))).toBe(true);
	});
});

describe("checkNonNullAssertions", () => {
	// test-contract: flags a non-null assertion before property access
	it("flags a non-null assertion before property access", () => {
		const out = checkNonNullAssertions("const x = foo!.bar;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: does NOT flag loose-inequality `!==`
	it("does NOT flag loose-inequality `!==`", () => {
		const out = checkNonNullAssertions("if (a !== b) doThing();\n", "src/x.ts");
		expect(out).toEqual([]);
	});

	// test-contract: does NOT run on test files
	it("does NOT run on test files", () => {
		const out = checkNonNullAssertions("const x = foo!.bar;\n", "src/x.test.ts");
		expect(out).toEqual([]);
	});
});

describe("checkMagicLiteralInConditional", () => {
	// test-contract: flags an opaque numeric comparison literal
	it("flags an opaque numeric comparison literal", () => {
		const out = checkMagicLiteralInConditional("if (status === 42) {}\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: does NOT flag the `typeof x === \"string\"` narrowing idiom
	it("does NOT flag the `typeof x === \"string\"` narrowing idiom", () => {
		const out = checkMagicLiteralInConditional(
			'if (typeof x === "string") {}\n',
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	// test-contract: does NOT flag a self-describing identifier-like string token
	it("does NOT flag a self-describing identifier-like string token", () => {
		const out = checkMagicLiteralInConditional(
			'if (runner === "codex") {}\n',
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});
});

describe("checkBroadObjectTypes", () => {
	// test-contract: flags Record<string, any>
	it("flags Record<string, any>", () => {
		const out = checkBroadObjectTypes("const x: Record<string, any> = {};\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: flags a bare Function type annotation
	it("flags a bare Function type annotation", () => {
		const out = checkBroadObjectTypes("let cb: Function;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: does NOT run on generated files
	it("does NOT run on generated files", () => {
		const out = checkBroadObjectTypes(
			"// auto-generated\nconst x: Record<string, any> = {};\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	// test-contract: does NOT flag the type-safe `unknown` wide map (finding 2026-06)
	it("does NOT flag the type-safe `unknown` wide map (finding 2026-06)", () => {
		// `unknown` forces narrowing at every use site — the honest type for dynamic
		// SQL rows / parsed JSON — so it is exempt; only shapeless `any` is flagged.
		expect(checkBroadObjectTypes("const x: Record<string, unknown> = {};\n", "src/x.ts")).toEqual(
			[],
		);
		expect(
			checkBroadObjectTypes("function f(): Record<string, unknown> { return {}; }\n", "src/x.ts"),
		).toEqual([]);
		expect(checkBroadObjectTypes("const m: { [k: string]: unknown } = {};\n", "src/x.ts")).toEqual(
			[],
		);
	});
});

describe("checkEvalUsage", () => {
	// test-contract: flags a direct eval() call
	it("flags a direct eval() call", () => {
		const out = checkEvalUsage("eval(userInput);\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: flags setTimeout with a string argument (implied eval)
	it("flags setTimeout with a string argument (implied eval)", () => {
		const out = checkEvalUsage('setTimeout("doThing()", 100);\n', "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// FP regression: a member method named `eval` (`obj.eval(...)`) is not the
	// global eval. The negative lookbehind `(?<![.\w])` (matching the sibling
	// checkEvalInputTainted) must keep these from firing.
	// test-contract: does NOT flag a member call `mathParser.eval(expr)`
	it("does NOT flag a member call `mathParser.eval(expr)`", () => {
		expect(checkEvalUsage("const r = mathParser.eval(expr);\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: does NOT flag `vm.eval(code)`
	it("does NOT flag `vm.eval(code)`", () => {
		expect(checkEvalUsage("vm.eval(code);\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: does NOT flag an identifier-suffixed `myEval(x)`
	it("does NOT flag an identifier-suffixed `myEval(x)`", () => {
		expect(checkEvalUsage("const y = myEval(x);\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: still flags bare `eval(userInput)`
	it("still flags bare `eval(userInput)`", () => {
		expect(checkEvalUsage("eval(userInput);\n", "src/x.ts").length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: still flags `eval (x)` with a space before the paren
	it("still flags `eval (x)` with a space before the paren", () => {
		expect(checkEvalUsage("eval (x);\n", "src/x.ts").length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: still flags a statement-leading global `eval(...)`
	it("still flags a statement-leading global `eval(...)`", () => {
		expect(checkEvalUsage("\teval(payload);\n", "src/x.ts").length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkInnerHtmlUsage", () => {
	// test-contract: flags direct innerHTML assignment
	it("flags direct innerHTML assignment", () => {
		const out = checkInnerHtmlUsage("el.innerHTML = userHtml;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: flags dangerouslySetInnerHTML
	it("flags dangerouslySetInnerHTML", () => {
		const out = checkInnerHtmlUsage(
			"<div dangerouslySetInnerHTML={{ __html: x }} />\n",
			"src/x.tsx",
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkNanComparison", () => {
	// test-contract: flags `x === NaN`
	it("flags `x === NaN`", () => {
		const out = checkNanComparison("if (x === NaN) {}\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: does NOT flag Number.isNaN(x)
	it("does NOT flag Number.isNaN(x)", () => {
		const out = checkNanComparison("if (Number.isNaN(x)) {}\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

describe("checkJsLooseEquality", () => {
	// test-contract: flags loose `==`
	it("flags loose `==`", () => {
		const out = checkJsLooseEquality("if (a == b) {}\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: does NOT flag the `x == null` idiom
	it("does NOT flag the `x == null` idiom", () => {
		const out = checkJsLooseEquality("if (a == null) {}\n", "src/x.ts");
		expect(out).toEqual([]);
	});

	// test-contract: does NOT flag strict `===`
	it("does NOT flag strict `===`", () => {
		const out = checkJsLooseEquality("if (a === b) {}\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

describe("checkConstantCondition", () => {
	// test-contract: flags `if (true)`
	it("flags `if (true)`", () => {
		const out = checkConstantCondition("if (true) {}\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: does NOT flag `if (x === false)`
	it("does NOT flag `if (x === false)`", () => {
		const out = checkConstantCondition("if (x === false) {}\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

describe("checkUnsafeOptionalChaining", () => {
	// test-contract: flags `(obj?.foo).bar`
	it("flags `(obj?.foo).bar`", () => {
		const out = checkUnsafeOptionalChaining("const y = (obj?.foo).bar;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: does NOT flag `(obj?.foo ?? d).bar`
	it("does NOT flag `(obj?.foo ?? d).bar`", () => {
		const out = checkUnsafeOptionalChaining("const y = (obj?.foo ?? d).bar;\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

describe("checkNumberPrecisionLoss", () => {
	// test-contract: flags an integer literal beyond MAX_SAFE_INTEGER
	it("flags an integer literal beyond MAX_SAFE_INTEGER", () => {
		const out = checkNumberPrecisionLoss("const id = 9007199254740993;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	// test-contract: does NOT flag a small integer literal
	it("does NOT flag a small integer literal", () => {
		const out = checkNumberPrecisionLoss("const id = 42;\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

// ===========================================================================
// Survivor-elimination corpus (campaign plan 15, wave 2).
//
// Every case below is labeled P<n> (positive — MUST FIRE) or N<n> (negative —
// MUST NOT FIRE) so the Check Evidence Contract parser counts it, and each
// asserts a RETURNED VALUE (line number + reported text), never a mock.
//
// Shared shape assertions: an `InlineMatch` is `{line: <1-based>, text:
// <original line, trimmed, capped at 150 chars>}`. `text` comes from the
// ORIGINAL content (not the comment/string-stripped copy used for scanning),
// so every detector gets one exact-shape case and one 150-char truncation
// case. Together those pin `i + 1`, `content.split("\n")`, `.trim()` and
// `.slice(0, 150)` — the four mutation targets that repeat at every push site.
// ===========================================================================

/** 200 chars of filler so a fixture line exceeds the 150-char report cap. */
const PAD = "a".repeat(200);

/** Build `count` copies of `line`, newline-joined, to exercise the 10-match cap. */
function repeatLines(line: string, count: number): string {
	return Array.from({ length: count }, (_, i) => line.replace(/#/g, String(i))).join("\n");
}

describe("checkNonNullAssertions — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and the ORIGINAL (untrimmed-source) text
	it("P1: reports the exact 1-based line and the ORIGINAL (untrimmed-source) text", () => {
		const content = "const a = 1;\n\tconst x = foo!.bar; // trailing comment\n";
		expect(checkNonNullAssertions(content, "src/x.ts")).toEqual([
			{ line: 2, text: "const x = foo!.bar; // trailing comment" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `const ${PAD} = foo!.bar;`;
		const out = checkNonNullAssertions(`${line}\n`, "src/x.ts");
		expect(out).toEqual([{ line: 1, text: line.slice(0, 150) }]);
		expect(out[0]?.text).toHaveLength(150);
	});

	// test-contract: P3: fires on `.tsx` as well as `.ts`
	it("P3: fires on `.tsx` as well as `.ts`", () => {
		expect(checkNonNullAssertions("const x = foo!.bar;\n", "src/x.tsx")).toEqual([
			{ line: 1, text: "const x = foo!.bar;" },
		]);
	});

	// test-contract: P4: fires on index access `arr![0]` (the `\\w!\\[` alternative)
	it("P4: fires on index access `arr![0]` (the `\\w!\\[` alternative)", () => {
		expect(checkNonNullAssertions("const v = arr![0];\n", "src/x.ts")).toEqual([
			{ line: 1, text: "const v = arr![0];" },
		]);
	});

	// test-contract: P5: fires on call-close `fn(a!)` (the `\\w!\\)` alternative)
	it("P5: fires on call-close `fn(a!)` (the `\\w!\\)` alternative)", () => {
		expect(checkNonNullAssertions("fn(a!);\n", "src/x.ts")).toEqual([
			{ line: 1, text: "fn(a!);" },
		]);
	});

	// The `!==`/`!=` veto runs on the line with `\w!\.` spans DELETED. Deleting
	// leaves `!` + `=` adjacent here, so a mutant that replaces the deletion with
	// non-empty filler ending in `!` would synthesize a `!=` and suppress the
	// finding. Asserting that this line still fires pins the empty replacement.
	// test-contract: P6: still fires when deleting the assertion span leaves an `=` behind
	it("P6: still fires when deleting the assertion span leaves an `=` behind", () => {
		expect(checkNonNullAssertions("x!.=y;\n", "src/x.ts")).toEqual([
			{ line: 1, text: "x!.=y;" },
		]);
	});

	// test-contract: P7: caps the reported matches at 10 even with 12 offenders
	it("P7: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkNonNullAssertions(repeatLines("const v# = foo!.bar;", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "const v9 = foo!.bar;" });
	});
});

describe("checkNonNullAssertions — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on `.js` (TypeScript-only check)
	it("N1: does NOT run on `.js` (TypeScript-only check)", () => {
		expect(checkNonNullAssertions("const x = foo!.bar;\n", "src/x.js")).toEqual([]);
	});

	// The scan regex requires `!` IMMEDIATELY followed by `.`/`[`/`)`. The
	// looser verification regex allows whitespace, so this line is the one input
	// that separates the two — it must stay unflagged.
	// test-contract: N2: does NOT flag `foo! .bar` (whitespace between `!` and `.`)
	it("N2: does NOT flag `foo! .bar` (whitespace between `!` and `.`)", () => {
		expect(checkNonNullAssertions("const y = foo! .bar;\n", "src/x.ts")).toEqual([]);
	});

	// Veto branch: the line DOES contain a non-null assertion, but also a real
	// `!==`, so the check suppresses it rather than risk a boolean-negation FP.
	// test-contract: N3: does NOT flag an assertion sharing a line with `!==`
	it("N3: does NOT flag an assertion sharing a line with `!==`", () => {
		expect(checkNonNullAssertions("if (a!.b !== c) run();\n", "src/x.ts")).toEqual([]);
	});

	// The veto is evaluated AFTER deleting `\w!\.` spans, and deleting can JOIN a
	// stray `!` to a following `=`. Here the raw line has no `!=`, but the
	// post-deletion text (`a!=`) does — so the check must stay silent.
	// test-contract: N4: does NOT flag when deleting the assertion span creates a `!=`
	it("N4: does NOT flag when deleting the assertion span creates a `!=`", () => {
		expect(checkNonNullAssertions("a!b!.=\n", "src/x.ts")).toEqual([]);
	});
});

describe("checkMagicLiteralInConditional — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tif (status === 42) { go(); } // note\n";
		expect(checkMagicLiteralInConditional(content, "src/x.ts")).toEqual([
			{ line: 2, text: "if (status === 42) { go(); } // note" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `if (${PAD} === 42) {}`;
		const out = checkMagicLiteralInConditional(`${line}\n`, "src/x.ts");
		expect(out).toEqual([{ line: 1, text: line.slice(0, 150) }]);
	});

	// test-contract: P3: fires with no whitespace after the operator
	it("P3: fires with no whitespace after the operator", () => {
		expect(checkMagicLiteralInConditional("if (x===42) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// `10` truncated to `1` is NOT magic, so a lookahead flipped to a positive
	// assertion (or to `\W`) silently downgrades this to a non-finding.
	// test-contract: P4: fires on a multi-digit literal whose first digit alone is not magic
	it("P4: fires on a multi-digit literal whose first digit alone is not magic", () => {
		expect(checkMagicLiteralInConditional("if (x === 10) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// `1.05` is magic; `1` (the value left when the fractional part is dropped
	// or restricted to a single digit) is not.
	// test-contract: P5: fires on a multi-decimal literal `1.05`
	it("P5: fires on a multi-decimal literal `1.05`", () => {
		expect(checkMagicLiteralInConditional("if (x === 1.05) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P6: fires on a negative magic number
	it("P6: fires on a negative magic number", () => {
		expect(checkMagicLiteralInConditional("if (x === -5) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P7: fires on an opaque double-quoted phrase (spaces defeat the token rule)
	it("P7: fires on an opaque double-quoted phrase (spaces defeat the token rule)", () => {
		expect(checkMagicLiteralInConditional('if (x === "a b c") {}\n', "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P8: fires on an opaque double-quoted phrase with no space after the operator
	it("P8: fires on an opaque double-quoted phrase with no space after the operator", () => {
		expect(checkMagicLiteralInConditional('if (x==="a b c") {}\n', "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P9: fires on an opaque single-quoted phrase
	it("P9: fires on an opaque single-quoted phrase", () => {
		expect(checkMagicLiteralInConditional("if (x === 'a b c') {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P10: fires on an opaque single-quoted phrase with no space after the operator
	it("P10: fires on an opaque single-quoted phrase with no space after the operator", () => {
		expect(checkMagicLiteralInConditional("if (x==='a b c') {}\n", "src/x.ts")).toHaveLength(1);
	});

	// The self-describing exemption is anchored at BOTH ends: a leading digit
	// means the literal is not an identifier-shaped token, so it stays magic.
	// test-contract: P11: fires on `\"1abc\"` — start anchor of the self-describing rule
	it("P11: fires on `\"1abc\"` — start anchor of the self-describing rule", () => {
		expect(checkMagicLiteralInConditional('if (x === "1abc") {}\n', "src/x.ts")).toHaveLength(1);
	});

	// test-contract: abc def
	it('P12: fires on `"abc def"` — end anchor of the self-describing rule', () => {
		expect(checkMagicLiteralInConditional('if (x === "abc def") {}\n', "src/x.ts")).toHaveLength(
			1,
		);
	});

	// test-contract: P13: fires on a `case` label at column 0
	it("P13: fires on a `case` label at column 0", () => {
		expect(checkMagicLiteralInConditional("case 42:\n", "src/x.ts")).toEqual([
			{ line: 1, text: "case 42:" },
		]);
	});

	// test-contract: P14: fires on an INDENTED `case` label
	it("P14: fires on an INDENTED `case` label", () => {
		expect(checkMagicLiteralInConditional("\t\tcase 42:\n", "src/x.ts")).toEqual([
			{ line: 1, text: "case 42:" },
		]);
	});

	// test-contract: P15: fires on `case  42:` (multiple spaces after the keyword)
	it("P15: fires on `case  42:` (multiple spaces after the keyword)", () => {
		expect(checkMagicLiteralInConditional("case  42:\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P16: fires on `case 42 :` (whitespace before the colon)
	it("P16: fires on `case 42 :` (whitespace before the colon)", () => {
		expect(checkMagicLiteralInConditional("case 42 :\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P17: fires on `case 10:` — first-digit truncation is not magic
	it("P17: fires on `case 10:` — first-digit truncation is not magic", () => {
		expect(checkMagicLiteralInConditional("case 10:\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P18: fires on `case 1.05:` — multi-decimal case label
	it("P18: fires on `case 1.05:` — multi-decimal case label", () => {
		expect(checkMagicLiteralInConditional("case 1.05:\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P19: fires on `case -5:` — negative case label
	it("P19: fires on `case -5:` — negative case label", () => {
		expect(checkMagicLiteralInConditional("case -5:\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P20: fires on an opaque double-quoted `case` label
	it("P20: fires on an opaque double-quoted `case` label", () => {
		expect(checkMagicLiteralInConditional('case "a b c":\n', "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P21: fires on an opaque single-quoted `case` label
	it("P21: fires on an opaque single-quoted `case` label", () => {
		expect(checkMagicLiteralInConditional("case 'a b c':\n", "src/x.ts")).toHaveLength(1);
	});

	// One line, two candidate hits: the comparison branch reports and moves on,
	// so the `case` branch must NOT double-report the same line.
	// test-contract: P22: reports a line ONCE when both the comparison and case rules match
	it("P22: reports a line ONCE when both the comparison and case rules match", () => {
		expect(checkMagicLiteralInConditional("case 42: if (x === 43) break;\n", "src/x.ts")).toEqual([
			{ line: 1, text: "case 42: if (x === 43) break;" },
		]);
	});

	// test-contract: P23: caps the reported matches at 10 even with 12 offenders
	it("P23: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkMagicLiteralInConditional(repeatLines("if (s# === 42) {}", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "if (s9 === 42) {}" });
	});
});

describe("checkMagicLiteralInConditional — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on a non-JS/TS extension
	it("N1: does NOT run on a non-JS/TS extension", () => {
		expect(checkMagicLiteralInConditional("if (status === 42) {}\n", "src/x.py")).toEqual([]);
	});

	// test-contract: N2: does NOT run on test files
	it("N2: does NOT run on test files", () => {
		expect(checkMagicLiteralInConditional("if (status === 42) {}\n", "src/x.test.ts")).toEqual([]);
	});

	// test-contract: N3: does NOT flag `x === 1` (boundary: |n| must EXCEED 1)
	it("N3: does NOT flag `x === 1` (boundary: |n| must EXCEED 1)", () => {
		expect(checkMagicLiteralInConditional("if (x === 1) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N4: does NOT flag `x === 0` or `x === -1`
	it("N4: does NOT flag `x === 0` or `x === -1`", () => {
		expect(checkMagicLiteralInConditional("if (x === 0) {}\n", "src/x.ts")).toEqual([]);
		expect(checkMagicLiteralInConditional("if (x === -1) {}\n", "src/x.ts")).toEqual([]);
	});

	// A 400-digit literal coerces to Infinity. `Math.abs(Infinity) > 1` is true,
	// so only the finiteness guard keeps this from being reported.
	// test-contract: N5: does NOT flag a literal that coerces to Infinity
	it("N5: does NOT flag a literal that coerces to Infinity", () => {
		const huge = "9".repeat(400);
		expect(checkMagicLiteralInConditional(`if (x === ${huge}) {}\n`, "src/x.ts")).toEqual([]);
	});

	// test-contract: N6: does NOT flag a BigInt literal `3n`
	it("N6: does NOT flag a BigInt literal `3n`", () => {
		expect(checkMagicLiteralInConditional("if (x === 3n) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N7: does NOT flag a 1-char string literal (needs 3+ chars)
	it("N7: does NOT flag a 1-char string literal (needs 3+ chars)", () => {
		expect(checkMagicLiteralInConditional('if (x === "?") {}\n', "src/x.ts")).toEqual([]);
		expect(checkMagicLiteralInConditional("if (x === '?') {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N8: does NOT flag a 1-char `case` label
	it("N8: does NOT flag a 1-char `case` label", () => {
		expect(checkMagicLiteralInConditional('case "?":\n', "src/x.ts")).toEqual([]);
		expect(checkMagicLiteralInConditional("case '?':\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N9: does NOT flag a dotted/hyphenated self-describing token
	it("N9: does NOT flag a dotted/hyphenated self-describing token", () => {
		expect(checkMagicLiteralInConditional('if (k === "foo-bar.baz") {}\n', "src/x.ts")).toEqual([]);
	});

	// The `case` rule is anchored to the start of the line: a `case` appearing
	// mid-line (inside a one-line switch) is not a label this rule owns.
	// test-contract: N10: does NOT flag a mid-line `case` on a one-line switch
	it("N10: does NOT flag a mid-line `case` on a one-line switch", () => {
		expect(checkMagicLiteralInConditional("switch (k) { case 42: }\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N11: does NOT flag switch scaffolding inside a template literal
	it("N11: does NOT flag switch scaffolding inside a template literal", () => {
		const content = ["const tpl = `", '  case "a b c":', "`;"].join("\n");
		expect(checkMagicLiteralInConditional(content, "src/x.ts")).toEqual([]);
	});

	// test-contract: N12: does NOT flag a magic literal that lives in a line comment
	it("N12: does NOT flag a magic literal that lives in a line comment", () => {
		expect(checkMagicLiteralInConditional("// if (x === 42) {}\n", "src/x.ts")).toEqual([]);
	});

	// The `typeof` exemption is keyed on the RHS being one of the 8 language-
	// defined typeof results. A line that says `typeof` but compares against an
	// opaque phrase is NOT that idiom and must still be reported — widening the
	// exemption to "any line mentioning typeof" would lose this.
	// test-contract: N13: an opaque phrase is still reported on a line that mentions `typeof`
	it("N13: an opaque phrase is still reported on a line that mentions `typeof`", () => {
		expect(checkMagicLiteralInConditional('if (typeof x === "a b c") {}\n', "src/x.ts")).toEqual([
			{ line: 1, text: 'if (typeof x === "a b c") {}' },
		]);
	});

	// test-contract: N14: does NOT flag a single-quoted self-describing token
	it("N14: does NOT flag a single-quoted self-describing token", () => {
		expect(checkMagicLiteralInConditional("if (runner === 'codex') {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N15: does NOT flag `case 1:` or `case 0:` (below the magic-number floor)
	it("N15: does NOT flag `case 1:` or `case 0:` (below the magic-number floor)", () => {
		expect(checkMagicLiteralInConditional("case 1:\n", "src/x.ts")).toEqual([]);
		expect(checkMagicLiteralInConditional("case 0:\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N16: does NOT flag a self-describing `case` label (either quote style)
	it("N16: does NOT flag a self-describing `case` label (either quote style)", () => {
		expect(checkMagicLiteralInConditional('case "codex":\n', "src/x.ts")).toEqual([]);
		expect(checkMagicLiteralInConditional("case 'codex':\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N17: truncates the `case`-branch text to 150 characters
	it("N17: truncates the `case`-branch text to 150 characters", () => {
		const line = `case 42: handle(${PAD});`;
		expect(checkMagicLiteralInConditional(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});

	// -------------------------------------------------------------------------
	// Subsumption pins (prosecution wave, campaign plan 15).
	//
	// These four cases kill NO mutant today and are not claimed to — they pin the
	// OBSERVABLE consequence of three exemption sets that are currently dead
	// code. `TRIVIAL_STRINGS`, `TYPEOF_RESULTS` and `SELF_DESCRIBING_ALLOWLIST`
	// each hold only members that `SELF_DESCRIBING_TOKEN` (/^[A-Za-z][\w.-]*$/)
	// already matches, so every one of their entries is spared by the token rule
	// before the set is ever consulted. That is exactly why 28 mutants over those
	// three sets survive: emptying a set, blanking a member, or forcing its guard
	// changes no return value for any reachable input (no capture group can be
	// the empty string — `-?\d+` and `[^"\\]{3,}` / `[^'\\]{3,}` each require at
	// least one character).
	//
	// Without these cases the exemption is asserted only for inputs that ALSO
	// travel the token rule via another test. Narrowing `SELF_DESCRIBING_TOKEN`
	// — the documented fix that would make the dead sets live again — would
	// silently start flagging these lines. Pinned here so that change is visible.
	// -------------------------------------------------------------------------
	// test-contract: N18: does NOT flag the trivial keyword strings
	it("N18: does NOT flag the trivial keyword strings", () => {
		for (const kw of ["true", "false", "null", "undefined"]) {
			expect(checkMagicLiteralInConditional(`if (x === "${kw}") {}\n`, "src/x.ts")).toEqual([]);
			expect(checkMagicLiteralInConditional(`case "${kw}":\n`, "src/x.ts")).toEqual([]);
		}
	});

	// The `typeof` operand does NOT appear on these lines: the exemption comes
	// from the token rule alone, which is what makes the TYPEOF_RESULTS set
	// redundant rather than load-bearing.
	// test-contract: N19: does NOT flag a typeof-result name compared WITHOUT `typeof`
	it("N19: does NOT flag a typeof-result name compared WITHOUT `typeof`", () => {
		for (const t of [
			"string",
			"number",
			"bigint",
			"boolean",
			"symbol",
			"undefined",
			"object",
			"function",
		]) {
			expect(checkMagicLiteralInConditional(`if (kind === "${t}") {}\n`, "src/x.ts")).toEqual([]);
		}
	});

	// test-contract: N20: does NOT flag an HTTP method name (allowlist members)
	it("N20: does NOT flag an HTTP method name (allowlist members)", () => {
		for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
			expect(checkMagicLiteralInConditional(`if (method === "${m}") {}\n`, "src/x.ts")).toEqual([]);
			expect(checkMagicLiteralInConditional(`case '${m}':\n`, "src/x.ts")).toEqual([]);
		}
	});

	// The boundary the exemption actually turns on: an all-caps token with a
	// SPACE in it is not identifier-shaped, so it stays magic. This is the input
	// class an allowlist entry would have to belong to before the set could
	// change any verdict.
	// test-contract: N21: an all-caps phrase WITH a space is still flagged
	it("N21: an all-caps phrase WITH a space is still flagged", () => {
		expect(checkMagicLiteralInConditional('if (method === "GET ALL") {}\n', "src/x.ts")).toEqual([
			{ line: 1, text: 'if (method === "GET ALL") {}' },
		]);
	});
});

describe("checkBroadObjectTypes — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tconst x: Record<string, any> = {}; // wide\n";
		expect(checkBroadObjectTypes(content, "src/x.ts")).toEqual([
			{ line: 2, text: "const x: Record<string, any> = {}; // wide" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `const ${PAD}: Record<string, any> = {};`;
		expect(checkBroadObjectTypes(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});

	// test-contract: P3: fires on `Record <string, any>` (space before the type args)
	it("P3: fires on `Record <string, any>` (space before the type args)", () => {
		expect(checkBroadObjectTypes("const x: Record <string, any> = {};\n", "src/x.ts")).toHaveLength(
			1,
		);
	});

	// test-contract: P4: fires on `Record<string,any>` (no space after the comma)
	it("P4: fires on `Record<string,any>` (no space after the comma)", () => {
		expect(checkBroadObjectTypes("const x: Record<string,any> = {};\n", "src/x.ts")).toHaveLength(
			1,
		);
	});

	// test-contract: P5: fires on `Record<string, any >` (space before the closing angle)
	it("P5: fires on `Record<string, any >` (space before the closing angle)", () => {
		expect(checkBroadObjectTypes("const x: Record<string, any > = {};\n", "src/x.ts")).toHaveLength(
			1,
		);
	});

	// test-contract: P6: fires on a union key type `Record<string | number, any>`
	it("P6: fires on a union key type `Record<string | number, any>`", () => {
		expect(
			checkBroadObjectTypes("const x: Record<string | number, any> = {};\n", "src/x.ts"),
		).toHaveLength(1);
	});

	// test-contract: P7: fires on a tightly-packed index signature `{[k:string]:any}`
	it("P7: fires on a tightly-packed index signature `{[k:string]:any}`", () => {
		expect(checkBroadObjectTypes("const m: {[k:string]:any} = {};\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P8: fires on a fully-spaced index signature `{ [ key : string ] : any }`
	it("P8: fires on a fully-spaced index signature `{ [ key : string ] : any }`", () => {
		expect(
			checkBroadObjectTypes("const m: { [ key : string ] : any } = {};\n", "src/x.ts"),
		).toHaveLength(1);
	});

	// test-contract: P9: fires on `number` and `symbol` index-signature key types
	it("P9: fires on `number` and `symbol` index-signature key types", () => {
		expect(checkBroadObjectTypes("const m: { [k: number]: any } = {};\n", "src/x.ts")).toHaveLength(
			1,
		);
		expect(checkBroadObjectTypes("const m: { [k: symbol]: any } = {};\n", "src/x.ts")).toHaveLength(
			1,
		);
	});

	// test-contract: P10: fires on `:  Function` with multiple spaces
	it("P10: fires on `:  Function` with multiple spaces", () => {
		expect(checkBroadObjectTypes("let cb:  Function;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P11: fires on `as Function`
	it("P11: fires on `as Function`", () => {
		expect(checkBroadObjectTypes("const f = x as Function;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P12: fires on `: object` with exactly one space
	it("P12: fires on `: object` with exactly one space", () => {
		expect(checkBroadObjectTypes("let o: object;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P13: fires on `:  object` with multiple spaces
	it("P13: fires on `:  object` with multiple spaces", () => {
		expect(checkBroadObjectTypes("let o:  object;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P14: fires on `.tsx`
	it("P14: fires on `.tsx`", () => {
		expect(checkBroadObjectTypes("const x: Record<string, any> = {};\n", "src/x.tsx")).toHaveLength(
			1,
		);
	});

	// test-contract: P15: caps the reported matches at 10 even with 12 offenders
	it("P15: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkBroadObjectTypes(repeatLines("const v#: Record<string, any> = {};", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "const v9: Record<string, any> = {};" });
	});
});

describe("checkBroadObjectTypes — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on `.js`
	it("N1: does NOT run on `.js`", () => {
		expect(checkBroadObjectTypes("const x: Record<string, any> = {};\n", "src/x.js")).toEqual([]);
	});

	// test-contract: N2: does NOT run on test files
	it("N2: does NOT run on test files", () => {
		expect(checkBroadObjectTypes("const x: Record<string, any> = {};\n", "src/x.test.ts")).toEqual(
			[],
		);
	});

	// The key-type character class deliberately excludes `<`/`>`, so a nested
	// generic key is NOT a `Record<K, any>` this rule owns. Widening the class
	// to "any non-space" would make this fire.
	// test-contract: N3: does NOT flag `Record<Map<string,number>, any>` (nested generic key)
	it("N3: does NOT flag `Record<Map<string,number>, any>` (nested generic key)", () => {
		expect(
			checkBroadObjectTypes("const x: Record<Map<string,number>, any> = {};\n", "src/x.ts"),
		).toEqual([]);
	});

	// test-contract: N4: does NOT flag the capitalised `Object` wrapper type
	it("N4: does NOT flag the capitalised `Object` wrapper type", () => {
		expect(checkBroadObjectTypes("let o: Object;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N5: does NOT flag an identifier that merely starts with `object`
	it("N5: does NOT flag an identifier that merely starts with `object`", () => {
		expect(checkBroadObjectTypes("let o: objectish;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N6: does NOT flag a clean typed line
	it("N6: does NOT flag a clean typed line", () => {
		expect(checkBroadObjectTypes("const n: number = 1;\n", "src/x.ts")).toEqual([]);
	});

	// String-literal key types are blanked to `""` by the shared stripper before
	// scanning, and `"` is outside the key-type character class — so a union with
	// a literal type currently escapes the rule. (A known gap, pinned here: it is
	// exactly the input that separates the whitespace-only quantifier after `<`
	// from a permissive any-non-space one.)
	// test-contract: a
	it('N7: does NOT flag `Record<"a"|B, any>` — literal key types are blanked', () => {
		expect(checkBroadObjectTypes('const x: Record<"a"|B, any> = {};\n', "src/x.ts")).toEqual([]);
	});
});

describe("checkEvalUsage — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\teval(userInput); // danger\n";
		expect(checkEvalUsage(content, "src/x.ts")).toEqual([
			{ line: 2, text: "eval(userInput); // danger" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `const ${PAD} = eval(userInput);`;
		expect(checkEvalUsage(`${line}\n`, "src/x.ts")).toEqual([{ line: 1, text: line.slice(0, 150) }]);
	});

	// The lookbehind rejects `.eval(` and `xeval(`; a whitespace-preceded global
	// `eval(` must still fire (a mutant that requires a WORD char before `eval`
	// would silently stop reporting the real thing).
	// test-contract: P3: fires on a space-preceded global `eval(`
	it("P3: fires on a space-preceded global `eval(`", () => {
		expect(checkEvalUsage("const r = a + eval(x);\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P4: fires on `new  Function(` with multiple spaces
	it("P4: fires on `new  Function(` with multiple spaces", () => {
		expect(checkEvalUsage("const f = new  Function('a', 'return a');\n", "src/x.ts")).toHaveLength(
			1,
		);
	});

	// test-contract: P5: fires on `new Function (` with a space before the paren
	it("P5: fires on `new Function (` with a space before the paren", () => {
		expect(checkEvalUsage("const f = new Function ('a');\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P6: fires on `new Function(` — the implied-eval branch
	it("P6: fires on `new Function(` — the implied-eval branch", () => {
		expect(checkEvalUsage("const f = new Function('return 1');\n", "src/x.ts")).toEqual([
			{ line: 1, text: "const f = new Function('return 1');" },
		]);
	});

	// test-contract: P7: fires on `setInterval` with a string argument
	it("P7: fires on `setInterval` with a string argument", () => {
		expect(checkEvalUsage('setInterval("tick()", 5);\n', "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P8: fires on `setTimeout (` with a space before the paren
	it("P8: fires on `setTimeout (` with a space before the paren", () => {
		expect(checkEvalUsage('setTimeout ("x", 1);\n', "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P9: fires on `setTimeout( \"x\")` with a space after the paren
	it("P9: fires on `setTimeout( \"x\")` with a space after the paren", () => {
		expect(checkEvalUsage('setTimeout( "x", 1);\n', "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P10: reports a line ONCE when it holds both `eval(` and `new Function(`
	it("P10: reports a line ONCE when it holds both `eval(` and `new Function(`", () => {
		expect(checkEvalUsage("eval(new Function('x')());\n", "src/x.ts")).toEqual([
			{ line: 1, text: "eval(new Function('x')());" },
		]);
	});

	// test-contract: P11: caps the reported matches at 10 even with 12 offenders
	it("P11: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkEvalUsage(repeatLines("eval(input#);", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "eval(input9);" });
	});

	// test-contract: P12: the `new Function` branch reports the exact line and ORIGINAL text
	it("P12: the `new Function` branch reports the exact line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tconst f = new Function('x'); // implied eval\n";
		expect(checkEvalUsage(content, "src/x.ts")).toEqual([
			{ line: 2, text: "const f = new Function('x'); // implied eval" },
		]);
	});

	// test-contract: P13: the `new Function` branch truncates its text to 150 characters
	it("P13: the `new Function` branch truncates its text to 150 characters", () => {
		const line = `const ${PAD} = new Function('x');`;
		expect(checkEvalUsage(`${line}\n`, "src/x.ts")).toEqual([{ line: 1, text: line.slice(0, 150) }]);
	});

	// test-contract: P14: the timer branch reports the exact line and ORIGINAL text
	it("P14: the timer branch reports the exact line and ORIGINAL text", () => {
		const content = 'const a = 1;\n\tsetTimeout("doThing()", 100); // implied eval\n';
		expect(checkEvalUsage(content, "src/x.ts")).toEqual([
			{ line: 2, text: 'setTimeout("doThing()", 100); // implied eval' },
		]);
	});

	// test-contract: P15: the timer branch truncates its text to 150 characters
	it("P15: the timer branch truncates its text to 150 characters", () => {
		const line = `setTimeout("${PAD}", 100);`;
		expect(checkEvalUsage(`${line}\n`, "src/x.ts")).toEqual([{ line: 1, text: line.slice(0, 150) }]);
	});
});

describe("checkEvalUsage — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on a non-JS/TS extension
	it("N1: does NOT run on a non-JS/TS extension", () => {
		expect(checkEvalUsage("eval(userInput);\n", "src/x.py")).toEqual([]);
	});

	// test-contract: N2: does NOT run on test files
	it("N2: does NOT run on test files", () => {
		expect(checkEvalUsage("eval(userInput);\n", "src/x.test.ts")).toEqual([]);
	});

	// Identifier-suffixed, all lower case so the `eval` substring really is
	// present — only the word-char lookbehind keeps this quiet.
	// test-contract: N3: does NOT flag `myeval(x)`
	it("N3: does NOT flag `myeval(x)`", () => {
		expect(checkEvalUsage("const r = myeval(x);\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N4: does NOT flag `setTimeout(fn, 100)` with a function reference
	it("N4: does NOT flag `setTimeout(fn, 100)` with a function reference", () => {
		expect(checkEvalUsage("setTimeout(doThing, 100);\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N5: does NOT flag a plain `Function` reference without `new`
	it("N5: does NOT flag a plain `Function` reference without `new`", () => {
		expect(checkEvalUsage("const f = Function;\n", "src/x.ts")).toEqual([]);
	});
});

describe("checkInnerHtmlUsage — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tel.innerHTML = userHtml; // xss\n";
		expect(checkInnerHtmlUsage(content, "src/x.ts")).toEqual([
			{ line: 2, text: "el.innerHTML = userHtml; // xss" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `${PAD}.innerHTML = userHtml;`;
		expect(checkInnerHtmlUsage(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});

	// test-contract: P3: fires on `el.innerHTML=x` with no space around `=`
	it("P3: fires on `el.innerHTML=x` with no space around `=`", () => {
		expect(checkInnerHtmlUsage("el.innerHTML=x;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P4: caps the reported matches at 10 even with 12 offenders
	it("P4: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkInnerHtmlUsage(repeatLines("el#.innerHTML = h;", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "el9.innerHTML = h;" });
	});
});

describe("checkInnerHtmlUsage — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on a non-JS/TS extension
	it("N1: does NOT run on a non-JS/TS extension", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = h;\n", "src/x.py")).toEqual([]);
	});

	// test-contract: N2: does NOT run on test files
	it("N2: does NOT run on test files", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = h;\n", "src/x.test.ts")).toEqual([]);
	});

	// test-contract: N3: returns an EMPTY array for content with no sink at all
	it("N3: returns an EMPTY array for content with no sink at all", () => {
		expect(checkInnerHtmlUsage("const a = 1;\n", "src/x.ts")).toEqual([]);
	});

	// Detector-implementation lines: a regex literal that MENTIONS the sink is
	// not a use of it. Both skip arms are exercised separately below because
	// `dangerouslySetInnerHTML` contains no lowercase `innerHTML`, so only the
	// second arm can suppress it.
	// test-contract: N4: does NOT flag a regex literal that matches `.innerHTML =`
	it("N4: does NOT flag a regex literal that matches `.innerHTML =`", () => {
		expect(checkInnerHtmlUsage("const RE = /x.innerHTML = y/;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N5: does NOT flag a regex literal that matches `dangerouslySetInnerHTML`
	it("N5: does NOT flag a regex literal that matches `dangerouslySetInnerHTML`", () => {
		expect(checkInnerHtmlUsage("const RE = /dangerouslySetInnerHTML/;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N6: does NOT flag a regex literal with padding around `dangerouslySet`
	it("N6: does NOT flag a regex literal with padding around `dangerouslySet`", () => {
		expect(checkInnerHtmlUsage("const RE = /ab dangerouslySetInnerHTML cd/;\n", "src/x.ts")).toEqual(
			[],
		);
	});

	// test-contract: N7: does NOT flag a line that also calls `.test(` on a pattern
	it("N7: does NOT flag a line that also calls `.test(` on a pattern", () => {
		expect(checkInnerHtmlUsage("const ok = /foo/.test(s); el.innerHTML = t;\n", "src/x.ts")).toEqual(
			[],
		);
	});

	// test-contract: N8: does NOT flag a line that also calls `.match(` on a pattern
	it("N8: does NOT flag a line that also calls `.match(` on a pattern", () => {
		expect(checkInnerHtmlUsage("const m = s.match(rx); el.innerHTML = t;\n", "src/x.ts")).toEqual(
			[],
		);
	});

	// test-contract: N9: does NOT flag READING `.innerHTML` (no assignment)
	it("N9: does NOT flag READING `.innerHTML` (no assignment)", () => {
		expect(checkInnerHtmlUsage("const h = el.innerHTML;\n", "src/x.ts")).toEqual([]);
	});
});

describe("checkNanComparison — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tif (x === NaN) {} // never true\n";
		expect(checkNanComparison(content, "src/x.ts")).toEqual([
			{ line: 2, text: "if (x === NaN) {} // never true" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `if (${PAD} === NaN) {}`;
		expect(checkNanComparison(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});

	// test-contract: P3: fires on LOOSE `x == NaN`
	it("P3: fires on LOOSE `x == NaN`", () => {
		expect(checkNanComparison("if (x == NaN) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P4: fires on `x !== NaN` and `x != NaN`
	it("P4: fires on `x !== NaN` and `x != NaN`", () => {
		expect(checkNanComparison("if (x !== NaN) {}\n", "src/x.ts")).toHaveLength(1);
		expect(checkNanComparison("if (x != NaN) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P5: fires with no whitespace before `NaN`
	it("P5: fires with no whitespace before `NaN`", () => {
		expect(checkNanComparison("if (x ===NaN) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P6: fires on the reversed form `NaN === x` (spaced)
	it("P6: fires on the reversed form `NaN === x` (spaced)", () => {
		expect(checkNanComparison("if (NaN === x) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P7: fires on the reversed form `NaN=== x` (unspaced)
	it("P7: fires on the reversed form `NaN=== x` (unspaced)", () => {
		expect(checkNanComparison("if (NaN=== x) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P8: fires on the reversed LOOSE form `NaN == x`
	it("P8: fires on the reversed LOOSE form `NaN == x`", () => {
		expect(checkNanComparison("if (NaN == x) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// Deliberate: this check has no test-file exemption — a NaN comparison is
	// just as broken inside a test as in product code.
	// test-contract: P9: DOES run on test files (no test exemption for this check)
	it("P9: DOES run on test files (no test exemption for this check)", () => {
		expect(checkNanComparison("if (x === NaN) {}\n", "src/x.test.ts")).toHaveLength(1);
	});

	// test-contract: P10: caps the reported matches at 10 even with 12 offenders
	it("P10: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkNanComparison(repeatLines("if (v# === NaN) {}", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "if (v9 === NaN) {}" });
	});
});

describe("checkNanComparison — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on a non-JS/TS extension
	it("N1: does NOT run on a non-JS/TS extension", () => {
		expect(checkNanComparison("if (x === NaN) {}\n", "src/x.py")).toEqual([]);
	});

	// test-contract: N2: does NOT flag `Number.isNaN(x)` — the correct idiom
	it("N2: does NOT flag `Number.isNaN(x)` — the correct idiom", () => {
		expect(checkNanComparison("if (Number.isNaN(x)) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N3: does NOT flag an identifier that merely starts with `NaN`
	it("N3: does NOT flag an identifier that merely starts with `NaN`", () => {
		expect(checkNanComparison("if (NaNCount === 2) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N4: does NOT flag `NaN` in a comment
	it("N4: does NOT flag `NaN` in a comment", () => {
		expect(checkNanComparison("// if (x === NaN) {}\n", "src/x.ts")).toEqual([]);
	});
});

describe("checkJsLooseEquality — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tif (a == b) {} // loose\n";
		expect(checkJsLooseEquality(content, "src/x.ts")).toEqual([
			{ line: 2, text: "if (a == b) {} // loose" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `if (${PAD} == b) {}`;
		expect(checkJsLooseEquality(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});

	// test-contract: P3: fires on loose `!=`
	it("P3: fires on loose `!=`", () => {
		expect(checkJsLooseEquality("if (a != b) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// The left-hand alternation includes start-of-line; without it a comparison
	// with nothing before it goes unreported.
	// test-contract: P4: fires when the loose operator starts the line
	it("P4: fires when the loose operator starts the line", () => {
		expect(checkJsLooseEquality("== b;\n", "src/x.ts")).toHaveLength(1);
	});

	// `nullish` is not `null`: the FP guard is word-bounded, so this stays a
	// reportable loose comparison.
	// test-contract: P5: fires on `a == nullish` (word boundary defeats the null exemption)
	it("P5: fires on `a == nullish` (word boundary defeats the null exemption)", () => {
		expect(checkJsLooseEquality("if (a == nullish) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// The null exemption is per-COMPARISON, not per-line: a line that also holds
	// a genuine loose comparison must still be reported.
	// test-contract: P6: fires when a null idiom shares the line with a real loose comparison
	it("P6: fires when a null idiom shares the line with a real loose comparison", () => {
		expect(checkJsLooseEquality("if (a == null && b == c) {}\n", "src/x.ts")).toEqual([
			{ line: 1, text: "if (a == null && b == c) {}" },
		]);
	});

	// Regex literals are blanked with EQUAL-LENGTH spaces before scanning. Here
	// the `==` lives outside the literal and must survive the blanking.
	// test-contract: P7: fires on a loose comparison that follows a regex literal
	it("P7: fires on a loose comparison that follows a regex literal", () => {
		expect(checkJsLooseEquality("const RE = /a/ == b;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P8: DOES run on test files (no test exemption for this check)
	it("P8: DOES run on test files (no test exemption for this check)", () => {
		expect(checkJsLooseEquality("if (a == b) {}\n", "src/x.test.ts")).toHaveLength(1);
	});

	// test-contract: P9: caps the reported matches at 10 even with 12 offenders
	it("P9: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkJsLooseEquality(repeatLines("if (v# == b) {}", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "if (v9 == b) {}" });
	});
});

describe("checkJsLooseEquality — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on a non-JS/TS extension
	it("N1: does NOT run on a non-JS/TS extension", () => {
		expect(checkJsLooseEquality("if (a == b) {}\n", "src/x.py")).toEqual([]);
	});

	// test-contract: N2: does NOT flag `!==`, `<=` or `>=`
	it("N2: does NOT flag `!==`, `<=` or `>=`", () => {
		expect(checkJsLooseEquality("if (a !== b) {}\n", "src/x.ts")).toEqual([]);
		expect(checkJsLooseEquality("if (a <= b) {}\n", "src/x.ts")).toEqual([]);
		expect(checkJsLooseEquality("if (a >= b) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N3: does NOT flag `a != null` (the documented FP guard)
	it("N3: does NOT flag `a != null` (the documented FP guard)", () => {
		expect(checkJsLooseEquality("if (a != null) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N4: does NOT flag `a ==null` with no space before the keyword
	it("N4: does NOT flag `a ==null` with no space before the keyword", () => {
		expect(checkJsLooseEquality("if (a ==null) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N5: does NOT flag the reversed `null == a`
	it("N5: does NOT flag the reversed `null == a`", () => {
		expect(checkJsLooseEquality("if (null == a) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N6: does NOT flag the reversed `null== a` with no space
	it("N6: does NOT flag the reversed `null== a` with no space", () => {
		expect(checkJsLooseEquality("if (null== a) {}\n", "src/x.ts")).toEqual([]);
	});

	// Both null forms on one line: the exemption must strip BOTH before deciding.
	// test-contract: N7: does NOT flag a line whose only loose comparisons are null idioms
	it("N7: does NOT flag a line whose only loose comparisons are null idioms", () => {
		expect(checkJsLooseEquality("if (b != null && null === c) {}\n", "src/x.ts")).toEqual([]);
	});

	// The null exemption works by DELETING the null comparisons and re-testing.
	// Deleting must leave nothing behind: filler text here would rejoin as a
	// spurious `!=` against the following `=`.
	// test-contract: N8: does NOT flag when deleting the null idiom abuts a following `=`
	it("N8: does NOT flag when deleting the null idiom abuts a following `=`", () => {
		expect(checkJsLooseEquality("if (a == null=x) {}\n", "src/x.ts")).toEqual([]);
	});

	// Regex literals holding `==`/`!=` as PATTERN characters are the FP shape
	// that bit this check on its own source. Blanking must cover the whole
	// literal, including a `/` inside a character class.
	// test-contract: N9: does NOT flag `==` inside a regex literal
	it("N9: does NOT flag `==` inside a regex literal", () => {
		expect(checkJsLooseEquality("const RE = /a==b/;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N10: does NOT flag `==` after a character class containing a slash
	it("N10: does NOT flag `==` after a character class containing a slash", () => {
		expect(checkJsLooseEquality("const RE = /[a/b]==c/;\n", "src/x.ts")).toEqual([]);
	});

	// The blanking replacement is equal-length SPACES, so a following `null`
	// keeps its word boundary and the null exemption still applies.
	// test-contract: N11: keeps the null exemption intact across a blanked regex literal
	it("N11: keeps the null exemption intact across a blanked regex literal", () => {
		expect(checkJsLooseEquality("if (foo == null/x/) {}\n", "src/x.ts")).toEqual([]);
	});

	// The blanking must be LENGTH-PRESERVING. Deleting the literal outright
	// would splice the surrounding `=` characters together into a phantom `==`
	// that exists nowhere in the source.
	// test-contract: N12: blanking a regex literal must not splice neighbours into a phantom `==`
	it("N12: blanking a regex literal must not splice neighbours into a phantom `==`", () => {
		expect(checkJsLooseEquality("if (a =/x/= b) {}\n", "src/x.ts")).toEqual([]);
	});
});

describe("checkConstantCondition — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tif (true) { go(); } // always\n";
		expect(checkConstantCondition(content, "src/x.ts")).toEqual([
			{ line: 2, text: "if (true) { go(); } // always" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `if (true) { ${PAD}; }`;
		expect(checkConstantCondition(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});

	// test-contract: P3: fires on `if(true)` with no space after the keyword
	it("P3: fires on `if(true)` with no space after the keyword", () => {
		expect(checkConstantCondition("if(true) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P4: fires on `if ( true )` with padded parens
	it("P4: fires on `if ( true )` with padded parens", () => {
		expect(checkConstantCondition("if ( true ) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P5: fires on each constant condition literal
	it("P5: fires on each constant condition literal", () => {
		expect(checkConstantCondition("if (false) {}\n", "src/x.ts")).toHaveLength(1);
		expect(checkConstantCondition("if (0) {}\n", "src/x.ts")).toHaveLength(1);
		expect(checkConstantCondition("if (1) {}\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P6: fires on a constant ternary `return true ? a : b`
	it("P6: fires on a constant ternary `return true ? a : b`", () => {
		expect(checkConstantCondition("return true ? a : b;\n", "src/x.ts")).toEqual([
			{ line: 1, text: "return true ? a : b;" },
		]);
	});

	// test-contract: P7: fires on `true? a : b` with no space before the `?`
	it("P7: fires on `true? a : b` with no space before the `?`", () => {
		expect(checkConstantCondition("return true? a : b;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P8: fires on `true ?a : b` with no space after the `?`
	it("P8: fires on `true ?a : b` with no space after the `?`", () => {
		expect(checkConstantCondition("return true ?a : b;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P9: fires on a constant ternary with `false`
	it("P9: fires on a constant ternary with `false`", () => {
		expect(checkConstantCondition("return false ? a : b;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P10: reports a line ONCE when it holds both an `if` and a ternary
	it("P10: reports a line ONCE when it holds both an `if` and a ternary", () => {
		expect(checkConstantCondition("if (true) { return false ? 1 : 2; }\n", "src/x.ts")).toEqual([
			{ line: 1, text: "if (true) { return false ? 1 : 2; }" },
		]);
	});

	// test-contract: P11: caps the reported matches at 10 even with 12 offenders
	it("P11: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkConstantCondition(repeatLines("if (true) { v#(); }", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "if (true) { v9(); }" });
	});
});

describe("checkConstantCondition — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on a non-JS/TS extension
	it("N1: does NOT run on a non-JS/TS extension", () => {
		expect(checkConstantCondition("if (true) {}\n", "src/x.py")).toEqual([]);
	});

	// test-contract: N2: does NOT run on test files
	it("N2: does NOT run on test files", () => {
		expect(checkConstantCondition("if (true) {}\n", "src/x.test.ts")).toEqual([]);
	});

	// `=== false ?` is a comparison feeding a ternary, not a constant condition.
	// test-contract: N3: does NOT flag `y === false ? a : b`
	it("N3: does NOT flag `y === false ? a : b`", () => {
		expect(checkConstantCondition("const x = y === false ? a : b;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N4: does NOT flag `y !== true ? a : b`
	it("N4: does NOT flag `y !== true ? a : b`", () => {
		expect(checkConstantCondition("const x = y !== true ? a : b;\n", "src/x.ts")).toEqual([]);
	});

	// An unterminated quote defeats the string stripper, so a comment marker can
	// still reach the scan. The `//` guard is what keeps commented-out ternary
	// prose from being reported as a constant condition.
	// test-contract: N5: does NOT flag a ternary that sits after a `//` marker
	it("N5: does NOT flag a ternary that sits after a `//` marker", () => {
		expect(checkConstantCondition("const x = 'a // true ? b : c\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N6: does NOT flag a normal boolean-variable condition
	it("N6: does NOT flag a normal boolean-variable condition", () => {
		expect(checkConstantCondition("if (isReady) {}\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N7: does NOT flag `y ===false ?` with no space after the operator
	it("N7: does NOT flag `y ===false ?` with no space after the operator", () => {
		expect(checkConstantCondition("return y ===false ? a : b;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N8: does NOT flag `y === false?` with no space before the `?`
	it("N8: does NOT flag `y === false?` with no space before the `?`", () => {
		expect(checkConstantCondition("return y === false? a : b;\n", "src/x.ts")).toEqual([]);
	});
});

describe("checkConstantCondition — ternary branch report shape", () => {
	it("distinguishes runtime conditions from optional type members and conditional types", () => {
		const source = [
			"type Optional = { true?: string; false?: number };",
			"type Choice<T> = T extends true ? string : number;",
			"const compare = x && true ? a : b;",
			"const assigned = true ? a : b;",
			"const grouped = (false) ? a : b;",
		].join("\n");
		expect(checkConstantCondition(source, "src/value.ts").map((match) => match.line)).toEqual([4, 5]);
	});

	// test-contract: P12: the ternary branch reports the exact line and ORIGINAL text
	it("P12: the ternary branch reports the exact line and ORIGINAL text", () => {
		const content = "const a = 1;\n\treturn true ? a : b; // always a\n";
		expect(checkConstantCondition(content, "src/x.ts")).toEqual([
			{ line: 2, text: "return true ? a : b; // always a" },
		]);
	});

	// test-contract: P13: the ternary branch truncates its text to 150 characters
	it("P13: the ternary branch truncates its text to 150 characters", () => {
		const line = `return true ? ${PAD} : b;`;
		expect(checkConstantCondition(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});
});

describe("checkUnsafeOptionalChaining — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tconst y = (obj?.foo).bar; // throws\n";
		expect(checkUnsafeOptionalChaining(content, "src/x.ts")).toEqual([
			{ line: 2, text: "const y = (obj?.foo).bar; // throws" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `const ${PAD} = (obj?.foo).bar;`;
		expect(checkUnsafeOptionalChaining(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});

	// test-contract: P3: fires with whitespace between the close-paren and the property
	it("P3: fires with whitespace between the close-paren and the property", () => {
		expect(checkUnsafeOptionalChaining("const y = (obj?.foo) .bar;\n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: P4: caps the reported matches at 10 even with 12 offenders
	it("P4: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkUnsafeOptionalChaining(repeatLines("const y# = (o?.f).bar;", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "const y9 = (o?.f).bar;" });
	});
});

describe("checkUnsafeOptionalChaining — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on a non-JS/TS extension
	it("N1: does NOT run on a non-JS/TS extension", () => {
		expect(checkUnsafeOptionalChaining("const y = (obj?.foo).bar;\n", "src/x.py")).toEqual([]);
	});

	// test-contract: N2: does NOT run on test files
	it("N2: does NOT run on test files", () => {
		expect(checkUnsafeOptionalChaining("const y = (obj?.foo).bar;\n", "src/x.test.ts")).toEqual([]);
	});

	// test-contract: N3: does NOT flag an unparenthesised chain `obj?.foo.bar`
	it("N3: does NOT flag an unparenthesised chain `obj?.foo.bar`", () => {
		expect(checkUnsafeOptionalChaining("const y = obj?.foo.bar;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N4: does NOT flag the `||` fallback form
	it("N4: does NOT flag the `||` fallback form", () => {
		expect(checkUnsafeOptionalChaining("const y = (obj?.foo || d).bar;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N5: does NOT flag the `&&` guard form
	it("N5: does NOT flag the `&&` guard form", () => {
		expect(checkUnsafeOptionalChaining("const y = (obj?.foo && d).bar;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N6: does NOT flag a fallback form with whitespace before the property
	it("N6: does NOT flag a fallback form with whitespace before the property", () => {
		expect(checkUnsafeOptionalChaining("const y = (obj?.foo || d) .bar;\n", "src/x.ts")).toEqual([]);
	});
});

describe("checkNumberPrecisionLoss — positive (must fire)", () => {
	// test-contract: P1: reports the exact 1-based line and ORIGINAL text
	it("P1: reports the exact 1-based line and ORIGINAL text", () => {
		const content = "const a = 1;\n\tconst id = 9007199254740993; // lossy\n";
		expect(checkNumberPrecisionLoss(content, "src/x.ts")).toEqual([
			{ line: 2, text: "const id = 9007199254740993; // lossy" },
		]);
	});

	// test-contract: P2: truncates the reported text to 150 characters
	it("P2: truncates the reported text to 150 characters", () => {
		const line = `const ${PAD} = 9007199254740993;`;
		expect(checkNumberPrecisionLoss(`${line}\n`, "src/x.ts")).toEqual([
			{ line: 1, text: line.slice(0, 150) },
		]);
	});

	// One report per LINE, not per literal — the inner scan stops at the first
	// unsafe literal it finds.
	// test-contract: P3: reports a line ONCE even with two unsafe literals on it
	it("P3: reports a line ONCE even with two unsafe literals on it", () => {
		expect(
			checkNumberPrecisionLoss("const a = [9007199254740993, 9007199254740994];\n", "src/x.ts"),
		).toEqual([{ line: 1, text: "const a = [9007199254740993, 9007199254740994];" }]);
	});

	// test-contract: P4: DOES run on test files (no test exemption for this check)
	it("P4: DOES run on test files (no test exemption for this check)", () => {
		expect(checkNumberPrecisionLoss("const id = 9007199254740993;\n", "src/x.test.ts")).toHaveLength(
			1,
		);
	});

	// test-contract: P5: caps the reported matches at 10 even with 12 offenders
	it("P5: caps the reported matches at 10 even with 12 offenders", () => {
		const out = checkNumberPrecisionLoss(repeatLines("const v# = 9007199254740993;", 12), "src/x.ts");
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual({ line: 10, text: "const v9 = 9007199254740993;" });
	});
});

describe("checkNumberPrecisionLoss — negative (must not fire)", () => {
	// test-contract: N1: does NOT run on a non-JS/TS extension
	it("N1: does NOT run on a non-JS/TS extension", () => {
		expect(checkNumberPrecisionLoss("const id = 9007199254740993;\n", "src/x.py")).toEqual([]);
	});

	// Boundary: MAX_SAFE_INTEGER itself is exactly representable.
	// test-contract: N2: does NOT flag Number.MAX_SAFE_INTEGER itself
	it("N2: does NOT flag Number.MAX_SAFE_INTEGER itself", () => {
		expect(checkNumberPrecisionLoss("const id = 9007199254740991;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N3: does NOT flag a 16-digit literal below the safe ceiling
	it("N3: does NOT flag a 16-digit literal below the safe ceiling", () => {
		expect(checkNumberPrecisionLoss("const id = 1000000000000000;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N4: does NOT flag a 15-digit literal (below the scan width)
	it("N4: does NOT flag a 15-digit literal (below the scan width)", () => {
		expect(checkNumberPrecisionLoss("const id = 900719925474099;\n", "src/x.ts")).toEqual([]);
	});

	// test-contract: N5: does NOT flag a BigInt literal
	it("N5: does NOT flag a BigInt literal", () => {
		expect(checkNumberPrecisionLoss("const id = 9007199254740993n;\n", "src/x.ts")).toEqual([]);
	});
});

// ===========================================================================
// Mutation-kill fleet wave 3 (K4, campaign scratch/fleet-r2). Best-attempt
// pins for survivors NOT covered by the wave-2 subsumption argument above.
// Each case below is the STRONGEST input found for its target mutant after
// exhaustive analysis (hand tracing + a standalone re-implementation fuzzed
// against 200k+ random lines — see scratch/fleet-r2/k4/*.mjs); none is
// claimed to kill anything. Full rationale is in the fleet report, not
// re-derived per case here to stay within its report budget.
// ===========================================================================

describe("checkNonNullAssertions — nnaMatch verification-regex pins", () => {
	// test-contract: fires with a multi-char identifier through the exact adjacency the outer detector already required
	it("fires with a multi-char identifier through the exact adjacency the outer detector already required", () => {
		expect(checkNonNullAssertions("const v = value!.bar;\n", "src/x.ts")).toEqual([
			{ line: 1, text: "const v = value!.bar;" },
		]);
	});
});

describe("checkJsLooseEquality — null-idiom guard pin", () => {
	// test-contract: fires on a loose comparison with NO null idiom anywhere on the line
	it("fires on a loose comparison with NO null idiom anywhere on the line", () => {
		expect(checkJsLooseEquality("if (left == right) {}\n", "src/x.ts")).toEqual([
			{ line: 1, text: "if (left == right) {}" },
		]);
	});
});

describe("checkConstantCondition — trim()/tail-quantifier pins", () => {
	// test-contract: fires on a constant condition with leading AND trailing whitespace
	it("fires on a constant condition with leading AND trailing whitespace", () => {
		expect(checkConstantCondition("   if (true) {}   \n", "src/x.ts")).toHaveLength(1);
	});

	// test-contract: fires on a constant ternary with leading AND trailing whitespace
	it("fires on a constant ternary with leading AND trailing whitespace", () => {
		expect(checkConstantCondition("   return true ? a : b;   \n", "src/x.ts")).toHaveLength(1);
	});
});

describe("checkEvalUsage — trim() pin", () => {
	// test-contract: fires on eval() with leading AND trailing whitespace on the line
	it("fires on eval() with leading AND trailing whitespace on the line", () => {
		expect(checkEvalUsage("   eval(x);   \n", "src/x.ts")).toHaveLength(1);
	});
});

describe("checkInnerHtmlUsage — trim() pin", () => {
	// test-contract: fires on innerHTML assignment with leading AND trailing whitespace
	it("fires on innerHTML assignment with leading AND trailing whitespace", () => {
		expect(checkInnerHtmlUsage("   el.innerHTML = h;   \n", "src/x.ts")).toHaveLength(1);
	});
});

// Extends the "Subsumption pins" comment (near N18-N21 above): the SAME
// argument covers the `isTypeofCheck` gate (`strLiteral !== undefined &&
// TYPEOF_RESULTS.has(strLiteral) && /\btypeof\b/.test(line)`, the `dq ?? sq`
// feeding it, and `!isTypeofCheck`) plus `isMagicLiteralHit`'s three
// `!== undefined` guards — extracted 2026-08-09, after that comment was
// written. Every TYPEOF_RESULTS member is ALSO a self-describing token, so
// `isMagicString` returns `false` for it regardless of whether the typeof
// gate skipped the call. `undefined` itself is likewise safe on every path:
// `Number(undefined)` is `NaN` (isMagicNumber false), `Set.has(undefined)` is
// `false`, and `RegExp.test(undefined)` coerces to the STRING `"undefined"`,
// which `SELF_DESCRIBING_TOKEN` also matches. N13/N19 above exercise the
// double-quoted typeof path; this case adds the single-quoted `sq` capture.
describe("checkMagicLiteralInConditional — typeof-gate subsumption pin", () => {
	// test-contract: does NOT flag the typeof idiom through the single-quoted `sq` capture
	it("does NOT flag the typeof idiom through the single-quoted `sq` capture", () => {
		expect(checkMagicLiteralInConditional("if (typeof x === 'string') {}\n", "src/x.ts")).toEqual([]);
	});
});
