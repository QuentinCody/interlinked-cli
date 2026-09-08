import { describe, expect, it } from "vitest";
import {
	parseInlineValue,
	parseScalar,
	tokenizeKeyValue,
} from "./graph-prediction-parser-scalars.js";

describe("tokenizeKeyValue — positive (must fire)", () => {
	// test-contract: bug — comment detection must be startsWith("#"), not endsWith("#");
	// a value that happens to end in '#' must still parse as a normal key/value line.
	it("P1: does not false-block a value that merely ends with '#'", () => {
		const result = tokenizeKeyValue("key: value#");
		expect(result).not.toBeNull();
		expect(result?.key).toBe("key");
		expect(result?.rest).toBe("value#");
	});

	// test-contract: public-api — the key/value regex separator is `\s*:\s*`; zero
	// whitespace on either side of the colon is a valid separator, not a parse failure.
	it("P2: colon with zero whitespace after it still splits key/value", () => {
		const result = tokenizeKeyValue("key:value");
		expect(result).not.toBeNull();
		expect(result?.key).toBe("key");
		expect(result?.rest).toBe("value");
	});

	// test-contract: public-api — whitespace before the colon must be tolerated
	// (the pre-colon separator is `\s*`, zero-or-more, not `\S*`).
	it("P3: whitespace before the colon is tolerated", () => {
		const result = tokenizeKeyValue("key : value");
		expect(result).not.toBeNull();
		expect(result?.key).toBe("key");
		expect(result?.rest).toBe("value");
	});

	// test-contract: boundary — the post-colon separator (`\s*`) must be consumed as
	// separator and excluded from `rest`, not left inside it (guards against the
	// separator being narrowed to `\S*`, which would swallow the value itself).
	it("P4: whitespace after the colon is fully consumed as separator, not folded into rest", () => {
		const result = tokenizeKeyValue("key:abc");
		expect(result).not.toBeNull();
		expect(result?.rest).toBe("abc");
	});
});

describe("tokenizeKeyValue — negative (must not fire)", () => {
	// test-contract: boundary — the key regex is anchored with `^`; an identifier
	// must start at position 0, so a leading digit disqualifies the whole line.
	it("N1: an identifier must start at position 0 — leading digit disqualifies the whole line", () => {
		expect(tokenizeKeyValue("1abc: value")).toBeNull();
	});

	// test-contract: boundary — the value-capture group is anchored with a trailing
	// `$`; it must consume to the true end of the string, not stop at an embedded
	// newline that a later part of the line still follows.
	it("N2: the value capture must consume to the true end of string, not stop at an embedded newline", () => {
		expect(tokenizeKeyValue("key: value\nmore")).toBeNull();
	});
});

describe("parseScalar — numeric edge cases", () => {
	// test-contract: boundary — the float regex is anchored with a trailing `$`;
	// trailing non-numeric text after the digits disqualifies numeric parsing.
	it("a trailing non-numeric suffix after a float disqualifies numeric parsing", () => {
		expect(parseScalar("3.14abc")).toBe("3.14abc");
	});

	// test-contract: boundary — the float regex is anchored with a leading `^`;
	// leading non-numeric text before the digits disqualifies numeric parsing.
	it("a leading non-numeric prefix before a float disqualifies numeric parsing", () => {
		expect(parseScalar("abc3.14")).toBe("abc3.14");
	});

	// test-contract: public-api — the integer part of the float regex is `\d*`
	// (zero-or-more); a bare ".5" with no leading digit is still a valid float.
	it("a float with zero leading digits before the decimal point is still recognized", () => {
		expect(parseScalar(".5")).toBe(0.5);
	});
});

describe("parseScalar — quote stripping requires a MATCHING pair", () => {
	// test-contract: bug — quote-stripping requires startsWith AND endsWith on the
	// SAME quote character; a lone trailing quote with no matching leading quote
	// must not trigger stripping.
	it("a lone trailing double quote (no leading quote) is left untouched", () => {
		expect(parseScalar('abc"')).toBe('abc"');
	});

	// test-contract: bug — same guard, opposite side: a lone leading double quote
	// with no matching trailing quote must not trigger stripping.
	it("a lone leading double quote (no trailing quote) is left untouched", () => {
		expect(parseScalar('"abc')).toBe('"abc');
	});

	// test-contract: bug — quote-stripping requires startsWith AND endsWith on the
	// SAME single-quote character; a lone trailing quote must not trigger stripping.
	it("a lone trailing single quote (no leading quote) is left untouched", () => {
		expect(parseScalar("abc'")).toBe("abc'");
	});

	// test-contract: bug — same guard, opposite side: a lone leading single quote
	// with no matching trailing quote must not trigger stripping.
	it("a lone leading single quote (no trailing quote) is left untouched", () => {
		expect(parseScalar("'abc")).toBe("'abc");
	});

	// test-contract: public-api — sanity check that a genuinely matched pair is
	// still stripped, so the negative cases above are proven against live behavior.
	it("a properly matched double-quote pair is still stripped", () => {
		expect(parseScalar('"abc"')).toBe("abc");
	});

	// test-contract: public-api — sanity check that a genuinely matched single-quote
	// pair is still stripped, proving the negative cases above against live behavior.
	it("a properly matched single-quote pair is still stripped", () => {
		expect(parseScalar("'abc'")).toBe("abc");
	});
});

describe("parseInlineValue — bracket detection requires BOTH ends", () => {
	// test-contract: bug — the list-detection guard is `startsWith("[") && endsWith("]")`;
	// a `&&` weakened to `||`, or either literal blanked, would misclassify a
	// one-sided bracket as a list.
	it("starts with '[' but has no closing ']' — left as a raw scalar string", () => {
		const result = parseInlineValue("[abc");
		expect(result.value).toBe("[abc");
		expect(result.formatViolation).toBe(false);
	});

	// test-contract: bug — same guard, opposite side: a value ending in ']' with no
	// matching leading '[' must not be misclassified as a bracketed list.
	it("ends with ']' but has no opening '[' — left as a raw scalar string", () => {
		const result = parseInlineValue("abc]");
		expect(result.value).toBe("abc]");
		expect(result.formatViolation).toBe(false);
	});

	// test-contract: public-api — sanity check that a real bracketed list is still
	// parsed into an array, so the negative cases above are proven against live behavior.
	it("a real bracketed list is still parsed into an array", () => {
		const result = parseInlineValue("[a, b, c]");
		expect(result.value).toEqual(["a", "b", "c"]);
	});
});

describe("parseInlineValue — empty-string rest yields a raw empty scalar, not an empty list", () => {
	// test-contract: bug — the `"[]"` shortcut literal must be exactly "[]"; if that
	// literal were blanked to "", an empty (non-bracketed) rest would wrongly parse
	// as an empty array instead of falling through to the empty-string scalar.
	it("empty rest parses to the empty string, not []", () => {
		const result = parseInlineValue("");
		expect(result.value).toBe("");
		expect(result.formatViolation).toBe(false);
	});
});

describe("parseInlineValue — MAX_LIST_ENTRIES boundary is strictly '>'", () => {
	// test-contract: boundary — items.length > MAX_LIST_ENTRIES (50) must not fire
	// at exactly 50; a `>` weakened to `>=` would flag the boundary case itself.
	it("exactly 50 entries does not trip the format-violation flag", () => {
		const items = Array.from({ length: 50 }, (_, i) => `v${i}`);
		const result = parseInlineValue(`[${items.join(", ")}]`);
		expect(result.formatViolation).toBe(false);
		// SAFETY: parseInlineValue on bracketed input always yields a string[] for
		// `value`; asserting the length is how the "exactly 50" boundary is checked.
		expect(result).toHaveProperty(["value","length"], 50);
	});

	// test-contract: boundary — sanity check that the cap is enforced at all (51 > 50
	// must trip), proving the exact-50 negative case above against live behavior.
	it("51 entries does trip the format-violation flag", () => {
		const items = Array.from({ length: 51 }, (_, i) => `v${i}`);
		const result = parseInlineValue(`[${items.join(", ")}]`);
		expect(result.formatViolation).toBe(true);
	});
});
