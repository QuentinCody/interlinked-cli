import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	extractTemplateInterpolationExpressions,
	stripAllLiterals,
	stripComments,
	stripRegexLiterals,
	stripStringLiterals,
	stripTemplateLiterals,
} from "../strip-helpers.js";

describe("stripComments", () => {
	it("strips line comments to spaces", () => {
		const out = stripComments("const x = 1; // comment");
		expect(out).toBe("const x = 1;           ");
	});

	it("strips block comments to spaces, preserving newlines", () => {
		const out = stripComments("a /* b\nc */ d");
		expect(out).toBe("a     \n     d");
	});

	it("preserves string content with comment-like sequences", () => {
		const out = stripComments('const x = "/* not a comment */";');
		expect(out).toBe('const x = "/* not a comment */";');
	});

	it("preserves template literal content with comment-like sequences", () => {
		const out = stripComments("const x = `/* also not a comment */`;");
		expect(out).toBe("const x = `/* also not a comment */`;");
	});
});

describe("stripRegexLiterals", () => {
	it("replaces regex body with spaces when preceded by an operator", () => {
		const out = stripRegexLiterals("const r = /foo/g;");
		expect(out).toBe("const r =       ;");
	});

	it("handles character classes that contain slashes", () => {
		const out = stripRegexLiterals("const r = /[\\w./]/g;");
		// The whole regex literal gets replaced with spaces of equal length.
		expect(out).toContain("const r = ");
		expect(out).not.toContain("/[");
	});

	it("does not strip division expressions", () => {
		// `a / b / c` should not be interpreted as a regex.
		const out = stripRegexLiterals("const r = a / b;");
		expect(out).toBe("const r = a / b;");
	});
});

describe("stripStringLiterals", () => {
	it("blanks interior of double-quoted strings", () => {
		expect(stripStringLiterals('const x = "hello";')).toBe('const x = "     ";');
	});

	it("blanks interior of single-quoted strings", () => {
		expect(stripStringLiterals("const x = 'hi';")).toBe("const x = '  ';");
	});

	it("handles escaped quotes", () => {
		// Inner content `a\"b` is 4 chars (a, backslash, quote, b) — replaced with 4 spaces.
		expect(stripStringLiterals('const x = "a\\"b";')).toBe('const x = "    ";');
	});
});

describe("stripTemplateLiterals", () => {
	// Backtick and `${` characters are built from char codes so this test
	// source doesn't contain bare template literals (biome flags
	// `\`hello\`` with no interpolation as noUnusedTemplateLiteral) and
	// doesn't contain `${` inside a regular string (flagged as
	// noTemplateCurlyInString). The functions under test operate on raw
	// string input either way.
	const BT = String.fromCharCode(96);
	const DOLLAR = String.fromCharCode(36);

	it("blanks template body but preserves backticks", () => {
		const input = `const x = ${BT}hello${BT};`;
		const out = stripTemplateLiterals(input);
		expect(out).toBe(`const x = ${BT}     ${BT};`);
	});

	it("strips interpolated expressions to opaque spaces", () => {
		// Body `a${b + 1}c` is 10 chars: a, $, {, b, space, +, space, 1, }, c.
		const input = `const x = ${BT}a${DOLLAR}{b + 1}c${BT};`;
		const out = stripTemplateLiterals(input);
		expect(out).toBe(`const x = ${BT}          ${BT};`);
	});

	it("P2 n44: a backtick or brace inside a string in an interpolation does not open a template or end the interpolation", () => {
		const line2 = "expect(1).toBe(2);";
		for (const inner of [`x.join("${BT}")`, `x.join('${BT}')`, `cond ? "}" : ""`, `"a\\"${BT}"`]) {
			const input = `const s = ${BT}a ${DOLLAR}{ ${inner} } b${BT};\n${line2}`;
			const out = stripTemplateLiterals(input);
			expect(out.split("\n")[1], inner).toBe(line2);
			expect(out).toHaveLength(input.length);
		}
	});
});

describe("extractTemplateInterpolationExpressions", () => {
	const BT = String.fromCharCode(96);
	const DOLLAR = String.fromCharCode(36);

	it("returns executable interpolation bodies, not template text", () => {
		const input = `const x = ${BT}avoid as any in prose ${DOLLAR}{raw as any}${BT};`;
		expect(extractTemplateInterpolationExpressions(input)).toEqual(["raw as any"]);
	});

	it("ignores backticks inside comments and quoted strings", () => {
		const input = [
			`// ${BT}${DOLLAR}{commented as any}${BT}`,
			`const text = "${BT}${DOLLAR}{quoted as any}${BT}";`,
			`const real = ${BT}${DOLLAR}{value as unknown}${BT};`,
		].join("\n");
		expect(extractTemplateInterpolationExpressions(input)).toEqual(["value as unknown"]);
	});
});

describe("stripAllLiterals — order regression", () => {
	// The regression this guards against: in a file with a lot of
	// quote-heavy lines, `stripAllLiterals` used to run
	// `stripTemplateLiterals → stripRegexLiterals → stripComments` and the
	// intermediate chain left `stripComments` in a stuck `inString` state
	// partway through large real files (`src/harness/generic-checks.ts`),
	// silently preserving every `//` and `/* */` comment from that point
	// forward. Downstream checks (empty_catch, magic_literal, etc.) then
	// flagged code-like strings that appeared in surviving comments.
	it("strips line and block comments to spaces in a realistic mix", () => {
		const src = [
			'const a = "foo = /bar/"; // regex-shaped inside string',
			'/** JSDoc: catch {} or typeof x === "string" */',
			"const patterns = [",
			'\t"a.b",',
			'\t"c.d",',
			"];",
			'const r = /".."/g; // regex literal with quotes inside',
			"// Line comment with catch (e) { } pattern",
			"function fn() {",
			"\ttry {} catch (e) { fallback() }",
			"}",
		].join("\n");

		const out = stripAllLiterals(src);
		const lines = out.split("\n");

		// The JSDoc line (L2) must be fully stripped.
		expect(nonNull(lines[1]).trim()).toBe("");

		// The line comment (L8) must be fully stripped.
		expect(nonNull(lines[7]).trim()).toBe("");

		// Real code (L10) must be preserved aside from the string bodies.
		expect(lines[9]).toContain("try");
		expect(lines[9]).toContain("catch");
		expect(lines[9]).toContain("fallback");
	});

	it("strips all comments even deep into a quote-heavy file", () => {
		// Simulate a file that opens many balanced strings followed by a
		// comment. The old chain got stuck on the real cli source; this
		// mini-repro keeps the fix's intent visible even without the full
		// 7500-line input.
		const src = `
const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const base = "index";
const suffix = ".js";
// This comment must be stripped even after many strings above.
const x = 1;
`.trim();

		const out = stripAllLiterals(src);
		const commentLine = out.split("\n").find((l) => l.startsWith("// This"));
		expect(commentLine).toBeUndefined();
	});
});

describe("stripTemplateLiterals nested templates", () => {
	it("keeps the outer template open across a nested template inside ${...}", () => {
		const src = "const a = `x ${`y`} z`; expect(a).toBe(1);";
		const out = stripTemplateLiterals(src);
		expect(out).toHaveLength(src.length);
		expect(out).toContain("expect(a).toBe(1);");
		expect(out.split("`")).toHaveLength(3);
	});

	it("closes the outer template after a nested template that holds a brace", () => {
		const src = "const a = `${`}`}`;\nexpect(b).toBe(2);";
		const out = stripTemplateLiterals(src);
		expect(out.split("\n")[1]).toBe("expect(b).toBe(2);");
	});
});

describe("stripTemplateLiterals regex literals", () => {
	it("does not open a template at a backtick inside a regex literal", () => {
		const src = "const r = /\\`/;\nexpect(r).toBeTruthy();";
		expect(stripTemplateLiterals(src)).toBe(src);
	});

	it("still treats a slash after an identifier as division", () => {
		const src = "const q = a / b; const t = `x`;";
		expect(stripTemplateLiterals(src)).toBe("const q = a / b; const t = ` `;");
	});
});
