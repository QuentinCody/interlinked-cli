// Unit tests for nan-coercion.ts
//
// Covers:
//   Positive (MUST fire):
//     P1  inline Date.parse → relational (no guard)
//     P2  two-step Number() → if comparison (no guard)
//     P3  inline parseInt → relational (no guard)
//     P4  inline parseFloat → relational (no guard)
//     P5  two-step Date.parse → comparison on different line
//   Negative (MUST NOT fire):
//     N1  Number.isFinite guard present before comparison
//     N2  equality operator (=== / !==) — not a relational op
//     N3  coercion result only used in arithmetic (no comparison)
//     N4  isNaN guard present
//     N5  Number.isNaN guard present
//     N6  non-JS file (.py) — out of scope

import { describe, expect, it } from "vitest";
import { detectNaNCoercionGuards } from "./nan-coercion.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fires(src: string): boolean {
	return detectNaNCoercionGuards(src, "src/util.ts").length > 0;
}

// ─── Positive cases ───────────────────────────────────────────────────────────

describe("detectNaNCoercionGuards — positive (must fire)", () => {
	it("P1: inline Date.parse() <= now with no guard", () => {
		const src = `
function isExpired(rec: { expires_at: string }): boolean {
  const now = Date.now();
  if (Date.parse(rec.expires_at) <= now) return true;
  return false;
}
`;
		expect(fires(src)).toBe(true);
		// Line 4 is the comparison
		const found = detectNaNCoercionGuards(src, "file.ts");
		expect(found.length).toBeGreaterThan(0);
		expect(found[0]?.text).toMatch(/nan_coercion_guard/);
	});

	it("P2: two-step Number() assignment then relational in if-statement", () => {
		const src = `
function checkLimit(input: string, limit: number): void {
  const n = Number(input);
  // do some other work
  if (n > limit) {
    throw new Error("exceeded");
  }
}
`;
		expect(fires(src)).toBe(true);
		const found = detectNaNCoercionGuards(src, "check.ts");
		expect(found.length).toBeGreaterThan(0);
	});

	it("P3: inline parseInt() < max with no guard", () => {
		const src = `const ok = parseInt(raw, 10) < MAX_RETRIES;`;
		expect(fires(src)).toBe(true);
	});

	it("P4: inline parseFloat() >= threshold with no guard", () => {
		const src = `if (parseFloat(value) >= THRESHOLD) doWork();`;
		expect(fires(src)).toBe(true);
	});

	it("P5: two-step Date.parse assignment then comparison on later line", () => {
		const src = `
function processEvent(ts: string, cutoff: number): boolean {
  const parsed = Date.parse(ts);
  const label = "event";
  return parsed < cutoff;
}
`;
		expect(fires(src)).toBe(true);
		const found = detectNaNCoercionGuards(src, "events.ts");
		// Should flag the return line, not the assignment
		const lineNos = found.map((m) => m.line);
		// The comparison is on line 5
		expect(lineNos.some((l) => l >= 4)).toBe(true);
	});

	it("P6: Number() > comparison (RHS coerce form)", () => {
		const src = `if (score > Number(raw)) { pass(); }`;
		expect(fires(src)).toBe(true);
	});
});

// ─── Negative cases ───────────────────────────────────────────────────────────

describe("detectNaNCoercionGuards — negative (must NOT fire)", () => {
	it("N1: Number.isFinite guard wrapping the comparison — should not fire", () => {
		const src = `
function inRange(raw: string, limit: number): boolean {
  const exp = Number(raw);
  if (Number.isFinite(exp) && exp <= limit) return true;
  return false;
}
`;
		expect(fires(src)).toBe(false);
	});

	it("N2: equality operator === not relational — should not fire", () => {
		const src = `const isZero = Number(x) === 0;`;
		expect(fires(src)).toBe(false);
	});

	it("N3: coercion result only used in arithmetic, no relational comparison", () => {
		const src = `
function offset(raw: string): number {
  const n = Number(raw);
  return n + 1;
}
`;
		expect(fires(src)).toBe(false);
	});

	it("N4: isNaN guard before comparison — should not fire", () => {
		const src = `
function lessThanMax(raw: string, max: number): boolean {
  const n = Number(raw);
  if (isNaN(n)) return false;
  return n < max;
}
`;
		expect(fires(src)).toBe(false);
	});

	it("N5: Number.isNaN guard before comparison — should not fire", () => {
		const src = `
function check(s: string, threshold: number): boolean {
  const v = parseFloat(s);
  if (!Number.isNaN(v) && v < threshold) return true;
  return false;
}
`;
		expect(fires(src)).toBe(false);
	});

	it("N6: non-JS file (.py) — out of scope, should not fire", () => {
		const src = `expiry = Date.parse(ts) <= now`;
		const found = detectNaNCoercionGuards(src, "script.py");
		expect(found).toHaveLength(0);
	});

	it("N7: !== operator not relational — should not fire", () => {
		const src = `const changed = parseInt(a, 10) !== parseInt(b, 10);`;
		expect(fires(src)).toBe(false);
	});

	it("N8: coercion in return without relational op — should not fire", () => {
		const src = `function parse(s: string): number { return Number(s); }`;
		expect(fires(src)).toBe(false);
	});
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("detectNaNCoercionGuards — edge cases", () => {
	it("does not fire on inline Number.isFinite wrapping the whole expression", () => {
		const src = `if (Number.isFinite(Date.parse(s)) && Date.parse(s) <= now) {}`;
		// Guard is present — should not fire
		expect(fires(src)).toBe(false);
	});

	it("counts multiple unguarded comparisons in one file", () => {
		const src = `
if (Date.parse(a) < Date.now()) {}
if (parseInt(b, 10) > 100) {}
`;
		const found = detectNaNCoercionGuards(src, "multi.ts");
		expect(found.length).toBeGreaterThanOrEqual(2);
	});

	it("caps results at 10 per file", () => {
		// Repeat the flagged pattern 15 times
		const lines15 = Array.from({ length: 15 }, (_, i) =>
			`if (Number(raw${i}) > 0) {}`,
		).join("\n");
		const found = detectNaNCoercionGuards(lines15, "cap.ts");
		expect(found.length).toBeLessThanOrEqual(10);
	});
});

// ─── Mutation-kill campaign (pass1_w24) ────────────────────────────────────────
// Targets specific surviving mutants from .interlinked/mutation-manifest.json.
// Each case documents which mutantId it kills and why. Ten MAX_MATCHES_PER_FILE
// cap-check mutants (across recordMatch/detectInlineShape/detectTwoStepShape),
// three module-level "g"-flag mutants, and three other narrow guard-condition
// mutants are NOT targeted here — see the campaign receipt for the structural
// equivalence argument (recordMatch's own cap check is a redundant backstop
// behind every call site; the module-level regex constants' flags are never
// read, only `.source` is; a couple of `?? stripped.length` boundary checks are
// safety-netted by the nullish fallback regardless of the guarding condition).
const INLINE_MSG =
	"nan_coercion_guard: coercion result used in relational comparison without Number.isFinite / isNaN guard";

describe("detectNaNCoercionGuards — mutation-kill (hasInlineGuard regex)", () => {
	// test-contract: mutation-kill — kills 06f878a49aa2913d (Number\.isFinite\s*\( -> \S*\()
	it("recognizes Number.isFinite guard with a space before the paren", () => {
		const src = `if (Number.isFinite (x) && Date.parse(raw) <= now) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills ce5a4a39c401ff00 ((?<!\w) -> (?<=\w))
	// test-contract: mutation-kill — kills 3f12f81e3f9adea7 ((?<!\w) -> (?<!\W))
	// test-contract: mutation-kill — kills 43a2ed3eb86c3681 (isNaN\s*\( -> isNaN\s\( on the bare-isNaN alt)
	it("recognizes bare isNaN(x) (no space, preceded by punctuation) as a guard", () => {
		const src = `if (isNaN(x) && Date.parse(raw) <= now) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills 3832652f01366d3f (Number\.isNaN\s*\( -> \S*\()
	it("does NOT treat Number.isNaNq( (non-whitespace garbage before paren) as a guard", () => {
		const src = `if (Number.isNaNq(x) && Date.parse(raw) <= now) {}`;
		expect(fires(src)).toBe(true);
	});

	// test-contract: mutation-kill — kills 6633d6d50e4b36c0 (bare isNaN\s*\( -> \S*\()
	it("does NOT treat isNaNq( (non-whitespace garbage before paren) as a guard", () => {
		const src = `if (isNaNq(x) && Date.parse(raw) <= now) {}`;
		expect(fires(src)).toBe(true);
	});
});

describe("detectNaNCoercionGuards — mutation-kill (escapeForRegex)", () => {
	// test-contract: mutation-kill — kills 5cec6cd541dd9023 ("\\$&" -> "" — deletes special
	// chars instead of escaping them, so a "$" in a two-step variable name is dropped from
	// the generated relational-use regex, and the real use is never located)
	it("escapes a $ in a two-step variable name instead of dropping it", () => {
		const src = `
function checkLimit(input: string, limit: number): void {
  const a$b = Number(input);
  if (a$b < limit) {
    throw new Error("exceeded");
  }
}
`;
		expect(fires(src)).toBe(true);
	});
});

describe("detectNaNCoercionGuards — mutation-kill (recordMatch)", () => {
	// test-contract: mutation-kill — kills 5a3a3a0ad84441b3 (seen.has(lineNo) -> false)
	it("dedupes two unguarded matches that land on the same line", () => {
		const src = `if (Number(a) > 0 && Number(b) > 0) {}`;
		const found = detectNaNCoercionGuards(src, "dup.ts");
		expect(found).toHaveLength(1);
	});

	// test-contract: mutation-kill — kills 242e734388ca68f0 (.slice(0, REPORT_LINE_TRUNC) removed)
	it("truncates a long raw line instead of embedding it in full", () => {
		const pad = "z".repeat(500);
		const src = `if (Number(a) > 0) {} // ${pad}`;
		const found = detectNaNCoercionGuards(src, "long.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text.length).toBeLessThan(300);
	});

	// test-contract: mutation-kill — kills 3ec841e9164893a9 (.trim() removed before .slice())
	it("trims leading whitespace from the raw line before reporting it", () => {
		const src = `        if (Number(a) > 0) {}`;
		const found = detectNaNCoercionGuards(src, "indent.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe(`${INLINE_MSG} — if (Number(a) > 0) {}`);
	});

	// test-contract: mutation-kill — kills ffd8c7784342957c (?? "" -> && "" — a truthy raw
	// line would evaluate the whole expression to "" instead of the line itself)
	it("keeps the actual raw-line content (not an empty string) in the report", () => {
		const src = `if (Number(a) > 0) {}`;
		const found = detectNaNCoercionGuards(src, "content.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe(`${INLINE_MSG} — if (Number(a) > 0) {}`);
	});

	// test-contract: mutation-kill — kills ae4ed3042a7a64ff (lineNo - 1 -> lineNo + 1; wrong
	// raw line, two lines ahead of the actual match, would be displayed)
	it("displays the raw text of the actual matched line, not a line two ahead", () => {
		const src = `// filler
if (Number(a) > 0) {}
// unrelated1
// SHOULD_NOT_APPEAR_HERE
`;
		const found = detectNaNCoercionGuards(src, "lines.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("if (Number(a) > 0) {}");
		expect(found[0]?.text).not.toContain("SHOULD_NOT_APPEAR_HERE");
	});
});

describe("detectNaNCoercionGuards — mutation-kill (detectInlineShape, coerce-then-rel)", () => {
	// test-contract: mutation-kill — kills a1e95e9a3f589012 (surround slice -> whole `stripped`
	// string; a guard far outside the +/-window would falsely suppress the finding)
	it("does not let a guard 200+ chars before the match suppress it", () => {
		const padding = "x".repeat(200);
		const src = `const g = Number.isFinite(1);\n// ${padding}\nif (Number(a) > 0) {}`;
		expect(fires(src)).toBe(true);
	});

	// test-contract: mutation-kill — kills eea926b319c8cc59 (hit.index + hit[0].length ->
	// hit.index - hit[0].length inside the surroundEnd Math.min call; shrinks the after-window
	// so a guard placed right after the match is no longer seen)
	it("still sees a guard placed immediately after the match (surroundEnd arithmetic)", () => {
		const src = `if (Date.parse(x) <= now && Number.isFinite(9)) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills 60891296d4d25752 (Math.min -> Math.max for
	// surroundEnd; window would extend to end-of-file, so a far-away guard wrongly suppresses)
	it("does not let a guard far after the match (beyond the +40 window) suppress it", () => {
		const padding = "x".repeat(200);
		const src = `if (Date.parse(x) <= now) {} // ${padding}\nconst g = Number.isFinite(1);`;
		expect(fires(src)).toBe(true);
	});
});

describe("detectNaNCoercionGuards — mutation-kill (detectInlineShape, rel-then-coerce)", () => {
	// test-contract: mutation-kill — kills fd0d9952f37b2327 (surround slice -> whole `stripped`
	// string for the rel-then-coerce branch)
	it("does not let a far-away guard suppress a rel-then-coerce match", () => {
		const padding = "x".repeat(200);
		const src = `const g = Number.isFinite(1);\n// ${padding}\nif (0 < Number(a)) {}`;
		expect(fires(src)).toBe(true);
	});

	// test-contract: mutation-kill — kills eeabe527ef0a2eb4 (Math.max(0, ...) -> Math.min(0,
	// ...) for surroundStart; a negative slice start counts from the string end, so a guard
	// right before the match is missed)
	it("still sees a guard right before a rel-then-coerce match (surroundStart clamp)", () => {
		const guard = "Number.isFinite(0);";
		const padding = "z".repeat(150);
		const src = `${guard}\nif (0 < Number(a)) {}\n${padding}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills fed36f83216a23e6 (hit.index - 80 -> hit.index + 80
	// for surroundStart; pushes the window start past the match, losing a before-guard)
	it("still sees a guard directly before a rel-then-coerce match (surroundStart sign)", () => {
		const src = `if (Number.isFinite(0) && 0 < Number(a)) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills 52c4466c50569935 (Math.min -> Math.max for
	// surroundEnd on the rel-then-coerce branch)
	it("does not let a guard far after a rel-then-coerce match (beyond +40) suppress it", () => {
		const padding = "x".repeat(200);
		const src = `if (0 < Number(a)) {} // ${padding}\nconst g = Number.isFinite(1);`;
		expect(fires(src)).toBe(true);
	});

	// test-contract: mutation-kill — kills b3f98f1359f4b80d (+40 -> -40 in the surroundEnd
	// Math.min call; shrinks the after-window so a guard shortly after is missed)
	it("still sees a guard shortly after a rel-then-coerce match (surroundEnd +40)", () => {
		const src = `if (0 < Number(a) && Number.isFinite(9)) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills 1b99719d8cbe3010 (+hit[0].length -> -hit[0].length
	// in the surroundEnd Math.min call; shifts the after-window boundary by 2*hit[0].length)
	it("still sees a bare-isNaN guard placed just past the shrunk after-window", () => {
		const filler = `${"x".repeat(18)} `;
		const src = `if (0 < Number(a)) {} ${filler}isNaN(9);`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills c47b9bd5af046ee2 (hasInlineGuard(surround) -> false;
	// disables guard suppression entirely on the rel-then-coerce branch)
	it("suppresses a guarded rel-then-coerce match instead of always firing", () => {
		const src = `if (Number.isFinite(9) && 0 < Number(a)) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills d48b7d38055cd0cd (rel-then-coerce message string -> "")
	it("uses the full nan_coercion_guard message text for a rel-then-coerce match", () => {
		const src = `if (0 < Number(a)) {}`;
		const found = detectNaNCoercionGuards(src, "relthencoerce.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe(`${INLINE_MSG} — if (0 < Number(a)) {}`);
	});
});

describe("detectNaNCoercionGuards — mutation-kill (detectTwoStepShape)", () => {
	// test-contract: mutation-kill — kills 82e5b5eb00330914 (assignHit.index +
	// assignHit[0].length -> - assignHit[0].length for windowStart; the use-scan window would
	// wrongly reach back before the assignment, picking up an unrelated earlier guard)
	it("does not let guard-shaped text before the assignment suppress the two-step use", () => {
		const guardBlock = "isNaN(n) ".repeat(6);
		const src = `${guardBlock}const n = Number(input);\nif (n < limit) {}`;
		expect(fires(src)).toBe(true);
	});

	// test-contract: mutation-kill — kills 4243823854763d1e (assignLineNo +
	// TWO_STEP_LOOKAHEAD_LINES -> - TWO_STEP_LOOKAHEAD_LINES)
	// test-contract: mutation-kill — kills 3f0a9655b031cf2d (lookahead in-bounds check -> false)
	// test-contract: mutation-kill — kills 9cea6615686cff62 (lookahead in-bounds check: < -> >=)
	it("does not scan past the 60-line lookahead window for a two-step use", () => {
		const filler = Array.from({ length: 65 }, (_, i) => `// filler line ${i}`).join("\n");
		const src = `const n = Number(input);\n${filler}\nif (n < limit) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills 410dab02dfe6b87c (lookaheadEndLine - 1 ->
	// lookaheadEndLine + 1; shifts the line-60 lookahead boundary by two lines)
	it("excludes a two-step use exactly on the line-61 lookahead boundary", () => {
		const filler = Array.from({ length: 59 }, (_, i) => `// f${i}`).join("\n");
		const src = `const n = Number(input);\n${filler}\nif (n < limit) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills 023065197d3ad67e (window = stripped.slice(...) ->
	// whole `stripped` string; the use-search window would no longer be windowStart-relative,
	// so the reported line for the found use would be wrong)
	it("reports the correct line for a two-step use with a windowed (not whole-file) scan", () => {
		const src = `
function checkLimit(input, limit) {
  const n = Number(input);
  if (n < limit) {
    throw new Error("x");
  }
}
`;
		const found = detectNaNCoercionGuards(src, "win.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});

	// test-contract: mutation-kill — kills ee7a4b58faf0f092 (between = stripped.slice(...) ->
	// whole `stripped` string; a guard placed AFTER the use would wrongly suppress it)
	it("does not let a guard placed after the two-step use suppress it", () => {
		const src = `
function checkLimit(input, limit) {
  const n = Number(input);
  if (n < limit) {
    throw new Error("x");
  }
  Number.isFinite(n);
}
`;
		expect(fires(src)).toBe(true);
	});

	// test-contract: mutation-kill — kills f5bf83e200d965ea (two-step message template -> ``)
	it("uses the full two-step nan_coercion_guard message text (with variable name)", () => {
		const src = `
function checkLimit(input, limit) {
  const n = Number(input);
  if (n < limit) {
    throw new Error("x");
  }
}
`;
		const found = detectNaNCoercionGuards(src, "msg.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain(
			`nan_coercion_guard: "n" from coercion used in relational comparison without Number.isFinite / isNaN guard`,
		);
	});
});

describe("detectNaNCoercionGuards — mutation-kill (pass1_w24 wave 2)", () => {
	// test-contract: mutation-kill — kills e28b38d942f82125 (Number\.isNaN\s*\( -> Number\.isNaN\s\(,
	// dropping the `*` so the alternative requires exactly one whitespace char before the paren
	// instead of zero-or-more; a no-space "Number.isNaN(x)" guard would then go undetected)
	it("recognizes Number.isNaN(x) guard with no space before the paren", () => {
		const src = `if (Number.isNaN(x) && Date.parse(raw) <= now) {}`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: mutation-kill — kills c46b64ff07f12113 (recordMatch's own
	// `matches.length >= MAX_MATCHES_PER_FILE` -> `matches.length > MAX_MATCHES_PER_FILE`) and
	// 878ef5a260291f5a (same condition -> `false`). recordMatch is the sole real enforcement
	// point for the per-file cap — the per-loop checks in detectInlineShape/detectTwoStepShape
	// are redundant early-exits behind it (see the structural-equivalence note below), so only a
	// strict boundary assertion against recordMatch's own guard can distinguish `>=` from `>` or
	// from an always-false condition. 11 distinct unguarded lines: original caps at exactly 10;
	// the `>` mutant allows an 11th push before its own `>10` check trips; the `false` mutant
	// caps at nothing (11 here, or more with more candidates).
	it("caps at exactly 10 matches, not 11, with 11 unguarded candidates", () => {
		const eleven = Array.from({ length: 11 }, (_, i) => `if (Number(raw${i}) > 0) {}`).join(
			"\n",
		);
		const found = detectNaNCoercionGuards(eleven, "cap11.ts");
		expect(found).toHaveLength(10);
	});
});

// Suspected-equivalent survivors (pass1_w24 wave 2) — structural-equivalence notes only, no new
// executable cases; see the campaign receipt at scratch/fleet-r3/receipts/nan-coercion.jsonl.
//
// d0ecfe6d9ca06028, 226457a217cc6b53, e88d75e79cb11717, 654aac835c1f5caf (detectInlineShape, both
// reA/reB loops), 0622a3d6bb330770, 03d00b06bed29a6b, 4041d9aee5adfcdf, 55fe103fabe1871b
// (detectTwoStepShape, both outer assign-loop and inner use-loop): each mutates a per-loop
// `matches.length >= MAX_MATCHES_PER_FILE` early-exit (ConditionalExpression -> false, or
// EqualityOperator >= -> >) that sits BEFORE a call to recordMatch, which re-checks the identical
// `>= MAX_MATCHES_PER_FILE` condition on its own and no-ops past the cap regardless. Disabling or
// loosening the outer early-exit only means the loop keeps iterating and calling a no-op
// recordMatch — no test can observe a difference in `matches`/`found`.
//
// 1b319f0164230cbb (detectTwoStepShape `varName === undefined` -> false): TWO_STEP_ASSIGN_RE's
// capturing group `([A-Za-z_$][\w$]*)` is a required (non-optional) group with a mandatory
// one-or-more-char class, so whenever assignRe matches at all, assignHit[1] is always a defined,
// non-empty string — the undefined check is TS-narrowing defensive code with no reachable input
// that makes it true.
//
// 1f2e15e321310760 (`lookaheadEndLine - 1 < lineOffsets.length` -> true) and 3831d0f89cb3f813
// (same condition, < -> <=): both only change which branch computes windowEnd, but
// `lineOffsets[lookaheadEndLine - 1] ?? stripped.length` returns stripped.length itself whenever
// the index is out of bounds (out-of-range array access is undefined, caught by the `??`). Both
// branches reduce to the identical stripped.length value at every boundary these mutants can
// move, so windowEnd is unchanged for any input.
//
// 50733c56385627a5, e9a17b1449ab414c, 924b1dde23bcea51 (module-level `"g"` flag -> `""` on
// INLINE_COERCE_THEN_REL_RE / INLINE_REL_THEN_COERCE_RE / TWO_STEP_ASSIGN_RE): grep-verified —
// each constant is referenced only via `.source` (lines 129/149/179), which discards flags
// entirely; a fresh RegExp is always constructed with a hardcoded `"g"`. The module-level object
// (and its flags) is otherwise unused, so the mutation has no observable effect.

describe("detectNaNCoercionGuards — mutation-kill (top-level split)", () => {
	// test-contract: mutation-kill — kills 219a9251632a17d1 (content.split("\\n") -> split(""),
	// turning rawLines into an array of individual characters instead of lines)
	it("builds rawLines by splitting on newlines, not into individual characters", () => {
		const src = `if (Number(a) > 0) {}`;
		const found = detectNaNCoercionGuards(src, "split.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe(`${INLINE_MSG} — if (Number(a) > 0) {}`);
	});
});
