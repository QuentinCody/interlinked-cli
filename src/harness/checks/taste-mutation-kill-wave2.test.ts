// Wave-2 survivor-kill campaign for src/harness/checks/taste.ts.
// Companion to taste.test.ts and taste-mutation-kill.test.ts — this file
// targets the specific mutants listed as surviving in
// scratch/fleet-r2/kill-briefs/src_harness_checks_taste.ts.json as of
// 2026-08-11. Each case's exact expected value was computed by calling the
// real (unmutated) export directly — see scratch/probes/ for the
// verification harness used to confirm each fixture actually kills its
// target mutant(s) (empirical mutant-application, not hand-derivation).
import { describe, expect, it } from "vitest";
import {
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkFunctionArity,
	checkManyOptionalParams,
	checkPositionalOptionalBoolean,
} from "./taste.js";

describe("checkBooleanTrap — wave 2 survivor kills", () => {
	it("P: basic 2bool", () => {
		const code = "call(true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: "call(true, false);" }]);
	});
	it("P: space before paren", () => {
		const code = "call (true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: "call (true, false);" }]);
	});
	it("N: nested array hides", () => {
		const code = "configure([true, false], real);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([]);
	});
	it("N: nested object hides", () => {
		const code = "configure({ a: true, b: false }, real);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([]);
	});
	it("P: nested call mixed A — non-bool nested args plus two trailing bools", () => {
		const code = "configure(nested(1, 2), true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("N: nested call mixed B — hides all three unless comma-branch depth breaks", () => {
		const code = "configure(nested(x, true, y), false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([]);
	});
	it("N: substring not literal", () => {
		const code = "configure(trueValue, falseValue);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([]);
	});
	it("P: three bools", () => {
		const code = "configure(true, false, true);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("N: test file gate", () => {
		const code = "call(true, false);";
		expect(checkBooleanTrap(code, "f.test.ts")).toEqual([]);
	});
	it("N: one bool below threshold", () => {
		const code = "call(true, x);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([]);
	});
	it("N: unsupported ext", () => {
		const code = "call(true, false);";
		expect(checkBooleanTrap(code, "f.py")).toEqual([]);
	});
	it("P: leading call then qualifying call", () => {
		const code = "helper(x); call(true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("N: bracket then brace both hide", () => {
		const code = "configure([true], {b: false}, real, other);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([]);
	});
	it("P: close bracket then boolean args", () => {
		const code = "configure(fn(a, b), true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: curly then trailing bools", () => {
		const code = "configure({a: 1, b: 2}, true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: double nested parens then bools", () => {
		const code = "configure(inner(deep(1)), true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: true at close position (isolates the closing-bracket arg check)", () => {
		const code = "call(false, true);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: true at comma position (isolates the comma-branch arg check)", () => {
		const code = "call(true, x, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: false at close position", () => {
		const code = "call(true, false);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: false at comma position", () => {
		const code = "call(false, x, true);";
		expect(checkBooleanTrap(code, "f.ts")).toEqual([{ line: 1, text: code }]);
	});
});

describe("checkFunctionArity — wave 2 survivor kills", () => {
	it("P: ts 5 param", () => {
		const code = "function foo(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] function foo(a,b,c,d,e) { return a; }" },
		]);
	});
	it("N: ts 4 param below", () => {
		const code = "function foo(a,b,c,d) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([]);
	});
	it("N: test file gate", () => {
		const code = "function foo(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.test.ts")).toEqual([]);
	});
	it("N: unsupported ext", () => {
		const code = "function foo(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.py")).toEqual([]);
	});
	it("N: export double space before function keyword (freely re-anchorable, no observable effect)", () => {
		const code = "export  function foo(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] export  function foo(a,b,c,d,e) { return a; }",
			},
		]);
	});
	it("P: async double space before function keyword", () => {
		const code = "async  function foo(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] async  function foo(a,b,c,d,e) { return a; }",
			},
		]);
	});
	it("P: export async double space", () => {
		const code = "export  async  function foo(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] export  async  function foo(a,b,c,d,e) { return a; }",
			},
		]);
	});
	it("P: space before generic function — post-identifier \\s* must consume it before the generic group", () => {
		const code = "function foo <T>(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] function foo <T>(a,b,c,d,e) { return a; }" },
		]);
	});
	it("P: space after generic function — pre-paren \\s* must consume it after the generic group", () => {
		const code = "function foo<T> (a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] function foo<T> (a,b,c,d,e) { return a; }" },
		]);
	});
	it("P: space both sides generic function", () => {
		const code = "function foo <T> (a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] function foo <T> (a,b,c,d,e) { return a; }",
			},
		]);
	});
	it("P: arrow export double space", () => {
		const code = "export  const build = (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] export  const build = (a,b,c,d,e) => a;" },
		]);
	});
	it("P: arrow async single space", () => {
		const code = "const build = async (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] const build = async (a,b,c,d,e) => a;" },
		]);
	});
	it("P: arrow async double space — async\\s+ must consume both spaces before the real paren", () => {
		const code = "const build = async  (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] const build = async  (a,b,c,d,e) => a;" },
		]);
	});
	it("P: arrow colon type double space", () => {
		const code = "const build:  Handler = (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] const build:  Handler = (a,b,c,d,e) => a;" },
		]);
	});
	it("P: arrow post-id double space before colon", () => {
		const code = "const build  : Handler = (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] const build  : Handler = (a,b,c,d,e) => a;",
			},
		]);
	});
	it("P: arrow double space before equals, no colon", () => {
		const code = "const build  = (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] const build  = (a,b,c,d,e) => a;" },
		]);
	});
	it("P: arrow double space after equals", () => {
		const code = "const build =  (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] const build =  (a,b,c,d,e) => a;" },
		]);
	});
	it("N: arrow type annotation containing '=' char is not confused for the real default-marker equals", () => {
		const code = "const build: Record<string,()=>void> = (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([]);
	});
	it("P: arrow type single char annotation", () => {
		const code = "const build: X = (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] const build: X = (a,b,c,d,e) => a;" },
		]);
	});
	it("P: go func double space", () => {
		const code = "func  F(a int, b int, c int, d int, e int, f int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([
			{
				line: 1,
				text: "[6 params → consider options object] func  F(a int, b int, c int, d int, e int, f int) {}",
			},
		]);
	});
	it("N: go func receiver single char body — checkFunctionArity's naive paramMatch captures the RECEIVER's parens, not the real params", () => {
		const code = "func (r *T) F(a int, b int, c int, d int, e int, f int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([]);
	});
	it("N: go func receiver empty body would not match", () => {
		const code = "func () F(a int, b int, c int, d int, e int, f int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([]);
	});
	it("P: go func name no trailing space before paren", () => {
		const code = "func F (a int, b int, c int, d int, e int, f int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([
			{
				line: 1,
				text: "[6 params → consider options object] func F (a int, b int, c int, d int, e int, f int) {}",
			},
		]);
	});
	it("P: rust pub double space", () => {
		const code = "pub  fn create_widget(a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		expect(checkFunctionArity(code, "f.rs")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] pub  fn create_widget(a: i32, b: i32, c: i32, d: i32, e: i32) {}",
			},
		]);
	});
	it("P: rust async double space", () => {
		const code = "async  fn create_widget(a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		expect(checkFunctionArity(code, "f.rs")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] async  fn create_widget(a: i32, b: i32, c: i32, d: i32, e: i32) {}",
			},
		]);
	});
	it("P: rust fn double space", () => {
		const code = "fn  create_widget(a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		expect(checkFunctionArity(code, "f.rs")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] fn  create_widget(a: i32, b: i32, c: i32, d: i32, e: i32) {}",
			},
		]);
	});
	it("P: rust space before generic", () => {
		const code = "fn create_widget <T>(a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		expect(checkFunctionArity(code, "f.rs")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] fn create_widget <T>(a: i32, b: i32, c: i32, d: i32, e: i32) {}",
			},
		]);
	});
	it("P: rust space after generic", () => {
		const code = "fn create_widget<T> (a: i32, b: i32, c: i32, d: i32, e: i32) {}";
		expect(checkFunctionArity(code, "f.rs")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] fn create_widget<T> (a: i32, b: i32, c: i32, d: i32, e: i32) {}",
			},
		]);
	});
	it("N: func with a nonempty multichar receiver body and double space before it", () => {
		const code = "func  (recv Receiver) Method(a int, b int, c int, d int, e int, f int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([]);
	});
	it("N: destructured single object param skip", () => {
		const code = "function foo({ a, b, c, d, e }) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([]);
	});
	it("N: destructured object with extra positional", () => {
		const code = "function foo({ a, b, c }, extra) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([]);
	});
	it("N: a plain call (not a declaration) never sets funcName, regardless of the !funcName gate", () => {
		const code = "doSomething(a,b,c,d,e,f);";
		expect(checkFunctionArity(code, "f.ts")).toEqual([]);
	});
	it("P: leading whitespace on declaration line — reported text must be the TRIMMED line", () => {
		const code = "  function foo(a,b,c,d,e) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] function foo(a,b,c,d,e) { return a; }" },
		]);
	});
	it("P: destructure-skip heuristic widened to || or hardcoded true would wrongly hide a real 5-param case", () => {
		const code = "function foo({ a, b, c, d, e }, extra1, extra2, extra3, extra4) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[5 params → consider options object] function foo({ a, b, c, d, e }, extra1, extra2, extra3, extra4) { return a; }",
			},
		]);
	});
	it("N: check2's single-brace-pair shape is reachable independent of check1 via a stray unmatched bracket", () => {
		const code = "function foo({ x] , a, b, c, d, e }) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([]);
	});
	it("P: 6 param above boundary", () => {
		const code = "function foo(a,b,c,d,e,f) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[6 params → consider options object] function foo(a,b,c,d,e,f) { return a; }" },
		]);
	});
	it("P: arrow zero space around colon AND equals — forces the exactly-one-whitespace mutants to fail", () => {
		const code = "const build:Handler= (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] const build:Handler= (a,b,c,d,e) => a;" },
		]);
	});
	it("P: arrow zero space after colon only", () => {
		const code = "const build:Handler = (a,b,c,d,e) => a;";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] const build:Handler = (a,b,c,d,e) => a;" },
		]);
	});
	it("N: go func double space inside receiver paren", () => {
		const code = "func (r  *T) F(a int, b int, c int, d int, e int, f int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([]);
	});
	it("P: go func double space after name before paren", () => {
		const code = "func F  (a int, b int, c int, d int, e int, f int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([
			{
				line: 1,
				text: "[6 params → consider options object] func F  (a int, b int, c int, d int, e int, f int) {}",
			},
		]);
	});
	it("P: check2 anchor-drop would let a TRAILING brace param be mistaken for the whole single-destructure shape", () => {
		const code = "function foo(a, b, c, d, e, f, { z }) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[7 params → consider options object] function foo(a, b, c, d, e, f, { z }) { return a; }",
			},
		]);
	});
	it("P: check2 trailing non-space content directly after the closing brace, no space", () => {
		const code = "function foo({ x] , a, b, c, d, e }f) { return a; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[6 params → consider options object] function foo({ x] , a, b, c, d, e }f) { return a; }",
			},
		]);
	});
	it("P: go comma-heavy receiver, single space before method name", () => {
		const code = "func (a, b, c, d, e, f Type) F(x int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([
			{ line: 1, text: "[6 params → consider options object] func (a, b, c, d, e, f Type) F(x int) {}" },
		]);
	});
	it("P: go comma-heavy receiver, double space before method name", () => {
		const code = "func (a, b, c, d, e, f Type)  F(x int) {}";
		expect(checkFunctionArity(code, "f.go")).toEqual([
			{
				line: 1,
				text: "[6 params → consider options object] func (a, b, c, d, e, f Type)  F(x int) {}",
			},
		]);
	});
});

describe("checkPositionalOptionalBoolean — wave 2 survivor kills", () => {
	it("P: basic optional marker", () => {
		const code = "function g(flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag?: boolean) {}" },
		]);
	});
	it("P: typed default", () => {
		const code = "function g(flag: boolean = false) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag: boolean = false) {}" },
		]);
	});
	it("P: inferred default", () => {
		const code = "function g(flag = true) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag = true) {}" },
		]);
	});
	it("N: non literal typed default", () => {
		const code = "function g(flag: boolean = maybe()) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: non literal inferred default", () => {
		const code = "function g(flag = maybe()) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: test file gate", () => {
		const code = "function g(flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.test.ts")).toEqual([]);
	});
	it("N: unsupported ext", () => {
		const code = "function g(flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.py")).toEqual([]);
	});
	it("N: decorator prefixed param has no leading identifier", () => {
		const code = "function foo(@Optional() flag?: boolean) { return flag; }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: destructured object param skip", () => {
		const code = "function foo(x: number, { flag }: Opts) { return flag; }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: destructured array param skip", () => {
		const code = "function foo(x: number, [flag]: Opts) { return flag; }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: rest param skip", () => {
		const code = "function foo(x: number, ...rest: boolean[]) { return rest; }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: public modifier prefixed", () => {
		const code = "class C { constructor(public flag?: boolean) {} }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: private modifier prefixed", () => {
		const code = "class C { constructor(private flag: boolean = false) {} }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: protected modifier prefixed", () => {
		const code = "class C { constructor(protected flag = true) {} }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: readonly modifier prefixed", () => {
		const code = "class C { constructor(readonly flag?: boolean) {} }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("P: 'static' is not a recognized modifier keyword, so it is NOT stripped and becomes the reported name's prefix text", () => {
		const code = "function h(static flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function h(static flag?: boolean) {}" },
		]);
	});
	it("P: modifier word with no trailing whitespace is not stripped (word-boundary is \\s+, not \\b)", () => {
		const code = "function h(publicflag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: publicflag] function h(publicflag?: boolean) {}" },
		]);
	});
	it("P: optional marker with a real space before the colon — the one input the ?-adjacent \\s* can't be masked on", () => {
		const code = "function g(flag ?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag ?: boolean) {}" },
		]);
	});
	it("P: optional marker double space after colon", () => {
		const code = "function g(flag?:  boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag?:  boolean) {}" },
		]);
	});
	it("P: optional marker trailing space inside the param", () => {
		const code = "function g(flag?: boolean ) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag?: boolean ) {}" },
		]);
	});
	it("P: typed default double space after equals", () => {
		const code = "function g(flag: boolean =  false) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag: boolean =  false) {}" },
		]);
	});
	it("P: typed default double space before equals", () => {
		const code = "function g(flag: boolean  = false) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag: boolean  = false) {}" },
		]);
	});
	it("P: typed default zero space before equals", () => {
		const code = "function g(flag: boolean= false) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag: boolean= false) {}" },
		]);
	});
	it("P: inferred default double space after equals", () => {
		const code = "function g(flag =  true) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag =  true) {}" },
		]);
	});
	it("P: inferred default double space before equals", () => {
		const code = "function g(flag  = true) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag  = true) {}" },
		]);
	});
	it("P: double space after the function keyword before a multi-char name", () => {
		const code = "function  createWidget(flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function  createWidget(flag?: boolean) {}" },
		]);
	});
	it("P: multichar generic block fully consumed before the params", () => {
		const code = "function createWidget<KV>(flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function createWidget<KV>(flag?: boolean) {}" },
		]);
	});
	it("P: arrow double space before identifier", () => {
		const code = "const  createWidget = (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[positional optional boolean: flag] const  createWidget = (flag?: boolean) => flag;",
			},
		]);
	});
	it("P: arrow colon type double space", () => {
		const code = "const createWidget:  Handler = (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[positional optional boolean: flag] const createWidget:  Handler = (flag?: boolean) => flag;",
			},
		]);
	});
	it("P: arrow double space before equals", () => {
		const code = "const createWidget  = (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[positional optional boolean: flag] const createWidget  = (flag?: boolean) => flag;",
			},
		]);
	});
	it("P: arrow async double space", () => {
		const code = "const createWidget = async  (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[positional optional boolean: flag] const createWidget = async  (flag?: boolean) => flag;",
			},
		]);
	});
	it("P: arrow async single space", () => {
		const code = "const createWidget = async (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[positional optional boolean: flag] const createWidget = async (flag?: boolean) => flag;",
			},
		]);
	});
	it("P: a generic's own comma does not fragment the following real positional-optional-boolean param", () => {
		const code = "function h(a: Map<string, number>, flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[positional optional boolean: flag] function h(a: Map<string, number>, flag?: boolean) {}",
			},
		]);
	});
	it("P: with two offenders present, only the FIRST one found is reported (loop breaks on first match)", () => {
		const code = "function h(a?: boolean, b?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: a] function h(a?: boolean, b?: boolean) {}" },
		]);
	});
	it("N: union type excluded", () => {
		const code = "function h(flag?: boolean | null) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: required boolean not flagged", () => {
		const code = "function h(flag: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: trailing non-space content after 'boolean' that is not the literal type name", () => {
		const code = "function g(flag?: booleanx) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: trailing non-space content after 'true' that is not the literal boolean value", () => {
		const code = "function g(flag = truex) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: a leading non-word char blocks the anchored identifier match (no re-anchor point)", () => {
		const code = "function foo($flag?: boolean) { return flag; }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("N: a modifier keyword appearing as a MID-STRING substring (not a prefix) must not be stripped", () => {
		const code = "function foo(notpublic flag?: boolean) { return flag; }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
	it("P: typed default zero space after colon", () => {
		const code = "function g(flag:boolean = false) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag:boolean = false) {}" },
		]);
	});
	it("P: typed default zero space everywhere", () => {
		const code = "function g(flag:boolean=false) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag:boolean=false) {}" },
		]);
	});
	it("P: optional marker zero space after colon", () => {
		const code = "function g(flag?:boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag?:boolean) {}" },
		]);
	});
	it("P: inferred default zero space around equals", () => {
		const code = "function g(flag=true) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function g(flag=true) {}" },
		]);
	});
	it("P: leading whitespace on declaration line — reported text must be the TRIMMED line", () => {
		const code = "  function foo(flag?: boolean) { return flag; }";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function foo(flag?: boolean) { return flag; }" },
		]);
	});
	it("P: truncates the reported line-text portion to exactly 120 characters after the prefix", () => {
		const params = `${Array.from({ length: 20 }, (_, i) => `p${i}: number`).join(", ")}, flag?: boolean`;
		const code = `function foo(${params}) {}`;
		const matches = checkPositionalOptionalBoolean(code, "f.ts");
		expect(matches).toHaveLength(1);
		const prefix = "[positional optional boolean: flag] ";
		expect(matches[0]?.text.startsWith(prefix)).toBe(true);
		expect(matches[0]?.text.slice(prefix.length)).toHaveLength(120);
		expect(matches[0]?.text.slice(prefix.length)).toBe(code.slice(0, 120));
	});
});

describe("checkManyOptionalParams — wave 2 survivor kills", () => {
	it("P: 3 optional boundary", () => {
		const code = "function h(a?: number, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{ line: 1, text: "[3 optional params → consider options object] function h(a?: number, b?: number, c?: number) {}" },
		]);
	});
	it("N: 2 optional below threshold", () => {
		const code = "function h(a?: number, b?: number, c: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("N: test file gate", () => {
		const code = "function h(a?: number, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.test.ts")).toEqual([]);
	});
	it("N: unsupported ext", () => {
		const code = "function h(a?: number, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.py")).toEqual([]);
	});
	it("N: rest param not counted", () => {
		const code = "function h(a?: number, b?: number, ...rest: number[]) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("P: mix of ?: and = defaults", () => {
		const code = "function h(a?: number, b = 1, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{ line: 1, text: "[3 optional params → consider options object] function h(a?: number, b = 1, c?: number) {}" },
		]);
	});
	it("N: an arrow-type-annotated required param's '=>' is not miscounted as a default '='", () => {
		const code = "function h(a?: number, b?: number, cb: () => void) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("N: a generic's own comma does not fragment the enclosing required param", () => {
		const code = "function h(a: Map<string, number>, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("P: a generic's own comma alongside three real optionals still counts correctly", () => {
		const code = "function h(a: Map<string, number>, b?: number, c?: number, d?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a: Map<string, number>, b?: number, c?: number, d?: number) {}",
			},
		]);
	});
	it("P: an object-literal default's own top-level '=' counts as optional", () => {
		const code = "function h(a = { x: 1, y: 2 }, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a = { x: 1, y: 2 }, b?: number, c?: number) {}",
			},
		]);
	});
	it("N: array-literal default internal comma does not fragment when below threshold", () => {
		const code = "function h(a = [1, 2, 3], b: number, c: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("P: array-literal default internal comma does not fragment, and the default itself counts", () => {
		const code = "function h(a = [1, 2, 3], b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a = [1, 2, 3], b?: number, c?: number) {}",
			},
		]);
	});
	it("N: call-expression default internal comma does not fragment when below threshold", () => {
		const code = "function h(a = compute(1, 2), b: number, c: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("P: call-expression default internal comma does not fragment, and the default itself counts", () => {
		const code = "function h(a = compute(1, 2), b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a = compute(1, 2), b?: number, c?: number) {}",
			},
		]);
	});
	it("P: bracket-indexed default internal comma does not fragment", () => {
		const code = "function h(a = arr[0, 1], b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a = arr[0, 1], b?: number, c?: number) {}",
			},
		]);
	});
	it("P: brace-object default with an internal comma does not fragment", () => {
		const code = "function h(a?: number, b?: number, c = {x:1,y:2}) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c = {x:1,y:2}) {}",
			},
		]);
	});
	it("P: exactly 3 optionals with a 4th required param mixed in", () => {
		const code = "function h(a?: number, b?: number, c: number, d?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c: number, d?: number) {}",
			},
		]);
	});
	it("P: angle-bracket pair correctly closes before a trailing top-level marker", () => {
		const code = "function h(a?: number, b?: number, c: Foo<X> = 1) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c: Foo<X> = 1) {}",
			},
		]);
	});
	it("P: paren pair correctly closes before a trailing top-level marker", () => {
		const code = "function h(a?: number, b?: number, c: (x) = 1) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c: (x) = 1) {}",
			},
		]);
	});
	it("P: curly pair correctly closes before a trailing top-level marker", () => {
		const code = "function h(a?: number, b?: number, c: {x} = 1) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c: {x} = 1) {}",
			},
		]);
	});
	it("P: square pair correctly closes before a trailing top-level marker", () => {
		const code = "function h(a?: number, b?: number, c: [x] = 1) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c: [x] = 1) {}",
			},
		]);
	});
	it("N: an angle bracket that never closes correctly hides its own internal '=' as non-top-level", () => {
		const code = "function h(a?: number, b?: number, c: Foo<T = X) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("N: a paren that never closes correctly hides its own internal '=' as non-top-level", () => {
		const code = "function h(a?: number, b?: number, c: (x = 1)) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("N: a curly brace that never closes correctly hides its own internal '=' as non-top-level", () => {
		const code = "function h(a?: number, b?: number, c: {x = 1}) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("N: a square bracket that never closes correctly hides its own internal '=' as non-top-level", () => {
		const code = "function h(a?: number, b?: number, c: [x = 1]) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("N: a rest param is never counted as optional even with a default-looking (raw-text) suffix", () => {
		const code = "function h(a?: number, b?: number, ...args: number[] = []) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("N: an arrow-type-annotated required param is not miscounted via its own '=>'", () => {
		const code = "function h(a?: number, b?: number, c: () => void) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("P: a default value containing '==' still counts via its OWN leading top-level '='", () => {
		const code = "function h(a?: number, b?: number, c = (d == 1)) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c = (d == 1)) {}",
			},
		]);
	});
	it("P: a modifier keyword as a MID-STRING substring (not a prefix) must not be stripped, but the real '=' still counts", () => {
		const code = "function h(a?: number, b?: number, notpublic = 1) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, notpublic = 1) {}",
			},
		]);
	});
	it("N: a genuine 'public' modifier prefix is stripped, leaving no top-level marker on any of the three params", () => {
		const code = "class C { constructor(public a?: number, public b?: number, public c?: number) {} }";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("P: leading whitespace on declaration line — reported text must be the TRIMMED line", () => {
		const code = "  function foo(a?: number, b?: number, c?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function foo(a?: number, b?: number, c?: number) {}",
			},
		]);
	});
	it("P: truncates the reported line-text portion to exactly 100 characters after the prefix", () => {
		const params = `${Array.from({ length: 20 }, (_, i) => `p${i}: number`).join(", ")}, a?: number, b?: number, c?: number`;
		const code = `function foo(${params}) {}`;
		const matches = checkManyOptionalParams(code, "f.ts");
		expect(matches).toHaveLength(1);
		const prefix = "[3 optional params → consider options object] ";
		expect(matches[0]?.text.startsWith(prefix)).toBe(true);
		expect(matches[0]?.text.slice(prefix.length)).toHaveLength(100);
		expect(matches[0]?.text.slice(prefix.length)).toBe(code.slice(0, 100));
	});
	it("N: text BEFORE the real '(' with an unbalanced '<' poisons extractParamStr's depth-tracked scan for it", () => {
		const code = "// a < b function foo(a, b, c) { return 1; }";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("P: a '(' inside a properly balanced generic bound must be skipped in favor of the real param-list '('", () => {
		const code = "function foo<T = (x: number)>(a?: number, b?: number, c?: number) { return 1; }";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function foo<T = (x: number)>(a?: number, b?: number, c?: number) { return 1; }",
			},
		]);
	});
	it("P: a legitimately optional last param whose default contains a generic still counts correctly", () => {
		const code = "function h(a?: number, b?: number, c: Map<string, number> = new Map()) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c: Map<string, number> = new Map()) {}",
			},
		]);
	});
	it("N: a bare '?' from an unrelated construct (a conditional type) must not trip the optional-marker check on its own", () => {
		const code = "function h(a?: number, b?: number, c: T extends U ? X : Y) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("N: '==' immediately followed by '>' exercises both the comparison and arrow-type exclusions at once", () => {
		const code = "function h(a?: number, b?: number, c==>x) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
	it("P: a genuine top-level '=' immediately after a closed generic's own '>' still counts as a default marker", () => {
		const code = "function h(a?: number, b?: number, c<T>=x) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([
			{
				line: 1,
				text: "[3 optional params → consider options object] function h(a?: number, b?: number, c<T>=x) {}",
			},
		]);
	});
});

describe("checkCatchAndIgnore — wave 2 survivor kills", () => {
	it("P: bare return null", () => {
		const code = "try { doWork(); } catch (e) { return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("N: logs then returns", () => {
		const code = "try { doWork(); } catch (e) { console.error(e); return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("N: non-default body", () => {
		const code = "try { doWork(); } catch (e) { doCleanup(); }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("N: non-listed return value", () => {
		const code = 'try { doWork(); } catch (e) { return "fallback"; }';
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("N: numeric value not in the default-value list", () => {
		const code = "try { doWork(); } catch (e) { return 42; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("N: unsupported ext", () => {
		const code = "try { doWork(); } catch (e) { return null; }";
		expect(checkCatchAndIgnore(code, "h.py")).toEqual([]);
	});
	it("P: multiline body", () => {
		const code = "try {\n  doWork();\n} catch (e) {\n  const x = 1;\n  return null;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (e) {" }]);
	});
	it("N: explanatory comment suppresses the flag", () => {
		const code =
			"try {\n  doWork();\n} catch (e) {\n  // intentional: caller treats null as absent\n  return null;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("P: catch with no space before the paren", () => {
		const code = "try { doWork(); } catch(e) { return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: catch with no binding", () => {
		const code = "try { doWork(); } catch { return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: catch double space before the brace", () => {
		const code = "try { doWork(); } catch (e)  { return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return undefined", () => {
		const code = "try { doWork(); } catch (e) { return undefined; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return false", () => {
		const code = "try { doWork(); } catch (e) { return false; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return true", () => {
		const code = "try { doWork(); } catch (e) { return true; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return empty single-quoted string", () => {
		const code = "try { doWork(); } catch (e) { return ''; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return empty double-quoted string", () => {
		const code = 'try { doWork(); } catch (e) { return ""; }';
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return empty template string", () => {
		const code = "try { doWork(); } catch (e) { return ``; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return empty array", () => {
		const code = "try { doWork(); } catch (e) { return []; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return empty object", () => {
		const code = "try { doWork(); } catch (e) { return {}; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return zero", () => {
		const code = "try { doWork(); } catch (e) { return 0; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return negative one", () => {
		const code = "try { doWork(); } catch (e) { return -1; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return void 0", () => {
		const code = "try { doWork(); } catch (e) { return void 0; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("N: handled via throw", () => {
		const code = "try { doWork(); } catch (e) { throw e; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("N: handled via logger.warn", () => {
		const code = "try { doWork(); } catch (e) { logger.warn(e); return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("N: handled via a bare 'error' identifier anywhere in the body", () => {
		const code = "try { doWork(); } catch (e) { const error = e; return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("P: an unrelated word is not mistaken for a handled keyword", () => {
		const code = "try { doWork(); } catch (e) { doOther(); return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("N: catch block near end of file, braces never balance — must not crash reading past the array bound", () => {
		const code = "try {\n  doWork();\n} catch (e) {\n  doSomething(\n";
		expect(() => checkCatchAndIgnore(code, "h.ts")).not.toThrow();
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("P: catch block body spanning exactly the 8-line collection window", () => {
		const code =
			"try {\n  doWork();\n} catch (e) {\n  step1();\n  step2();\n  step3();\n  step4();\n  return null;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (e) {" }]);
	});
	it("P: nested braces in the body before the default return", () => {
		const code = "try {\n  doWork();\n} catch (e) {\n  if (x) { y(); }\n  return null;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (e) {" }]);
	});
	it("N: a keyword matching ONLY the console.\\w+ alternative (not any bare alternative) still marks the body handled", () => {
		const code = "try { doWork(); } catch (e) { console.debug(e); return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("P: a multi-char catch binding", () => {
		const code = "try { doWork(); } catch (err) { return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: a catch binding literally named 'error' does not leak into the collected body as a handled keyword", () => {
		const code = "try { doWork(); } catch (error) { return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("N: a bare default return that is NOT the last statement in the body must not be flagged", () => {
		const code = "try { doWork(); } catch (e) { return null; doOther(); }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("P: return null with a space before the semicolon", () => {
		const code = "try { doWork(); } catch (e) { return null ; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: double space between 'return' and 'null'", () => {
		const code = "try { doWork(); } catch (e) { return  null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: return null with no trailing semicolon", () => {
		const code = "try { doWork(); } catch (e) { return null }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: double space before the closing brace", () => {
		const code = "try { doWork(); } catch (e) { return null;  }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});
	it("P: leading whitespace on the try line — reported text must be the TRIMMED line", () => {
		const code = "  try { doWork(); } catch (e) { return null; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([
			{ line: 1, text: "try { doWork(); } catch (e) { return null; }" },
		]);
	});
	it("N: an over-150-char reported line is still correctly truncated (verified via the unclosed-line-window case)", () => {
		const code = `try { doWork(); } catch (e) { return null; } // ${"x".repeat(150)}`;
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([]);
	});
	it("P: multiline catch binding named 'error'", () => {
		const code = "try {\n  doWork();\n} catch (error) {\n  return null;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (error) {" }]);
	});
	it("P: multiline catch with a same-line comment BEFORE the catch header", () => {
		const code = "try { doWork(); } /* note */ catch (e) {\n  return null;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([
			{ line: 1, text: "try { doWork(); } /* note */ catch (e) {" },
		]);
	});
	it("P: 'return' and its value on separate lines, no indentation", () => {
		const code = "try {\ndoWork();\n} catch (e) {\nreturn\nnull;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (e) {" }]);
	});
	it("P: a '/' split across two lines with no indentation is not a comment", () => {
		const code = "try {\ndoWork();\n} catch (e) {\na = b /\n/ c;\nreturn null;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (e) {" }]);
	});
	it("P: a catch block that closes early, followed by unrelated trailing statements in the collection window", () => {
		const code =
			"try {\n  doWork();\n} catch (e) {\n  return null;\n}\nunrelated1();\nunrelated2();";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (e) {" }]);
	});
	it("N: 10-match cap — an 11th qualifying catch block does not push an 11th match", () => {
		const code = Array.from(
			{ length: 12 },
			() => "try { doWork(); } catch (e) { return null; }",
		).join("\n");
		expect(checkCatchAndIgnore(code, "h.ts")).toHaveLength(10);
	});
});
