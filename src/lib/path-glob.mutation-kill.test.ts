import { describe, expect, it } from "vitest";
import { matchesGlob } from "./path-glob.js";

describe("path-glob mutation kills", () => {
	// test-contract: boundary — a literal "+" in a glob matches only a literal "+", not a repeat quantifier
	it("treats plus as a literal character", () => {
		expect(matchesGlob("a+b", "a+b")).toBe(true);
		expect(matchesGlob("aab", "a+b")).toBe(false);
	});
});
