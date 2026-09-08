// Mutation-kill companion for assert-side-effects.ts — targets the 99
// surviving mutants from `npx tsx src/index.ts mutation survivors --file
// src/harness/checks/assert-side-effects.ts --json` (snapshot:
// scratch/fleet-r3/asve-survivors.json). Each case is labeled with the
// mutantId(s) it targets in a comment. See
// scratch/fleet-r3/src_harness_checks_assert-side-effects.ts-shadow-verify.mts
// for the empirical kill verification against the exact mutator text.

import { describe, expect, it } from "vitest";
import {
	checkCAssertSideEffects,
	checkJavaAssertSideEffects,
	checkPythonAssertSideEffects,
	checkPythonAssertTautology,
	detectAssertSideEffect,
} from "./assert-side-effects.js";

const C_PATH = "src/core/hmr.c";
const PY_PATH = "src/cache/store.py";
const JAVA_PATH = "src/main/java/com/acme/Registry.java";

// ─── (module) — QUERY_CONTINUATION_SEGMENTS as a verb-first continuation ──────
// Targets: 2145ac74dc51549f "len", 74409184d8869e94 "length",
// 3027d02fdf473292 "count", 10c61ed0a67a12c8 "empty",
// ebfa43858f79fe4b "capacity", 12182c366ea40260 "is" (1st occurrence),
// d7b34ee0d6ecaa70 "exists", fe1feb9428205e11 "was" (1st),
// aea7fd09696b01ab "has" (1st), 5349a0a3606001d3 "should",
// 68b9118e2235f786 "can" (1st).
describe("detectAssertSideEffect — QUERY_CONTINUATION_SEGMENTS (verb_continuation is an accessor)", () => {
	it("set_len / set_length / set_count / set_empty / set_capacity are accessors, not mutations", () => {
		expect(detectAssertSideEffect("set_len(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_length(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_count(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_empty(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_capacity(x)", "snake")).toBe(false);
	});

	it("set_is / set_exists / set_was / set_has / set_should / set_can are accessors, not mutations", () => {
		expect(detectAssertSideEffect("set_is(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_exists(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_was(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_has(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_should(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("set_can(x)", "snake")).toBe(false);
	});
});

// ─── (module) — NOUN_VERB_FINAL_EXEMPT homographs (final segment) ────────────
// Targets: 194922d696f7bf7c "store", ecfb1ca38f78ba6f "clear".
// ("set" / "open" are already covered by to_set(/is_open( in the base file.)
describe("detectAssertSideEffect — NOUN_VERB_FINAL_EXEMPT homographs", () => {
	it("backing_store( and all_clear( are pure homographs, not mutations", () => {
		expect(detectAssertSideEffect("backing_store(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("all_clear(x)", "snake")).toBe(false);
	});

	it("flag_set( and door_open( are pure homographs, not mutations", () => {
		// Unlike to_set(/is_open( in the base file — whose FIRST segments
		// ("to"/"is") are ALSO PREDICATE_FIRST_SEGMENTS members and so stay
		// false for that independent reason too — these use a first segment
		// that is neither a verb nor a predicate word, isolating the
		// NOUN_VERB_FINAL_EXEMPT check on "set"/"open" specifically.
		expect(detectAssertSideEffect("flag_set(x)", "snake")).toBe(false);
		expect(detectAssertSideEffect("door_open(x)", "snake")).toBe(false);
	});
});

// ─── (module) — PREDICATE_FIRST_SEGMENTS (first segment guards a real verb) ──
// Targets: 9d0228e6d0ef4859 "is" (2nd), f4e5cb68b947b126 "has" (2nd),
// 492e2d9b931cdf34 "was" (2nd), f50381a5ab0b9a63 "can" (2nd),
// e2c3d8475cd17276 "needs", 72bed739d386a7aa "must", 792050f1cb441883 "may",
// ad2030adaab4bfbc "will", b3290371074e0ce8 "to", b1a2bec718380131 "as".
// Each uses a NON-exempt final verb ("close") so the NOUN_VERB_FINAL_EXEMPT
// check doesn't short-circuit before reaching PREDICATE_FIRST_SEGMENTS —
// unlike is_open(/lock_free( in the base file, whose "open"/"free" finals ARE
// exempt and short-circuit first, never touching this set at all.
describe("detectAssertSideEffect — PREDICATE_FIRST_SEGMENTS (first segment reads as a question)", () => {
	it("is_close / has_close / was_close / can_close are reads, not mutations", () => {
		expect(detectAssertSideEffect("is_close(conn)", "snake")).toBe(false);
		expect(detectAssertSideEffect("has_close(conn)", "snake")).toBe(false);
		expect(detectAssertSideEffect("was_close(conn)", "snake")).toBe(false);
		expect(detectAssertSideEffect("can_close(conn)", "snake")).toBe(false);
	});

	it("needs_close / must_close / may_close / will_close / to_close / as_close are reads, not mutations", () => {
		expect(detectAssertSideEffect("needs_close(conn)", "snake")).toBe(false);
		expect(detectAssertSideEffect("must_close(conn)", "snake")).toBe(false);
		expect(detectAssertSideEffect("may_close(conn)", "snake")).toBe(false);
		expect(detectAssertSideEffect("will_close(conn)", "snake")).toBe(false);
		expect(detectAssertSideEffect("to_close(conn)", "snake")).toBe(false);
		expect(detectAssertSideEffect("as_close(conn)", "snake")).toBe(false);
	});
});

// ─── (module) — ASSIGNMENT_RE `^|` alternative (position-0 boundary) ─────────
// Targets: 62218349c99b9b2d.
describe("detectAssertSideEffect — ASSIGNMENT_RE start-of-string boundary", () => {
	it("fires on an assignment with no preceding character at all", () => {
		// The regex's `(?:^|[^=!<>\[])` alternative exists specifically for an
		// assignment token that is the very FIRST character of the body — with
		// no preceding char, only the `^` branch can match.
		expect(detectAssertSideEffect("=5", "snake")).toBe(true);
	});
});

// ─── (module) — "snake" is never compared by name; only "python"/"camel" are ─
// This mutant ("snake" -> "") is expected EQUIVALENT (see shadow-verify /
// equivalence-fuzz notes) but a distinguishing fixture costs nothing to try.
describe("detectAssertSideEffect — shared core, additional boundary", () => {
	it("snake mode: bare set( fires (the bare-builtin exemption is python-only)", () => {
		// Targets 651120310eac4d2f (lang==="python" -> true inside
		// detectAssertSideEffect's call to hasSnakeMutatingCall) AND
		// 61d3bcb7e87f9b7a (python && first==="set" -> python || first==="set",
		// inside isSnakeMutatingName) — both wrongly exempt a bare `set(` call
		// in NON-python mode.
		expect(detectAssertSideEffect("set(x)", "snake")).toBe(true);
	});

	it("python mode: a BARE (undotted) mutating verb still fires — only bare set( is exempt", () => {
		// Targets c7c05a8850306fb3 (first==="set" -> true inside
		// isSnakeMutatingName's segs.length===1 branch), which would wrongly
		// exempt EVERY bare verb in python mode, not just "set".
		expect(detectAssertSideEffect("push(x)", "python")).toBe(true);
		expect(detectAssertSideEffect("close(x)", "python")).toBe(true);
	});
});

// ─── C — C_FAMILY_EXTS: every listed extension, not just .c / .cpp ───────────
// Targets: 63384335e3ae53a2 ".h", 6497611a2bfe7c45 ".cc",
// 69aa3f319c6f6942 ".hpp", d04be1b1b4163e17 ".cxx", 3d8a44d685cf9cb6 ".hh".
describe("checkCAssertSideEffects — every C_FAMILY_EXTS extension is in scope", () => {
	it("each listed extension is scanned (not just .c / .cpp, already covered elsewhere)", () => {
		const src = "void f(void) { assert(insert_stale(m, k)); }";
		expect(checkCAssertSideEffects(src, "src/core/hmr.h")).toHaveLength(1);
		expect(checkCAssertSideEffects(src, "src/core/hmr.cc")).toHaveLength(1);
		expect(checkCAssertSideEffects(src, "src/core/hmr.hpp")).toHaveLength(1);
		expect(checkCAssertSideEffects(src, "src/core/hmr.cxx")).toHaveLength(1);
		expect(checkCAssertSideEffects(src, "src/core/hmr.hh")).toHaveLength(1);
	});
});

// ─── C — C_ASSERT_CALL_SRC must require the literal assert( token ───────────
// Targets: 9f2291bdc7171dbd (C_ASSERT_CALL_SRC -> "", which matches at EVERY
// offset instead of only after "assert").
describe("checkCAssertSideEffects — C_ASSERT_CALL_SRC boundary", () => {
	it("a mutating call nested inside a non-assert function call is not flagged", () => {
		const src = "void f(void) { log_call(insert_stale(m, k)); }";
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});
});

// ─── C — C_DEFINE_ASSERT_RE tolerance for indentation / spacing variants ─────
// Targets: b949f9a91fdc84e4 ([ \t]* -> [^ \t]*, breaks an INDENTED #define),
// 39075f39b80497e7 (\s*define -> \S*define, breaks "#   define"),
// 3046272659e149de (define\s+assert -> define\sassert, breaks 2+ spaces).
describe("checkCAssertSideEffects — C_DEFINE_ASSERT_RE bail tolerates whitespace variants", () => {
	it("an INDENTED #define assert still bails the whole file", () => {
		const src = [
			"  #define assert(x) my_always_on_check(x)",
			"void f(void) {",
			"  assert(write(fd, buf, n) == n);",
			"}",
		].join("\n");
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("extra spaces between # and define still bails the whole file", () => {
		const src = [
			"#   define assert(x) my_always_on_check(x)",
			"void f(void) {",
			"  assert(write(fd, buf, n) == n);",
			"}",
		].join("\n");
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("two spaces between define and assert still bails the whole file", () => {
		const src = [
			"#define  assert(x) my_always_on_check(x)",
			"void f(void) {",
			"  assert(write(fd, buf, n) == n);",
			"}",
		].join("\n");
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});
});

// ─── C — checkCAssertSideEffects internal offset/state bookkeeping ──────────
describe("checkCAssertSideEffects — internal offset bookkeeping", () => {
	it("assert( at the very start of the file (offset 0) still fires", () => {
		// Targets 47206337b42b8979 (scannedUntil sentinel -1 -> +1): with the
		// sentinel starting at +1, a match at start=0 is wrongly treated as
		// "already scanned" (0 < 1) and skipped.
		const src = "assert(insert_stale(m, k));";
		const found = checkCAssertSideEffects(src, C_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	it("body is exactly the assert() interior, not the whole file", () => {
		// Targets 01811459f96fbe7f (stripped.slice(openIndex+1, closeIndex) ->
		// stripped): a mutating call ELSEWHERE in the file must not leak into
		// an unrelated, clean assert's body.
		const src = [
			"void other(void) { insert_stale(m, k); }",
			"void f(void) { assert(count >= 0); }",
		].join("\n");
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("body starts exactly one character after assert( — not one character before", () => {
		// Targets 9ec222c3ea47ea0e (openIndex+1 -> openIndex-1): "ake(" alone is
		// not a recognized verb, but the character immediately BEFORE this
		// assert's own "(" is the "t" of "assert" itself — if the body slice
		// wrongly included it, "ake(" would read as "take(", a real verb.
		const src = "void f(void) { assert(ake(x)); }";
		expect(checkCAssertSideEffects(src, C_PATH)).toHaveLength(0);
	});

	it("preview text uses newline-splitting, not per-character splitting", () => {
		// Targets 6fa620b47e0f7d36 ("\n" -> ""): rawLines = content.split("")
		// would index into individual characters instead of lines.
		const src = [
			"#include <assert.h>",
			"void flush_buf(int fd, const char *buf, int n) {",
			"  assert(write(fd, buf, n) == n);",
			"}",
		].join("\n");
		const found = checkCAssertSideEffects(src, C_PATH);
		expect(found[0]?.text).toBe(
			"ubs_c_assert_side_effect: side effect inside assert() — compiling with NDEBUG (standard release) erases the argument, so it never runs; hoist the call out of the assert — assert(write(fd, buf, n) == n);",
		);
	});
});

// ─── Python — PY_ASSERT_LINE_RE anchoring ────────────────────────────────────
describe("checkPythonAssertSideEffects — PY_ASSERT_LINE_RE anchoring", () => {
	it("`assert` must be the first token on the line (after only whitespace)", () => {
		// Targets 3eb158f846ff0a82 (removes the leading ^): a semicolon-joined
		// leading statement means "assert" is not at line-start; this per-line
		// scanner does not treat it as a Python assert statement.
		const src = "debug = True; assert q.pop() is not None";
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});

	it("REGRESSION: a CRLF-terminated assert line with a real side effect is detected", () => {
		// Targets 0199e15fe368056c (removes the trailing $). This was a REAL
		// bug: `.` never matches \r (a line terminator per ECMA-262), so
		// `(.+)$` could not match a line ending in \r — CRLF-encoded Python
		// files (common from Windows editors) silently bypassed this detector
		// on every non-final line. Fixed by tolerating an optional trailing \r
		// before the anchor (see PY_ASSERT_LINE_RE in assert-side-effects.ts).
		const src = "def refresh(cache, key):\r\n    assert cache.insert_stale(key)\r\n";
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("two consecutive U+2028 separators between assert and the condition are both consumed", () => {
		// Targets b90f2c50e8420c40 (\s+ -> \s, exactly one separator char
		// instead of one-or-more). U+2028 LINE SEPARATOR is \s-matching but
		// excluded by `.` (also a line terminator) — greedy \s+ must consume
		// BOTH chars for (.+) to have anything left to match; a single \s
		// leaves one U+2028 stranded where (.+) cannot start.
		const sep = "  ";
		const src = `def refresh(cache, key):\n    assert${sep}cache.insert_stale(key)\n`;
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});
});

// ─── Python — topLevelCommaIndex / stripTrailingAssertMessage paren depth ────
describe("checkPythonAssertSideEffects — message-comma paren-depth tracking", () => {
	it("a comma INSIDE a paren group in the condition is not mistaken for the message separator", () => {
		// Targets: PY_GROUP_OPENERS "([{" -> "" (module-level StringLiteral),
		// 6107e1d838ee1e96 (PY_GROUP_OPENERS.includes(ch) -> false),
		// 629ed3981947222c (depth++ -> depth--), and ade6e279f55106c7
		// (depth<=0 -> true). All four wrongly treat the comma inside
		// `func(a, ...)` as the top-level message separator, truncating the
		// condition before it ever reaches the real mutating call.
		const src = "assert func(a, insert_stale(m, k))";
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found).toHaveLength(1);
	});

	it("depth correctly returns to 0 after a paren group closes, so the REAL message comma is found", () => {
		// Targets: PY_GROUP_CLOSERS ")]}" -> "" (module-level StringLiteral),
		// b55fc2dcf6d0504f (PY_GROUP_CLOSERS.includes(ch) -> false), and
		// b0bb2d43ed7df358 (depth-- -> depth++). All three fail to close the
		// `func(a, b)` group, so depth never returns to 0 and the REAL
		// top-level comma (before the message) is missed — the mutating call
		// in the MESSAGE then wrongly leaks into the scanned condition.
		const src = "assert func(a, b), insert_stale(m, k)";
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});

	it("REGRESSION: a no-message condition keeps its exact final character", () => {
		// Targets 535432512ba34f96 (idx===-1 -> false) and 59c5ae707399dc17
		// (the -1 in `idx===-1` -> +1). Both wrongly slice off the LAST
		// character of a condition that has no top-level comma at all —
		// here that character completes the walrus token `:=`.
		const src = "assert n:=";
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(1);
	});
});

// ─── Python — checkPythonAssertSideEffects preview text ─────────────────────
describe("checkPythonAssertSideEffects — preview text", () => {
	it("preview text uses newline-splitting, not per-character splitting", () => {
		// Targets 46fb887ad4406f59 ("\n" -> "").
		const src = ["def refresh(cache, key):", "    assert cache.insert_stale(key)"].join("\n");
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found[0]?.text).toBe(
			"ubs_python_assert_side_effect: side effect inside an assert statement — `python -O` strips asserts, so the call never runs in optimized deployments; hoist it out of the assert — assert cache.insert_stale(key)",
		);
	});
});

// ─── Java — the `: message` operand and preview text ────────────────────────
describe("checkJavaAssertSideEffects — the : message operand", () => {
	it("a side effect in the : message operand still fires (not just the condition)", () => {
		// Targets 7eb191fe14b7fa9c (m[2] ?? "" -> m[2] && ""): when m[2] is
		// truthy (a non-empty ": message" capture), `&&` evaluates to the
		// RIGHT operand ("") instead of m[2] itself — silently dropping the
		// message from the scanned body.
		const src = "class C { void f(List<String> list, String y) { assert x > 0 : list.add(y); } }";
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(1);
	});

	it("preview text uses newline-splitting, not per-character splitting", () => {
		// Targets a7d55e9594506085 ("\n" -> "").
		const src = [
			"class Registry {",
			"  void track(List<String> list, String x) {",
			"    assert list.add(x);",
			"  }",
			"}",
		].join("\n");
		const found = checkJavaAssertSideEffects(src, JAVA_PATH);
		expect(found[0]?.text).toBe(
			"ubs_java_assert_side_effect: side effect inside an assert — JVM assertions are DISABLED by default (no -ea), so the argument never runs in production; hoist the call out of the assert — assert list.add(x);",
		);
	});
});

// ─── checkPythonAssertTautology — regex boundaries and line numbers ─────────
describe("checkPythonAssertTautology — anchoring and line numbers", () => {
	it("the tautology must be the first token on the line (after only whitespace)", () => {
		// Targets 322967cfd1191cd2 (removes the leading ^).
		const src = 'if True: assert (x == 1, "should be 1")';
		expect(checkPythonAssertTautology(src, PY_PATH)).toEqual([]);
	});

	it("an indented tautology (inside a function) still fires", () => {
		// Targets 0e53cbddb56a7709 (^\s* -> ^\S*, which requires
		// NON-whitespace before "assert" — breaking every indented line).
		const src = ["def f():", '    assert (x == 1, "should be 1")'].join("\n");
		const found = checkPythonAssertTautology(src, PY_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("no space between assert and the opening paren still fires", () => {
		// Targets 128c9cf752d0dc08 (assert\s*\( -> assert\s\(, which REQUIRES
		// at least one space and rejects zero).
		const src = 'assert(x == 1, "should be 1")';
		expect(checkPythonAssertTautology(src, PY_PATH)).toHaveLength(1);
	});

	it("no space between the comma and the message operand still fires", () => {
		// Targets 2afbe452f8afff45 (,\s* -> ,\s, which REQUIRES at least one
		// space and rejects zero).
		const src = 'assert (x == 1,"should be 1")';
		expect(checkPythonAssertTautology(src, PY_PATH)).toHaveLength(1);
	});

	it("trailing whitespace after the closing paren is tolerated", () => {
		// Targets 0e2e888b86460e4e (trailing \s* -> \S*, which requires the
		// trailing run to be NON-whitespace — rejecting real trailing spaces).
		const src = 'assert (x == 1, "should be 1")   ';
		expect(checkPythonAssertTautology(src, PY_PATH)).toHaveLength(1);
	});

	it("reports the correct 1-based line number", () => {
		// Targets 014a5e045f23d676 (i + 1 -> i - 1, the recordMatch lineNo
		// argument).
		const src = ["x = 1", 'assert (x == 1, "should be 1")'].join("\n");
		const found = checkPythonAssertTautology(src, PY_PATH);
		expect(found[0]?.line).toBe(2);
	});

	it("preview text uses newline-splitting, not per-character splitting", () => {
		// Targets bb0807da394bc55d ("\n" -> "").
		const src = 'assert (x == 1, "should be 1")';
		const found = checkPythonAssertTautology(src, PY_PATH);
		expect(found[0]?.text).toBe(
			'ubs_python_assert_tautology: `assert (cond, "msg")` asserts a non-empty TUPLE — always truthy, so this assertion can never fail. Drop the parentheses: `assert cond, "msg"`. — assert (x == 1, "should be 1")',
		);
	});
});

// ─── recordMatch — preview-text construction (truncation, trim, line index) ─
// Exercised through checkCAssertSideEffects, but the mutants live in the
// shared recordMatch helper and so equally affect all three languages.
describe("recordMatch — preview text construction", () => {
	it("preview text is trimmed of leading whitespace", () => {
		// Targets b52120fdd7ca2294 (removes .trim(), keeping only .slice()).
		const src = ["void f(void) {", "     assert(insert_stale(m, k));", "}"].join("\n");
		const found = checkCAssertSideEffects(src, C_PATH);
		expect(found[0]?.text.endsWith("— assert(insert_stale(m, k));")).toBe(true);
	});

	it("preview text is truncated to 150 characters", () => {
		// Targets ecbd2cd0b5585e40 (removes .slice(0, REPORT_LINE_TRUNC),
		// keeping only .trim()).
		const longCall = `insert_stale(${"x".repeat(200)})`;
		const src = `void f(void) { assert(${longCall}); }`;
		const found = checkCAssertSideEffects(src, C_PATH);
		const tail = (found[0]?.text ?? "").split(" — ")[1] ?? "";
		expect(tail.length).toBeLessThanOrEqual(150);
	});

	it("preview text comes from the correct line (lineNo - 1 index)", () => {
		// Targets 081b79042c9884d3 (lineNo - 1 -> lineNo + 1).
		const src = [
			"line1_marker_AAA",
			"void f(void) {",
			"  assert(insert_stale(m, k)); // line3_marker_BBB",
			"line4_marker_CCC",
			"}",
		].join("\n");
		const found = checkCAssertSideEffects(src, C_PATH);
		expect(found[0]?.line).toBe(3);
		expect(found[0]?.text).toContain("line3_marker_BBB");
		expect(found[0]?.text).not.toContain("line4_marker_CCC");
		expect(found[0]?.text).not.toContain("line1_marker_AAA");
	});
});

// Text blocks can precede a real mutator in a valid Java assert expression.
describe("checkJavaAssertSideEffects — text blocks within assertion conditions", () => {
	it("finds a mutating call after a text-block comparison", () => {
		const q3 = '"""';
		const src = [
			`class C { void f(List<String> list, String x) { assert ${q3}`,
			"docstring",
			`${q3}.isEmpty() || list.add(x); } }`,
		].join("\n");
		expect(checkJavaAssertSideEffects(src, JAVA_PATH)).toHaveLength(1);
	});
});

// ─── PY_ASSERT_LINE_RE — trailing-$ anchor rejects mid-line \r garbage ───────
describe("checkPythonAssertSideEffects — PY_ASSERT_LINE_RE trailing anchor", () => {
	// test-contract: invariant — PY_ASSERT_LINE_RE anchors at end-of-line so a
	// line is either a WHOLE assert statement or not matched at all.
	it("a line with content AFTER a mid-line CR is not treated as a bare assert line", () => {
		// Targets 018bd9a260878b97 (removes the trailing $ from
		// /^\s*assert\s+(.+)\r?$/). `.` never matches \r, so with the $ anchor
		// a line carrying "\r" followed by MORE text after it can never match
		// (the greedy (.+) stalls before the \r and nothing consumes the
		// trailing text before end-of-string). Without $, the same greedy
		// (.+)\r? is satisfied as soon as it reaches the \r — the trailing
		// text after it is simply ignored, and the truncated capture group
		// ("insert_stale(x)") still contains the mutating call, so the mutant
		// WOULD fire here while the original correctly does not match at all.
		const src = "def f(x):\n    assert insert_stale(x)\rTRAILING_GARBAGE\n";
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});
});

// ─── blankTripleQuotedBlocks — `open === null` gates which branch decides delim ─
describe("blankTripleQuotedBlocks — open-state gates delimiter lookup (via Python)", () => {
	// test-contract: invariant — an OPEN triple-quoted block can only be
	// closed by its OWN delimiter, never by a different, unrelated one.
	it("a mismatched delimiter embedded inside an open block does not close it early", () => {
		// Targets c63c9f73f25cb198 (`open === null` -> `true`): once a block is
		// open, the real code fixes `delim = open` (the SAME delimiter that
		// opened it) so only that exact delimiter can close it. With the
		// condition forced to `true`, the ternary re-runs
		// `delimiters.find(...)` even while `open` is a live triple-double
		// block — an embedded, unrelated `'''` inside it now satisfies
		// `.find` and is treated as a closer, reopening/closing state early
		// and un-blanking the assert line that follows, which still lives
		// inside the real (unmutated) """ block.
		const src = [
			'"""',
			"docstring text with an embedded '''marker''' inside it",
			"    assert insert_stale(x)",
			'"""',
		].join("\n");
		expect(checkPythonAssertSideEffects(src, PY_PATH)).toHaveLength(0);
	});
});

// ─── blankTripleQuotedBlocks — `delim !== undefined` guards a possibly-undefined delim ─
describe("blankTripleQuotedBlocks — undefined-delim guard (via Python)", () => {
	// test-contract: boundary — scanning code that happens to contain the
	// literal text "undefined" must never crash the detector.
	it("does not throw when scanning code containing the literal text 'undefined' outside any block", () => {
		// Targets d238bc7675b3fed5 (`delim !== undefined` -> `true`): when
		// `open === null` and no real delimiter starts at the current
		// position, `delim` is `undefined` and the real `&&` short-circuits
		// before `stripped.startsWith(delim, i)` ever runs. Forced to `true`,
		// `"...".startsWith(undefined, i)` coerces to the literal string
		// "undefined" — which this fixture supplies verbatim in plain code —
		// making the call match, then `open = delim` (= undefined) and
		// `" ".repeat(delim.length)` throws (`undefined.length`). The
		// original returns normally; the mutant throws.
		const src = "x = undefined\nassert insert_stale(y)\n";
		expect(() => checkPythonAssertSideEffects(src, PY_PATH)).not.toThrow();
		const found = checkPythonAssertSideEffects(src, PY_PATH);
		expect(found).toHaveLength(1);
	});
});
