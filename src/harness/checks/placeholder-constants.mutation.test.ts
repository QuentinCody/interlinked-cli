// Mutation-hardening tests for placeholder-constants.ts.
// Each test pins one behavior described in the module header / doc comments:
//   - comments are captured even when the same line also carries code
//   - the scanner never carries string state across lines for double quotes (Rust)
//   - escapes inside interpreted string literals do not end the literal
//   - CRLF normalization drops exactly one trailing CR per line
//   - the Python docstring tracker pairs triple quotes left to right, 3 chars apart

import { describe, expect, it } from "vitest";
import { checkPlaceholderRuntimeConstant } from "./placeholder-constants.js";

function run(src: string, path: string) {
	return checkPlaceholderRuntimeConstant(src, path);
}

describe("checkPlaceholderRuntimeConstant — mutation hardening (must fire)", () => {
	it("a Rust char literal holding a double quote does not hide a same-line confession above the declaration", () => {
		const src = [`let q = '"'; // temporary`, "const N: usize = 4;"].join("\n");
		const found = run(src, "src/lib.rs");
		expect(found.map((m) => m.line)).toEqual([2]);
	});

	it("CRLF handling removes only the carriage return, so a confession ending the line is intact", () => {
		const src = "# TODO: stand-in\r\nBATCH_SIZE = 64\r\n";
		const found = run(src, "src/config.py");
		expect(found.map((m) => m.line)).toEqual([2]);
		expect(found[0]?.text.endsWith("BATCH_SIZE = 64")).toBe(true);
	});

	it("a block comment opened by /*/ stays open until a later */ and keeps its confession", () => {
		const src = ["/*/ stand-in */", "const LIMIT = 3;"].join("\n");
		const found = run(src, "src/config.ts");
		expect(found.map((m) => m.line)).toEqual([2]);
	});

	it("code that follows a closed block comment is scanned from the character after the closer", () => {
		const src = [
			"const A = 5; // stand-in",
			"y = a /* c */* b;",
			"const B = 6; // temporary",
		].join("\n");
		const found = run(src, "src/config.ts");
		expect(found.map((m) => m.line)).toEqual([1, 3]);
	});

	it("an escaped quote inside a JS string does not end it, so a trailing confession comment is kept", () => {
		const src = [`const s = "\\""; // stand-in`, "const N = 3;"].join("\n");
		const found = run(src, "src/config.ts");
		expect(found.map((m) => m.line)).toEqual([2]);
	});

	it("an escaped quote inside a Go interpreted string does not end it, so a trailing confession comment is kept", () => {
		const src = [`var s = "\\"" // stand-in`, "const N = 3"].join("\n");
		const found = run(src, "src/config.go");
		expect(found.map((m) => m.line)).toEqual([2]);
	});

	it("an unterminated double-quoted Rust string does not swallow the following lines", () => {
		const src = [`let s = "unterminated;`, "const N: usize = 4; // stand-in"].join("\n");
		const found = run(src, "src/lib.rs");
		expect(found.map((m) => m.line)).toEqual([2]);
	});
});

describe("checkPlaceholderRuntimeConstant — mutation hardening (must NOT fire)", () => {
	it("a single-character Python code line between confession and declaration breaks attachment", () => {
		const src = ["# stand-in", "x", "BATCH = 64"].join("\n");
		expect(run(src, "src/config.py")).toEqual([]);
	});

	it("a Python line opening a docstring with four quotes keeps the docstring open", () => {
		const src = [`DOC = """"`, "# stand-in", "BATCH = 64", `"""`].join("\n");
		expect(run(src, "src/config.py")).toEqual([]);
	});
});
