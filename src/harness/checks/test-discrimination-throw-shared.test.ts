// Companion for the shared string-scanning primitives used by both
// test-discrimination-throw.ts (assertion parsing) and
// test-discrimination-throw-scope.ts (call-scoping resolution). Full
// end-to-end coverage of the detector lives in
// test-discrimination-throw.test.ts; this file pins the primitives directly.

import { describe, expect, it } from "vitest";
import { collectThrowSites, extractBalancedArgs, parseLeadingLiteral } from "./test-discrimination-throw-shared.js";

describe("parseLeadingLiteral — positive (must fire)", () => {
	it("P1: parses a double-quoted string literal", () => {
		expect(parseLeadingLiteral('"hello"')).toEqual({ prefix: "hello", end: 7 });
	});

	it("P2: parses a template literal, stopping at the first ${", () => {
		expect(parseLeadingLiteral("`missing id: ${id}`")?.prefix).toBe("missing id: ");
	});
});

describe("parseLeadingLiteral — negative (must not fire)", () => {
	it("N1: returns null for text that doesn't open with a quote", () => {
		expect(parseLeadingLiteral("foo")).toBeNull();
	});

	it("N2: returns null for an unterminated literal", () => {
		expect(parseLeadingLiteral('"unterminated')).toBeNull();
	});
});

describe("extractBalancedArgs — positive (must fire)", () => {
	it("P1: extracts simple arguments", () => {
		const text = "foo(a, b)";
		expect(extractBalancedArgs(text, text.indexOf("("))).toBe("a, b");
	});

	it("P2: respects nested parens", () => {
		const text = "foo(bar(1), 2)";
		expect(extractBalancedArgs(text, text.indexOf("("))).toBe("bar(1), 2");
	});
});

describe("extractBalancedArgs — negative (must not fire)", () => {
	it("N1: returns null for an unterminated call", () => {
		const text = "foo(a, b";
		expect(extractBalancedArgs(text, text.indexOf("("))).toBeNull();
	});
});

describe("collectThrowSites — positive (must fire)", () => {
	it("P1: collects a plain string throw message", () => {
		expect(collectThrowSites('throw new Error("bad");')).toEqual([{ message: "bad" }]);
	});
});

describe("collectThrowSites — negative (must not fire)", () => {
	it("N1: ignores a throw with no literal message", () => {
		expect(collectThrowSites("throw new Error(msg);")).toEqual([]);
	});
});
