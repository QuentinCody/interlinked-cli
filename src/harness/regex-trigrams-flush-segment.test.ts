import { describe, expect, it } from "vitest";
import { extractLiteralSegments } from "./regex-trigrams-flush-segment.js";

describe("extractLiteralSegments", () => {
	it("returns the whole run for a plain literal-only pattern", () => {
		expect(extractLiteralSegments("abcdef")).toEqual(["abcdef"]);
	});

	it("flushes at a wildcard, dropping segments under 3 chars", () => {
		expect(extractLiteralSegments("abc.def")).toEqual(["abc", "def"]);
		expect(extractLiteralSegments("ab.cdef")).toEqual(["cdef"]);
	});

	it("drops the preceding char before a quantifier", () => {
		expect(extractLiteralSegments("xyzab?cde")).toEqual(["xyza", "cde"]);
	});

	it("skips lazy/possessive quantifier modifiers", () => {
		expect(extractLiteralSegments("xyz(ab*?cde)")).toEqual(["xyz", "cde"]);
		expect(extractLiteralSegments("xyz(ab++cde)")).toEqual(["xyz", "cde"]);
	});

	it("handles {n,m} repetition, including unterminated and leading-brace cases", () => {
		expect(extractLiteralSegments("xyzab{2,3}?cde")).toEqual(["xyza", "cde"]);
		expect(extractLiteralSegments("xyzab{2,3}cde")).toEqual(["xyza", "cde"]);
		expect(extractLiteralSegments("xyzab{2,3")).toEqual(["xyza"]);
		expect(extractLiteralSegments("{2,3}xyzcde")).toEqual(["xyzcde"]);
	});

	it("resolves known escapes to their literal char and passes unknown escapes through", () => {
		expect(extractLiteralSegments("ab\\.cdef")).toEqual(["ab.cdef"]);
		expect(extractLiteralSegments("xyz\\qcde")).toEqual(["xyzqcde"]);
	});

	it("flushes on non-literal escapes (\\d, \\w, ...) without consuming them", () => {
		expect(extractLiteralSegments("xyz\\dcde")).toEqual(["xyz", "cde"]);
	});

	it("keeps a trailing lone backslash as a literal", () => {
		expect(extractLiteralSegments("abc\\")).toEqual(["abc\\"]);
	});

	it("skips character classes, including negated and leading-] forms", () => {
		expect(extractLiteralSegments("xyz[^abc]def")).toEqual(["xyz", "def"]);
		expect(extractLiteralSegments("xyz[]abc]def")).toEqual(["xyz", "def"]);
		expect(extractLiteralSegments("xyz[a\\]bc]def")).toEqual(["xyz", "def"]);
	});

	it("ignores anchors without consuming surrounding literal", () => {
		expect(extractLiteralSegments("xyz^abc")).toEqual(["xyzabc"]);
		expect(extractLiteralSegments("xyz$abc")).toEqual(["xyzabc"]);
	});

	it("recurses into non-capturing and capturing groups", () => {
		expect(extractLiteralSegments("(?:abc)def")).toEqual(["abc", "def"]);
		expect(extractLiteralSegments("(abc)def")).toEqual(["abc", "def"]);
	});

	it("skips lookaround and unknown-modifier groups", () => {
		expect(extractLiteralSegments("xyz(?=abc)def")).toEqual(["xyz", "def"]);
		expect(extractLiteralSegments("xyz(?!abc)def")).toEqual(["xyz", "def"]);
	});

	it("skips a group containing top-level alternation", () => {
		expect(extractLiteralSegments("xyz(abc|def)ghi")).toEqual(["xyz", "ghi"]);
	});

	it("stops at top-level alternation, leaving branch handling to the caller", () => {
		expect(extractLiteralSegments("abcdef|ghijkl")).toEqual(["abcdef"]);
	});

	it("returns an empty array for a pattern with no literal of length >= 3", () => {
		expect(extractLiteralSegments("a.b")).toEqual([]);
	});
});
