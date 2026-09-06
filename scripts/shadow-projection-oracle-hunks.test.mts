import { describe, expect, it } from "vitest";
import { oracleApplyHunks } from "./shadow-projection-oracle-hunks.mjs";

/** The oracle's own placement model, exercised directly. The corpus generator
 *  reaches it through `oracleProject`, which means a divergence between the two
 *  implementations shows up there as a whole-row disagreement with no line to
 *  point at; these cases pin the arithmetic itself. */
function applied(before: string, ...lines: readonly string[]): string {
	const result = oracleApplyHunks(before, lines);
	if (!result.ok) throw new Error(`expected a placement, got: ${result.reason}`);
	return result.value;
}

function refused(before: string, ...lines: readonly string[]): string {
	const result = oracleApplyHunks(before, lines);
	if (result.ok) throw new Error(`expected a refusal, got: ${JSON.stringify(result.value)}`);
	return result.reason;
}

const TWO_BLOCKS = "function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 1;\n}\n";

describe("oracleApplyHunks — positive (must accept)", () => {
	it("P1: a single hunk replaces its one matching block", () => {
		expect(applied("one\ntwo\n", "@@", "-one", "+ONE")).toBe("ONE\ntwo\n");
	});

	it("P2: two ordered hunks are BOTH placed against the original lines", () => {
		expect(applied("one\ntwo\nthree\n", "@@", "-one", "+ONE", "@@", "-three", "+THREE")).toBe("ONE\ntwo\nTHREE\n");
	});

	it("P3: hunk 2 matches the ORIGINAL line, never the text hunk 1 introduces", () => {
		expect(applied("one\ntwo\nthree\n", "@@", "-one", "+two", "@@", "-two", "+TWO")).toBe("two\nTWO\nthree\n");
	});

	it("P4: an @@ anchor selects the second of two identical blocks", () => {
		expect(applied(TWO_BLOCKS, "@@ function b() {", "-\treturn 1;", "+\treturn 2;")).toBe(
			"function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 2;\n}\n",
		);
	});

	it("P5: the cursor alone disambiguates a block that also occurs before it", () => {
		expect(applied(TWO_BLOCKS, "@@", " function a() {", "-\treturn 1;", "+\treturn 9;", "@@", "-\treturn 1;", "+\treturn 8;")).toBe(
			"function a() {\n\treturn 9;\n}\nfunction b() {\n\treturn 8;\n}\n",
		);
	});

	it("P6: a pure insertion goes to END OF FILE whatever the anchor names", () => {
		expect(applied(TWO_BLOCKS, "@@ function a() {", "+// tail")).toBe(`${TWO_BLOCKS}// tail\n`);
	});

	it("P7: a pure insertion into a `…\\n\\n` pre-image lands before the empty last line", () => {
		expect(applied("a\n\n", "@@", "+b")).toBe("a\nb\n");
	});

	it("P8: a pre-image with no final newline gains exactly one", () => {
		expect(applied("a", "@@", "-a", "+b")).toBe("b\n");
	});

	it("P9: deleting the only line leaves the empty string, not a lone newline", () => {
		expect(applied("gone\n", "@@", "-gone")).toBe("");
	});
});

describe("oracleApplyHunks — negative (must reject)", () => {
	it("N1: DEPENDENT hunks are refused — the reviewer's measured native failure", () => {
		expect(refused("alpha\nomega\n", "@@", "-alpha", "+bravo", "@@", "-bravo", "+charlie")).toBe("context_not_found");
	});

	it("N2: REVERSED hunks are refused — the cursor only moves forward", () => {
		expect(refused("one\ntwo\n", "@@", "-two", "+TWO", "@@", "-one", "+ONE")).toBe("context_not_found");
	});

	it("N2b: `@@anchor` with no space after the marker is malformed — the native grammar knows only `@@` and `@@ ` (review r2, finding 3)", () => {
		expect(refused("anchor\nalpha\n", "@@anchor", "-alpha", "+bravo")).toBe("malformed_hunk_line");
	});

	it("N3: OVERLAPPING hunks are refused", () => {
		expect(refused("one\ntwo\n", "@@", "-one", "-two", "+ONE", "+TWO", "@@", "-two", "+again")).toBe("context_not_found");
	});

	it("N4: an anchor that occurs only before the cursor is anchor_not_found", () => {
		expect(refused(TWO_BLOCKS, "@@ function b() {", "-\treturn 1;", "+\treturn 2;", "@@ function a() {", "-}", "+};")).toBe(
			"anchor_not_found",
		);
	});

	it("N5: an ambiguous block is refused rather than resolved to the first site", () => {
		expect(refused("same();\nsame();\n", "@@", "-same();", "+other();")).toBe("ambiguous_context");
	});

	it("N6: an anchor matching two lines is ambiguous_anchor", () => {
		expect(refused("dup\nx\ndup\ny\n", "@@ dup", "-y", "+z")).toBe("ambiguous_anchor");
	});

	it("N7: a hunk carrying no line at all is refused, as Codex's parser refuses an empty chunk", () => {
		expect(refused("a\n", "@@")).toBe("hunk_without_context_or_deletion");
	});

	it("N8: a body line before the first @@ marker is refused", () => {
		expect(refused("a\n", "-a", "+b")).toBe("hunk_body_before_marker");
	});

	it("N9: an update body with no hunk at all is refused", () => {
		expect(refused("a\n")).toBe("update_without_hunk");
	});

	it("N10: a body line with an unknown prefix is refused", () => {
		expect(refused("a\n", "@@", "!a")).toBe("malformed_hunk_line");
	});

	it("N11: an LF-only pattern does not match a CRLF line — one strategy, no fuzzy ladder", () => {
		expect(refused("const x = 1;\r\n", "@@", "-const x = 1;", "+const x = 7;")).toBe("context_not_found");
	});
});
