// Mutation-hardening tests for unsafe-span.ts (Campaign A, 2026-10-21).
// Each test pins behavior that a single-change mutant of the module left
// unobserved by unsafe-span.test.ts. Basis for every assertion is cited as
// unsafe-span.ts line numbers (module header and doc comments).

import { describe, expect, it } from "vitest";
import { checkRustUnsafeSpan, checkSuppressionSpan } from "./unsafe-span.js";

const RS_PATH = "crates/core/src/ffi.rs";
const TS_PATH = "src/lib/app.ts";
const QUOTE = String.fromCharCode(39);

// Directive fixture lines, hoisted so no test-body line carries a string
// containing the two-char comment closer.
const DISABLE = "/* eslint-disable */";
const ENABLE = "/* eslint-enable */";
const DISABLE_A_DASHED_B = "/* eslint-disable a, --b */";
const ENABLE_DASHED_B = "/* eslint-enable --b */";
const ENABLE_A = "/* eslint-enable a */";

function rust(lines: string[]) {
	return checkRustUnsafeSpan(lines.join("\n"), RS_PATH);
}

function suppression(lines: string[]) {
	return checkSuppressionSpan(lines.join("\n"), TS_PATH);
}

function stmts(n: number, indent = "    "): string[] {
	return Array.from({ length: n }, (_, i) => indent + "step_" + i + "();");
}

describe("checkRustUnsafeSpan — scan continues past an unclosed block", () => {
	it("MU-RU1: an unbalanced earlier `unsafe {` does not stop the scan from finding a later wide block", () => {
		// Basis: unsafe-span.ts:205-207 — unbalanced opens (absent keys) "cost nothing";
		// an unclosed candidate is skipped, not terminal.
		const found = rust([
			"unsafe {", // 1 — never closed
			"unsafe {", // 2 — wide, properly closed
			...stmts(6),
			"}",
		]);
		expect(found.map((m) => m.line)).toEqual([2]);
	});
});

describe("checkRustUnsafeSpan — block opener token shape", () => {
	it("MU-RU2: `unsafe{` with no space before the brace is still an unsafe block", () => {
		// Basis: unsafe-span.ts:198-199 — block form is `unsafe` immediately followed by `{`;
		// the opener pattern uses zero-or-more whitespace, unsafe-span.ts:202.
		const found = rust(["unsafe{", ...stmts(6), "}"]);
		expect(found.map((m) => m.line)).toEqual([1]);
	});

	it("MU-RU3: an identifier merely ending in `unsafe` before a brace is not an unsafe block", () => {
		// Basis: unsafe-span.ts:202 — the opener is a keyword match; `my_unsafe {`
		// (a struct literal) must not be judged as an escape hatch.
		const found = rust(["let v = my_unsafe {", ...stmts(6), "};"]);
		expect(found).toHaveLength(0);
	});
});

describe("checkRustUnsafeSpan — raw-string prefix recognition", () => {
	it("MU-RU4: a digit before a raw-string-looking opener keeps `r` inside an identifier", () => {
		// Basis: unsafe-span.ts:118-119 — "previous char must not extend an identifier";
		// a digit extends one. `a1r` is an identifier and `"x"` an ordinary string, so
		// the closing brace is live code. Were it read as a raw opener it would run
		// to the later hash-quote and hide the closing brace.
		const found = rust(["unsafe {", '    let a1r#"x";', ...stmts(5), "}", 'let z = "#";']);
		expect(found.map((m) => m.line)).toEqual([1]);
	});

	it("MU-RU5: a raw-string-looking opener right after a closed string literal is not a raw string", () => {
		// Basis: unsafe-span.ts:118-119 (the guard names `"` and `'` as non-opening
		// predecessors); in the Rust lexer a literal followed by `r` is a suffix.
		const found = rust(["unsafe {", '    let s = "x"r#"y";', ...stmts(5), "}", 'let z = "#";']);
		expect(found.map((m) => m.line)).toEqual([1]);
	});
});

describe("checkRustUnsafeSpan — char literal edge", () => {
	it("MU-RU6: three quotes in a row are not a char literal; the next char still pairs normally", () => {
		// Basis: unsafe-span.ts:150-154 — a char literal is exactly one non-quote char
		// between quotes. In the tripled-quote line below, only the trailing
		// quote-brace-quote is a literal and hides that brace, so the block stays
		// wide. A scanner that blanked the three quotes would leave the brace live
		// and close the block early.
		const tripled = "    let c = " + QUOTE.repeat(3) + "}" + QUOTE + ";";
		const found = rust(["unsafe {", tripled, ...stmts(5), "}"]);
		expect(found.map((m) => m.line)).toEqual([1]);
	});
});

describe("checkSuppressionSpan — directive parsing", () => {
	it("MU-SU1: a double hyphen with no whitespace after it is part of a rule name, not a justification split", () => {
		// Basis: unsafe-span.ts:304 — "a ` -- ` tail is a justification" (dashes
		// surrounded by whitespace). `--b` is therefore a listed rule and the
		// matching enable closes it (rule `a` is re-enabled early, so only the
		// wide `--b` region can fire).
		const found = suppression([DISABLE_A_DASHED_B, ENABLE_A, ...stmts(11, ""), ENABLE_DASHED_B]);
		expect(found.map((m) => m.line)).toEqual([1]);
	});

	it("MU-SU2: a later bare disable never counts as the enable of an earlier disable", () => {
		// Basis: unsafe-span.ts:404-407 — only `enable` directives close a region.
		const found = suppression([DISABLE, DISABLE, ...stmts(15, ""), ENABLE]);
		expect(found.map((m) => m.line)).toEqual([1, 2]);
	});
});

describe("checkSuppressionSpan — line tracking across string literals", () => {
	it("MU-SU3: a multi-line template literal before a directive counts its newlines in the reported line", () => {
		// Basis: unsafe-span.ts:350-354, 377-379 — templates span lines and the
		// scanner's line counter must advance over them; a finding is anchored
		// at the disable directive's line (unsafe-span.ts:453).
		const found = suppression(["const t = `a", "b", "c`;", DISABLE, ...stmts(12, ""), ENABLE]);
		expect(found.map((m) => m.line)).toEqual([4]);
	});
});
