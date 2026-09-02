// Content fingerprints for survivor reconciliation — the pure AST half of
// survivor-moves.ts (extracted 2026-09-02 for the 500-line cap): where an
// expression sits, and what "the same mutant content" hashes to.

import { describe, expect, it } from "vitest";
import { fingerprintAt, indexSource, offsetsOfLexeme, type SourceIndex } from "./survivor-fingerprint.js";

const FILE = "src/example.ts";

const BEFORE = [
	"export function f(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

function indexOf(content: string): SourceIndex {
	const index = indexSource({ file: FILE, content });
	if (index === null) throw new Error("typescript unavailable");
	return index;
}

describe("indexSource — positive (must fire)", () => {
	it("P1: resolves an exact span to the DEEPEST node — the expression, not a wrapper", () => {
		const index = indexOf(BEFORE);
		const start = BEFORE.indexOf("a > b");
		const node = index.bySpan.get(`${start}:${start + "a > b".length}`);
		if (node === undefined) throw new Error("expected a node at the expression span");
		expect(index.parsed.ts.isBinaryExpression(node)).toBe(true);
	});
});

describe("indexSource — negative (must not fire)", () => {
	it("N1: a span no node occupies is absent", () => {
		expect(indexOf(BEFORE).bySpan.has("0:1")).toBe(false);
	});
});

describe("offsetsOfLexeme — positive (must fire)", () => {
	it("P1: reports the AST-node occurrences of an operator, not its type-argument look-alikes", () => {
		const src = "function f(m: Map<string, number>, a: number, b: number): boolean {\n\treturn a > b;\n}\n";
		expect(offsetsOfLexeme(indexOf(src), ">")).toEqual([src.indexOf("> b")]);
	});

	it("P2: reports every occurrence, ascending and deduplicated", () => {
		const src = "function f(a: number): number {\n\tif (a > 1) return a > 2 ? 1 : 0;\n\treturn 0;\n}\n";
		expect(offsetsOfLexeme(indexOf(src), ">")).toEqual([src.indexOf("> 1"), src.indexOf("> 2")]);
	});
});

describe("offsetsOfLexeme — negative (must not fire)", () => {
	it("N1: an absent lexeme yields no offsets", () => {
		expect(offsetsOfLexeme(indexOf(BEFORE), "<")).toEqual([]);
	});
});

describe("fingerprintAt — positive (must fire)", () => {
	it("P1: is whitespace- and comment-insensitive", () => {
		const a = "function f(a: number, b: number): number {\n\tif (a > b) return 1;\n\treturn 2;\n}\n";
		const b = "function f(a: number, b: number): number {\n\tif (a  >  b /* c */)   return 1;\n\treturn 2;\n}\n";
		expect(fingerprintAt(indexOf(a), a.indexOf("> b"), ">")).toBe(fingerprintAt(indexOf(b), b.indexOf(">  b"), ">"));
	});

	it("P2: blanks nested block interiors — the statement's SHAPE is the key", () => {
		const a = "function f(a: number, b: number): number {\n\tif (a > b) { return 1; }\n\treturn 2;\n}\n";
		const b = "function f(a: number, b: number): number {\n\tif (a > b) { return 9; }\n\treturn 2;\n}\n";
		expect(fingerprintAt(indexOf(a), a.indexOf("> b"), ">")).toBe(fingerprintAt(indexOf(b), b.indexOf("> b"), ">"));
	});

	it("P3: is the same in a different enclosing function — the symbol is not part of the content", () => {
		const a = "function f(a: number, b: number): number {\n\tif (a > b) return 1;\n\treturn 2;\n}\n";
		const b = "function g(a: number, b: number): number {\n\tif (a > b) return 1;\n\treturn 2;\n}\n";
		expect(fingerprintAt(indexOf(a), a.indexOf("> b"), ">")).toBe(fingerprintAt(indexOf(b), b.indexOf("> b"), ">"));
	});
});

describe("fingerprintAt — negative (must not fire)", () => {
	it("N1: returns null when no AST node spans the offset", () => {
		expect(fingerprintAt(indexOf(BEFORE), 0, "zz")).toBeNull();
	});

	it("N2: differs when the enclosing statement differs", () => {
		const a = "function f(a: number, b: number): number {\n\tif (a > b) return 1;\n\treturn 2;\n}\n";
		const b = "function f(a: number, b: number): number {\n\tif (a > b) return 3;\n\treturn 2;\n}\n";
		expect(fingerprintAt(indexOf(a), a.indexOf("> b"), ">")).not.toBe(fingerprintAt(indexOf(b), b.indexOf("> b"), ">"));
	});

	it("N3: differs when the mutated expression differs under the same statement shape", () => {
		const a = "function f(a: number, b: number): number {\n\tif (a > b) return 1;\n\treturn 2;\n}\n";
		const b = "function f(a: number, b: number): number {\n\tif (a >= b) return 1;\n\treturn 2;\n}\n";
		expect(fingerprintAt(indexOf(a), a.indexOf("> b"), ">")).not.toBe(fingerprintAt(indexOf(b), b.indexOf(">= b"), ">="));
	});
});
