import { describe, expect, it } from "vitest";
import {
	checkAsyncPromiseExecutor,
	checkFloatingPromises,
	checkMisusedPromises,
	checkSilentPromiseSwallow,
} from "./agent-safety-async.js";

// Deep coverage for the agent-safety async/promise check family. Each
// detector's regex/heuristic boundaries are asserted with exact `toEqual`
// on the FULL returned match array (line + text) — not just `.length` — so
// a mutated line number, truncated message, or off-by-one whitespace
// boundary is visible to the assertion. Positive cases are prefixed "P",
// negative "N", and cap/edge-of-range cases "boundary" per the harness's
// Check Evidence Contract.

describe("checkMisusedPromises", () => {
	it("P1: flags .forEach(async ...) with no spacing", () => {
		const src = ["const xs = [1];", "xs.forEach(async (x) => {", "  await x;", "});"].join(
			"\n",
		);
		expect(checkMisusedPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "xs.forEach(async (x) => {" },
		]);
	});

	it("P2: flags .forEach (async ...) — a space before the opening paren", () => {
		const src = "xs.forEach (async (x) => {});";
		expect(checkMisusedPromises(src, "src/foo.ts")).toEqual([
			{ line: 1, text: "xs.forEach (async (x) => {});" },
		]);
	});

	it("P3: flags .forEach( async ...) — a space after the opening paren", () => {
		const src = "xs.forEach( async (x) => {});";
		expect(checkMisusedPromises(src, "src/foo.ts")).toEqual([
			{ line: 1, text: "xs.forEach( async (x) => {});" },
		]);
	});

	it("P4: flags .reduce(async ...)", () => {
		const src = "xs.reduce(async (acc, x) => acc, []);";
		expect(checkMisusedPromises(src, "src/foo.ts")).toEqual([
			{ line: 1, text: "xs.reduce(async (acc, x) => acc, []);" },
		]);
	});

	it("N1: does not flag a synchronous .forEach", () => {
		expect(checkMisusedPromises("xs.forEach((x) => x);", "src/foo.ts")).toEqual([]);
	});

	it("N2: does not flag .map(async ...) — only forEach/reduce are covered", () => {
		expect(checkMisusedPromises("xs.map(async (x) => x);", "src/foo.ts")).toEqual([]);
	});

	it("N3: does not run on non-JS/TS files", () => {
		expect(checkMisusedPromises("xs.forEach(async (x) => x);", "src/foo.py")).toEqual([]);
	});

	// Census fault (docs/reviews/kill-proof-census-harness.md, "Product defect
	// found"): the chain scanner walked back across a ternary `?`, so the `await`
	// on the CONDITION suppressed the finding on the forEach in the branch.
	// test-contract: bug — `await c ? xs.forEach(async …) : …` awaits `c`, not the forEach; the finding must fire
	it("P5: flags .forEach(async ...) in a ternary branch whose condition is awaited", () => {
		const src = "const r = await ready ? items.forEach(async (x) => { await save(x); }) : null;";
		expect(checkMisusedPromises(src, "src/foo.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P6: flags .forEach(async ...) on a negated receiver after await", () => {
		const src = "await !flag.forEach(async (x) => { await save(x); });";
		expect(checkMisusedPromises(src, "src/foo.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("N4: does not flag an awaited optional-chain / non-null receiver's forEach", () => {
		expect(
			checkMisusedPromises("await stream?.pipe(t)!.forEach(async (x) => { await save(x); });", "src/foo.ts"),
		).toEqual([]);
	});

	it("boundary: caps at 10 matches even when more exist, preserving the first 10 in order", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `xs${i}.forEach(async (x) => x);`);
		const out = checkMisusedPromises(lines.join("\n"), "src/foo.ts");
		expect(out).toEqual(lines.slice(0, 10).map((l, i) => ({ line: i + 1, text: l })));
	});
});

describe("checkFloatingPromises — extension / test-file guards", () => {
	it("N: does not run on non-JS/TS files", () => {
		const src = ["async function main() { return; }", "main();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.py")).toEqual([]);
	});

	it("N: does not run on test files, even with an unhandled async call", () => {
		const src = ["async function main() { return; }", "main();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.test.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — regression guards (pre-existing)", () => {
	it("does not flag interface/type method signatures", () => {
		const src = [
			"async function stop() { return; }",
			"interface Handle {",
			"  stop(reason?: string): Promise<void>;",
			"}",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out).toEqual([]);
	});

	it("does not flag arrow-function concise-body return values", () => {
		const src = [
			"async function fn(d: number) { return d; }",
			"const rows = await Promise.all(",
			"  xs.map((d) =>",
			"    fn(d),",
			"  ),",
			");",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out).toEqual([]);
	});

	it("still flags a truly floating async call at statement position", () => {
		const src = [
			"async function doIt() { return; }",
			"function caller() {",
			"  doIt();", // floating — no await, no return, no void
			"}",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("still flags a bare entrypoint call to an in-file async function", () => {
		const src = ["async function main() { return; }", "main();"].join("\n");
		expect(checkFloatingPromises(src, "src/index.ts").length).toBe(1);
	});

	it("does not flag main() handled by .catch on the same line", () => {
		const src = [
			"async function main() { return; }",
			"main().catch((err) => { console.error(err); });",
		].join("\n");
		expect(checkFloatingPromises(src, "src/index.ts")).toEqual([]);
	});

	it("does not flag main() whose .catch sits on the next chain line", () => {
		const src = [
			"async function main() { return; }",
			"main()",
			"  .catch((err) => {",
			"    console.error(err);",
			"  });",
		].join("\n");
		expect(checkFloatingPromises(src, "src/index.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — STATEMENT_PREFIX_KEYWORDS word boundary", () => {
	it("P: a call whose name merely STARTS WITH a keyword is not treated as keyword-led", () => {
		const src = ["async function asyncHelper() { return; }", "asyncHelper();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "asyncHelper();" },
		]);
	});

	it("N: a bare call whose leaf coincidentally equals a real keyword IS suppressed by the keyword-prefix guard", () => {
		// `async` is both a JS keyword AND (here) an object-shorthand property
		// name registered as a known-async id. The keyword guard must win —
		// `async();` reads as the reserved word, not a call to the property.
		const src = ["const obj = { async: async () => { return; } };", "async();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — collectFloatingAsyncIds: function-declaration form", () => {
	it("P: recognizes `async function foo(`", () => {
		const src = ["async function foo() { return; }", "foo();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([{ line: 2, text: "foo();" }]);
	});

	it("P: recognizes `async function* foo(` — generator, no space before '*'", () => {
		const src = ["async function* gen() { return; }", "gen();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([{ line: 2, text: "gen();" }]);
	});

	it("P: recognizes `async function * foo(` — generator, space on both sides of '*'", () => {
		// The star's own trailing `\s+` is mandatory — a space must follow it
		// before the name (unlike `function* gen()`, covered above).
		const src = ["async function * gen2() { return; }", "gen2();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([{ line: 2, text: "gen2();" }]);
	});

	it("P: recognizes extra whitespace between async/function/name", () => {
		const src = ["async  function   spaced() { return; }", "spaced();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "spaced();" },
		]);
	});

	it("P: recognizes a space before the declaration's own opening paren", () => {
		const src = ["async function withSpace () { return; }", "withSpace();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "withSpace();" },
		]);
	});

	it("boundary: recognizes extra whitespace between the generator '*' and the name (not just before the star)", () => {
		// The `\s+` right before the name is mandatory and independent of the
		// `\s*` before the star — it must tolerate more than one space on its
		// own, with nothing before the star to "absorb" the extra spaces.
		const src = ["async function*   spacedGen() { return; }", "spacedGen();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "spacedGen();" },
		]);
	});
});

describe("checkFloatingPromises — collectFloatingAsyncIds: const/let/var arrow-assignment form", () => {
	it("P: recognizes `const foo = async (`", () => {
		const src = ["const doIt = async () => { return; };", "doIt();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([{ line: 2, text: "doIt();" }]);
	});

	it("P: recognizes `let` and `var` too", () => {
		const srcLet = ["let doItLet = async () => { return; };", "doItLet();"].join("\n");
		expect(checkFloatingPromises(srcLet, "src/foo.ts")).toEqual([
			{ line: 2, text: "doItLet();" },
		]);
		const srcVar = ["var doItVar = async () => { return; };", "doItVar();"].join("\n");
		expect(checkFloatingPromises(srcVar, "src/foo.ts")).toEqual([
			{ line: 2, text: "doItVar();" },
		]);
	});

	it("P: recognizes a typed declaration `const foo: Type = async (`", () => {
		// The type-annotation group is `[^=]+` — it cannot span a `=>` (as an
		// arrow-typed annotation would), so the fixture uses a plain type.
		const src = ["const doItTyped: unknown = async () => { return; };", "doItTyped();"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "doItTyped();" },
		]);
	});

	it("P: recognizes a generic arrow `const foo = async <T>(`", () => {
		const src = ["const doItGeneric = async <T>(x: T) => x;", "doItGeneric(1);"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "doItGeneric(1);" },
		]);
	});

	it("P: recognizes a name with digits/underscore/dollar", () => {
		const src = ["const $do_It2 = async () => { return; };", "$do_It2();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "$do_It2();" },
		]);
	});

	it("P: recognizes extra whitespace around each token", () => {
		const src = [
			"const  spacedArrow   =   async   () => { return; };",
			"spacedArrow();",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "spacedArrow();" },
		]);
	});

	it("boundary: recognizes a space between the variable name and ':' in a typed declaration", () => {
		const src = [
			"const spacedType : unknown = async () => { return; };",
			"spacedType();",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "spacedType();" },
		]);
	});

	it("boundary: recognizes zero spaces after ':' in a typed declaration", () => {
		const src = [
			"const zeroSpaceType:unknown = async () => { return; };",
			"zeroSpaceType();",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "zeroSpaceType();" },
		]);
	});

	it("boundary: recognizes zero spaces between the type annotation and '=' ", () => {
		const src = [
			"const zeroSpaceEq: unknown= async () => { return; };",
			"zeroSpaceEq();",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "zeroSpaceEq();" },
		]);
	});

	it("N: a bare ':' immediately followed by '=' (no type content at all) is not a valid typed declaration", () => {
		// Malformed input probing the boundary between the optional type group
		// and the '=' sign — `:=` must not be swallowed as "empty type".
		const src = ["const foo:= async () => { return; };", "foo();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("N: requires the value to actually be invoked (followed by '(' or '<'), not just referenced", () => {
		const src = ["const notInvoked = async;", "notInvoked();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — collectFloatingAsyncIds: class-method form", () => {
	it("P: recognizes a plain async class method", () => {
		const src = [
			"class Foo {",
			"  async bar() { return; }",
			"}",
			"function caller() {",
			"  const f = new Foo();",
			"  f.bar();",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 6, text: "f.bar();" },
		]);
	});

	it("P: recognizes a stack of access modifiers before async", () => {
		const src = [
			"class Foo {",
			"  public static async run() { return; }",
			"}",
			"function caller() {",
			"  const f = new Foo();",
			"  f.run();",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 6, text: "f.run();" },
		]);
	});

	it("P: recognizes extra whitespace around the method name and paren", () => {
		const src = [
			"class Foo {",
			"   async   spaced2  ()  { return; }",
			"}",
			"function caller() {",
			"  const f = new Foo();",
			"  f.spaced2();",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 6, text: "f.spaced2();" },
		]);
	});

	it("boundary: tolerates multiple spaces between stacked access modifiers", () => {
		const src = [
			"class Foo {",
			"  public  static  async spacedMods() { return; }",
			"}",
			"function caller() {",
			"  const f = new Foo();",
			"  f.spacedMods();",
			"}",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 6, text: "f.spacedMods();" },
		]);
	});

	it("N: the class-method regex is anchored to leading whitespace at the START of the line", () => {
		// Without the anchor, "async notAMethod(" could be found mid-line
		// after arbitrary leading text — it must not be.
		const src = ["xxx  async notAMethod() { return; }", "notAMethod();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — collectFloatingAsyncIds: object-shorthand form", () => {
	it("P: recognizes `foo: async (`", () => {
		const src = ["const obj = {", "  run: async () => { return; },", "};", "obj.run();"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 4, text: "obj.run();" },
		]);
	});

	it("P: recognizes extra whitespace around the ':' and 'async'", () => {
		const src = [
			"const obj2 = {",
			"  spaced3   :   async   () => { return; },",
			"};",
			"obj2.spaced3();",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 4, text: "obj2.spaced3();" },
		]);
	});

	it("N: requires the value to actually be invoked (followed by '(' or '<'), not just referenced", () => {
		const src = ["const obj3 = { foo: async };", "obj3.foo();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — built-in fetch()", () => {
	it("P: flags a bare fetch() call", () => {
		const src = 'fetch("/api");';
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 1, text: 'fetch("/api");' },
		]);
	});

	it("N: does not flag fetch().catch(...)", () => {
		const src = 'fetch("/api").catch(() => {});';
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — shouldSkipFloatingLine: identifier-start guard", () => {
	it("N: a digit-led token is not treated as a candidate even when its leaf resolves to a known async id", () => {
		const src = ["async function foo() { return; }", "0.foo();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — shouldSkipFloatingLine: walking back past blank lines", () => {
	it("N: walks back past a single blank line to find the true previous (arg-list) context", () => {
		const src = [
			"async function foo() { return; }",
			"someCall(",
			"",
			"  foo()",
			");",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("N: walks back past a whitespace-only line (not just truly empty) to find prior context", () => {
		const src = [
			"async function foo() { return; }",
			"someCall(",
			"   ",
			"foo()",
			");",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("boundary: a candidate on the very first line of the file never crashes the blank-line walk-back", () => {
		const src = ["mainEntry();", "async function mainEntry() { return; }"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 1, text: "mainEntry();" },
		]);
	});
});

describe("checkFloatingPromises — shouldSkipFloatingLine: arg-list guard (prev ends in '([,')", () => {
	it("boundary: prev === 0 (candidate is the second line) still checks the first line for arg-list context", () => {
		const src = ["someCall(", "foo()", ");", "async function foo() { return; }"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — shouldSkipFloatingLine: arrow concise-body guard", () => {
	it("N: does not flag when the arrow body line has trailing whitespace after '=>'", () => {
		const src = ["async function fn() { return; }", "const x = () => ", "fn();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("N: the '=>' guard is anchored to the end of the previous line, not a substring anywhere in it", () => {
		const src = [
			"async function foo() { return; }",
			"const helper = (x) => x + 1;",
			"foo();",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 3, text: "foo();" },
		]);
	});

	it("boundary: prev === 0 (candidate is the second line) still checks the first line for a trailing '=>'", () => {
		const src = ["const helper = () =>", "fn();", "async function fn() { return; }"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — shouldSkipFloatingLine: interface/type Promise<> signature guard", () => {
	it("boundary: the exemption requires the Promise<> shape at the true END of the line", () => {
		const src = ["async function trigger() { return; }", "trigger(): Promise<void>;x"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "trigger(): Promise<void>;x" },
		]);
	});

	it("N: tolerates a space before ':'", () => {
		const src = ["async function stop2() { return; }", "stop2() : Promise<void>;"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("N: tolerates zero spaces after ':'", () => {
		const src = ["async function stop3() { return; }", "stop3():Promise<void>;"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("N: tolerates a space before '<'", () => {
		const src = ["async function stop4() { return; }", "stop4(): Promise <void>;"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("N: tolerates a space before ';'", () => {
		const src = ["async function stop5() { return; }", "stop5(): Promise<void> ;"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — extractCallLeafId", () => {
	it("N: the leading-call leaf is anchored to the START of the line, not searched anywhere within it", () => {
		const src = ["async function bar() { return; }", "foo-bar();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("P: a space between the call identifier and its own parenthesis is still recognized", () => {
		const src = ["async function spacedCall() { return; }", "spacedCall ();"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: "spacedCall ();" },
		]);
	});

	it("boundary: a bare identifier with no call parens at all does not crash leaf extraction", () => {
		const src = ["async function foo() { return; }", "bareIdentifierNoCall"].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("P: optional-chaining is normalized before isolating the final segment (obj?.bar())", () => {
		const src = ["async function bar() { return; }", "const obj = { bar };", "obj?.bar();"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 3, text: "obj?.bar();" },
		]);
	});

	it("P: a multi-character bracket-notation suffix is stripped before the leaf lookup", () => {
		const src = [
			"async function handlers() { return; }",
			"const registry = { handlers };",
			"registry.handlers[10]();",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 3, text: "registry.handlers[10]();" },
		]);
	});
});

describe("checkFloatingPromises — already-handled (.catch/.finally) suppression", () => {
	it("N: does not flag a call already handled by .finally()", () => {
		const src = ["async function main3() { return; }", "main3().finally(() => {});"].join(
			"\n",
		);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("N: an already-caught call is recognized even with a space before '(' in .catch", () => {
		const src = [
			"async function main() { return; }",
			"main().catch ((e) => log(e));",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});

	it("N: an already-finally-handled call is recognized even with a space before '(' in .finally", () => {
		const src = [
			"async function main2() { return; }",
			"main2().finally (() => {});",
		].join("\n");
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — shouldSkipFloatingLine: multi-line chain (next non-blank starts with '.')", () => {
	it("N: walks forward past a truly blank line to find the chain continuation", () => {
		const src = [
			"async function main4() { return; }",
			"main4()",
			"",
			"  .catch((err) => {",
			"    console.error(err);",
			"  });",
		].join("\n");
		expect(checkFloatingPromises(src, "src/index.ts")).toEqual([]);
	});

	it("N: walks forward past a whitespace-only line (not just truly empty) to find the chain continuation", () => {
		const src = [
			"async function main5() { return; }",
			"main5()",
			"   ",
			"  .catch((err) => {",
			"    console.error(err);",
			"  });",
		].join("\n");
		expect(checkFloatingPromises(src, "src/index.ts")).toEqual([]);
	});
});

describe("checkFloatingPromises — cap and text construction", () => {
	it("boundary: caps at 10 matches even when more exist, preserving the first 10 in order", () => {
		const decls = Array.from({ length: 12 }, (_, i) => `async function fn${i}() { return; }`);
		const calls = Array.from({ length: 12 }, (_, i) => `fn${i}();`);
		const src = [...decls, ...calls].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		const expected = calls.slice(0, 10).map((text, i) => ({ line: decls.length + i + 1, text }));
		expect(out).toEqual(expected);
	});

	it("boundary: match text is trimmed of leading whitespace and truncated to 150 characters", () => {
		const original = `   longCall();${" zzz".repeat(60)}`;
		const src = ["async function longCall() { return; }", original].join("\n");
		const expectedText = original.trim().slice(0, 150);
		expect(checkFloatingPromises(src, "src/foo.ts")).toEqual([
			{ line: 2, text: expectedText },
		]);
	});
});

describe("checkAsyncPromiseExecutor", () => {
	it("P1: flags new Promise(async ...) with no extra spacing", () => {
		const src = "new Promise(async (resolve) => {});";
		expect(checkAsyncPromiseExecutor(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P2: flags with multiple spaces between 'new' and 'Promise'", () => {
		const src = "new   Promise(async (resolve) => {});";
		expect(checkAsyncPromiseExecutor(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P3: flags with a space before the opening paren", () => {
		const src = "new Promise (async (resolve) => {});";
		expect(checkAsyncPromiseExecutor(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P4: flags with a space after the opening paren", () => {
		const src = "new Promise( async (resolve) => {});";
		expect(checkAsyncPromiseExecutor(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("N1: does not flag a synchronous Promise executor", () => {
		expect(checkAsyncPromiseExecutor("new Promise((resolve) => resolve(1));", "src/x.ts")).toEqual(
			[],
		);
	});

	it("N2: does not run on non-JS/TS files", () => {
		expect(
			checkAsyncPromiseExecutor("new Promise(async (resolve) => {});", "src/x.py"),
		).toEqual([]);
	});

	it("boundary: caps at 10 matches, preserving the first 10 in order", () => {
		const lines = Array.from({ length: 12 }, () => "new Promise(async (r) => {});");
		const out = checkAsyncPromiseExecutor(lines.join("\n"), "src/x.ts");
		expect(out).toEqual(lines.slice(0, 10).map((l, i) => ({ line: i + 1, text: l })));
	});
});

describe("checkSilentPromiseSwallow", () => {
	it("P1: flags .catch(() => {})", () => {
		const out = checkSilentPromiseSwallow('fetch("/api").catch(() => {});\n', "src/x.ts");
		expect(out).toEqual([{ line: 1, text: 'fetch("/api").catch(() => {});' }]);
	});

	it("P2: flags .catch with a bound param and an empty body", () => {
		const out = checkSilentPromiseSwallow("foo().catch((e) => {});\n", "src/x.ts");
		expect(out).toEqual([{ line: 1, text: "foo().catch((e) => {});" }]);
	});

	it("P3: flags .catch with an UNparenthesized single param and an empty body", () => {
		const src = "foo().catch(e => {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P4: flags .catch with a multi-character unparenthesized param name", () => {
		const src = "foo().catch(err123 => {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("P5: flags .catch(function (e) {})", () => {
		const out = checkSilentPromiseSwallow("foo().catch(function (e) {});\n", "src/x.ts");
		expect(out).toEqual([{ line: 1, text: "foo().catch(function (e) {});" }]);
	});

	it("P6: flags .catch(function namedHandler(e) {})", () => {
		const src = "foo().catch(function namedHandler(e) {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch with varied whitespace around the arrow and braces still flags", () => {
		const src = "foo().catch ((e)  =>  {  });";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch( function ...) with varied whitespace still flags", () => {
		const src = "foo().catch( function  (e)  {  } );";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch( (e) => {}) — space right after catch's own '('", () => {
		const src = "foo().catch( (e) => {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch((e) => {} ) — space before catch's own closing ')'", () => {
		const src = "foo().catch((e) => {} );";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch (function (e) {}) — space between catch and its own '('", () => {
		const src = "foo().catch (function (e) {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch(function(e) {}) — zero spaces between 'function' and its params", () => {
		const src = "foo().catch(function(e) {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch(function handler2(e) {}) — function name containing a digit", () => {
		const src = "foo().catch(function handler2(e) {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch(function namedHandler (e) {}) — space between the function name and its own '('", () => {
		const src = "foo().catch(function namedHandler (e) {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("boundary: .catch(function ...(err) {}) — multi-character parameter list", () => {
		const src = "foo().catch(function namedHandler2(err) {});";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([{ line: 1, text: src }]);
	});

	it("N1: does NOT flag .catch returning an explicit fallback value (null / undefined / void 0)", () => {
		const cases = [
			"foo().catch(() => undefined);\n",
			"foo().catch(_ => null);\n",
			"foo().catch(() => void 0);\n",
		];
		for (const src of cases) {
			expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([]);
		}
	});

	it("N2: does NOT flag .catch with a real handler body", () => {
		expect(checkSilentPromiseSwallow("foo().catch((e) => log(e));\n", "src/x.ts")).toEqual([]);
	});

	it("N3: does NOT flag .catch with an explicit param-ack body", () => {
		expect(checkSilentPromiseSwallow("foo().catch((e) => { void e; });\n", "src/x.ts")).toEqual(
			[],
		);
	});

	it("N4: does NOT flag .catch(handlerIdent) — unknown intent", () => {
		expect(checkSilentPromiseSwallow("foo().catch(handleError);\n", "src/x.ts")).toEqual([]);
	});

	it("N5: does NOT flag when an inline comment marks intent", () => {
		expect(
			checkSilentPromiseSwallow("foo().catch(() => { /* fire and forget */ });\n", "src/x.ts"),
		).toEqual([]);
	});

	it("N6: the intent comment is honored even with a space before .catch's own parenthesis", () => {
		const src = "foo().catch (() => {} /* fire and forget */);";
		expect(checkSilentPromiseSwallow(src, "src/x.ts")).toEqual([]);
	});

	it("N7: does NOT run on test files", () => {
		expect(checkSilentPromiseSwallow("foo().catch(() => {});\n", "src/x.test.ts")).toEqual([]);
	});

	it("N8: does NOT run on non-JS/TS files", () => {
		expect(checkSilentPromiseSwallow("foo().catch(() => {});\n", "src/x.py")).toEqual([]);
	});

	it("boundary: caps at 10 matches, preserving the first 10 in order", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `foo${i}().catch(() => {});`);
		const out = checkSilentPromiseSwallow(lines.join("\n"), "src/x.ts");
		expect(out).toEqual(lines.slice(0, 10).map((l, i) => ({ line: i + 1, text: l })));
	});

	it("boundary: match text is trimmed of leading whitespace and truncated to 150 characters", () => {
		const original = `   longSwallow().catch(() => {});${" zzz".repeat(60)}`;
		const expectedText = original.trim().slice(0, 150);
		expect(checkSilentPromiseSwallow(original, "src/x.ts")).toEqual([
			{ line: 1, text: expectedText },
		]);
	});
});

describe("agent-safety async check surface — smoke", () => {
	it("checkAsyncPromiseExecutor returns an array", () => {
		expect(Array.isArray(checkAsyncPromiseExecutor("", "a.ts"))).toBe(true);
	});

	it("checkMisusedPromises returns an array", () => {
		expect(Array.isArray(checkMisusedPromises("", "a.ts"))).toBe(true);
	});
});
