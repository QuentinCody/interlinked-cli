import { describe, expect, it } from "vitest";
import { describeKind, TEST_MUTANT_KINDS, TestMutantDriftError, testMutantId } from "./test-mutants-types.js";

describe("test-mutants-types — positive (must fire)", () => {
	it("P1: every kind has a distinct non-empty description", () => {
		const descriptions = TEST_MUTANT_KINDS.map((k) => describeKind(k));
		expect(descriptions.every((d) => d.length > 0)).toBe(true);
		expect(new Set(descriptions).size).toBe(TEST_MUTANT_KINDS.length);
	});

	it("P2: the id is stable for identical inputs and 16 hex chars", () => {
		const a = testMutantId("a.test.ts", "assertion_negate", 10, "not.toBe");
		expect(testMutantId("a.test.ts", "assertion_negate", 10, "not.toBe")).toBe(a);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
	});

	it("P3: the drift error carries the mutant id, expected and actual text", () => {
		const err = new TestMutantDriftError("abc", "toBe", "toEqual");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("TestMutantDriftError");
		expect([err.mutantId, err.expected, err.actual]).toEqual(["abc", "toBe", "toEqual"]);
	});
});

describe("test-mutants-types — negative (must not fire)", () => {
	it("N1: a different file, kind, offset or replacement yields a different id", () => {
		const base = testMutantId("a.test.ts", "assertion_negate", 10, "x");
		const others = [
			testMutantId("b.test.ts", "assertion_negate", 10, "x"),
			testMutantId("a.test.ts", "assertion_delete", 10, "x"),
			testMutantId("a.test.ts", "assertion_negate", 11, "x"),
			testMutantId("a.test.ts", "assertion_negate", 10, "y"),
		];
		expect(others.includes(base)).toBe(false);
		expect(new Set(others).size).toBe(4);
	});

	it("N2: field boundaries cannot be forged by concatenation", () => {
		expect(testMutantId("a", "assertion_negate", 1, "2x")).not.toBe(testMutantId("a", "assertion_negate", 12, "x"));
	});
});
