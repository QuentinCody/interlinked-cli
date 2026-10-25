import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeCyclomaticComplexity } from "./cyclomatic.js";

// Mutation-driven hardening of cyclomatic.ts. Each case pins an observable
// behavior of one decision point that the sibling cyclomatic.test.ts leaves
// unpinned. Fixtures are synthetic; sources are joined from arrays so the
// leading whitespace of the language under test (Python) stays explicit.
const src = (...rows: string[]): string => rows.join("\n");

describe("computeCyclomaticComplexity — AST dispatch", () => {
	it("treats an AST pass that finds no functions as authoritative (the regex walker is not consulted for it)", () => {
		// A bare call followed by a block is not a method declaration to the real
		// TS parser (no function entries), but the regex walker would read the
		// `foo(a) {` line as a method.
		const entries = computeCyclomaticComplexity(
			src("  foo(a) {", "    if (a) { }", "  }"),
			"src/bare-call.ts",
		);
		expect(entries).toEqual([]);
	});
});

describe("computeCyclomaticComplexity — regex-walker fallback for JS/TS (exact entry shape)", () => {
	let fallbackComplexity: typeof computeCyclomaticComplexity;

	beforeAll(async () => {
		vi.resetModules();
		vi.doMock("./cyclomatic-ast.js", () => ({
			computeCyclomaticAst: () => null,
			astComplexityAvailable: () => false,
			__resetTsCacheForTesting: () => {},
		}));
		const mod = await import("./cyclomatic.js");
		fallbackComplexity = mod.computeCyclomaticComplexity;
	});

	afterAll(() => {
		vi.doUnmock("./cyclomatic-ast.js");
		vi.resetModules();
	});

	it("emits the 1-based start line, 1-based end line, and js_ts language tag for a walked function", () => {
		const entries = fallbackComplexity(
			src("", "function alpha() {", "  return 1;", "}", ""),
			"src/shape.ts",
		);
		expect(entries).toEqual([
			{ name: "alpha", line: 2, endLine: 4, cyclomatic: 1, language: "js_ts" },
		]);
	});

	it("emits no entry (and does not throw) for a function declaration with no opening brace in reach", () => {
		const source = src("function dangling(a)", ";", "run(a);");
		expect(() => fallbackComplexity(source, "src/nobrace.ts")).not.toThrow();
		expect(fallbackComplexity(source, "src/nobrace.ts")).toEqual([]);
	});

	it("does not count `if`/`for`-suffixed identifiers followed by a paren as decision keywords", () => {
		const entries = fallbackComplexity(
			src(
				"function beta(x) {",
				"  const a = notif (x);",
				"  const b = xfor (x);",
				"  return a + b;",
				"}",
			),
			"src/boundary.ts",
		);
		expect(entries[0]?.cyclomatic).toBe(1);
	});

	it("does not count a `case` suffix of an identifier (e.g. `showcase (1)`) as a case label", () => {
		const entries = fallbackComplexity(
			src("function gamma() {", "  return showcase (1);", "}"),
			"src/boundary-case.ts",
		);
		expect(entries[0]?.cyclomatic).toBe(1);
	});
});

describe("computeCyclomaticComplexity — Python walker", () => {
	it("includes trailing blank lines before the next dedented statement in the function span", () => {
		const entries = computeCyclomaticComplexity(
			src("def a():", "    return 1", "", "", "def b():", "    return 2"),
			"src/m.py",
		);
		expect(entries.find((e) => e.name === "a")).toMatchObject({
			line: 1,
			endLine: 4,
		});
	});

	it("does not treat identifiers that merely start with a keyword (`format`, `iffy`, `whilex`, `exceptional`) as decisions", () => {
		const entries = computeCyclomaticComplexity(
			src(
				"def f():",
				"    format = 1",
				"    iffy = 2",
				"    whilex = 3",
				"    exceptional = 4",
				"    return format",
			),
			"src/m.py",
		);
		expect(entries[0]?.cyclomatic).toBe(1);
	});

	it("does not treat a comprehension filter containing the word `elsewhere` as a ternary", () => {
		const entries = computeCyclomaticComplexity(
			src(
				"def f(items):",
				"    y = [i for i in items if elsewhere(i)]",
				"    return y",
			),
			"src/m.py",
		);
		expect(entries[0]?.cyclomatic).toBe(1);
	});

	it("does not treat an `if` that is only a substring of an identifier as the ternary `if`", () => {
		const entries = computeCyclomaticComplexity(
			src("def f():", "    value = diff else 0", "    return value"),
			"src/m.py",
		);
		expect(entries[0]?.cyclomatic).toBe(1);
	});
});

describe("computeCyclomaticComplexity — Go walker", () => {
	it("counts a `for` loop as a decision point", () => {
		const entries = computeCyclomaticComplexity(
			src("func f() {", "\tfor i := 0; i < 3; i++ {", "\t}", "}"),
			"src/m.go",
		);
		expect(entries[0]?.cyclomatic).toBe(2);
	});

	it("does not count identifiers that end in `if` (e.g. `notif (a)`) as `if` decisions", () => {
		const entries = computeCyclomaticComplexity(
			src("func f(a int) {", "\tx := notif (a)", "\t_ = x", "}"),
			"src/m.go",
		);
		expect(entries[0]?.cyclomatic).toBe(1);
	});

	it("counts decisions on the header line when the body continues on later lines", () => {
		const entries = computeCyclomaticComplexity(
			src("func f(x int) { if x > 0 {", "\treturn", "\t}", "}"),
			"src/m.go",
		);
		expect(entries[0]?.cyclomatic).toBe(2);
	});

	it("stops a function's span and count at its closing brace, not at end of file", () => {
		const entries = computeCyclomaticComplexity(
			src(
				"func a() {",
				"\treturn",
				"}",
				"func b(x int) {",
				"\tif x > 0 {",
				"\t}",
				"}",
			),
			"src/m.go",
		);
		expect(entries.find((e) => e.name === "a")).toMatchObject({
			endLine: 3,
			cyclomatic: 1,
		});
		expect(entries.find((e) => e.name === "b")).toMatchObject({
			line: 4,
			endLine: 7,
			cyclomatic: 2,
		});
	});

	it("finds an opening brace on the 10th line from the declaration (offsets 0..9 are in reach)", () => {
		const filler = Array.from({ length: 8 }, () => "\ta int,");
		const entries = computeCyclomaticComplexity(
			src("func f(", ...filler, ") {", "}"),
			"src/m.go",
		);
		expect(entries.map((e) => e.name)).toEqual(["f"]);
	});

	it("does not look for an opening brace beyond 10 lines from the declaration", () => {
		const filler = Array.from({ length: 9 }, () => "\ta int,");
		const entries = computeCyclomaticComplexity(
			src("func g(", ...filler, ") {", "}"),
			"src/m.go",
		);
		expect(entries).toEqual([]);
	});
});

describe("computeCyclomaticComplexity — Rust walker", () => {
	it("counts a `while` loop as a decision point", () => {
		const entries = computeCyclomaticComplexity(
			src("fn f() {", "    while running {", "    }", "}"),
			"src/m.rs",
		);
		expect(entries[0]?.cyclomatic).toBe(2);
	});

	it("counts a `for` loop as a decision point", () => {
		const entries = computeCyclomaticComplexity(
			src("fn f() {", "    for i in v {", "    }", "}"),
			"src/m.rs",
		);
		expect(entries[0]?.cyclomatic).toBe(2);
	});

	it("does not count identifiers that merely start with a keyword (`format`, `iffy`, `whilex`)", () => {
		const entries = computeCyclomaticComplexity(
			src(
				"fn f() {",
				"    let format = 1;",
				"    let iffy = 2;",
				"    let whilex = 3;",
				"}",
			),
			"src/m.rs",
		);
		expect(entries[0]?.cyclomatic).toBe(1);
	});

	it("does not count `?` followed by a lowercase letter as the try operator", () => {
		const entries = computeCyclomaticComplexity(
			src("fn f() {", "    check::<T: ?sized>();", "}"),
			"src/m.rs",
		);
		expect(entries[0]?.cyclomatic).toBe(1);
	});
});
