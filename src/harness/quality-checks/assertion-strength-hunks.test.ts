import { describe, expect, it } from "vitest";
import { addedLinesText, classifyJsTsAssertionCalls, countAddedJsTsAssertions } from "./assertion-strength-hunks.js";

describe("classifyJsTsAssertionCalls — weak forms (harness-debt row 25)", () => {
	// test-contract: behavior — each newly-recognized weak shape counts once
	it("recognizes an undefined result as an exact observable", () => {
		expect(classifyJsTsAssertionCalls("expect(x).toBeUndefined();")).toEqual({ weak: 0, exact: 1 });
	});

	it("P2: toBeFalsy() counts weak", () => {
		expect(classifyJsTsAssertionCalls("expect(x).toBeFalsy();")).toEqual({ weak: 1, exact: 0 });
	});

	it("leaves a no-throw contract outside matcher-strength advice", () => {
		expect(classifyJsTsAssertionCalls("expect(fn).not.toThrow();")).toEqual({ weak: 0, exact: 0 });
	});

	it("P4: toBeTypeOf( counts weak", () => {
		expect(classifyJsTsAssertionCalls('expect(x).toBeTypeOf("function");')).toEqual({
			weak: 1,
			exact: 0,
		});
	});

	it("P5: a typeof-subject makes an otherwise-exact matcher weak", () => {
		expect(classifyJsTsAssertionCalls('expect(typeof f).toBe("function");')).toEqual({
			weak: 1,
			exact: 0,
		});
	});

	it("P6: toBe(<same identifier as subject>) self-compare counts weak, not exact", () => {
		expect(classifyJsTsAssertionCalls("expect(x).toBe(x);")).toEqual({ weak: 1, exact: 0 });
	});

	it("distinguishes broad call presence from an exact call count", () => {
		expect(
			classifyJsTsAssertionCalls("expect(fn).toHaveBeenCalled();\nexpect(fn).toHaveBeenCalledTimes(2);"),
		).toEqual({ weak: 1, exact: 1 });
	});

	it("P8: expect.anything()/expect.any( as an argument makes the call weak", () => {
		expect(classifyJsTsAssertionCalls("expect(x).toBe(expect.anything());")).toEqual({
			weak: 1,
			exact: 0,
		});
		expect(classifyJsTsAssertionCalls("expect(x).toEqual(expect.any(Number));")).toEqual({
			weak: 1,
			exact: 0,
		});
	});

	// A matching argument assertion in the same scope already pins the call.
	it("does not flag redundant presence alongside the same spy's argument assertion", () => {
		expect(
			classifyJsTsAssertionCalls(
				"expect(fn).toHaveBeenCalled();\nexpect(fn).toHaveBeenCalledWith(1, 2);",
			),
		).toEqual({ weak: 0, exact: 0 });
	});

	it("keeps unrelated spies and separate test scopes independent", () => {
		expect(classifyJsTsAssertionCalls(`
			it("first", () => { expect(fn).toHaveBeenCalled(); });
			it("second", () => { expect(fn).toHaveBeenCalledWith(1); });
			expect(other).toHaveBeenCalled();
			expect(fn).toHaveBeenCalledWith(1);
		`)).toEqual({ weak: 2, exact: 0 });
	});

	it("does not mistake a non-assertion matcher method for a spy assertion", () => {
		expect(classifyJsTsAssertionCalls("recorder.toHaveBeenCalled();")).toEqual({ weak: 0, exact: 0 });
	});

	it("distinguishes absent calls and negated equality from positive exact equality", () => {
		expect(classifyJsTsAssertionCalls("expect(fn).not.toHaveBeenCalled(); expect(x).not.toBe(1);")).toEqual({ weak: 1, exact: 1 });
	});

	it("does not treat an asymmetric argument matcher as an exact call-shape check", () => {
		expect(classifyJsTsAssertionCalls("expect(fn).toHaveBeenCalled(); expect(fn).toHaveBeenCalledWith(expect.anything());")).toEqual({ weak: 1, exact: 0 });
	});

	it("distinguishes exact null from excluding only undefined", () => {
		expect(classifyJsTsAssertionCalls("expect(x).toBeNull(); expect(y).not.toBeUndefined();")).toEqual({ weak: 1, exact: 1 });
	});

	it("preserves string values instead of collapsing different strings into a self-compare", () => {
		expect(classifyJsTsAssertionCalls('expect("red").toBe("blue");')).toEqual({ weak: 0, exact: 1 });
	});

	it("parses nested and asynchronous matcher chains", () => {
		expect(classifyJsTsAssertionCalls("expect(load(makeKey(getId()))).resolves.toEqual({ id: 1 });")).toEqual({ weak: 0, exact: 1 });
	});

	// test-contract: boundary — the ORIGINAL exact family is not reclassified
	// when the argument is a literal (no typeof/self-compare/expect.any shape)
	it("N2: toBe/toEqual/toStrictEqual with a literal argument stay exact", () => {
		expect(
			classifyJsTsAssertionCalls(
				'expect(x).toBe(1);\nexpect(y).toEqual({ a: 1 });\nexpect(z).toStrictEqual([1]);',
			),
		).toEqual({ weak: 0, exact: 3 });
	});

	// test-contract: boundary — toThrow WITH an argument still pins something,
	// so it must not be swept into the no-arg weak form
	it("N3: not.toThrow(SomeError) with an argument is not counted weak", () => {
		expect(classifyJsTsAssertionCalls("expect(fn).not.toThrow(TypeError);")).toEqual({
			weak: 0,
			exact: 0,
		});
	});

	// test-contract: boundary — a self-compare check requires an EXACT
	// identifier match; a different identifier is ordinary exact toBe
	it("N4: toBe(<different identifier>) is not a self-compare — stays exact", () => {
		expect(classifyJsTsAssertionCalls("expect(x).toBe(y);")).toEqual({ weak: 0, exact: 1 });
	});
});

describe("countAddedJsTsAssertions", () => {
	const count = (pre: string, post: string) => countAddedJsTsAssertions(pre, post, "case.test.ts");

	it("counts a multiline matcher replacement as an introduced assertion", () => {
		const pre = "expect(\n    result\n).toEqual(\n    [1]\n);";
		const post = "expect(\n    result\n).toContain(\n    1\n);";
		expect(count(pre, post)).toEqual({ weak: 1, exact: 0 });
	});

	it("ignores added matcher text inside an existing block comment or template", () => {
		expect(count("/*\nexample\n*/", "/*\nexample\nexpect(x).toBeTruthy();\n*/")).toEqual({ weak: 0, exact: 0 });
		expect(count("const text = `example`;", "const text = `example\nexpect(x).toBeTruthy();`;")).toEqual({ weak: 0, exact: 0 });
	});

	it("recognizes a live assertion when comment markers are removed", () => {
		expect(count("/*\nexpect(x).toBeTruthy();\n*/", "expect(x).toBeTruthy();")).toEqual({ weak: 1, exact: 0 });
	});

	it("ignores formatting, comments and moves while retaining duplicate occurrences", () => {
		const pre = "expect(x).toContain(1);\nexpect(y).toBe(2);";
		const moved = "expect(y).toBe(2);\nexpect(\n x /* moved */\n).toContain(1);";
		expect(count(pre, moved)).toEqual({ weak: 0, exact: 0 });
		expect(count(pre, `${moved}\nexpect(x).toContain(1);`)).toEqual({ weak: 1, exact: 0 });
	});

	it("does not offset a new assertion with an unchanged exact call on the same line", () => {
		expect(count("expect(x).toBe(1);", "expect(x).toBe(1); expect(y).toBeTruthy();")).toEqual({ weak: 1, exact: 0 });
	});

	it("uses unchanged argument checks for the same spy in the complete post-edit scope", () => {
		const pre = "expect(fn).toHaveBeenCalledWith(1);";
		expect(count(pre, `${pre}\nexpect(fn).toHaveBeenCalled();`)).toEqual({ weak: 0, exact: 0 });
	});

	it("does not claim an introduction verdict from recovered syntax", () => {
		expect(count("expect(", "expect(x).toBeTruthy();")).toEqual({ weak: 0, exact: 0 });
		expect(count("", "expect(x).toBeTruthy(); function {")).toEqual({ weak: 0, exact: 0 });
	});
});

describe("addedLinesText — pre/post multiset line diff (harness-debt row 25)", () => {
	// test-contract: behavior — a line present only in post is added
	it("P1: a brand-new line is reported as added", () => {
		expect(addedLinesText("const a = 1;", "const a = 1;\nconst b = 2;")).toBe("const b = 2;");
	});

	// test-contract: boundary — a pure move (removed here, added there,
	// same normalized text) cancels out and contributes nothing
	it("N1: a pure move of an identical line yields no added lines", () => {
		const pre = "const a = 1;\nconst b = 2;\nconst c = 3;";
		const post = "const b = 2;\nconst a = 1;\nconst c = 3;";
		expect(addedLinesText(pre, post)).toBe("");
	});

	// test-contract: boundary — a deleted line (present in pre, absent in
	// post) contributes nothing to "added" — only insertions count
	it("N2: a deleted-only line yields no added lines", () => {
		expect(addedLinesText("const a = 1;\nconst b = 2;", "const a = 1;")).toBe("");
	});

	// test-contract: boundary — leading/trailing whitespace differences are
	// normalized away by the trim, so re-indentation is not "added"
	it("N3: whitespace-only reformatting of an unchanged line is not added", () => {
		expect(addedLinesText("  const a = 1;", "const a = 1;")).toBe("");
	});

	// test-contract: boundary — an identical file (no diff) yields nothing
	it("N4: an unchanged file yields no added lines", () => {
		const content = "const a = 1;\nconst b = 2;";
		expect(addedLinesText(content, content)).toBe("");
	});
});
