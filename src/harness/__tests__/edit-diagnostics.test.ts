import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	buildNearMissWarning,
	countOccurrences,
	findClosestSpans,
	findOccurrenceLines,
	firstDivergenceLine,
	formatNearMisses,
	formatRescue,
	suggestUniqueAnchor,
} from "../edit-diagnostics.js";

describe("findClosestSpans", () => {
	it("returns no matches when target is empty", () => {
		expect(findClosestSpans("foo\nbar", "")).toEqual([]);
	});

	it("returns no matches when content is empty", () => {
		expect(findClosestSpans("", "foo")).toEqual([]);
	});

	it("returns no matches when target longer than file", () => {
		expect(findClosestSpans("a\nb", "a\nb\nc\nd")).toEqual([]);
	});

	it("finds whitespace-variant single-line near miss", () => {
		const content = ["function foo() {", "  return 1;", "}"].join("\n");
		const target = "function foo () {";
		const misses = findClosestSpans(content, target, 3);
		expect(misses.length).toBeGreaterThan(0);
		expect(nonNull(misses[0]).line).toBe(1);
		expect(nonNull(misses[0]).similarity).toBeGreaterThan(0.7);
	});

	it("finds a short single-line target with few window matches (exercises the extra single-line scan path)", () => {
		// A short single-line target with only one line in the file scoring
		// above threshold — this drives `candidates.length < n` after the
		// windowed pass, so the extra `addShortSingleLineCandidates` scan runs.
		const content = ["zzzzzzzzzzzz", "hello", "zzzzzzzzzzzz"].join("\n");
		const target = "hello";
		const misses = findClosestSpans(content, target, 3);
		expect(misses.length).toBe(1);
		expect(nonNull(misses[0]).line).toBe(2);
		expect(nonNull(misses[0]).similarity).toBe(1);
	});

	it("returns every scored line verbatim for a short single-line target", () => {
		// Pins the whole NearMiss shape the short-single-line scan produces: two
		// exact matches far enough apart to survive dedup, and a near match that
		// is dropped for sitting adjacent to a better one. Fails if the scan
		// stops pushing candidates for this target shape.
		const content = ["hello", "helloo", "zzzzzzzz", "hello"].join("\n");
		const misses = findClosestSpans(content, "hello", 3);
		expect(misses).toEqual([
			{ line: 1, endLine: 1, snippet: "hello", lines: ["hello"], similarity: 1 },
			{ line: 4, endLine: 4, snippet: "hello", lines: ["hello"], similarity: 1 },
		]);
	});

	it("finds multi-line near miss with one differing line", () => {
		const content = [
			"export function bar() {",
			"  const x = 1;",
			"  return x + 1;",
			"}",
			"",
			"export function baz() {",
			"  return 2;",
			"}",
		].join("\n");
		const target = ["export function bar() {", "  const x = 2;", "  return x + 1;", "}"].join(
			"\n",
		);
		const misses = findClosestSpans(content, target, 3);
		expect(nonNull(misses[0]).line).toBe(1);
		expect(nonNull(misses[0]).similarity).toBeGreaterThan(0.6);
	});

	it("returns up to N matches when several spans qualify", () => {
		const content = [
			"function alpha() {}",
			"function beta() {}",
			"function gamma() {}",
			"function delta() {}",
		].join("\n");
		const target = "function omega() {}";
		const misses = findClosestSpans(content, target, 3);
		expect(misses.length).toBeLessThanOrEqual(3);
		expect(misses.every((m) => m.similarity >= 0.4)).toBe(true);
	});

	it("returns empty when nothing similar enough", () => {
		const content = "completely\nunrelated\ncontent\nhere";
		const target = "xQzZyY!@#$%^&*";
		expect(findClosestSpans(content, target)).toEqual([]);
	});

	it("dedupes overlapping windows by keeping the highest score", () => {
		const content = [
			"const x = 1;",
			"const x = 1;",
			"const x = 1;",
			"const y = 2;",
			"const z = 3;",
		].join("\n");
		const target = ["const x = 1;", "const x = 1;"].join("\n");
		const misses = findClosestSpans(content, target, 3);
		// Three overlapping windows would all match; dedup should collapse them
		// such that consecutive results don't overlap.
		for (let i = 1; i < misses.length; i++) {
			expect(Math.abs(nonNull(misses[i]).line - nonNull(misses[i - 1]).line)).toBeGreaterThanOrEqual(2);
		}
	});

	it("ranks higher-similarity spans first", () => {
		const content = [
			"function foo(x: number): number { return x; }",
			"function fooo(x: string): string { return x; }",
		].join("\n");
		const target = "function foo(x: number): number { return x; }";
		const misses = findClosestSpans(content, target, 2);
		expect(nonNull(misses[0]).line).toBe(1);
		expect(nonNull(misses[0]).similarity).toBe(1);
		if (misses.length > 1) {
			expect(nonNull(misses[0]).similarity).toBeGreaterThan(nonNull(misses[1]).similarity);
		}
	});

	it("returns no matches when content is empty even if target is only whitespace", () => {
		// A whitespace-only target is truthy as a string, so this exercises the
		// `!content` half of the guard specifically (not just `!target`).
		expect(findClosestSpans("", " ")).toEqual([]);
	});

	it("finds a match when the file has exactly as many lines as the target", () => {
		// Boundary: fileLines.length === targetLines.length must NOT early-return.
		const misses = findClosestSpans("a\nb", "a\nb");
		expect(misses.length).toBe(1);
		expect(nonNull(misses[0]).line).toBe(1);
		expect(nonNull(misses[0]).similarity).toBe(1);
	});

	it("does not fuzzy-match a multi-line target against unrelated single lines", () => {
		// Guards against the multi-line-short-target heuristic incorrectly
		// applying to a 2-line target: only "abxcd" has any bigram overlap with
		// the raw "ab\ncd" string, and only via the (incorrect) single-line scan.
		const content = ["zzzzz", "abxcd", "wwwww"].join("\n");
		expect(findClosestSpans(content, "ab\ncd")).toEqual([]);
	});

	it("finds a match anchored at the very last valid window position", () => {
		const content = ["xxxx", "5555", "alpha", "beta"].join("\n");
		const misses = findClosestSpans(content, "alpha\nbeta");
		expect(misses.length).toBe(1);
		expect(nonNull(misses[0]).line).toBe(3);
		expect(nonNull(misses[0]).endLine).toBe(4);
		expect(nonNull(misses[0]).similarity).toBe(1);
	});

	it("finds an exact multi-line match with the correct line range and content", () => {
		const content = ["A", "B", "C", "D", "E"].join("\n");
		const misses = findClosestSpans(content, "C\nD");
		expect(misses.length).toBe(1);
		expect(nonNull(misses[0]).line).toBe(3);
		expect(nonNull(misses[0]).endLine).toBe(4);
		expect(nonNull(misses[0]).lines).toEqual(["C", "D"]);
		expect(nonNull(misses[0]).similarity).toBe(1);
	});

	it("includes a window match exactly at the similarity threshold, correctly averaged", () => {
		// "abc" vs "bcde" has Dice similarity exactly 0.4; both lines of the
		// window average to exactly MIN_SIMILARITY, which must be INCLUDED
		// (>= threshold), and the averaging must be a division, not something
		// else that would push it out of range.
		const content = ["zzzz", "bcde", "bcde", "wwww"].join("\n");
		const misses = findClosestSpans(content, "abc\nabc");
		expect(misses.length).toBe(1);
		expect(nonNull(misses[0]).line).toBe(2);
		expect(nonNull(misses[0]).similarity).toBeCloseTo(0.4, 10);
	});

	it("sorts results by similarity even when the best match sits on a later line", () => {
		const content = [
			"function fooo(x: string): string { return x; }",
			"unrelated1",
			"unrelated2",
			"function foo(x: number): number { return x; }",
		].join("\n");
		const target = "function foo(x: number): number { return x; }";
		const misses = findClosestSpans(content, target, 3);
		expect(nonNull(misses[0]).line).toBe(4);
		expect(nonNull(misses[0]).similarity).toBe(1);
		expect(nonNull(misses[1]).line).toBe(1);
	});

	it("matches across leading/trailing whitespace on both sides of the comparison", () => {
		// Line 1 of the target has leading whitespace the file line lacks;
		// line 2 of the FILE has leading/trailing whitespace the target lacks.
		// Both sides must be trimmed for this to score a perfect match.
		const content = ["xxx", "foo", "  bar  ", "yyy"].join("\n");
		const misses = findClosestSpans(content, "  foo\nbar");
		expect(misses.length).toBe(1);
		expect(nonNull(misses[0]).line).toBe(2);
		expect(nonNull(misses[0]).endLine).toBe(3);
		expect(nonNull(misses[0]).similarity).toBe(1);
	});

	it("does not report a match between two unrelated single characters", () => {
		// Both "x" and "y" have empty bigram sets; the fallback for that case
		// must not fall through to a 0/0 division.
		expect(findClosestSpans("zzz\ny\nzzz", "x")).toEqual([]);
	});

	it("requires real shared bigrams, not just a shared prefix, to score high", () => {
		const content = ["xxxx", "abcd", "yyyy"].join("\n");
		const misses = findClosestSpans(content, "abc");
		expect(misses.length).toBe(1);
		expect(nonNull(misses[0]).line).toBe(2);
		expect(nonNull(misses[0]).similarity).toBeCloseTo(0.8, 10);
	});

	it("truncates the snippet to 120 characters and trims surrounding whitespace", () => {
		const longLine = `  ${"A".repeat(150)}  `;
		const content = [longLine, "BBB"].join("\n");
		const misses = findClosestSpans(content, "AAA\nBBB");
		expect(misses.length).toBe(1);
		expect(nonNull(misses[0]).snippet.length).toBe(120);
		expect(nonNull(misses[0]).snippet.startsWith(" ")).toBe(false);
	});

	it("caps results at n and keeps the highest-similarity non-overlapping matches", () => {
		const content = [
			"ALPHA",
			"BETA",
			"junk1",
			"junk2",
			"ALPHA",
			"BETA",
			"junk3",
			"junk4",
			"ALPHA",
			"BETA",
		].join("\n");
		const misses = findClosestSpans(content, "ALPHA\nBETA", 2);
		expect(misses.map((m) => m.line)).toEqual([1, 5]);
	});

	it("collapses adjacent single-line matches into one", () => {
		const content = ["ALPHA", "ALPHA", "junk", "junk"].join("\n");
		const misses = findClosestSpans(content, "ALPHA", 3);
		expect(misses.map((m) => m.line)).toEqual([1]);
	});

	it("keeps two single-line matches that sit exactly at the overlap boundary apart", () => {
		const content = ["ALPHA", "junk", "ALPHA", "junk2"].join("\n");
		const misses = findClosestSpans(content, "ALPHA", 3);
		expect(misses.map((m) => m.line)).toEqual([1, 3]);
	});
});

describe("formatNearMisses", () => {
	it("returns empty string for no misses", () => {
		expect(formatNearMisses([])).toBe("");
	});

	it("formats with line, percent, and snippet", () => {
		const formatted = formatNearMisses([
			{ line: 42, endLine: 42, snippet: "function foo()", lines: ["function foo()"], similarity: 0.875 },
		]);
		expect(formatted).toContain("L42");
		expect(formatted).toContain("88%");
		expect(formatted).toContain("function foo()");
	});

	it("joins multiple misses with newlines", () => {
		const formatted = formatNearMisses([
			{ line: 1, endLine: 1, snippet: "a", lines: ["a"], similarity: 1 },
			{ line: 5, endLine: 5, snippet: "b", lines: ["b"], similarity: 0.6 },
		]);
		expect(formatted.split("\n").length).toBe(2);
	});
});

describe("firstDivergenceLine", () => {
	it("returns null when target and span are identical line-for-line", () => {
		expect(firstDivergenceLine("a\nb\nc", ["a", "b", "c"])).toBeNull();
	});

	it("returns the 1-based index of the first differing line", () => {
		expect(firstDivergenceLine("a\nb\nc", ["a", "X", "c"])).toBe(2);
	});

	it("detects a divergence in the extra length when the span is shorter than the target", () => {
		// max(targetLines.length, spanLines.length) must scan the LONGER side —
		// the extra target line 3 has nothing to compare against (undefined),
		// which must count as a divergence at that index, not be skipped.
		expect(firstDivergenceLine("a\nb\nc", ["a", "b"])).toBe(3);
	});
});

describe("countOccurrences", () => {
	it("returns 0 for an empty target", () => {
		expect(countOccurrences("abcabc", "")).toBe(0);
	});

	it("counts non-overlapping exact occurrences", () => {
		expect(countOccurrences("abcabcabc", "abc")).toBe(3);
	});

	it("returns 0 when the target never appears", () => {
		expect(countOccurrences("hello world", "xyz")).toBe(0);
	});
});

describe("findOccurrenceLines", () => {
	it("returns an empty array for an empty target", () => {
		expect(findOccurrenceLines("line1\nline2", "")).toEqual([]);
	});

	it("returns the 1-based start line of each occurrence", () => {
		const content = "alpha\nneedle here\nbeta\nneedle again";
		expect(findOccurrenceLines(content, "needle")).toEqual([2, 4]);
	});

	it("returns an empty array when nothing matches", () => {
		expect(findOccurrenceLines("no match here", "zzz")).toEqual([]);
	});

	it("counts newlines strictly before the match, not at its own leading newline", () => {
		// The match itself starts with "\n" (target = "\nbbb"). That leading
		// newline must NOT be counted as occurring "before" the match.
		expect(findOccurrenceLines("aaa\n\nbbb", "\nbbb")).toEqual([2]);
	});
});

describe("formatRescue", () => {
	it("returns an empty string when there are no misses", () => {
		expect(formatRescue([], "target")).toBe("");
	});

	it("renders the best span fenced, with the divergence line called out", () => {
		const misses = [
			{
				line: 3,
				endLine: 4,
				snippet: "function foo() {",
				lines: ["function foo() {", "  return 2;"],
				similarity: 0.8,
			},
		];
		const rescue = formatRescue(misses, "function foo() {\n  return 1;");
		expect(rescue).toContain("lines 3–4");
		expect(rescue).toContain("80% similar");
		expect(rescue).toContain("```");
		expect(rescue).toContain("function foo() {");
		expect(rescue).toContain("  return 2;");
		expect(rescue).toContain("First line differing from your old_string: line 4.");
	});

	it("uses a ~~~~ fence when the span itself contains a ``` line", () => {
		const misses = [
			{
				line: 1,
				endLine: 2,
				snippet: "```ts",
				lines: ["```ts", "code"],
				similarity: 0.9,
			},
		];
		const rescue = formatRescue(misses, "```ts\ncode");
		expect(rescue).toContain("~~~~");
	});

	it("lists runner-up matches when more than one miss is given", () => {
		const misses = [
			{ line: 1, endLine: 1, snippet: "best", lines: ["best"], similarity: 0.9 },
			{ line: 10, endLine: 10, snippet: "second", lines: ["second"], similarity: 0.5 },
		];
		const rescue = formatRescue(misses, "best");
		expect(rescue).toContain("Also similar:");
		expect(rescue).toContain("L10");
	});

	it("elides very long spans down to head + tail", () => {
		const longLines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		const misses = [
			{
				line: 1,
				endLine: 60,
				snippet: "line 0",
				lines: longLines,
				similarity: 1,
			},
		];
		const rescue = formatRescue(misses, longLines.join("\n"));
		expect(rescue).toContain("lines elided");
		expect(rescue).not.toContain("line 30");
		expect(rescue).toContain("line 0");
		expect(rescue).toContain("line 59");
	});

	it("reports the exact number of elided lines (60 total, 15 head + 15 tail)", () => {
		const longLines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		const misses = [{ line: 1, endLine: 60, snippet: "line 0", lines: longLines, similarity: 1 }];
		const rescue = formatRescue(misses, longLines.join("\n"));
		expect(rescue).toContain("(30 lines elided)");
	});

	it("does not elide a short span", () => {
		const misses = [{ line: 1, endLine: 2, snippet: "a", lines: ["a", "b"], similarity: 1 }];
		const rescue = formatRescue(misses, "a\nb");
		expect(rescue).not.toContain("elided");
	});

	it("does not elide exactly at the 40-line cap", () => {
		const lines40 = Array.from({ length: 40 }, (_, i) => `line${i}`);
		const misses = [{ line: 1, endLine: 40, snippet: "line0", lines: lines40, similarity: 1 }];
		const rescue = formatRescue(misses, lines40.join("\n"));
		expect(rescue).not.toContain("elided");
	});

	it("elides when the byte cap is exceeded even though the line count is small", () => {
		const bigLines = Array.from({ length: 5 }, () => "x".repeat(700));
		const misses = [{ line: 1, endLine: 5, snippet: "x", lines: bigLines, similarity: 1 }];
		const rescue = formatRescue(misses, bigLines.join("\n"));
		expect(rescue).toContain("elided");
	});

	it("does not elide exactly at the 3000-byte boundary", () => {
		// 3 lines * (999 chars + 1 newline byte) = 3000 exactly.
		const lines = Array.from({ length: 3 }, () => "y".repeat(999));
		const misses = [{ line: 1, endLine: 3, snippet: "y", lines, similarity: 1 }];
		const rescue = formatRescue(misses, lines.join("\n"));
		expect(rescue).not.toContain("elided");
	});

	it("elides once the byte count crosses the cap via longer lines", () => {
		// 3 lines * (1001 chars + 1) = 3006, just over the 3000-byte cap.
		const lines = Array.from({ length: 3 }, () => "z".repeat(1001));
		const misses = [{ line: 1, endLine: 3, snippet: "z", lines, similarity: 1 }];
		const rescue = formatRescue(misses, lines.join("\n"));
		expect(rescue).toContain("elided");
	});

	it("escapes an indented code-fence line with the alternate fence", () => {
		const misses = [
			{
				line: 1,
				endLine: 2,
				snippet: "```ts",
				lines: ["  ```ts", "code"],
				similarity: 1,
			},
		];
		const rescue = formatRescue(misses, "  ```ts\ncode");
		expect(rescue).toContain("~~~~");
	});

	it("starts with the closest-match header, not a placeholder", () => {
		const misses = [{ line: 1, endLine: 2, snippet: "a", lines: ["a", "b"], similarity: 1 }];
		const rescue = formatRescue(misses, "a\nb");
		expect(rescue.startsWith("Closest match")).toBe(true);
	});

	it("includes the exact copy-verbatim instruction sentence", () => {
		const misses = [{ line: 1, endLine: 2, snippet: "a", lines: ["a", "b"], similarity: 1 }];
		const rescue = formatRescue(misses, "a\nb");
		expect(rescue).toContain(
			"Current file content for that range — copy it EXACTLY (including whitespace) as your old_string:",
		);
	});

	it("does not call out a divergence line when the span is unchanged and multi-line", () => {
		const misses = [{ line: 2, endLine: 3, snippet: "a", lines: ["a", "b"], similarity: 1 }];
		const rescue = formatRescue(misses, "a\nb");
		expect(rescue).not.toContain("First line differing");
	});

	it("does not call out a divergence line for a differing single-line span", () => {
		const misses = [
			{ line: 5, endLine: 5, snippet: "const x = 2;", lines: ["const x = 2;"], similarity: 0.8 },
		];
		const rescue = formatRescue(misses, "const x = 1;");
		expect(rescue).not.toContain("First line differing");
	});

	it("excludes the best match from its own list of runners-up", () => {
		const misses = [
			{ line: 1, endLine: 1, snippet: "ALPHA", lines: ["ALPHA"], similarity: 0.9 },
			{ line: 10, endLine: 10, snippet: "BETA", lines: ["BETA"], similarity: 0.5 },
		];
		const rescue = formatRescue(misses, "ALPHA");
		const alsoSimilar = rescue.split("Also similar:")[1] ?? "";
		expect(alsoSimilar).not.toContain("ALPHA");
		expect(alsoSimilar).toContain("BETA");
	});

	it("omits the also-similar section when there is only one match", () => {
		const misses = [{ line: 1, endLine: 2, snippet: "a", lines: ["a", "b"], similarity: 1 }];
		const rescue = formatRescue(misses, "a\nb");
		expect(rescue).not.toContain("Also similar");
	});

	it("joins multiple runners-up with a trimmed semicolon separator", () => {
		const misses = [
			{ line: 1, endLine: 1, snippet: "BEST", lines: ["BEST"], similarity: 0.95 },
			{ line: 5, endLine: 5, snippet: "X", lines: ["X"], similarity: 0.6 },
			{ line: 8, endLine: 8, snippet: "Y", lines: ["Y"], similarity: 0.5 },
		];
		const rescue = formatRescue(misses, "BEST");
		// A tight "; L8" (single space, no leading indent) only appears if the
		// runner-up segments were both trimmed AND joined with "; ".
		expect(rescue).toContain("; L8");
	});

	it("renders the rescue block across multiple lines", () => {
		const misses = [
			{ line: 1, endLine: 1, snippet: "BEST", lines: ["BEST"], similarity: 0.95 },
			{ line: 5, endLine: 5, snippet: "X", lines: ["X"], similarity: 0.6 },
		];
		const rescue = formatRescue(misses, "BEST");
		expect(rescue).toContain("\n");
	});
});

describe("buildNearMissWarning", () => {
	it("wraps the rescue block with a file path and retry instruction", () => {
		const misses = [
			{ line: 5, endLine: 5, snippet: "const x = 1;", lines: ["const x = 1;"], similarity: 1 },
		];
		const warning = buildNearMissWarning("src/foo.ts", misses, "const x = 1;");
		expect(warning).toContain("[interlinked:edit-near-miss] old_string not found in src/foo.ts");
		expect(warning).toContain("const x = 1;");
		expect(warning).toContain("Retry with the exact current text — no re-read needed.");
	});
});

describe("suggestUniqueAnchor", () => {
	it("returns null when the target is unique or absent", () => {
		expect(suggestUniqueAnchor("only one match here", "only one")).toBeNull();
		expect(suggestUniqueAnchor("nothing matches", "zzz")).toBeNull();
	});

	it("extends forward by one line when that disambiguates", () => {
		const content = [
			"function foo() {",
			"  return 1;",
			"}",
			"function foo() {",
			"  return 2;",
			"}",
		].join("\n");
		const anchor = suggestUniqueAnchor(content, "function foo() {");
		expect(anchor).not.toBeNull();
		expect(countOccurrences(content, anchor ?? "")).toBe(1);
		expect(anchor).toContain("return 1;");
	});

	it("falls back to extending backward when forward extension can't disambiguate", () => {
		// Both occurrences of TARGET sit on the last line, so there is no
		// newline after the first occurrence (forward extension fails
		// immediately); the preceding line disambiguates it instead.
		const content = "prefix\nline2 TARGET stuff TARGET";
		const anchor = suggestUniqueAnchor(content, "TARGET");
		expect(anchor).not.toBeNull();
		expect(countOccurrences(content, anchor ?? "")).toBe(1);
		expect(anchor).toContain("line2 TARGET");
	});

	it("returns null when neither direction can disambiguate within the extension budget", () => {
		// Two byte-for-byte identical blocks: extending up to 3 lines in
		// either direction from TARGET produces the same candidate text in
		// both copies, so uniqueness can never be achieved.
		const block = ["same", "same", "same", "TARGET", "same", "same", "same"].join("\n");
		const content = `${block}\n${block}`;
		expect(suggestUniqueAnchor(content, "TARGET")).toBeNull();
	});

	it("does not try to extend a target that is already unique, even with newlines nearby", () => {
		// Exactly one occurrence: the <=1 short-circuit must fire immediately
		// rather than falling through to a (redundant, incorrect) extension.
		expect(suggestUniqueAnchor("prefix\nUNIQUE_TARGET\nsuffix", "UNIQUE_TARGET")).toBeNull();
	});

	it("extends forward through the end of file when there is no trailing newline", () => {
		const content = "NEEDLE end\nNEEDLE end";
		expect(suggestUniqueAnchor(content, "NEEDLE")).toBe(content);
	});

	it("extends backward past the immediately preceding newline to the line before it", () => {
		// Forward fails (both occurrences share the last line). Backward must
		// skip the newline directly before "NEEDLE" and land on "BBB\nNEEDLE",
		// not re-find the same adjacent newline (a no-op) or overshoot by one
		// character.
		const anchor = suggestUniqueAnchor("AAA\nBBB\nNEEDLE NEEDLE", "NEEDLE");
		expect(anchor).toBe("BBB\nNEEDLE");
	});

	it("returns null when only one line precedes the match and it still cannot disambiguate", () => {
		// Only "before" precedes the match's line, with no newline before that.
		// The bail-out guard must actually stop the search here rather than
		// wrapping/underflowing into a bogus non-null anchor.
		expect(suggestUniqueAnchor("before\nNEEDLE NEEDLE", "NEEDLE")).toBeNull();
	});
});
