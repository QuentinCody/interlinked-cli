// Tests for the generic quality/smell UBS detectors. The exhaustive red/green
// suites in src/harness/__tests__/ubs-*.test.ts exercise these via the
// ubs-language-specific.ts barrel and stay as human-readable per-check specs;
// THIS file is the mutation-testing companion — the mutation runner scopes
// coverage to the exact-stem `<file>.test.ts`, so every MUST-FIRE /
// MUST-NOT-FIRE case that needs to discriminate a specific mutant lives here,
// even where it duplicates a barrel-level scenario.
//
// Conventions used throughout:
//  - "P<n>" = positive (must fire), "N<n>" = negative (must not fire) — the
//    Check Evidence Contract's labeling convention.
//  - Assertions use `toEqual` with the FULL expected array (not just
//    `.length > 0`) wherever practical: an exact-array assertion discriminates
//    the `{ line, text }` construction (ArithmeticOperator / MethodExpression
//    / ObjectLiteral mutants on `i + 1` / `.trim().slice(0, 150)`) that a bare
//    length check cannot.
//  - Multi-line, non-first-line, indented fixtures with a line >150 chars are
//    used to kill the `.trim()` / `.slice(0, 150)` / off-by-one-line mutants
//    in one shot.
//  - Regex mutants on optional whitespace (`\s*` -> `\s`) are killed with a
//    DOUBLE-SPACE fixture (the mutant's "exactly one" can't consume two);
//    regex mutants that only change under a NO-space fixture (`\s*` -> `\S*`,
//    since `\S*` also accepts zero) are killed separately where needed.

import { describe, expect, it } from "vitest";
import { MATCH_LIMIT } from "./_shared.js";
import {
	checkDeeplyNestedCallback,
	checkLargeFunction,
	checkMagicNumberNoConst,
	checkNumericComparisonChain,
	checkPrintDebugLeak,
	checkTimeFormatLocaleDep,
	checkUbsStringConcatInLoop,
} from "./quality-smell-checks.js";

describe("ubs-language-specific/quality-smell-checks", () => {
	// =========================================================================
	// checkUbsStringConcatInLoop
	// =========================================================================
	describe("checkUbsStringConcatInLoop", () => {
		it("P1: flags `result += chunk` inside a JS for-loop, truncating a long indented line", () => {
			const longTail = "x".repeat(200);
			const codeLines = [
				"function f() {",
				"  let result = '';",
				"  for (const part of parts) {",
				`    result += ${longTail};`,
				"  }",
				"}",
			];
			const code = codeLines.join("\n");
			const expectedText = codeLines[3]?.trim().slice(0, 150);
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([
				{ line: 4, text: expectedText },
			]);
			expect(expectedText?.length).toBe(150);
		});

		it("P2: flags a Java for-loop concat independent of the JS/TS extension gate", () => {
			const codeLines = [
				"class Foo {",
				"  void bar() {",
				'    String result = "";',
				"    for (String part : parts) {",
				"      result += part;",
				"    }",
				"  }",
				"}",
			];
			const code = codeLines.join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/main/Foo.java")).toEqual([
				{ line: 5, text: "result += part;" },
			]);
		});

		it("N1: does NOT fire on an unsupported extension, even with a matching brace/loop/concat shape", () => {
			const code = "for (let i = 0; i < n; i++) {\n  s += chunk;\n}\n";
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.rb")).toEqual([]);
		});

		it("N2: does NOT fire on test files", () => {
			const code = "for (let i = 0; i < n; i++) {\n  s += chunk;\n}\n";
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.test.ts")).toEqual([]);
		});

		it("N3: does NOT flag a numeric accumulator initialized with `let x = 0` (spaced)", () => {
			// The concat regex requires a letter/underscore/dollar/quote right
			// after `+=` — a bare digit RHS (`total += 5`) never matches it at
			// all, so the RHS here must be an identifier (`len`) for this case
			// to actually reach the numericVars suppression it's testing.
			const code = [
				"function f() {",
				"  let total = 0;",
				"  for (const x of xs) {",
				"    total += len;",
				"  }",
				"}",
			].join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("N4: does NOT flag a numeric accumulator initialized with `x=0` (no spaces around `=`)", () => {
			const code = [
				"function f() {",
				"  let count=0;",
				"  for (const x of xs) {",
				"    count += tail;",
				"  }",
				"}",
			].join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("P5: matches `result+=part` with no whitespace anywhere around the operator", () => {
			const code = "function f() {\n  for (const p of ps) {\n    result+=part;\n  }\n}";
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([
				{ line: 3, text: "result+=part;" },
			]);
		});

		it("P6: a nested single-line brace pair (net closeCount>openCount, both nonzero) decrements by the correct delta", () => {
			// `{ } }` on one line contributes openCount=1, closeCount=2 — if the
			// decrement used `closeCount + openCount` instead of the difference,
			// loopDepth would drop to 0 here instead of 2, and the concat on the
			// very next line would be missed.
			const codeLines = [
				"function f() {",
				"  for (const x of xs) {",
				"    for (const y of ys) {",
				"      for (const z of zs) {",
				"      { } }",
				"      result += x;",
				"    }",
				"  }",
				"}",
			];
			const code = codeLines.join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([
				{ line: 6, text: "result += x;" },
			]);
		});

		it("P3: a concat inside a loop is flagged; the same variable after the loop closes is not (brace-depth pop)", () => {
			const codeLines = [
				"function f() {",
				"  for (const part of parts) {",
				"    result += part;",
				"  }",
				"  result += tail;",
				"}",
			];
			const code = codeLines.join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([
				{ line: 3, text: "result += part;" },
			]);
		});

		it("P4: nested loops decrement brace depth correctly on close (each `}` on its own line)", () => {
			const codeLines = [
				"function f() {",
				"  for (const p of ps) {",
				"    for (const q of qs) {",
				"      result += q;",
				"    }",
				"    result += p;",
				"  }",
				"  result += done;",
				"}",
			];
			const code = codeLines.join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([
				{ line: 4, text: "result += q;" },
				{ line: 6, text: "result += p;" },
			]);
		});

		it("boundary: stops collecting matches at MATCH_LIMIT", () => {
			const n = MATCH_LIMIT + 2;
			const codeLines = ["function f() {"];
			for (let i = 0; i < n; i++) {
				codeLines.push(`  for (const x${i} of xs) {`);
				codeLines.push(`    acc${i} += x${i};`);
				codeLines.push("  }");
			}
			codeLines.push("}");
			const matches = checkUbsStringConcatInLoop(codeLines.join("\n"), "src/lib/foo.ts");
			expect(matches.length).toBe(MATCH_LIMIT);
		});

		it("N5: does NOT flag `cursor.offset += pathLen` — a byte-offset member accumulator", () => {
			const code = [
				"function f() {",
				"  const cursor = { offset: 0 };",
				"  for (const pathLen of lens) {",
				"    cursor.offset += pathLen;",
				"  }",
				"}",
			].join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("N6: does NOT flag `total += buf.length` — RHS is a `.length` read", () => {
			const code = [
				"function f() {",
				"  let i = 0;",
				"  while (i < n) {",
				"    total += buf.length;",
				"    i++;",
				"  }",
				"}",
			].join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("N7: does NOT flag `acc.count += 1` — target's last segment is a numeric name", () => {
			const code = [
				"function f() {",
				"  for (const x of xs) {",
				"    acc.count += x;",
				"  }",
				"}",
			].join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("P7: still flags `s += chunk` inside a for loop (plain string accumulator)", () => {
			const code = [
				"function f() {",
				"  let s = '';",
				"  for (const chunk of chunks) {",
				"    s += chunk;",
				"  }",
				"}",
			].join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([
				{ line: 4, text: "s += chunk;" },
			]);
		});

		it('P8: still flags `html += "<li>" + x + "</li>"` inside a while loop (string concat with markup)', () => {
			const code = [
				"function f() {",
				"  let html = '';",
				"  let i = 0;",
				"  while (i < n) {",
				'    html += "<li>" + x + "</li>";',
				"    i++;",
				"  }",
				"}",
			].join("\n");
			expect(checkUbsStringConcatInLoop(code, "src/lib/foo.ts")).toEqual([
				{ line: 5, text: 'html += "<li>" + x + "</li>";' },
			]);
		});
	});

	// =========================================================================
	// checkNumericComparisonChain
	// =========================================================================
	describe("checkNumericComparisonChain", () => {
		it("N1: does NOT fire on non-Java extensions, even with 3+ instanceof lines", () => {
			const code =
				"if (a instanceof X) { return 1; }\nif (a instanceof Y) { return 2; }\nif (a instanceof Z) { return 3; }\n";
			expect(checkNumericComparisonChain(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("N2: does NOT flag exactly 2 consecutive instanceof lines (boundary below 3)", () => {
			const code =
				"if (a instanceof X) { return 1; }\nif (a instanceof Y) { return 2; }\ndoSomethingElse();\n";
			expect(checkNumericComparisonChain(code, "src/Foo.java")).toEqual([]);
		});

		it("P1: flushes a match mid-scan when a run of exactly 3 instanceof lines is followed by unrelated code", () => {
			// The run starts at index1 (not 0) — discriminates a mutated `-1`
			// sentinel from a coincidental `+1` — and its first line is
			// indented + >150 chars, to discriminate the `.trim().slice(0,150)`
			// construction on the mid-scan flush's push site.
			const longSuffix = "x".repeat(200);
			const codeLines = [
				"junk();",
				`    if (a instanceof X) { return "${longSuffix}"; }`,
				"if (a instanceof Y) { return 2; }",
				"if (a instanceof Z) { return 3; }",
				"doSomethingElse();",
			];
			const code = codeLines.join("\n");
			const expectedText = codeLines[1]?.trim().slice(0, 150);
			expect(checkNumericComparisonChain(code, "src/Foo.java")).toEqual([
				{ line: 2, text: expectedText },
			]);
		});

		it("N5: does NOT flush via the mid-scan path when runLen is only 2 (below the floor)", () => {
			const code = "if (a instanceof X) {}\nif (a instanceof Y) {}";
			expect(checkNumericComparisonChain(code, "src/Foo.java")).toEqual([]);
		});

		it("P2: tolerates blank and brace-only lines inside a run without resetting it", () => {
			const code = [
				"if (a instanceof X) { return 1; }",
				"",
				"if (a instanceof Y) { return 2; }",
				"}",
				"if (a instanceof Z) { return 3; }",
				"doSomethingElse();",
			].join("\n");
			expect(checkNumericComparisonChain(code, "src/Foo.java")).toEqual([
				{ line: 1, text: "if (a instanceof X) { return 1; }" },
			]);
		});

		it("P3: flags a run of 3+ consecutive compareTo(...) lines, tolerating whitespace before the parenthesis", () => {
			const code = "a.compareTo (b);\na.compareTo(c);\na.compareTo(d);\nstop();\n";
			expect(checkNumericComparisonChain(code, "src/Foo.java")).toEqual([
				{ line: 1, text: "a.compareTo (b);" },
			]);
		});

		it("P4: flushes and correctly restarts across two separate runs", () => {
			const code = [
				"if (a instanceof X) { }",
				"if (a instanceof Y) { }",
				"if (a instanceof Z) { }",
				"unrelated1();",
				"if (b instanceof P) { }",
				"if (b instanceof Q) { }",
				"if (b instanceof R) { }",
				"unrelated2();",
			].join("\n");
			expect(checkNumericComparisonChain(code, "src/Foo.java")).toEqual([
				{ line: 1, text: "if (a instanceof X) { }" },
				{ line: 5, text: "if (b instanceof P) { }" },
			]);
		});

		it("P5: flushes a run of exactly 3 via the end-of-function fallback (no trailing break line)", () => {
			// Same discriminating shape as P1 (run starts at index1; first line
			// indented + >150 chars) but exercised through the END-of-function
			// fallback push site instead of the mid-scan one.
			const longSuffix = "y".repeat(200);
			const codeLines = [
				"junk();",
				`    if (a instanceof X) { return "${longSuffix}"; }`,
				"if (a instanceof Y) { return 2; }",
				"if (a instanceof Z) { return 3; }",
			];
			const code = codeLines.join("\n");
			const expectedText = codeLines[1]?.trim().slice(0, 150);
			expect(checkNumericComparisonChain(code, "src/Foo.java")).toEqual([
				{ line: 2, text: expectedText },
			]);
		});

		it("boundary: stops collecting matches at MATCH_LIMIT", () => {
			const n = MATCH_LIMIT + 2;
			const lines: string[] = [];
			for (let i = 0; i < n; i++) {
				lines.push(`if (a instanceof T${i}a) {}`);
				lines.push(`if (a instanceof T${i}b) {}`);
				lines.push(`if (a instanceof T${i}c) {}`);
				lines.push(`stop${i}();`);
			}
			const matches = checkNumericComparisonChain(lines.join("\n"), "src/Foo.java");
			expect(matches.length).toBe(MATCH_LIMIT);
		});
	});

	// =========================================================================
	// checkPrintDebugLeak
	// =========================================================================
	describe("checkPrintDebugLeak", () => {
		it("P1: flags console.log in non-test, non-CLI source, truncating a long indented line", () => {
			const longMsg = "y".repeat(200);
			const codeLines = ["function process() {", `    console.log("${longMsg}");`];
			const code = codeLines.join("\n");
			const expectedText = codeLines[1]?.trim().slice(0, 150);
			expect(checkPrintDebugLeak(code, "src/lib/process.ts")).toEqual([
				{ line: 2, text: expectedText },
			]);
		});

		it("P2: matches console.log with whitespace before the parenthesis", () => {
			const code = "function f() {\n  console.log (x);\n}\n";
			expect(checkPrintDebugLeak(code, "src/lib/f.ts")).toEqual([
				{ line: 2, text: "console.log (x);" },
			]);
		});

		it("P3: flags Python print() outside test files", () => {
			const code = "def calc(x):\n    print(x)\n    return x * 2\n";
			expect(checkPrintDebugLeak(code, "src/lib/calc.py")).toEqual([
				{ line: 2, text: "print(x)" },
			]);
		});

		it("P4: flags Go fmt.Println outside script/cli paths", () => {
			const code = 'func process() {\n  fmt.Println("x")\n}\n';
			expect(checkPrintDebugLeak(code, "internal/handler.go")).toEqual([
				{ line: 2, text: 'fmt.Println("x")' },
			]);
		});

		it("N1: does NOT fire on an unsupported extension", () => {
			expect(checkPrintDebugLeak("console.log(x);", "src/lib/a.rb")).toEqual([]);
		});

		it("N2: does NOT fire on test files", () => {
			expect(checkPrintDebugLeak("console.log(x);", "src/lib/a.test.ts")).toEqual([]);
		});

		it("N3: does NOT fire on a /commands/-only path", () => {
			expect(checkPrintDebugLeak("console.log(x);", "src/commands/foo.ts")).toEqual([]);
		});

		it("N4: does NOT fire on a /cmd/-only path", () => {
			expect(checkPrintDebugLeak("console.log(x);", "src/cmd/foo.ts")).toEqual([]);
		});

		it("N5: does NOT fire on a /bin/-only path", () => {
			expect(checkPrintDebugLeak("console.log(x);", "src/bin/foo.ts")).toEqual([]);
		});

		it("N6: does NOT fire on a script/cli path (isScriptOrCliPath)", () => {
			expect(checkPrintDebugLeak("console.log(x);", "scripts/foo.ts")).toEqual([]);
		});

		it("boundary: stops collecting matches at MATCH_LIMIT", () => {
			const n = MATCH_LIMIT + 2;
			const lines = Array.from({ length: n }, (_, i) => `console.log(${i});`);
			const matches = checkPrintDebugLeak(lines.join("\n"), "src/lib/many.ts");
			expect(matches.length).toBe(MATCH_LIMIT);
		});
	});

	// =========================================================================
	// checkMagicNumberNoConst
	// =========================================================================
	describe("checkMagicNumberNoConst", () => {
		it("P1: flags a long run of digits in an expression, truncating a long indented line", () => {
			const bigNumber = "1".repeat(200);
			const codeLines = ["function f() {", `    x = foo + ${bigNumber};`];
			const code = codeLines.join("\n");
			const expectedText = codeLines[1]?.trim().slice(0, 150);
			expect(checkMagicNumberNoConst(code, "a.ts")).toEqual([{ line: 2, text: expectedText }]);
		});

		it("P2: flags a standalone exactly-3-digit literal (the {3,} floor)", () => {
			const code = "x = foo + 150;";
			expect(checkMagicNumberNoConst(code, "a.ts")).toEqual([{ line: 1, text: code }]);
		});

		it("P3: flags a Go `:=` short assignment (not exempted by the const/let/var/final regex)", () => {
			const code = "func f() {\n  total := 4096\n}\n";
			expect(checkMagicNumberNoConst(code, "src/lib/f.go")).toEqual([
				{ line: 2, text: "total := 4096" },
			]);
		});

		it("P4: flags a Java field of a non-exempt keyword ('int' is not const/let/var/final)", () => {
			const code = "class Foo {\n  void bar() {\n    int total = 4096;\n  }\n}\n";
			expect(checkMagicNumberNoConst(code, "src/main/Foo.java")).toEqual([
				{ line: 3, text: "int total = 4096;" },
			]);
		});

		it("P5: flags a Swift expression gated by the `.swift` extension", () => {
			const code = "func f() {\n  return base + 4096\n}\n";
			expect(checkMagicNumberNoConst(code, "src/lib/f.swift")).toEqual([
				{ line: 2, text: "return base + 4096" },
			]);
		});

		it("N1: does NOT fire on an unsupported extension", () => {
			expect(checkMagicNumberNoConst("x = foo + 4096;", "a.rb")).toEqual([]);
		});

		it("N2: does NOT fire on test files", () => {
			expect(checkMagicNumberNoConst("x = foo + 4096;", "a.test.ts")).toEqual([]);
		});

		it("N3: does NOT flag small numbers like `i + 1` (below the {3,} floor)", () => {
			expect(checkMagicNumberNoConst("const next = i + 1;", "a.ts")).toEqual([]);
		});

		it("N4: does NOT flag `const N = 4096;` (named-constant exemption)", () => {
			expect(checkMagicNumberNoConst("const N = 4096;", "a.ts")).toEqual([]);
		});

		it("N5: does NOT flag `let N = 4096;`", () => {
			expect(checkMagicNumberNoConst("let N = 4096;", "a.ts")).toEqual([]);
		});

		it("N6: does NOT flag `var N = 4096;`", () => {
			expect(checkMagicNumberNoConst("var N = 4096;", "a.ts")).toEqual([]);
		});

		it("N7: does NOT flag `final TOTAL = 4096;` (the `final` alternative of the keyword group)", () => {
			expect(checkMagicNumberNoConst("final TOTAL = 4096;", "a.java")).toEqual([]);
		});

		it("N8: does NOT flag a declaration with doubled internal whitespace", () => {
			expect(checkMagicNumberNoConst("const  XY  =  4096;", "a.ts")).toEqual([]);
		});

		it("N9: does NOT flag a declaration with no whitespace around `=`", () => {
			expect(checkMagicNumberNoConst("const N=4096;", "a.ts")).toEqual([]);
		});

		it("boundary: stops collecting matches at MATCH_LIMIT", () => {
			const n = MATCH_LIMIT + 2;
			const lines = Array.from({ length: n }, (_, i) => `x = foo + ${1000 + i};`);
			const matches = checkMagicNumberNoConst(lines.join("\n"), "a.ts");
			expect(matches.length).toBe(MATCH_LIMIT);
		});
	});

	// =========================================================================
	// checkLargeFunction (JS/C-family arm + Python arm)
	// =========================================================================
	describe("checkLargeFunction", () => {
		/** Builds a C-family-style function body of exactly `targetBodyLines` (endIdx - openIdx). */
		function buildCFamilyFunction(
			header: string,
			targetBodyLines: number,
		): { code: string; expectedText: string } {
			const statementCount = Math.max(0, targetBodyLines - 1);
			const body = Array.from({ length: statementCount }, (_, i) => `  doStuff(${i});`);
			const codeLines = [header, ...body, "}"];
			return { code: codeLines.join("\n"), expectedText: header.trim().slice(0, 150) };
		}

		it("P1: flags an 80+ line JS function, not starting on line 1", () => {
			const body = Array.from({ length: 82 }, (_, i) => `  doStuff(${i});`);
			const codeLines = ["// header comment", "function bigFunc() {", ...body, "}"];
			const code = codeLines.join("\n");
			expect(checkLargeFunction(code, "src/lib/huge.ts")).toEqual([
				{ line: 2, text: "function bigFunc() {" },
			]);
		});

		it("P2: flags an 80+ line Python def, not starting on line 1", () => {
			const body = Array.from({ length: 82 }, () => "    do_stuff()");
			const codeLines = ["# header comment", "def huge():", ...body];
			const code = codeLines.join("\n");
			expect(checkLargeFunction(code, "src/lib/huge.py")).toEqual([
				{ line: 2, text: "def huge():" },
			]);
		});

		it("P3: flags an 80+ line Go func (gated by `.go`)", () => {
			const { code, expectedText } = buildCFamilyFunction("func run() {", 82);
			expect(checkLargeFunction(code, "src/lib/run.go")).toEqual([{ line: 1, text: expectedText }]);
		});

		it("P4: flags an 80+ line Rust fn (gated by `.rs`)", () => {
			const { code, expectedText } = buildCFamilyFunction("fn run() {", 82);
			expect(checkLargeFunction(code, "src/lib/run.rs")).toEqual([{ line: 1, text: expectedText }]);
		});

		it("P5: flags an 80+ line Swift func (gated by `.swift`)", () => {
			const { code, expectedText } = buildCFamilyFunction("func run() {", 82);
			expect(checkLargeFunction(code, "src/lib/run.swift")).toEqual([
				{ line: 1, text: expectedText },
			]);
		});

		it("P6: flags an 80+ line arrow-shaped body gated by `.java`", () => {
			const { code, expectedText } = buildCFamilyFunction("callback = (x) => {", 82);
			expect(checkLargeFunction(code, "src/lib/Run.java")).toEqual([
				{ line: 1, text: expectedText },
			]);
		});

		it("P7: flags an 80+ line arrow-shaped body gated by `.c`", () => {
			const { code, expectedText } = buildCFamilyFunction("callback = (x) => {", 82);
			expect(checkLargeFunction(code, "src/lib/run.c")).toEqual([{ line: 1, text: expectedText }]);
		});

		it("P8: flags an 80+ line arrow-shaped body gated by `.cpp`", () => {
			const { code, expectedText } = buildCFamilyFunction("callback = (x) => {", 82);
			expect(checkLargeFunction(code, "src/lib/run.cpp")).toEqual([
				{ line: 1, text: expectedText },
			]);
		});

		it("N1: does NOT fire on an unsupported extension, even with an 80+ line body", () => {
			const { code } = buildCFamilyFunction("function big() {", 82);
			expect(checkLargeFunction(code, "src/lib/big.rb")).toEqual([]);
		});

		it("N2: does NOT fire on test files, even with an 80+ line body", () => {
			const { code } = buildCFamilyFunction("function big() {", 82);
			expect(checkLargeFunction(code, "src/lib/big.test.ts")).toEqual([]);
		});

		it("N3: does NOT flag a 30-line function", () => {
			const { code } = buildCFamilyFunction("function smol() {", 30);
			expect(checkLargeFunction(code, "src/lib/smol.ts")).toEqual([]);
		});

		it("boundary (C-family): does NOT flag exactly LARGE_FUNCTION_LINE_LIMIT-1 (79) body lines", () => {
			const { code } = buildCFamilyFunction("function edge() {", 79);
			expect(checkLargeFunction(code, "src/lib/edge.ts")).toEqual([]);
		});

		it("boundary (C-family): flags exactly LARGE_FUNCTION_LINE_LIMIT (80) body lines", () => {
			const { code, expectedText } = buildCFamilyFunction("function edge() {", 80);
			expect(checkLargeFunction(code, "src/lib/edge.ts")).toEqual([{ line: 1, text: expectedText }]);
		});

		it("boundary (Python): does NOT flag exactly LARGE_FUNCTION_LINE_LIMIT-1 (79) body lines", () => {
			// No trailing "\n" — content.split("\n") must produce EXACTLY 79 body
			// lines after the def, or the phantom trailing blank (itself a
			// counted body line, see the "counts blank lines" case below) would
			// push this over the boundary and defeat the test's own point.
			const body = Array.from({ length: 79 }, () => "    do_stuff()").join("\n");
			const code = `def edge():\n${body}`;
			expect(checkLargeFunction(code, "src/lib/edge.py")).toEqual([]);
		});

		it("boundary (Python): flags exactly LARGE_FUNCTION_LINE_LIMIT (80) body lines", () => {
			const body = Array.from({ length: 80 }, () => "    do_stuff()").join("\n");
			const code = `def edge():\n${body}`;
			expect(checkLargeFunction(code, "src/lib/edge.py")).toEqual([{ line: 1, text: "def edge():" }]);
		});

		it("Python: counts blank lines as part of the body (does not terminate early)", () => {
			const lines: string[] = [];
			for (let i = 0; i < 40; i++) {
				lines.push("    do_stuff()");
				lines.push("");
			}
			const code = `def big():\n${lines.join("\n")}\n`;
			expect(checkLargeFunction(code, "src/lib/big.py")).toEqual([{ line: 1, text: "def big():" }]);
		});

		it("Python: stops counting a function body at the first dedent, even with more content after", () => {
			const shortBody = Array.from({ length: 5 }, () => "    do_stuff()").join("\n");
			const following = Array.from({ length: 80 }, () => "do_other_stuff()").join("\n");
			const code = `def small():\n${shortBody}\n${following}\n`;
			expect(checkLargeFunction(code, "src/lib/small.py")).toEqual([]);
		});

		it("Python: recognizes a def signature with doubled internal whitespace and a multi-char name", () => {
			const body = Array.from({ length: 80 }, () => "    do_stuff()").join("\n");
			const code = `def  bigname  (arg1, arg2):\n${body}\n`;
			expect(checkLargeFunction(code, "src/lib/bigname.py")).toEqual([
				{ line: 1, text: "def  bigname  (arg1, arg2):" },
			]);
		});

		it("Python: flags an 80+ line def with a long, indented signature (push-site trim/slice)", () => {
			const longArg = "z".repeat(200);
			const body = Array.from({ length: 80 }, () => "        do_stuff()");
			const codeLines = ["def outer():", `    def  inner_fn(${longArg}):`, ...body];
			const code = codeLines.join("\n");
			const expectedText = codeLines[1]?.trim().slice(0, 150);
			const matches = checkLargeFunction(code, "src/lib/tall.py");
			expect(matches).toContainEqual({ line: 2, text: expectedText });
		});

		it("Python: a whitespace-only (not truly empty) line mid-body is tolerated as blank", () => {
			const body: string[] = [];
			for (let i = 0; i < 40; i++) {
				body.push("    do_stuff()");
				body.push("   "); // whitespace, not "" — `.trim() === ""` still holds
			}
			const code = `def big():\n${body.join("\n")}`;
			expect(checkLargeFunction(code, "src/lib/whitespace.py")).toEqual([
				{ line: 1, text: "def big():" },
			]);
		});

		it("Python: does NOT treat `def` appearing mid-line (not at the true line start) as a header", () => {
			// Without the `^` anchor, `.match()` could find "def foo(" as a
			// substring starting mid-line; the leading `x` here must block it.
			const body = Array.from({ length: 80 }, () => "  doStuff();").join("\n");
			const code = `xdef foo():\n${body}`;
			expect(checkLargeFunction(code, "src/lib/adversarial.py")).toEqual([]);
		});

		it("Python: computes each nested def's dedent threshold from ITS OWN indentation", () => {
			const innerBody = ["        stmt1()", "        stmt2()", "        stmt3()"];
			const afterInner = Array.from({ length: 80 }, (_, i) => `    filler${i}()`);
			const codeLines = ["def outer():", "    def inner():", ...innerBody, ...afterInner];
			const matches = checkLargeFunction(codeLines.join("\n"), "src/lib/nested.py");
			// inner's own body is only 3 statements before the indent-4 filler dedents it —
			// it must NOT be flagged, even though 80+ indent-4 lines follow in the file.
			expect(matches.some((m) => m.text === "def inner():")).toBe(false);
		});

		it("C-family: finds an opening brace up to 4 lines after a multi-line function signature", () => {
			const body = Array.from({ length: 80 }, (_, i) => `  doStuff(${i});`);
			const codeLines = ["function bigFunc(", "  a,", "  b", ") {", ...body, "}"];
			expect(checkLargeFunction(codeLines.join("\n"), "src/lib/x.ts")).toEqual([
				{ line: 1, text: "function bigFunc(" },
			]);
		});

		it("C-family: flags an 80+ line function with a long, indented header (push-site trim/slice)", () => {
			const longArg = "z".repeat(200);
			const { code, expectedText } = buildCFamilyFunction(`    function  tall(${longArg}) {`, 82);
			expect(checkLargeFunction(code, "src/lib/tall.ts")).toEqual([{ line: 1, text: expectedText }]);
		});

		it("C-family: recognizes each headerRe alternative with doubled internal whitespace and a multi-char name", () => {
			for (const header of [
				"function  bigFunc() {",
				"fn  bigFunc() {",
				"func  bigFunc() {",
				"callback  =  (x)  =>  {",
			]) {
				const { code, expectedText } = buildCFamilyFunction(header, 82);
				expect(checkLargeFunction(code, "src/lib/spaced.ts")).toEqual([
					{ line: 1, text: expectedText },
				]);
			}
		});

		it("C-family: recognizes the arrow alternative with zero whitespace anywhere", () => {
			// A doubled-whitespace fixture alone can't discriminate `\w+` (the
			// arrow's leading identifier class) from a negated `\W+` mutant: the
			// space right after the identifier lets `\W+` "start" there instead
			// and still complete the match. Zero whitespace removes that escape.
			const { code, expectedText } = buildCFamilyFunction("callback=(x)=>{", 82);
			expect(checkLargeFunction(code, "src/lib/zerospace.java")).toEqual([
				{ line: 1, text: expectedText },
			]);
		});

		it("C-family: recognizes the arrow alternative with a multi-character argument list", () => {
			// `[^)]*` -> `[^)]` (exactly one char) is masked by a single-char
			// arg like `(x)`; `(x, y)` needs the star to consume all 4 chars.
			const { code, expectedText } = buildCFamilyFunction("callback = (x, y) => {", 82);
			expect(checkLargeFunction(code, "src/lib/multiarg.java")).toEqual([
				{ line: 1, text: expectedText },
			]);
		});

		it("C-family: `endIdx - openIdx` is not corrupted into `endIdx + openIdx` when openIdx is large", () => {
			// 50 unrelated filler lines push the header (and its openIdx) deep
			// into the file; the REAL body here is only 2 statements — an
			// `endIdx + openIdx` bug would inflate that past the 80-line
			// threshold purely from openIdx's magnitude.
			const codeLines = [
				...Array.from({ length: 50 }, (_, i) => `filler${i}();`),
				"function small() {",
				"  doStuff();",
				"  doStuff2();",
				"}",
			];
			expect(checkLargeFunction(codeLines.join("\n"), "src/lib/deep.ts")).toEqual([]);
		});

		it("C-family: does NOT find an opening brace exactly 5 lines after the header (window is 4)", () => {
			// findOpeningBrace's window is `startIdx .. startIdx+4` (5 checks).
			// Placing the brace at offset 5 keeps it just OUTSIDE that window —
			// a `<=` off-by-one would pull it back in.
			const body = Array.from({ length: 80 }, (_, i) => `  doStuff(${i});`);
			const codeLines = [
				"function bigFunc(",
				"  a",
				"  b",
				"  c",
				"  d",
				") {",
				...body,
				"}",
			];
			expect(checkLargeFunction(codeLines.join("\n"), "src/lib/offset5.ts")).toEqual([]);
		});

		it("C-family: findOpeningBrace's not-found sentinel must be -1, not a valid absolute line index", () => {
			// findOpeningBrace returns -1 when no `{` is found in its window. If
			// that sentinel were mutated to a small positive constant (e.g. +1),
			// the caller's `openIdx === -1` guard would silently stop catching
			// the miss, and findBraceBalanceEnd would run from that WRONG,
			// header-independent absolute index instead. This fixture puts a
			// real, unrelated, large balanced `if` block at absolute index 1 and
			// a brace-less decoy header far away (index 88, outside its own
			// 5-line window) — a wrong sentinel would misattribute the
			// unrelated block's size to the decoy header and report a phantom
			// match; the real algorithm skips the decoy header entirely.
			const innerBody = Array.from({ length: 80 }, (_, i) => `  z${i}();`);
			const codeLines = [
				"noop0();", // index 0
				"if (y) {", // index 1 — landing zone for a wrong "+1" sentinel
				...innerBody, // index 2..81
				"}", // index 82 — balances the unrelated block
				"gap1();", // index 83
				"gap2();",
				"gap3();",
				"gap4();",
				"gap5();",
				"function trap(", // index 88 — matches headerRe, no brace within its own window
				"gap6();",
				"gap7();",
				"gap8();",
				"gap9();",
			];
			expect(checkLargeFunction(codeLines.join("\n"), "src/lib/sentinel.ts")).toEqual([]);
		});

		it("C-family: a same-line self-balanced brace pair on the header does not short-circuit the real body scan", () => {
			// findBraceBalanceEnd's `k > openIdx` guards against returning at the
			// very first iteration. A same-line `{}` decoy makes depth hit 0
			// exactly AT openIdx; a `k >= openIdx` mutant would stop right there
			// (bodyLines=0) instead of continuing on to find the REAL 80-line
			// block that follows on the next (unrelated) opening brace.
			const code = [
				"function big() {}",
				"if (y) {",
				...Array.from({ length: 80 }, (_, i) => `  z${i}();`),
				"}",
			].join("\n");
			expect(checkLargeFunction(code, "src/lib/decoy.ts")).toEqual([
				{ line: 1, text: "function big() {}" },
			]);
		});

		it("C-family: an unbalanced (never-closing) function does not crash and reports no match", () => {
			const code = "function bigFunc() {\n  doStuff();\n  // never closes\n";
			expect(checkLargeFunction(code, "src/lib/unbalanced.ts")).toEqual([]);
		});

		it("C-family: does NOT treat a header as large when its opening brace is more than 4 lines away", () => {
			const body = Array.from({ length: 80 }, (_, i) => `  doStuff(${i});`);
			const codeLines = [
				"function bigFunc(",
				"  a,",
				"  b",
				"  c",
				"  d",
				"  e",
				") {",
				...body,
				"}",
			];
			expect(checkLargeFunction(codeLines.join("\n"), "src/lib/x.ts")).toEqual([]);
		});

		it("boundary: caps large-function matches at MATCH_LIMIT (C-family arm)", () => {
			const n = MATCH_LIMIT + 2;
			const codeLines: string[] = [];
			for (let f = 0; f < n; f++) {
				codeLines.push(`function big${f}() {`);
				for (let i = 0; i < 80; i++) codeLines.push(`  doStuff(${f}, ${i});`);
				codeLines.push("}");
			}
			const matches = checkLargeFunction(codeLines.join("\n"), "src/lib/many.ts");
			expect(matches.length).toBe(MATCH_LIMIT);
		});

		it("boundary: caps large-function matches at MATCH_LIMIT (Python arm)", () => {
			const n = MATCH_LIMIT + 2;
			const codeLines: string[] = [];
			for (let f = 0; f < n; f++) {
				codeLines.push(`def big${f}():`);
				for (let i = 0; i < 80; i++) codeLines.push(`    do_stuff_${f}_${i}()`);
			}
			const matches = checkLargeFunction(codeLines.join("\n"), "src/lib/many.py");
			expect(matches.length).toBe(MATCH_LIMIT);
		});
	});

	// =========================================================================
	// checkDeeplyNestedCallback
	// =========================================================================
	describe("checkDeeplyNestedCallback", () => {
		it("P1: flags 4-level callback nesting, not on line 1, with a long indented line", () => {
			const longArg = "z".repeat(200);
			const codeLines = [
				"// setup",
				"a(() => {",
				"  b(() => {",
				"    c(() => {",
				`      d(${longArg}, () => {`,
				"        e();",
				"      });",
				"    });",
				"  });",
				"});",
			];
			const code = codeLines.join("\n");
			const expectedText = codeLines[4]?.trim().slice(0, 150);
			// Once funcDepth reaches NESTING_LIMIT it stays >= the limit until a
			// closing brace pops the stack, so the `e();` line INSIDE that scope
			// is flagged too — not just the line that tipped depth over 4.
			expect(checkDeeplyNestedCallback(code, "src/lib/foo.ts")).toEqual([
				{ line: 5, text: expectedText },
				{ line: 6, text: "e();" },
			]);
		});

		it("N1: does NOT fire on an unsupported extension", () => {
			const code =
				"a(() => {\n  b(() => {\n    c(() => {\n      d(() => {\n        e();\n      });\n    });\n  });\n});\n";
			expect(checkDeeplyNestedCallback(code, "src/foo.py")).toEqual([]);
		});

		it("N2: does NOT fire on test files", () => {
			const code =
				"a(() => {\n  b(() => {\n    c(() => {\n      d(() => {\n        e();\n      });\n    });\n  });\n});\n";
			expect(checkDeeplyNestedCallback(code, "src/foo.test.ts")).toEqual([]);
		});

		it("boundary: does NOT flag exactly 3-level nesting", () => {
			const code = "a(() => {\n  b(() => {\n    c(() => {\n      d();\n    });\n  });\n});\n";
			expect(checkDeeplyNestedCallback(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("P2: the callback stack correctly pops after a deep block closes (no false positive after)", () => {
			const codeLines = [
				"a(() => {",
				"  b(() => {",
				"    c(() => {",
				"      d(() => {",
				"        e();",
				"      });",
				"    });",
				"  });",
				"});",
				"f(() => {",
				"  g();",
				"});",
			];
			const code = codeLines.join("\n");
			expect(checkDeeplyNestedCallback(code, "src/lib/foo.ts")).toEqual([
				{ line: 4, text: "d(() => {" },
				{ line: 5, text: "e();" },
			]);
		});

		it("does NOT count a brace-only line (no `function`/`=>`) as a function opener at depth 3", () => {
			// `line.match(/\bfunction\b|=>/g) || []` — if the `[]` fallback were
			// ever non-empty, a brace-only line at funcDepth 3 would spuriously
			// push the stack to 4 and get flagged even though it opens no
			// callback at all.
			const code = [
				"a(() => {",
				"  b(() => {",
				"    c(() => {",
				"      if (x) {",
				"        y();",
				"      }",
				"    });",
				"  });",
				"});",
			].join("\n");
			expect(checkDeeplyNestedCallback(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("a single line with two `=>` but only one `{` pushes the stack once, not twice", () => {
			// `Math.min(funcOpens, opens)` bounds the push count to the number
			// of braces ACTUALLY opened on the line — a `Math.max` mutant would
			// push twice here (2 arrows, 1 brace) and cross NESTING_LIMIT one
			// level early.
			const code = [
				"a(() => {",
				"  b(() => {",
				"    const cb = (x) => (y) => {", // funcOpens=2, opens=1
				"      inner();",
				"    };",
				"  });",
				"});",
			].join("\n");
			expect(checkDeeplyNestedCallback(code, "src/lib/foo.ts")).toEqual([]);
		});

		it("boundary: stops collecting matches at MATCH_LIMIT", () => {
			const n = MATCH_LIMIT + 2;
			const codeLines: string[] = [];
			for (let i = 0; i < n; i++) {
				codeLines.push(`a${i}(() => {`);
				codeLines.push(`  b${i}(() => {`);
				codeLines.push(`    c${i}(() => {`);
				codeLines.push(`      d${i}(() => {`);
				codeLines.push("        e();");
				codeLines.push("      });");
				codeLines.push("    });");
				codeLines.push("  });");
				codeLines.push("});");
			}
			const matches = checkDeeplyNestedCallback(codeLines.join("\n"), "src/lib/foo.ts");
			expect(matches.length).toBe(MATCH_LIMIT);
		});
	});

	// =========================================================================
	// checkTimeFormatLocaleDep
	// =========================================================================
	describe("checkTimeFormatLocaleDep", () => {
		it("P1: flags JS `date.toLocaleString()` with no args, not on line 1", () => {
			const code = "// setup\nconst s = date.toLocaleString();\n";
			expect(checkTimeFormatLocaleDep(code, "src/lib/fmt.ts")).toEqual([
				{ line: 2, text: "const s = date.toLocaleString();" },
			]);
		});

		it("P2: flags `date.toLocaleDateString()`", () => {
			const code = "const s = date.toLocaleDateString();";
			expect(checkTimeFormatLocaleDep(code, "src/lib/fmt.ts")).toEqual([{ line: 1, text: code }]);
		});

		it("P3: flags Java DateTimeFormatter.ofLocalizedDate(...) without .withLocale (`.java` gate)", () => {
			const code = "var f = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM);";
			expect(checkTimeFormatLocaleDep(code, "src/main/Fmt.java")).toEqual([{ line: 1, text: code }]);
		});

		it("N1: does NOT flag DateTimeFormatter.ofLocalizedDate(...).withLocale(...)", () => {
			const code =
				"var f = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(Locale.US);";
			expect(checkTimeFormatLocaleDep(code, "src/main/Fmt.java")).toEqual([]);
		});

		it("N2: does NOT flag `date.toLocaleString('en-US')` (explicit locale)", () => {
			expect(checkTimeFormatLocaleDep("date.toLocaleString('en-US');", "src/lib/fmt.ts")).toEqual([]);
		});

		it("N3: does NOT fire on an unsupported extension", () => {
			expect(checkTimeFormatLocaleDep("date.toLocaleString();", "src/lib/fmt.py")).toEqual([]);
		});

		it("N4: does NOT fire on test files", () => {
			expect(checkTimeFormatLocaleDep("date.toLocaleString();", "src/foo.test.ts")).toEqual([]);
		});

		it("P4: flags `date.toLocaleString ()` with whitespace before the opening parenthesis", () => {
			const code = "const s = date.toLocaleString ();";
			expect(checkTimeFormatLocaleDep(code, "src/lib/fmt.ts")).toEqual([{ line: 1, text: code }]);
		});

		it("N5: does NOT flag DateTimeFormatter.ofLocalizedDate(...) .withLocale(...) with whitespace before the dot", () => {
			// The negative lookahead is `(?!\s*\.withLocale)` — a `\S*` mutant
			// can't consume the space, so it would wrongly treat this as
			// "not followed by withLocale" and flag it.
			const code =
				"var f = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM) .withLocale(Locale.US);";
			expect(checkTimeFormatLocaleDep(code, "src/main/Fmt.java")).toEqual([]);
		});

		it("P5: flags an 80+-char-overflowing, indented DateTimeFormatter line (push-site trim/slice)", () => {
			const longArg = "z".repeat(200);
			const codeLines = [
				"// setup",
				`    var f = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM_${longArg});`,
			];
			const code = codeLines.join("\n");
			const expectedText = codeLines[1]?.trim().slice(0, 150);
			expect(checkTimeFormatLocaleDep(code, "src/main/Fmt.java")).toEqual([
				{ line: 2, text: expectedText },
			]);
		});

		it("boundary: stops collecting matches at MATCH_LIMIT", () => {
			const n = MATCH_LIMIT + 2;
			const lines = Array.from({ length: n }, (_, i) => `const s${i} = date.toLocaleString();`);
			const matches = checkTimeFormatLocaleDep(lines.join("\n"), "src/lib/fmt.ts");
			expect(matches.length).toBe(MATCH_LIMIT);
		});
	});
});
