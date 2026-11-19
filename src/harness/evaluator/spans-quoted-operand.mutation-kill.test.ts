import { describe, expect, it } from "vitest";
import { quotedOperandText } from "./spans-quoted-operand.js";

describe("spans-quoted-operand mutation-kill", () => {
	// test-contract: invariant — a quoted body containing a backslash is not one simple word and stays masked
	it("returns null for a single-quoted body with a backslash", () => {
		expect(quotedOperandText("'a\\b'")).toBeNull();
	});

	// test-contract: invariant — a double-quoted body with a backslash and no nested quote stays masked
	it("returns null for a double-quoted body with a backslash", () => {
		expect(quotedOperandText('"C:\\tmp"')).toBeNull();
	});

	// test-contract: public-api — a plain single word still renders as an operand with space-filled delimiters
	it("renders a simple quoted word with space-filled delimiters", () => {
		expect(quotedOperandText("'abc'")).toBe(" abc ");
	});
});
