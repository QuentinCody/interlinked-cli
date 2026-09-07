import { describe, expect, it } from "vitest";
import {
	CODE_FILE_EXT_RE,
	splitCommandSegments,
	splitShellWordsLoose,
	stripOuterQuotes,
} from "./pre-checks-bash-write-shared.js";

describe("shared bash-write parsing primitives", () => {
	it("separates real newlines while preserving quoted newlines", () => {
		expect(splitCommandSegments("echo 'first\nsecond'\ngit status")).toEqual(["echo 'first\nsecond'", "git status"]);
	});

	it("P1: splitCommandSegments splits on &&, ||, ; and |", () => {
		expect(splitCommandSegments("a b && c d ; e | f")).toEqual(["a b", "c d", "e", "f"]);
	});

	it("P2: splitShellWordsLoose keeps quoted strings as one word", () => {
		expect(splitShellWordsLoose(`sed -i 's/a b/c/' x.ts`)).toEqual(["sed", "-i", "'s/a b/c/'", "x.ts"]);
	});

	it("P3: stripOuterQuotes removes one matched quote pair only", () => {
		expect(stripOuterQuotes("'x y'")).toBe("x y");
		expect(stripOuterQuotes('"x"')).toBe("x");
		expect(stripOuterQuotes("plain")).toBe("plain");
	});

	// Review 2026-08-28 (final round, P1): the naive split treated a `|` inside
	// a quoted regex as a pipe, so an upstream flag associated with a
	// downstream command — a read-only pipeline false-blocked as `sed -i`, a
	// zero-FP-contract violation for a deterministic block. Exact case first.
	it("N1: a quoted-alternation pipe is NOT a segment boundary (the reproduced false block)", () => {
		expect(splitCommandSegments(`rg -i 'a|b' src/x.ts | sed -n '1,200p'`)).toEqual([
			`rg -i 'a|b' src/x.ts`,
			`sed -n '1,200p'`,
		]);
	});

	it("N2: double-quoted pipes and escaped pipes stay inside their segment", () => {
		expect(splitCommandSegments(`grep "a|b" f.ts | wc -l`)).toEqual([`grep "a|b" f.ts`, "wc -l"]);
		expect(splitCommandSegments(String.raw`echo a\|b | cat`)).toEqual([String.raw`echo a\|b`, "cat"]);
	});

	it("N3: separators without surrounding whitespace still split (the old regex required it)", () => {
		expect(splitCommandSegments("a|b&&c;d")).toEqual(["a", "b", "c", "d"]);
	});

	it("N4: an unterminated quote consumes to end of string rather than resurrecting the split", () => {
		expect(splitCommandSegments(`rg 'a|b`)).toEqual([`rg 'a|b`]);
	});

	it("P4: CODE_FILE_EXT_RE matches gated source extensions and not docs", () => {
		expect(CODE_FILE_EXT_RE.test("a.ts")).toBe(true);
		expect(CODE_FILE_EXT_RE.test("a.py")).toBe(true);
		expect(CODE_FILE_EXT_RE.test("a.md")).toBe(false);
	});
});
