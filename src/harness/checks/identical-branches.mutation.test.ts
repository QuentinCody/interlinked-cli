import { describe, expect, it } from "vitest";
import { checkIdenticalBranches } from "./identical-branches.js";

// Mutation-hardening tests for identical-branches.ts. Each test pins behavior
// that is stated in the module header or a doc comment in the module.

describe("checkIdenticalBranches — body normalization (identical-branches.ts:78-87)", () => {
	it("treats arms that differ only in indentation as identical (whitespace runs collapse)", () => {
		const content = "if (x) {\n    go(a,\n        b);\n} else {\n\tgo(a, b);\n}";
		const found = checkIdenticalBranches(content, "src/indent.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toMatch(/identical if\/else branches/);
	});
});

describe("checkIdenticalBranches — snippet trimming (SNIPPET_MAX, identical-branches.ts:57-58)", () => {
	const block = (body: string) => `if (f) {\n  ${body}\n} else {\n  ${body}\n}`;

	it("shows a body of exactly SNIPPET_MAX (70) chars in full, without an ellipsis", () => {
		const body = "a".repeat(70);
		const found = checkIdenticalBranches(block(body), "src/edge70.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text.endsWith(`: ${body}`)).toBe(true);
		expect(found[0]?.text).not.toContain("…");
	});

	it("trims a body longer than SNIPPET_MAX to its first 70 chars plus an ellipsis", () => {
		const body = "a".repeat(70) + "b";
		const found = checkIdenticalBranches(block(body), "src/edge71.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text.endsWith(`: ${"a".repeat(70)}…`)).toBe(true);
	});
});

describe("checkIdenticalBranches — else detection across layouts (identical-branches.ts:134-138)", () => {
	it("fires when `else` starts on the line after the closing brace (Allman/Stroustrup layout)", () => {
		const content = "if (x) {\n  go();\n}\nelse {\n  go();\n}";
		expect(checkIdenticalBranches(content, "src/stroustrup.ts")).toHaveLength(1);
	});

	it("fires when the else-block `{` sits on its own line after `else`", () => {
		const content = "if (x) {\n  go();\n} else\n{\n  go();\n}";
		const found = checkIdenticalBranches(content, "src/else-newline.ts");
		expect(found).toHaveLength(1);
		// Reported line is the then-arm's closing brace (line 3), not the else `{` (line 4).
		expect(found[0]?.line).toBe(3);
	});

	it("fires on identical arms whose bodies contain nested braces", () => {
		const content = "if (a) { if (b) { y(); } } else { if (b) { y(); } }";
		expect(checkIdenticalBranches(content, "src/nested-same.ts")).toHaveLength(1);
	});
});

describe("checkIdenticalBranches — unbalanced braces are skipped, never guessed", () => {
	it("does not fire when the else block never closes, even if a truncated body would match", () => {
		// Without a closing brace the else body is unknown; comparing a prefix would be a guess.
		const content = "if (x) { a } else { ab";
		expect(checkIdenticalBranches(content, "src/open-else.ts")).toEqual([]);
	});

	it("does not fire when the then-arm has no matching opening brace", () => {
		const content = "a } else { a }";
		expect(checkIdenticalBranches(content, "src/no-then-open.ts")).toEqual([]);
	});
});

describe("checkIdenticalBranches — ternary operator discrimination (identical-branches.ts:170-179)", () => {
	it("fires on a ternary whose branches use optional chaining (`?.` is not a ternary `?`)", () => {
		expect(checkIdenticalBranches("const v = c ? a?.b : a?.b;", "src/chain.ts")).toHaveLength(1);
	});

	it("fires on a ternary whose branches use nullish coalescing (`??` is not a ternary `?`)", () => {
		expect(checkIdenticalBranches("const v = c ? a ?? b : a ?? b;", "src/nullish.ts")).toHaveLength(1);
	});
});

describe("checkIdenticalBranches — brackets inside ternary branches (identical-branches.ts:181-228)", () => {
	it("fires on identical array-literal branches (commas and colons inside brackets do not end a branch)", () => {
		expect(checkIdenticalBranches("const v = c ? [1, 2] : [1, 2];", "src/arr.ts")).toHaveLength(1);
	});

	it("fires on identical index-expression branches", () => {
		expect(checkIdenticalBranches("const v = c ? arr[0] : arr[0];", "src/idx.ts")).toHaveLength(1);
	});

	it("fires on identical object-literal branches (the colon inside braces is not the ternary colon)", () => {
		const content = "const v = c ? { a: 1, b: 2 } : { a: 1, b: 2 };";
		expect(checkIdenticalBranches(content, "src/obj.ts")).toHaveLength(1);
	});

	it("fires when the branches are call expressions containing an object literal", () => {
		const content = "const v = c ? f({ a: 1 }) : f({ a: 1 });";
		expect(checkIdenticalBranches(content, "src/call-obj.ts")).toHaveLength(1);
	});

	it("ends the false branch at a comma, so a following call argument is not part of it", () => {
		expect(checkIdenticalBranches("call(c ? a : a, other);", "src/comma.ts")).toHaveLength(1);
	});

	it("ends the false branch at a semicolon, so the next statement is not part of it", () => {
		expect(checkIdenticalBranches("const v = c ? a : a;\nconst w = 1;", "src/semi.ts")).toHaveLength(1);
	});
});

describe("checkIdenticalBranches — ternary scan bail-outs (identical-branches.ts:191-193)", () => {
	it("bails on a statement terminator before any colon but still scans later ternaries", () => {
		// `int? count = null;` has a stray `?` whose statement ends before any ternary colon;
		// the label colon further down must not be adopted, which would also skip the
		// identical ternary in between.
		const content = "int? count = null;\nvar y = (flag ? a : a);\nretry: count = 1;";
		const found = checkIdenticalBranches(content, "src/Nullable.cs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});
});

describe("checkIdenticalBranches — empty ternary arms", () => {
	it("does not report two empty arms as identical results", () => {
		expect(checkIdenticalBranches("const v = c ? : ;", "src/empty-ternary.ts")).toEqual([]);
	});
});

describe("checkIdenticalBranches — interior of a reported ternary (identical-branches.ts:250)", () => {
	it("resumes scanning past the true-branch interior: nested ternaries there are not re-reported", () => {
		const content = "const v = c ? (d ? e : e) : (d ? e : e);";
		const found = checkIdenticalBranches(content, "src/interior.ts");
		// Outer ternary + the inner ternary in the false branch; the one in the
		// true branch is skipped by the resume.
		expect(found).toHaveLength(2);
	});
});

describe("checkIdenticalBranches — Rust lifetime handling is Rust-only (identical-branches.ts:60-66)", () => {
	it("does not rewrite apostrophes in non-Rust files (single-quoted strings keep their braces)", () => {
		const content = "if (x) { f('ab'); } else { f('ab'); }";
		expect(checkIdenticalBranches(content, "src/quotes.ts")).toHaveLength(1);
	});

	it("keeps positions aligned when Rust lifetimes precede an identical if/else", () => {
		const content = [
			"fn pick<'a>(x: &'a str, y: &'a str, c: bool) -> &'a str {",
			"    if c {",
			"        x",
			"    } else {",
			"        x",
			"    }",
			"}",
		].join("\n");
		const found = checkIdenticalBranches(content, "src/pick.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});
});

describe("checkIdenticalBranches — overall cap (identical-branches.ts:255-259)", () => {
	it("returns at most 10 findings when block and ternary findings together exceed the cap", () => {
		const blocks = Array.from({ length: 6 }, (_, i) => `if (x${i}) {\n  same();\n} else {\n  same();\n}`);
		const ternaries = Array.from({ length: 6 }, (_, i) => `const v${i} = cond${i} ? same : same;`);
		const found = checkIdenticalBranches([...blocks, ...ternaries].join("\n"), "src/mixed.ts");
		expect(found).toHaveLength(10);
	});
});
