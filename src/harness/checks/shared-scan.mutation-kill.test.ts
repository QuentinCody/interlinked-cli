// Mutation-kill companion for shared-scan.ts — targets survivors from
// `npx tsx src/index.ts mutation survivors --file src/harness/checks/shared-scan.ts --json`
// (snapshot scratch/fleet-r3/shared-scan-survivors.json, generation 740).
// Labeled P:/N: prefixes per the Check Evidence Contract convention.
import { describe, expect, it } from "vitest";
import {
	collectElapsedTimeAnchors,
	findEnclosingScope,
	isTypeOnlyModule,
} from "./shared-scan.js";

describe("findEnclosingScope — SCOPE_DECLARATION_RES[0] (function) regex precision", () => {
	it("P: does not match a mid-line 'function' keyword when the line does not start with it (anchor required)", () => {
		const content = "return function foo() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 1)).toBeNull();
	});

	it("P: finds an indented (nested) function declaration by name — leading whitespace must be tolerated", () => {
		const content = "  function helper() {\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("helper");
	});

	it("P: tolerates two spaces after the `export` keyword before `function`", () => {
		const content = "export  function foo() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("foo");
	});

	it("P: tolerates two spaces after the `async` keyword before `function`", () => {
		const content = "async  function foo() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("foo");
	});

	it("N: does not match when a stray non-whitespace character sits directly after `function` (no separator)", () => {
		const content = "function%foo() {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBeNull();
	});

	it("P: finds a generator function with no space between the star and the name", () => {
		const content = "function*gen() {\n  yield 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("gen");
	});

	it("P: tolerates whitespace between the function name and its opening parenthesis", () => {
		const content = "function foo () {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("foo");
	});
});

describe("findEnclosingScope — SCOPE_DECLARATION_RES[1] (class) regex precision", () => {
	it("P: does not match a mid-line 'class' keyword when the line does not start with it", () => {
		const content = "return class Foo {\n  x = 1;\n}\n";
		expect(findEnclosingScope(content, 1)).toBeNull();
	});

	it("P: finds an indented (nested) class declaration by name", () => {
		const content = "  class Widget {\n    x = 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("Widget");
	});

	it("P: tolerates two spaces after `export` before `class`", () => {
		const content = "export  class Foo {\n  x = 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("Foo");
	});

	it("P: tolerates two spaces after `abstract` before `class`", () => {
		const content = "abstract  class Foo {\n  x = 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("Foo");
	});

	it("P: tolerates two spaces after `class` before the name", () => {
		const content = "class  Foo {\n  x = 1;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("Foo");
	});
});

describe("findEnclosingScope — SCOPE_DECLARATION_RES[2] (arrow function) regex precision", () => {
	it("P: does not match a mid-line 'const NAME = ... =>' when the line does not start with it", () => {
		const content = "return; const leaked = a => a;\n";
		expect(findEnclosingScope(content, 1)).toBeNull();
	});

	it("P: finds an indented (nested) arrow-function assignment by name", () => {
		const content = "  const nested = x => x;\n";
		expect(findEnclosingScope(content, 1)).toBe("nested");
	});

	it("P: tolerates two spaces after `export` before `const`", () => {
		const content = "export  const pub = x => x;\n";
		expect(findEnclosingScope(content, 1)).toBe("pub");
	});

	it("P: tolerates two spaces after `const` before the name", () => {
		const content = "const  spaced = x => x;\n";
		expect(findEnclosingScope(content, 1)).toBe("spaced");
	});

	it("P: tolerates a fully compact arrow function with zero optional whitespace anywhere (bare param)", () => {
		const content = "const id=x=>x;\n";
		expect(findEnclosingScope(content, 1)).toBe("id");
	});

	it("P: tolerates a fully compact arrow function with a multi-character bare parameter name", () => {
		const content = "const id=xy=>xy;\n";
		expect(findEnclosingScope(content, 1)).toBe("id");
	});

	it("P: tolerates zero whitespace between `async` and the opening parenthesis of the param list", () => {
		const content = "const run=async(x) => x;\n";
		expect(findEnclosingScope(content, 1)).toBe("run");
	});
});

describe("findEnclosingScope — SCOPE_DECLARATION_RES[3] (function expression) regex precision", () => {
	it("P: does not match a mid-line 'const NAME = function' when the line does not start with it", () => {
		const content = "return; const leaked2 = function () {};\n";
		expect(findEnclosingScope(content, 1)).toBeNull();
	});

	it("P: finds an indented (nested) function-expression assignment by name", () => {
		const content = "  const nested2 = function () {\n    return 1;\n  };\n";
		expect(findEnclosingScope(content, 2)).toBe("nested2");
	});

	it("P: tolerates two spaces after `export` before `const` (function expression)", () => {
		const content = "export  const wrapped = function () {\n  return 1;\n};\n";
		expect(findEnclosingScope(content, 2)).toBe("wrapped");
	});

	it("P: tolerates two spaces after `const` before the name (function expression)", () => {
		const content = "const  dblSpace = function () {\n  return 1;\n};\n";
		expect(findEnclosingScope(content, 2)).toBe("dblSpace");
	});

	it("P: tolerates zero whitespace on both sides of `=` (function expression)", () => {
		const content = "const zero=function () {\n  return 1;\n};\n";
		expect(findEnclosingScope(content, 2)).toBe("zero");
	});

	it("P: tolerates two spaces between `async` and `function`", () => {
		const content = "const af=async  function () {\n  return 1;\n};\n";
		expect(findEnclosingScope(content, 2)).toBe("af");
	});
});

describe("findEnclosingScope — SCOPE_DECLARATION_RES[4] (indented method) regex precision", () => {
	it("P: does not match a method-like tail on a line that has no leading whitespace of its own (anchor required)", () => {
		const content = "return foo; bar(x) {\n  return 1;\n}\n";
		expect(findEnclosingScope(content, 1)).toBeNull();
	});

	it("N: does not match when `async` is followed directly by the method name with no separating space", () => {
		const content = "  async foo(x) {\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("foo");
	});

	it("P: tolerates two spaces after `async` before the method name", () => {
		const content = "  async  spaced(x) {\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("spaced");
	});

	it("P: tolerates two spaces after `static` before the method name", () => {
		const content = "  static  spaced2(x) {\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("spaced2");
	});

	it("P: tolerates two spaces after `public` before the method name", () => {
		const content = "  public  spaced3(x) {\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("spaced3");
	});

	it("P: tolerates two spaces after `private` before the method name", () => {
		const content = "  private  spaced4(x) {\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("spaced4");
	});

	it("P: tolerates two spaces after `protected` before the method name", () => {
		const content = "  protected  spaced5(x) {\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("spaced5");
	});

	it("P: tolerates whitespace between the method name and its opening parenthesis", () => {
		const content = "  spacedParen (x) {\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("spacedParen");
	});

	it("P: tolerates zero whitespace between the closing parenthesis and the opening brace", () => {
		const content = "  tight(x){\n    return 1;\n  }\n";
		expect(findEnclosingScope(content, 2)).toBe("tight");
	});
});

describe("findEnclosingScope — target-line index arithmetic", () => {
	it("P: an in-range line number resolves to ITS OWN nearest scope, not a later one in the file", () => {
		const content = "function a() {\n  x;\n}\nfunction c() {\n  y;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("a");
	});
});

describe("collectElapsedTimeAnchors — TIMER_ANCHOR_ASSIGN_RE precision", () => {
	it("P: tolerates two spaces between `const`/`let`/`var` and the identifier", () => {
		const src = "const  dblspace = Date.now();\nconst d = Date.now() - dblspace;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["dblspace"]));
	});

	it("P: tolerates zero whitespace around the `=` sign", () => {
		const src = "const t0=Date.now();\nconst d = Date.now() - t0;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["t0"]));
	});

	it("P: tolerates whitespace between the clock object and its dot", () => {
		const src = "const t1 = Date .now();\nconst d = Date.now() - t1;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["t1"]));
	});

	it("P: tolerates whitespace between the dot and `now`", () => {
		const src = "const t2 = Date. now();\nconst d = Date.now() - t2;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["t2"]));
	});

	it("P: tolerates whitespace between `now` and its opening parenthesis", () => {
		const src = "const t3 = Date.now ();\nconst d = Date.now() - t3;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["t3"]));
	});

	it("P: tolerates whitespace inside the `now()` parentheses", () => {
		const src = "const t4 = Date.now( );\nconst d = Date.now() - t4;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set(["t4"]));
	});

	it("N: an identifier with no matching subtraction is never collected as an anchor (undefined-guard sanity)", () => {
		const src = "const solo = Date.now();\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set());
	});
});

describe("isTypeOnlyModule — typeOnlyTopLevelModeAt regex precision", () => {
	it("P: does not treat a later `import type` elsewhere in the file as matching an earlier, unrelated statement", () => {
		expect(
			isTypeOnlyModule(
				"ff.ts",
				"export const x = 1;\nimport type { A } from 'a';\ntype X = A;\n",
			),
		).toBe(false);
	});

	it("P: tolerates two spaces between `import` and `type`", () => {
		expect(isTypeOnlyModule("gg.ts", "import  type { A } from 'a';\ntype X = A;\n")).toBe(true);
	});

	it("P: tolerates two spaces between `export` and `type`", () => {
		expect(isTypeOnlyModule("hh.ts", "export  type X = string;\n")).toBe(true);
	});

	it("P: recognizes a plain `export type` declaration (not just `export interface`)", () => {
		expect(isTypeOnlyModule("q1.ts", "export type X = string;\n")).toBe(true);
	});

	it("P: does not treat a later `interface` elsewhere in the file as matching an earlier, unrelated statement", () => {
		expect(isTypeOnlyModule("dd.ts", "export const x = 1;\ninterface Y {}\n")).toBe(false);
	});

	it("P: tolerates two spaces between `export` and `interface`", () => {
		expect(isTypeOnlyModule("ee.ts", "export  interface Foo {}\n")).toBe(true);
	});
});

describe("isTypeOnlyModule — leading type/interface declaration pre-check regex precision", () => {
	it("P: recognizes an indented top-level `type` alias (leading whitespace before the keyword)", () => {
		expect(isTypeOnlyModule("ii.ts", "  type X = string;\n")).toBe(true);
	});
});

describe("isTypeOnlyModule — typeOnlyStatementEndAt: interface closing-brace termination", () => {
	it("P: a bodyless interface's closing brace ends the statement — trailing runtime code is not swallowed", () => {
		expect(isTypeOnlyModule("jj.ts", "interface Foo {}\nexport const y = 1;\n")).toBe(false);
	});

	it("P: an interface's closing brace ends the statement even with a body present", () => {
		expect(
			isTypeOnlyModule("jj2.ts", "interface Foo {\n  a: string;\n}\nexport const y = 1;\n"),
		).toBe(false);
	});

	it("P: a semicolon immediately after an interface's closing brace is consumed as part of the statement", () => {
		expect(
			isTypeOnlyModule("jj3.ts", "interface Foo {};\ninterface Bar {}\n"),
		).toBe(true);
	});

	it("P: whitespace between an interface's closing brace and a following semicolon is skipped", () => {
		expect(
			isTypeOnlyModule("jj4.ts", "interface Foo {}   ;\ninterface Bar {}\n"),
		).toBe(true);
	});
});

describe("isTypeOnlyModule — typeOnlyStatementEndAt: semicolon termination", () => {
	it("P: a top-level semicolon ends a `type` statement even mid-nesting-free text", () => {
		expect(isTypeOnlyModule("kk1.ts", "type X = string;export const y = 1;\n")).toBe(false);
	});

	it("P: a semicolon INSIDE an open brace (object-type member separator) does not end the statement early", () => {
		expect(isTypeOnlyModule("kk2.ts", "type X = { a: string; b: number };\n")).toBe(true);
	});
});

describe("isTypeOnlyModule — canEndTypeOnlyStatementAtNewline precision", () => {
	it("P: a blank line does not defer termination into content further down the file", () => {
		expect(isTypeOnlyModule("kk.ts", "type X =\n  \n  | Y;\n")).toBe(false);
	});

	it("P: does not treat a next line that merely CONTAINS `from` (not as its own clause) as an import continuation", () => {
		expect(isTypeOnlyModule("aa.ts", "import type Foo\nx.from(y);\ntype X = Foo;\n")).toBe(false);
	});

	it("P: does not treat a next line that CONTAINS `|` but does not start with it as a union continuation", () => {
		expect(isTypeOnlyModule("bb.ts", "type X = string\nexport const y = 1 | 2;\n")).toBe(false);
	});

	it("P: does not treat a next line that CONTAINS `typeof` but not at its start as a type continuation", () => {
		expect(isTypeOnlyModule("cc.ts", "type X = string\nexport const y = typeof x;\n")).toBe(false);
	});

	it("P: a genuinely empty next line ends the statement (no next-line content to inspect)", () => {
		expect(isTypeOnlyModule("ll.ts", "type X = string\n\nexport const y = 1;\n")).toBe(false);
	});

	it("N: does not end an `import type` statement when the next line really is its `from` clause", () => {
		expect(
			isTypeOnlyModule("mm.ts", 'import type Foo\nfrom "foo";\ntype X = Foo;\n'),
		).toBe(true);
	});

	it("N: does not end a `type` statement when the next line is a real union continuation", () => {
		expect(isTypeOnlyModule("nn.ts", 'type X =\n  | "a"\n  | "b";\n')).toBe(true);
	});
});

describe("isTypeOnlyModule — typeOnlyStatementEndAt: interface first-if gating (mode/ch must both hold)", () => {
	it("P: an interface's brace-on-its-own-line style is not treated as its own newline-terminated statement", () => {
		expect(isTypeOnlyModule("qq.ts", "interface Foo\n{\n  a: string;\n}\n")).toBe(true);
	});

	it("P: a stray closing brace before an interface's real body opens does not end the statement early", () => {
		expect(isTypeOnlyModule("rr.ts", "interface Foo }\nexport const y = 1;\n")).toBe(true);
	});
});

describe("isTypeOnlyModule — consumeOptionalSemicolon precision", () => {
	it("P: a non-semicolon character right after an interface's closing brace is NOT silently consumed", () => {
		expect(isTypeOnlyModule("oo.ts", "interface Foo {}x\n")).toBe(false);
	});
});

describe("isTypeOnlyModule — updateTypeOnlyScanDepth: paren-depth tracking", () => {
	it("P: an unbalanced opening parenthesis keeps the scanner inside it — a following statement is not wrongly treated as fresh", () => {
		expect(isTypeOnlyModule("pp.ts", "type X = ((a)\ntype Y = string;\n")).toBe(false);
	});
});

// round-2 fresh-eyes: canEndTypeOnlyStatementAtNewline's `nextLineEnd === -1`
// EOF branch. Round 1 fuzz-tested this branch to no divergence and filed
// four mutants as equivalent_candidate; a hand-crafted fixture (no trailing
// newline after the file's final line, whose trimmed content is a single
// leading-continuation-punctuation char) reaches a real divergence all four
// mutants share, because `code.slice(nextLineStart, -1)` (the "false"/"+1"
// fallback path) and `code` (the dropped-slice-start path) both differ from
// `code.slice(nextLineStart)` exactly when the EOF branch is genuinely live.
describe("isTypeOnlyModule — canEndTypeOnlyStatementAtNewline: true end-of-file branch (no trailing newline)", () => {
	// test-contract: boundary — file's last line (no trailing \n) is exactly
	// ")" after trim; a `type` statement's final newline must NOT be treated
	// as its own terminator here, so the ")" is scanned as part of the
	// statement and the whole module still reads as type-only.
	it("P: a bare continuation-punctuation last line (no trailing newline) is still absorbed into the type statement", () => {
		expect(isTypeOnlyModule("eof1.ts", "type X = Foo\n)")).toBe(true);
	});

	// test-contract: boundary — same shape, but the last line has leading
	// whitespace before the continuation punctuation. Any implementation that
	// forgets to slice from `nextLineStart` (uses the whole `code` instead)
	// or forgets `.trim()` reads a different first character here than the
	// real next-line text and disagrees with the P case above.
	it("P: leading whitespace before the last-line continuation punctuation does not change the verdict", () => {
		expect(isTypeOnlyModule("eof2.ts", "type X = Foo\n  )")).toBe(true);
	});
});
