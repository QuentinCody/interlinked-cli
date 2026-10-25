import { describe, expect, it } from "vitest";
import { blankJsxText, blankRegexLiterals, NAN_COMPARISON } from "./nan-comparison-scan.js";

describe("NAN_COMPARISON — positive (must fire)", () => {
	it("P1: matches a global NaN on the right of the operator", () => {
		expect(NAN_COMPARISON.test("if (x === NaN) {}")).toBe(true);
		expect(NAN_COMPARISON.test("if (x !=NaN) {}")).toBe(true);
	});

	it("P2: matches a bare global NaN on the left of the operator", () => {
		expect(NAN_COMPARISON.test("if (NaN == x) {}")).toBe(true);
		expect(NAN_COMPARISON.test("NaN=== x")).toBe(true);
	});

	it("P3: matches Number.NaN on the left — it IS the global", () => {
		expect(NAN_COMPARISON.test("return Number.NaN === x;")).toBe(true);
		expect(NAN_COMPARISON.test("return Number . NaN !== x;")).toBe(true);
	});
});

describe("NAN_COMPARISON — negative (must not fire)", () => {
	it("N1: a member named NaN on a user object is not the global", () => {
		expect(NAN_COMPARISON.test("return TokenKind.NaN === kind;")).toBe(false);
		expect(NAN_COMPARISON.test("return stats?.NaN !== undefined;")).toBe(false);
	});

	it("N2: an identifier that merely starts with or contains NaN", () => {
		expect(NAN_COMPARISON.test("NaNCount === 2")).toBe(false);
		expect(NAN_COMPARISON.test("v === NaN_SENTINEL")).toBe(false);
		expect(NAN_COMPARISON.test("$NaN === x")).toBe(false);
	});
});

describe("blankRegexLiterals — positive (must blank)", () => {
	it("P1: blanks a regex literal after `=` to same-length spaces", () => {
		const line = "const NAN_COMPARE = /\\w+\\s*!== NaN/;";
		const out = blankRegexLiterals(line);
		expect(out).toHaveLength(line.length);
		expect(out).toBe(`const NAN_COMPARE = ${" ".repeat("/\\w+\\s*!== NaN/".length)};`);
	});

	it("P2: blanks a regex literal in argument, return and arrow-body positions", () => {
		expect(blankRegexLiterals("re.test(/=== NaN/)")).toBe(`re.test(${" ".repeat("/=== NaN/".length)})`);
		expect(blankRegexLiterals("return /NaN ==/i;")).toBe(`return ${" ".repeat("/NaN ==/i".length)};`);
		expect(blankRegexLiterals("(s) => /== NaN/.test(s)")).toBe(`(s) => ${" ".repeat("/== NaN/".length)}.test(s)`);
	});
});

describe("blankRegexLiterals — positive (keyword starts)", () => {
	it("P1: blanks a regex literal after `case` / `yield`, including the `v` flag", () => {
		expect(blankRegexLiterals("case /=== NaN/.test(s):")).toBe(`case ${" ".repeat(9)}.test(s):`);
		expect(blankRegexLiterals("yield /=== NaN/v;")).toBe(`yield ${" ".repeat(10)};`);
	});
});

describe("blankRegexLiterals — negative (keyword-named members)", () => {
	it("N1: keeps division after a member named `case`", () => {
		const line = "const r = o.case / n === NaN / 2;";
		expect(blankRegexLiterals(line)).toBe(line);
	});
});

describe("blankRegexLiterals — negative (must keep)", () => {
	it("N1: keeps division — a `/` after an identifier is not a regex start", () => {
		const line = "const r = total / count === NaN / 2;";
		expect(blankRegexLiterals(line)).toBe(line);
	});

	it("N2: keeps a line with no slashes", () => {
		expect(blankRegexLiterals("if (x === NaN) {}")).toBe("if (x === NaN) {}");
	});
});

describe("blankJsxText — positive (must blank)", () => {
	it("P1: blanks the prose between tags in a .tsx file, keeping newlines and length", () => {
		const content = [
			"export function Doc() {",
			"\treturn <p>In JS, <code>NaN === NaN</code> is false.</p>;",
			"}",
		].join("\n");
		const out = blankJsxText(content, "src/Doc.tsx");
		expect(out).toHaveLength(content.length);
		expect(out.split("\n")).toHaveLength(3);
		expect(out).not.toContain("NaN === NaN");
		expect(out).toContain("<code>");
		expect(out).toContain("</code>");
	});

	it("P2: keeps a JSX expression container — `{x === NaN}` is code, not prose", () => {
		const content = "export const D = () => <p>{x === NaN}</p>;";
		expect(blankJsxText(content, "src/D.tsx")).toContain("{x === NaN}");
	});
});

describe("blankJsxText — negative (must not change)", () => {
	it("N1: returns a .ts file unchanged", () => {
		const content = "const a = 1 > 0 ? 2 : 3; // <p>NaN === NaN</p>";
		expect(blankJsxText(content, "src/a.ts")).toBe(content);
	});

	it("N2: returns content that does not parse unchanged", () => {
		const content = "export function X( { return <p>NaN === NaN</p>";
		expect(blankJsxText(content, "src/X.tsx")).toBe(content);
	});
});
