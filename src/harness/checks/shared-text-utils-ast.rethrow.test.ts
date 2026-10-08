import { describe, expect, it, vi } from "vitest";

// The stack-overflow fallback must not swallow other failures: a parser that throws anything but a
// RangeError is a defect the caller has to see, not a reason to switch to the line scanner silently.
vi.mock("./cyclomatic-ast.js", () => ({
	hasParseErrors: () => false,
	parseTsSource: () => {
		throw new TypeError("parser defect");
	},
}));

const { stripWithTypeScript } = await import("./shared-text-utils-ast.js");

describe("stripWithTypeScript — a parser failure that is not a stack overflow", () => {
	it("rethrows the error instead of falling back", () => {
		expect(() => stripWithTypeScript("const a = 1;", { strings: true })).toThrow("parser defect");
	});
});
