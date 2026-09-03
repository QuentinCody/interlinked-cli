import { describe, expect, it } from "vitest";
import {
	countBooleanArgsFrom,
	matchFunctionName,
	signatureParamCount,
} from "./taste-arg-scan.js";

describe("countBooleanArgsFrom", () => {
	it("counts top-level boolean literals up to the closing paren", () => {
		const line = "createUser(true, false)";
		expect(countBooleanArgsFrom(line, line.indexOf("(") + 1)).toBe(2);
	});

	it("ignores booleans nested inside a bracketed argument", () => {
		const line = "createUser({ a: true, b: false }, true)";
		expect(countBooleanArgsFrom(line, line.indexOf("(") + 1)).toBe(1);
	});

	it("returns 0 when no argument is a bare boolean literal", () => {
		const line = 'createUser("alice", flag)';
		expect(countBooleanArgsFrom(line, line.indexOf("(") + 1)).toBe(0);
	});

	it("counts the trailing argument when the call is unterminated", () => {
		const line = "createUser(true, false";
		expect(countBooleanArgsFrom(line, line.indexOf("(") + 1)).toBe(1);
	});
});

describe("matchFunctionName", () => {
	const patterns = [/function\s+(\w+)\s*\(/, /const\s+(\w+)\s*=\s*\(/];

	it("returns the capture of the first matching pattern", () => {
		expect(matchFunctionName("function alpha(a, b) {", patterns)).toBe("alpha");
		expect(matchFunctionName("const beta = (a, b) => {", patterns)).toBe("beta");
	});

	it("returns null when no pattern matches", () => {
		expect(matchFunctionName("const x = 1;", patterns)).toBeNull();
	});
});

describe("signatureParamCount", () => {
	it("counts top-level params of a single-line signature", () => {
		const lines = ["function f(a, b, c) {", "}"];
		expect(signatureParamCount(lines, 0)).toBe(3);
	});

	it("returns null for an empty parameter list", () => {
		expect(signatureParamCount(["function f() {", "}"], 0)).toBeNull();
	});

	it("returns null for a single destructured object param", () => {
		expect(signatureParamCount(["function f({ a, b, c }) {", "}"], 0)).toBeNull();
	});

	it("returns null when the line has no parenthesised signature", () => {
		expect(signatureParamCount(["const x = 1;", ""], 0)).toBeNull();
	});
});
