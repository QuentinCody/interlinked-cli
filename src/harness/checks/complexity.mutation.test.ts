import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkFunctionComplexity } from "./complexity.js";

// Mutation-hardening tests for checkFunctionComplexity. Each test pins one
// behavior the sibling complexity.test.ts leaves unobserved. Spec basis:
//   - complexity.ts header (L17-25): 6+ params, nesting 5+, 15+ branches
//     (if/else if/case/ternary), TS/JS/Python/Go/Rust.
//   - complexity.ts L85 doc: the opening brace is searched in a 10-line window.
//   - complexity.ts L153-155 doc: one finding per function (nesting first, then
//     branches); the parameter check short-circuits the body check (L198).
//   - complexity.test.ts L961: Python signatures join up to a +10 line window.

/** `depth` nested `if` blocks, indented, followed by the closing braces. */
function nestedIfBody(depth: number): string {
	let body = "";
	for (let d = 0; d < depth; d++) body += `${"\t".repeat(d + 1)}if (x > ${d}) {\n`;
	body += `${"\t".repeat(depth + 1)}return x;\n`;
	for (let d = depth - 1; d >= 0; d--) body += `${"\t".repeat(d + 1)}}\n`;
	return body;
}

describe("checkFunctionComplexity — opening-brace search window (10 lines)", () => {
	/** `function wide(a)` then `gap` blank lines, then the `{` and a depth-5 body. */
	function braceAfterGap(gap: number): string {
		return `function wide(a)\n${"\n".repeat(gap)}{\n${nestedIfBody(5)}}\n`;
	}

	it("finds an opening brace on the last line of the 10-line window (offset 9)", () => {
		const out = checkFunctionComplexity(braceAfterGap(8), "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[nesting depth 5]");
	});

	it("finds an opening brace one line earlier in the window (offset 8)", () => {
		const out = checkFunctionComplexity(braceAfterGap(7), "src/a.ts");
		expect(out).toHaveLength(1);
	});

	it("does not analyze a function whose opening brace is 10 lines below the head (outside the window)", () => {
		expect(checkFunctionComplexity(braceAfterGap(9), "src/a.ts")).toEqual([]);
	});
});

describe("checkFunctionComplexity — brace languages ignore braces inside string literals", () => {
	it("does not report nesting for a Go function whose string literal contains many braces", () => {
		const src = 'func tricky(a int) int {\n\ts := "{{{{{{{{"\n\treturn a\n}\n';
		expect(checkFunctionComplexity(src, "src/main.go")).toEqual([]);
	});

	it("does not report nesting for a Rust function whose string literal contains many braces", () => {
		const src = 'fn tricky(a: i32) -> i32 {\n\tlet s = "{{{{{{{{";\n\ta\n}\n';
		expect(checkFunctionComplexity(src, "src/lib.rs")).toEqual([]);
	});
});

describe("checkFunctionComplexity — ternary counting only counts real ternaries", () => {
	function bodyOf(line: (k: number) => string): string {
		let body = "";
		for (let k = 0; k < 15; k++) body += `\t${line(k)}\n`;
		return `function many(a, b) {\n${body}\treturn 0;\n}\n`;
	}

	it("does not count the nullish-coalescing operator `??` as a ternary", () => {
		const src = bodyOf((k) => `const v${k} = a ?? b;`);
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([]);
	});

	it("does not count an optional-marker `?:` as a ternary", () => {
		const src = bodyOf(() => "call(x?: y);");
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([]);
	});

	it("still counts real ternaries toward the 15-branch threshold", () => {
		const src = bodyOf((k) => `const v${k} = a ? b : ${k};`);
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("15 branches");
	});
});

describe("checkFunctionComplexity — one finding per function", () => {
	it("reports only the parameter finding for a function that also nests 5 deep", () => {
		const src = `function both(a, b, c, d, e, f) {\n${nestedIfBody(5)}}\n`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("parameters");
		expect(nonNull(out[0]).text).not.toContain("nesting");
	});
});

describe("checkFunctionComplexity — Python signature join window", () => {
	it("joins a signature whose closing paren is 10 lines below the def", () => {
		const params = Array.from({ length: 9 }, (_, k) => `    p${k},`).join("\n");
		const src = `def wide(\n${params}\n):\n    return 0\n`;
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
		expect(nonNull(out[0]).text).toContain("[9 parameters]");
	});
});
