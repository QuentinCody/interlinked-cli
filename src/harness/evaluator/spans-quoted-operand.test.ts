import { describe, expect, it } from "vitest";
import { quotedOperandText } from "./spans-quoted-operand.js";

// The integration cases (rule patterns over whole commands) live in
// spans.test.ts; these pin the renderer's contract on its own.
describe("quotedOperandText", () => {
	it("P1: a single-word double-quoted body is visible with space-filled delimiters", () => {
		expect(quotedOperandText('"/etc"')).toBe(" /etc ");
	});

	it("P2: an ANSI-C quoted single word keeps its two-character opener as spaces", () => {
		expect(quotedOperandText("$'src/app.ts'")).toBe("  src/app.ts ");
	});

	it("P3: an unterminated quote with a single-word body is still visible", () => {
		expect(quotedOperandText('"/etc')).toBe(" /etc");
	});

	it("P4: the output always has the input's length", () => {
		for (const t of ['"a"', "'src/x.ts'", "$'x'", '"$HOME/x"']) {
			expect(quotedOperandText(t)).toHaveLength(t.length);
		}
	});

	it("N1: whitespace in the body returns null", () => {
		expect(quotedOperandText("'rm -rf /'")).toBeNull();
	});

	it("N2: an operator, substitution, backslash or nested quote returns null", () => {
		for (const t of ['"a;b"', '"$(x)"', '"a|b"', '"a\\"b"', `'a"b'`, '"a>b"', '"`x`"']) {
			expect(quotedOperandText(t)).toBeNull();
		}
	});

	it("N3: empty or bare quotes return null", () => {
		expect(quotedOperandText('""')).toBeNull();
		expect(quotedOperandText('"')).toBeNull();
		expect(quotedOperandText("$'")).toBeNull();
	});
});
