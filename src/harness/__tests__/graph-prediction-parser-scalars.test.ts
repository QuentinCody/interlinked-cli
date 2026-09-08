// ===========================================
// graph-prediction parser — scalar / token primitives
// ===========================================
// Direct unit coverage for the leaf helpers in
// `graph-prediction-parser-scalars.ts`: `tokenizeKeyValue`, `parseScalar`,
// `splitInlineList`, `parseInlineValue`, `tokenizeListItem`, `flowQuote`,
// `parseRisk`, `parseCount`.

import { describe, expect, it } from "vitest";

import {
	flowQuote,
	parseCount,
	parseInlineValue,
	parseRisk,
	parseScalar,
	splitInlineList,
	tokenizeKeyValue,
	tokenizeListItem,
} from "../graph-prediction-parser-scalars.js";

describe("tokenizeKeyValue", () => {
	it("returns null for a blank/whitespace-only line", () => {
		expect(tokenizeKeyValue("   ")).toBeNull();
	});

	it("returns null for a comment line (after indent stripping)", () => {
		expect(tokenizeKeyValue("  # a comment")).toBeNull();
	});

	it("returns null when the line has no key: value shape", () => {
		expect(tokenizeKeyValue("not a key value line")).toBeNull();
	});

	it("parses indent, key, and trimmed rest from a key: value line", () => {
		expect(tokenizeKeyValue("  file: src/foo.ts  ")).toEqual({
			indent: 2,
			key: "file",
			rest: "src/foo.ts",
		});
	});

	it("uses indent 0 when the line has no leading spaces", () => {
		expect(tokenizeKeyValue("key: value")).toEqual({ indent: 0, key: "key", rest: "value" });
	});
});

describe("parseScalar", () => {
	it("parses an integer literal", () => {
		expect(parseScalar("42")).toBe(42);
	});

	it("parses a negative integer literal", () => {
		expect(parseScalar("-7")).toBe(-7);
	});

	it("parses a float literal", () => {
		expect(parseScalar("3.14")).toBe(3.14);
	});

	it("strips double-quote wrapping", () => {
		expect(parseScalar('"hello"')).toBe("hello");
	});

	it("strips single-quote wrapping", () => {
		expect(parseScalar("'hello'")).toBe("hello");
	});

	it("returns the bare text unchanged when it is not numeric or quoted", () => {
		expect(parseScalar("plain-text")).toBe("plain-text");
	});

	it("does not treat mismatched quote pairs as quoted", () => {
		expect(parseScalar("\"mismatched'")).toBe("\"mismatched'");
	});
});

describe("splitInlineList", () => {
	it("splits a simple comma list", () => {
		expect(splitInlineList("a, b, c")).toEqual(["a", "b", "c"]);
	});

	it("does not split commas inside quoted segments", () => {
		expect(splitInlineList('"a, b", c')).toEqual(['"a, b"', "c"]);
	});

	it("handles single-quoted segments", () => {
		expect(splitInlineList("'x, y', z")).toEqual(["'x, y'", "z"]);
	});

	it("drops empty pieces produced by trailing/blank commas", () => {
		expect(splitInlineList("a,,  ,b")).toEqual(["a", "b"]);
	});

	it("returns an empty array for empty input", () => {
		expect(splitInlineList("")).toEqual([]);
	});
});

describe("parseInlineValue", () => {
	it("recognizes the bare unknown sentinel", () => {
		expect(parseInlineValue("unknown")).toEqual({ value: "unknown", formatViolation: false });
	});

	it("recognizes an explicit empty list []", () => {
		expect(parseInlineValue("[]")).toEqual({ value: [], formatViolation: false });
	});

	it("parses an inline list with a single empty-string inner (whitespace only)", () => {
		expect(parseInlineValue("[   ]")).toEqual({ value: [], formatViolation: false });
	});

	it("parses a populated inline list, stringifying numeric items", () => {
		expect(parseInlineValue("[a, 2, 3.5]")).toEqual({
			value: ["a", "2", "3.5"],
			formatViolation: false,
		});
	});

	it("flags formatViolation when an inline list exceeds the 50-entry cap", () => {
		const items = Array.from({ length: 51 }, (_, i) => `item${i}`).join(", ");
		const result = parseInlineValue(`[${items}]`);
		expect(result.formatViolation).toBe(true);
		expect(Array.isArray(result.value)).toBe(true);
		expect(result).toHaveProperty(["value","length"], 51);
	});

	it("falls through to parseScalar for a plain non-list, non-sentinel value", () => {
		expect(parseInlineValue("42")).toEqual({ value: 42, formatViolation: false });
	});

	it("falls through to parseScalar for a plain string value", () => {
		expect(parseInlineValue("hello")).toEqual({ value: "hello", formatViolation: false });
	});
});

describe("tokenizeListItem", () => {
	it("returns null for a line that is not a block-list item", () => {
		expect(tokenizeListItem("not a list item")).toBeNull();
	});

	it("parses a bare dash with no trailing value as empty string", () => {
		expect(tokenizeListItem("  -")).toEqual({ indent: 2, value: "" });
	});

	it("parses a `- value` line, trimming the value", () => {
		expect(tokenizeListItem("  - foo  ")).toEqual({ indent: 2, value: "foo" });
	});

	it("uses indent 0 when there is no leading whitespace", () => {
		expect(tokenizeListItem("- x")).toEqual({ indent: 0, value: "x" });
	});
});

describe("flowQuote", () => {
	it("wraps a plain item in double quotes", () => {
		expect(flowQuote("src/foo.ts")).toBe('"src/foo.ts"');
	});

	it("escapes embedded double quotes", () => {
		expect(flowQuote('has "quotes" inside')).toBe('"has \\"quotes\\" inside"');
	});
});

describe("parseRisk", () => {
	it("accepts 'low'", () => {
		expect(parseRisk("low")).toBe("low");
	});

	it("accepts 'medium'", () => {
		expect(parseRisk("medium")).toBe("medium");
	});

	it("accepts 'high'", () => {
		expect(parseRisk("high")).toBe("high");
	});

	it("accepts the unknown sentinel", () => {
		expect(parseRisk("unknown")).toBe("unknown");
	});

	it("falls back to unknown for any unrecognized value", () => {
		expect(parseRisk("extreme")).toBe("unknown");
	});
});

describe("parseCount", () => {
	it("passes through the unknown sentinel unchanged", () => {
		expect(parseCount("unknown")).toBe("unknown");
	});

	it("parses a valid integer count", () => {
		expect(parseCount("5")).toBe(5);
	});

	it("returns unknown when the text does not parse to a finite number", () => {
		expect(parseCount("not-a-number")).toBe("unknown");
	});
});
