import { describe, expect, it } from "vitest";
import { addSectionContent, applyPatchHunksStrict, checkPatchEnvelope, trimPatchTrailer } from "./post-image-patch.js";

/** The strict applier works on the BODY lines of one `*** Update File:`
 *  section — the section header, `*** Move to:` and the envelope markers are
 *  consumed by the section parser before this point. */
function body(...lines: readonly string[]): readonly string[] {
	return lines;
}

function applied(before: string, lines: readonly string[]): string {
	const result = applyPatchHunksStrict(before, lines);
	if (!result.ok) throw new Error(`expected a placement, got: ${result.code}`);
	return result.content;
}

function refusedCode(before: string, lines: readonly string[]): string {
	const result = applyPatchHunksStrict(before, lines);
	if (result.ok) throw new Error("expected a refusal, got a placement");
	return result.code;
}

const TWO_BLOCKS = "function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 1;\n}\n";

describe("checkPatchEnvelope — positive (must accept)", () => {
	it("P1: a patch opening with Begin Patch and closing with End Patch is well formed", () => {
		expect(checkPatchEnvelope("*** Begin Patch\n*** Delete File: a.ts\n*** End Patch")).toBeNull();
	});

	it("P2: trailing blank lines after the end marker are tolerated", () => {
		expect(checkPatchEnvelope("*** Begin Patch\n*** Delete File: a.ts\n*** End Patch\n\n")).toBeNull();
	});

	it("P3: an envelope with no section between the markers is still a well-formed envelope", () => {
		expect(checkPatchEnvelope("*** Begin Patch\n*** End Patch")).toBeNull();
	});
});

describe("trimPatchTrailer — positive (must accept)", () => {
	it("P4: blank lines after the end marker are removed, so they cannot leak into the last section's body", () => {
		expect(trimPatchTrailer("*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch\n\n")).toBe(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch",
		);
	});

	it("P5: a payload with no trailing blank line is returned unchanged", () => {
		expect(trimPatchTrailer("*** Begin Patch\n*** End Patch")).toBe("*** Begin Patch\n*** End Patch");
	});

	it("P6: an INTERIOR blank line is a context line and is kept", () => {
		expect(trimPatchTrailer("*** Begin Patch\n@@\n\n-a\n*** End Patch\n")).toBe("*** Begin Patch\n@@\n\n-a\n*** End Patch");
	});
});

describe("checkPatchEnvelope — negative (must reject)", () => {
	it("N1: a patch with no End Patch marker is TRUNCATED and is refused", () => {
		expect(checkPatchEnvelope("*** Begin Patch\n*** Delete File: a.ts")).toBe("missing_end_marker");
	});

	it("N2: a patch that does not open with Begin Patch is refused", () => {
		expect(checkPatchEnvelope("*** Delete File: a.ts\n*** End Patch")).toBe("missing_begin_marker");
	});

	it("N3: an End Patch marker followed by a further section is refused — the terminator must be last", () => {
		expect(checkPatchEnvelope("*** Begin Patch\n*** End Patch\n*** Delete File: a.ts")).toBe("missing_end_marker");
	});

	it("N4: the empty payload is refused", () => {
		expect(checkPatchEnvelope("")).toBe("missing_begin_marker");
	});
});

describe("applyPatchHunksStrict — positive (must accept)", () => {
	it("P7: a bare hunk whose block occurs exactly once is placed at that site", () => {
		expect(applied("const x = 1;\nconst y = 1;\n", body("@@", "-const x = 1;", "+const x = 7;"))).toBe(
			"const x = 7;\nconst y = 1;\n",
		);
	});

	it("P8: an anchor selects the SECOND of two identical blocks", () => {
		expect(applied(TWO_BLOCKS, body("@@ function b() {", "-\treturn 1;", "+\treturn 2;"))).toBe(
			"function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 2;\n}\n",
		);
	});

	it("P9: an anchor selects the FIRST block when the block is unique after it", () => {
		expect(applied("function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 2;\n}\n", body("@@ function a() {", "-\treturn 1;", "+\treturn 9;"))).toBe(
			"function a() {\n\treturn 9;\n}\nfunction b() {\n\treturn 2;\n}\n",
		);
	});

	it("P10: an anchor is matched on the TRIMMED line text, so indentation does not defeat it", () => {
		expect(applied("class C {\n\tmethod() {\n\t\tbody();\n\t}\n}\n", body("@@ method() {", "-\t\tbody();", "+\t\tother();"))).toBe(
			"class C {\n\tmethod() {\n\t\tother();\n\t}\n}\n",
		);
	});

	it("P11: context lines surrounding a deletion are kept and only the deletion is replaced", () => {
		expect(applied("a\nb\nc\n", body("@@", " a", "-b", "+B", " c"))).toBe("a\nB\nc\n");
	});

	it("P12: two hunks in one section both apply, each at its own unique site", () => {
		expect(applied("one\ntwo\n", body("@@", "-one", "+ONE", "@@", "-two", "+TWO"))).toBe("ONE\nTWO\n");
	});

	it("P13: a bare hunk unique among near-duplicate lines is placed without an anchor", () => {
		expect(applied("same();\nsame(1);\n", body("@@", "-same(1);", "+other(1);"))).toBe("same();\nother(1);\n");
	});

	// ── Codex NormalizeToLf terminator rules (file_update.rs) ────────────────
	it("P14: a pre-image with NO final newline GAINS exactly one", () => {
		expect(applied("a", body("@@", "-a", "+b"))).toBe("b\n");
	});

	it("P15: a pre-image ending in TWO newlines collapses to one", () => {
		expect(applied("a\n\n", body("@@", "-a", "+b"))).toBe("b\n");
	});

	it("P16: an untouched tail keeps exactly one terminator, never two", () => {
		expect(applied("a\nb\n\n", body("@@", "-a", "+A"))).toBe("A\nb\n");
	});

	it("P17: deleting the only line leaves the EMPTY string, not a lone newline", () => {
		expect(applied("gone\n", body("@@", "-gone"))).toBe("");
	});

	it("P18: the popped terminator is invisible to the matcher — a hunk anchored at the last line still places", () => {
		expect(applied("a\nb\n", body("@@", " a", "-b", "+B"))).toBe("a\nB\n");
	});

	it("P19: a hunk that appends a line puts the terminator after the NEW last line", () => {
		expect(applied("a\n", body("@@", "-a", "+a", "+b"))).toBe("a\nb\n");
	});

	// ── Codex compute_replacements placement (file_update.rs, D34) ────────────
	it("P24: two ordered hunks are each placed against the ORIGINAL lines and both apply", () => {
		expect(applied("one\ntwo\nthree\n", body("@@", "-one", "+ONE", "@@", "-three", "+THREE"))).toBe("ONE\ntwo\nTHREE\n");
	});

	it("P25: hunk 2 cannot see the text hunk 1 INTRODUCES — it matches the original line of the same spelling", () => {
		// Under the old sequential applier hunk 1's output made TWO `two` lines
		// and hunk 2 was ambiguous. Codex records both replacements against the
		// original and applies them back-to-front, so each lands on its own line.
		expect(applied("one\ntwo\nthree\n", body("@@", "-one", "+two", "@@", "-two", "+TWO"))).toBe("two\nTWO\nthree\n");
	});

	it("P26: a block that also occurs BEFORE the cursor is placed at its single site at or after it", () => {
		// Hunk 1 consumes lines 0-1, so hunk 2's bare `\treturn 1;` matches only
		// the copy inside `function b`, even though line 1 spells it too.
		expect(applied(TWO_BLOCKS, body("@@", " function a() {", "-\treturn 1;", "+\treturn 9;", "@@", "-\treturn 1;", "+\treturn 8;"))).toBe(
			"function a() {\n\treturn 9;\n}\nfunction b() {\n\treturn 8;\n}\n",
		);
	});

	it("P27: a pure insertion is appended at END OF FILE, whatever line the anchor names", () => {
		expect(applied(TWO_BLOCKS, body("@@ function a() {", "+// tail"))).toBe(
			"function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 1;\n}\n// tail\n",
		);
	});

	it("P28: a pure insertion into a pre-image ending in TWO newlines lands BEFORE the empty last line", () => {
		// `a\n\n` pops to ["a", ""], whose last element is empty, so Codex's
		// insertion index is len-1, not len.
		expect(applied("a\n\n", body("@@", "+b"))).toBe("a\nb\n");
	});

	it("P29: a pure insertion into a pre-image with no final newline appends after the last line", () => {
		expect(applied("a", body("@@", "+b"))).toBe("a\nb\n");
	});
});

describe("addSectionContent — positive (must accept)", () => {
	it("P20: one added line is that line PLUS its newline — the reviewer's 20-byte probe", () => {
		expect(addSectionContent(["shadow-review-probe"])).toBe("shadow-review-probe\n");
		expect(Buffer.byteLength(addSectionContent(["shadow-review-probe"]), "utf8")).toBe(20);
	});

	it("P21: every added line carries its own newline, the last one included", () => {
		expect(addSectionContent(["a", "b"])).toBe("a\nb\n");
	});

	it("P22: no added line at all is the EMPTY file, not a lone newline", () => {
		expect(addSectionContent([])).toBe("");
	});

	it("P23: an added BLANK line is a real line and gets its own newline too", () => {
		expect(addSectionContent(["a", "", "b"])).toBe("a\n\nb\n");
	});
});

describe("applyPatchHunksStrict — negative (must reject)", () => {
	it("N5: an anchor matching NO line is anchor_not_found", () => {
		expect(refusedCode(TWO_BLOCKS, body("@@ function c() {", "-\treturn 1;", "+\treturn 2;"))).toBe("anchor_not_found");
	});

	it("N6: an anchor matching TWO lines is ambiguous_anchor", () => {
		expect(refusedCode("dup\nx\ndup\ny\n", body("@@ dup", "-y", "+z"))).toBe("ambiguous_anchor");
	});

	it("N7: a bare hunk whose block matches twice is ambiguous_context", () => {
		expect(refusedCode("same();\nsame();\n", body("@@", "-same();", "+other();"))).toBe("ambiguous_context");
	});

	it("N8: a hunk whose block matches nowhere is context_not_found", () => {
		expect(refusedCode("const x = 1;\n", body("@@", "-const q = 1;", "+const q = 2;"))).toBe("context_not_found");
	});

	it("N15: an anchor bounds the search BELOW only — naming the first of two identical blocks is still ambiguous", () => {
		expect(refusedCode(TWO_BLOCKS, body("@@ function a() {", "-\treturn 1;", "+\treturn 2;"))).toBe("ambiguous_context");
	});

	it("N9: a block that occurs only BEFORE the anchor is context_not_found, never wrapped around", () => {
		expect(refusedCode("only();\nanchor();\n", body("@@ anchor();", "-only();", "+other();"))).toBe("context_not_found");
	});

	it("N10: a hunk with NO line at all is refused — Codex's parser calls it 'Update hunk does not contain any lines'", () => {
		// Corrected 2026-09-05 (D34). This case used to be `@@` + `+b`, which
		// pinned the old refusal of every pure insertion. Codex INSERTS such a
		// hunk at EOF (`file_update.rs`, the `old_lines.is_empty()` branch), so
		// that shape is now P27-P29; the code survives for the truly empty hunk,
		// which Codex refuses at parse time.
		expect(refusedCode("a\n", body("@@"))).toBe("hunk_without_context_or_deletion");
	});

	it("N18: DEPENDENT hunks are refused — hunk 2 may not match what hunk 1 wrote", () => {
		// The reviewer measured the real tool on exactly this shape: "Failed to
		// find expected lines … bravo". The old sequential applier answered
		// `charlie\nomega\n`, a post-image the local apply never produces.
		expect(refusedCode("alpha\nomega\n", body("@@", "-alpha", "+bravo", "@@", "-bravo", "+charlie"))).toBe("context_not_found");
	});

	it("N19: REVERSED hunks are refused — the cursor only moves forward", () => {
		expect(refusedCode("one\ntwo\n", body("@@", "-two", "+TWO", "@@", "-one", "+ONE"))).toBe("context_not_found");
	});

	it("N20: OVERLAPPING hunks are refused — hunk 2's site lies inside hunk 1's block", () => {
		expect(refusedCode("one\ntwo\n", body("@@", "-one", "-two", "+ONE", "+TWO", "@@", "-two", "+two again"))).toBe("context_not_found");
	});

	it("N21: an anchor that occurs only BEFORE the cursor is anchor_not_found, never a wrap-around", () => {
		expect(refusedCode(TWO_BLOCKS, body("@@ function b() {", "-\treturn 1;", "+\treturn 2;", "@@ function a() {", "-}", "+};"))).toBe(
			"anchor_not_found",
		);
	});

	it("N22: an unfindable anchor refuses even a pure insertion, because the anchor is resolved FIRST", () => {
		expect(refusedCode("a\n", body("@@ nowhere", "+b"))).toBe("anchor_not_found");
	});

	it("N11: a body line carrying an unknown prefix is malformed_hunk_line", () => {
		expect(refusedCode("a\n", body("@@", "!a"))).toBe("malformed_hunk_line");
	});

	it("N24: `@@anchor` (no space after the marker) is malformed_hunk_line — the native tool refuses it (session review r2, finding 3)", () => {
		// parser.rs knows exactly `@@` and `@@ <context>`; the live tool answered
		// this shape with "Unexpected line found in update hunk: '@@anchor'".
		// Reading it as a header projected `anchor\nbravo\n` for a patch that
		// cannot execute.
		expect(refusedCode("anchor\nalpha\n", body("@@anchor", "-alpha", "+bravo"))).toBe("malformed_hunk_line");
		expect(refusedCode("anchor\nalpha\n", body("@@\tanchor", "-alpha", "+bravo"))).toBe("malformed_hunk_line");
	});

	it("N12: a body line before the first @@ marker is hunk_body_before_marker", () => {
		expect(refusedCode("a\n", body("-a", "+b"))).toBe("hunk_body_before_marker");
	});

	it("N13: an update section carrying no hunk at all is update_without_hunk", () => {
		expect(refusedCode("a\n", body())).toBe("update_without_hunk");
	});

	it("N14: the SECOND hunk's failure refuses the whole section — no partial placement", () => {
		expect(refusedCode("one\ntwo\n", body("@@", "-one", "+ONE", "@@", "-three", "+THREE"))).toBe("context_not_found");
	});

	it("N16: a CRLF pre-image line is NOT matched by an LF-only pattern — one match strategy, no fuzzy ladder", () => {
		// Codex WOULD place this: seek_sequence.rs falls back from exact match
		// to `trim_end()`, which drops the "\r". This projector refuses rather
		// than guess which rung the local apply used; `shadow: unavailable`
		// beats a confidently wrong post_tree_hash. See the corpus row
		// `apply-patch-update-crlf-rejects`.
		expect(refusedCode("const x = 1;\r\n", body("@@", "-const x = 1;", "+const x = 7;"))).toBe("context_not_found");
	});

	it("N17: trailing whitespace is likewise not trimmed away before matching", () => {
		expect(refusedCode("a  \n", body("@@", "-a", "+b"))).toBe("context_not_found");
	});
});
