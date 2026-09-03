import { describe, expect, it } from "vitest";
import { ifBlockHasMatchingElse, maxTernaryNestingDepth } from "./taste-smell-scanners.js";

describe("ifBlockHasMatchingElse", () => {
	it("finds an else on the line after the closing brace", () => {
		const lines = ["if (!x) {", "\ta();", "} else {", "\tb();", "}"];
		expect(ifBlockHasMatchingElse(lines, 0)).toBe(true);
	});

	it("finds an else that follows the closing brace on the same line", () => {
		const lines = ["if (!x) { a(); } else { b(); }"];
		expect(ifBlockHasMatchingElse(lines, 0)).toBe(true);
	});

	it("returns false when the block closes with no else", () => {
		const lines = ["if (!x) {", "\ta();", "}", "b();"];
		expect(ifBlockHasMatchingElse(lines, 0)).toBe(false);
	});

	it("ignores braces of nested blocks when locating the close", () => {
		const lines = ["if (!x) {", "\tif (y) {", "\t\ta();", "\t}", "} else {", "}"];
		expect(ifBlockHasMatchingElse(lines, 0)).toBe(true);
	});

	it("returns false when the nested block closes without an else", () => {
		const lines = ["if (!x) {", "\tif (y) {", "\t\ta();", "\t}", "}", "c();"];
		expect(ifBlockHasMatchingElse(lines, 0)).toBe(false);
	});

	it("returns false when the block never closes inside the 50-line window", () => {
		const lines = ["if (!x) {", ...Array.from({ length: 80 }, () => "\ta();"), "} else {"];
		expect(ifBlockHasMatchingElse(lines, 0)).toBe(false);
	});

	it("returns false when the closing brace is the last line of the file", () => {
		const lines = ["if (!x) {", "\ta();", "}"];
		expect(ifBlockHasMatchingElse(lines, 0)).toBe(false);
	});

	it("scans from the given start index, not from the top", () => {
		const lines = ["a();", "if (!x) {", "\tb();", "} else {", "}"];
		expect(ifBlockHasMatchingElse(lines, 1)).toBe(true);
	});
});

describe("maxTernaryNestingDepth", () => {
	it("reports 0 for a line with no ternary", () => {
		expect(maxTernaryNestingDepth("const a = b + c;")).toBe(0);
	});

	it("reports 1 for a single ternary", () => {
		expect(maxTernaryNestingDepth("const a = b ? c : d;")).toBe(1);
	});

	it("reports 2 for a nested ternary", () => {
		expect(maxTernaryNestingDepth("const a = b ? c ? d : e : f;")).toBe(2);
	});

	it("reports 1 for a flat ternary chain", () => {
		expect(maxTernaryNestingDepth("const a = b ? c : d ? e : f;")).toBe(1);
	});

	it("does not count optional chaining", () => {
		expect(maxTernaryNestingDepth("const a = b?.c?.d;")).toBe(0);
	});

	it("does not count nullish coalescing", () => {
		expect(maxTernaryNestingDepth("const a = b ?? c ?? d;")).toBe(0);
	});

	it("does not count question marks inside generic type arguments", () => {
		expect(maxTernaryNestingDepth("const m = new Map<string, number>();")).toBe(0);
	});

	it("still sees a ternary that follows a generic type argument", () => {
		expect(maxTernaryNestingDepth("const a = f<string>(x) ? y : z;")).toBe(1);
	});

	it("counts a trailing question mark at the end of the line", () => {
		expect(maxTernaryNestingDepth("const a = b ?")).toBe(1);
	});

	it("never returns a negative depth when colons outnumber question marks", () => {
		expect(maxTernaryNestingDepth("const a: string = b : c : d;")).toBe(0);
	});
});
