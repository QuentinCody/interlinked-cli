// Independent adversarial review of the `nan_comparison` pre_block check
// (2026-10-21). Each negative case is realistic code that the detector flagged
// before the refinement in checks/nan-comparison-scan.ts; the positives pin
// that the refinement did not weaken the true-positive shapes.

import { describe, expect, it } from "vitest";
import { checkNanComparison } from "../../checks/agent-safety-js-correctness.js";

describe("nan_comparison — negative (must not fire)", () => {
	it("N1: a user enum member named NaN on the left of the operator", () => {
		const content = [
			"export enum TokenKind { Integer, Float, NaN, Infinity }",
			"export function isNanToken(kind: TokenKind): boolean {",
			"\treturn TokenKind.NaN === kind;",
			"}",
		].join("\n");
		expect(checkNanComparison(content, "src/parser/number-token.ts")).toEqual([]);
	});

	it("N2: an optional-chained property named NaN", () => {
		const content = [
			"interface Buckets { NaN?: number; Infinity?: number }",
			"export function hasNanBucket(stats: Buckets | null): boolean {",
			"\treturn stats?.NaN !== undefined;",
			"}",
		].join("\n");
		expect(checkNanComparison(content, "src/stats/histogram.ts")).toEqual([]);
	});

	it("N3: a lint rule's own regex literal that DETECTS the pattern", () => {
		const content = [
			"const NAN_COMPARE = /\\w+\\s*!== NaN/;",
			"export function hasNanCompare(line: string): boolean {",
			"\treturn NAN_COMPARE.test(line);",
			"}",
		].join("\n");
		expect(checkNanComparison(content, "src/lint/no-nan-compare.ts")).toEqual([]);
	});

	it("N4: JSX prose in a docs component explaining the semantics", () => {
		const content = [
			"export function NanExplainer() {",
			"\treturn (",
			"\t\t<p>",
			"\t\t\tIn JavaScript, <code>NaN === NaN</code> is false. Use <code>Number.isNaN</code>.",
			"\t\t</p>",
			"\t);",
			"}",
		].join("\n");
		expect(checkNanComparison(content, "src/docs/NanExplainer.tsx")).toEqual([]);
	});

	it("N5: a regex literal passed as an argument", () => {
		const content = 'export const bad = (line: string) => /=== NaN\\b/.test(line) || line.includes("x");';
		expect(checkNanComparison(content, "src/lint.ts")).toEqual([]);
	});

	it("N6: a regex literal after `case` in a switch (true) classifier", () => {
		const content = [
			"export function classify(line: string): string {",
			"\tswitch (true) {",
			"\t\tcase /[!=]== NaN\\b/.test(line):",
			'\t\t\treturn "nan-compare";',
			"\t\tdefault:",
			'\t\t\treturn "ok";',
			"\t}",
			"}",
		].join("\n");
		expect(checkNanComparison(content, "src/lint/classify.ts")).toEqual([]);
	});

	it("N7: a regex literal yielded from a pattern generator", () => {
		const content = "export function* patterns() { yield /=== NaN/; yield /!== NaN/v; }";
		expect(checkNanComparison(content, "src/lint/patterns.ts")).toEqual([]);
	});

	it("N8: JSX prose in a Create React App `.js` component", () => {
		const content = [
			"export function NanExplainer() {",
			"\treturn <p>In JavaScript, <code>NaN === NaN</code> is false.</p>;",
			"}",
		].join("\n");
		expect(checkNanComparison(content, "src/docs/NanExplainer.js")).toEqual([]);
	});
});

describe("nan_comparison — positive (must fire)", () => {
	it("P1: Number.NaN on the left still fires — it IS the global", () => {
		const content = "export const bad = (x: number) => Number.NaN === x;";
		expect(checkNanComparison(content, "src/num.ts")).toHaveLength(1);
	});

	it("P2: division beside a NaN comparison is not a regex literal", () => {
		const content = "export const r = (total: number, count: number) => total / count === NaN / 2;";
		expect(checkNanComparison(content, "src/num.ts")).toHaveLength(1);
	});

	it("P3: a JSX expression container is code, not prose", () => {
		const content = "export const D = (x: number) => <p>{x === NaN ? 'nan' : 'num'}</p>;";
		expect(checkNanComparison(content, "src/D.tsx")).toHaveLength(1);
	});

	it("P4: a bare global NaN on the left in a .tsx file still fires", () => {
		const content = "export const bad = (x: number) => NaN === x;";
		expect(checkNanComparison(content, "src/num.tsx")).toHaveLength(1);
	});

	it("P5: a member named `case` before a division is not a keyword", () => {
		const content = "export const r = (o: { case: number }, n: number) => o.case / n === NaN / 2;";
		expect(checkNanComparison(content, "src/num.ts")).toHaveLength(1);
	});

	it("P6: a real comparison in a `.js` file that also carries JSX", () => {
		const content = "export const D = (x) => <p>{x !== NaN ? 'num' : 'nan'}</p>;";
		expect(checkNanComparison(content, "src/D.js")).toHaveLength(1);
	});
});
